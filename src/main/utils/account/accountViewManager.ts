/**
 * Account View Manager — WebContentsView-based multi-account session manager.
 *
 * Parallel implementation of {@link IAccountWindowManager} that hosts every
 * account inside a SINGLE host BrowserWindow using one
 * {@link Electron.WebContentsView} per account, each bound to its own
 * `persist:account-N` session partition.
 *
 * Compared to the BrowserWindow-per-account fallback in
 * {@link AccountWindowManager}, this approach:
 *   - Saves ~15-25 MB / account (no per-account window chrome / GPU surface).
 *   - Switches accounts in <16 ms via {@link Electron.WebContentsView.setBounds}
 *     instead of allocating + destroying BrowserWindows.
 *   - Avoids a separate macOS Dock entry per account.
 *
 * Hydrate/dehydrate map to view show/hide rather than window create/destroy.
 * The interface contract returns BrowserWindow from {@link getAccountWindow};
 * here we return the SHARED host BrowserWindow so consumers that call
 * `window.show()/focus()/restore()/isMinimized()` operate on the host (which
 * is what they actually want when "the account is visible"). Per-account
 * webContents (load URL, reload, throttle) flow through
 * {@link getAccountWebContents}.
 *
 * This module is opt-in behind the `app.useWebContentsView` config flag and
 * is selected in {@link getAccountWindowManager}. The legacy
 * {@link AccountWindowManager} path is left untouched as the default.
 *
 * @module accountViewManager
 */

import { BrowserWindow, WebContentsView, type WebContents, type Rectangle } from 'electron';
import log from 'electron-log';

import type {
  AccountManagerOptions,
  AccountWebContentsInfo,
  AccountWindowState,
  WindowFactory,
  IAccountWindowManager,
} from '../../../shared/types/window.js';
import type { AccountIndex, WebContentsId } from '../../../shared/types/branded.js';
import { asAccountIndex, asWebContentsId, toPartition } from '../../../shared/types/branded.js';
import { isGoogleAuthUrl } from '../../../shared/urlValidators.js';
import {
  markAsBootstrap as _markAsBootstrap,
  clearBootstrap as _clearBootstrap,
  clearAllBootstrap,
} from './bootstrapTracker.js';
import { bootstrapDelegates } from './accountLifecycleHelpers.js';
import {
  getAccountActivityTracker,
  startSessionMaintenance,
  stopSessionMaintenance,
} from './accountSessionMaintenance.js';
import {
  applyAccountWindowState,
  readAccountWindowState,
  readNormalBounds,
  submitAccountWindowState,
  unwatchAccountWindow,
  watchAccountWindow,
} from './accountWindowPersistenceBridge.js';
import { getIconCache } from '../platform/iconCache.js';
import { installPermissionHandlers } from '../security/permissionHandler.js';
import { ensureNotificationPermission } from '../security/notificationAccess.js';
import { installHeaderFix } from '../security/cspHeaderHandler.js';
import { getWindowDefaults } from '../platform/windowUtils.js';
import { logger } from '../lifecycle/logger.js';
import { asType, asUnsafe } from '../../../shared/typeUtils.js';
import { createAccountWebPreferences } from './accountWebPreferences.js';
import {
  notifyAccountWebContentsCreated,
  notifyAccountWebContentsDestroyed,
  notifyAccountRemoved,
} from './accountWebContentsHooks.js';

/**
 * WCV account resource state (KD2 three-state machine).
 *
 * - visible: frontmost account UI
 * - hidden-live: switched away but still a live session (not resource-parked)
 * - dehydrated-parked: hide + background throttle via {@link dehydrateAccount}
 *
 * `isDehydrated` is true **only** for dehydrated-parked — never for mere switch-away.
 */
type AccountResourceState = 'visible' | 'hidden-live' | 'dehydrated-parked';

/**
 * Per-account state for a WebContentsView entry. The view itself owns the
 * `persist:account-N` session through its `webPreferences.partition`; this
 * record keeps the bookkeeping needed to satisfy the
 * {@link IAccountWindowManager} contract.
 */
interface AccountViewEntry {
  view: WebContentsView;
  accountIndex: AccountIndex;
  createdAt: number;
  /** Last URL successfully loaded into the view. */
  currentUrl: string;
  /** Three-state resource/layout model — see {@link AccountResourceState}. */
  resourceState: AccountResourceState;
}

/**
 * AccountViewManager — Single host BrowserWindow + N WebContentsView accounts.
 *
 * Implements the same {@link IAccountWindowManager} surface as the
 * BrowserWindow-per-account manager so that all consumers
 * (`closeToTray`, `bootstrapPromotion`, `windowState`, etc.) work
 * transparently with either backend.
 */
export class AccountViewManager implements IAccountWindowManager {
  private hostWindow: BrowserWindow | null = null;
  private readonly views = new Map<AccountIndex, AccountViewEntry>();
  private readonly webContentsToAccountIndex = new Map<WebContentsId, AccountIndex>();
  private mostRecentAccountIndex: AccountIndex | null = null;
  private maintenanceStarted = false;
  /**
   * Most recently presented partition string. Used purely for diagnostics
   * to understand which account "owned" the host window when an event fires.
   */
  private resizeHandler: (() => void) | null = null;
  private activityHandler: (() => void) | null = null;

  private readonly isolated: boolean;
  private readonly isolatedBootstrap = new Set<AccountIndex>();

  constructor(_windowFactory?: WindowFactory, options?: AccountManagerOptions) {
    this.isolated = options?.isolated === true;
    if (!this.isolated) {
      // Reset shared bootstrap tracker so each manager instance starts clean,
      // matching the BrowserWindow path semantics.
      clearAllBootstrap();
      this.startMaintenance();
    }
  }

  private startMaintenance(): void {
    if (this.isolated || this.maintenanceStarted) {
      return;
    }
    startSessionMaintenance(getAccountActivityTracker(), this);
    this.maintenanceStarted = true;
  }

  private emitWebContentsCreated(accountIndex: AccountIndex, webContents: WebContents): void {
    if (this.isolated) {
      return;
    }
    notifyAccountWebContentsCreated({
      accountIndex,
      webContents,
      backend: 'web-contents-view',
    });
  }

  private emitWebContentsDestroyed(accountIndex: AccountIndex): void {
    if (this.isolated) {
      return;
    }
    notifyAccountWebContentsDestroyed(accountIndex);
  }

  // ─── Host window lifecycle ────────────────────────────────────────────────

  /**
   * Lazily build the single host BrowserWindow that contains every account
   * view. Uses the same security webPreferences baseline as the per-account
   * windows (sandbox, contextIsolation, no nodeIntegration) so the
   * defense-in-depth posture is preserved.
   */
  private ensureHostWindow(): BrowserWindow {
    if (this.hostWindow && !this.hostWindow.isDestroyed()) {
      return this.hostWindow;
    }
    const defaults = getWindowDefaults();
    const window = new BrowserWindow({
      // Host webContents is intentionally minimal — it only hosts child
      // WebContentsViews. We still apply the standard hardening options on
      // its own webPreferences in case any third-party extension or future
      // code path touches it.
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        disableBlinkFeatures: 'Auxclick',
        backgroundThrottling: false,
      },
      icon: getIconCache().getIcon('resources/icons/normal/256.png'),
      show: false,
      paintWhenInitiallyHidden: false,
      minHeight: 570,
      minWidth: 480,
      center: true,
      title: 'GogChat',
      backgroundColor: '#E8EAED',
      autoHideMenuBar: defaults.hideMenuBar,
    });

    // Forward host window resize events to the active view so it tracks the
    // host content bounds. WebContentsView does not auto-resize.
    const onResize = (): void => {
      this.layoutVisibleView();
    };
    window.on('resize', onResize);
    window.on('enter-full-screen', onResize);
    window.on('leave-full-screen', onResize);
    this.resizeHandler = onResize;

    if (!this.isolated) {
      const recordActivity = (): void => {
        if (this.mostRecentAccountIndex !== null) {
          getAccountActivityTracker().recordActivity(this.mostRecentAccountIndex);
        }
      };
      window.on('focus', recordActivity);
      window.on('blur', recordActivity);
      window.on('show', recordActivity);
      window.on('hide', recordActivity);
      this.activityHandler = recordActivity;
    }

    window.on('closed', () => {
      // Host window closing tears down everything — destroyAll cleans up.
      this.destroyAll();
    });

    // Always attach ready-to-show so notification permission runs even when startHidden.
    window.once('ready-to-show', () => {
      if (!defaults.startHidden && !window.isDestroyed()) {
        window.show();
      }
      if (!this.isolated) {
        // Same first-run macOS notification UX as windowWrapper (BW path).
        ensureNotificationPermission({ parentWindow: window });
      }
    });

    this.hostWindow = window;
    // Layout listener is already registered. Restore, then watch, so a
    // bounds handler cannot run ahead of view layout or throw past it.
    applyAccountWindowState(window, asAccountIndex(0));
    watchAccountWindow(window, asAccountIndex(0));
    log.info('[AccountViewManager] Host window created');
    return window;
  }

  /**
   * Apply the active view's bounds to fill the host window's content area.
   * Inactive views are positioned off-screen via setBounds(0,0,0,0) when
   * hidden so they keep their webContents alive without painting.
   */
  private layoutVisibleView(): void {
    if (!this.hostWindow || this.hostWindow.isDestroyed()) return;
    const [width = 0, height = 0] = this.hostWindow.getContentSize();
    const fullBounds: Rectangle = { x: 0, y: 0, width, height };
    for (const entry of this.views.values()) {
      if (entry.resourceState === 'visible') {
        try {
          entry.view.setBounds(fullBounds);
        } catch {
          log.warn(
            `[AccountViewManager] setBounds(visible) failed for account ${entry.accountIndex}`
          );
        }
      } else {
        try {
          entry.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        } catch {
          // View may already be detached; ignore.
        }
      }
    }
  }

  // ─── View construction ────────────────────────────────────────────────────

  /**
   * Create a WebContentsView for `accountIndex` bound to its
   * `persist:account-N` partition, attach it to the host window, install the
   * permission/header handlers on its session, and load `url`. Returns the
   * host BrowserWindow (the contract's return type) — callers wanting the
   * view's webContents should use {@link getAccountWebContents}.
   */
  createAccountWindow(url: string, accountIndex: AccountIndex): BrowserWindow {
    if (!this.isolated) {
      this.startMaintenance();
    }
    const host = this.ensureHostWindow();
    const existing = this.views.get(accountIndex);
    if (existing) {
      // Already have a view for this account: navigate it and bring it to
      // the front. Mirrors the routeAccountWindow semantics in the
      // BrowserWindow path.
      this.switchToAccount(accountIndex);
      const currentUrl = existing.view.webContents.getURL();
      if (this.isBootstrap(accountIndex) && isGoogleAuthUrl(currentUrl)) {
        return host;
      }
      try {
        void existing.view.webContents.loadURL(url);
        existing.currentUrl = url;
      } catch {
        log.warn(
          `[AccountViewManager] loadURL on existing view failed for account ${accountIndex}`
        );
      }
      return host;
    }

    const partition = toPartition(accountIndex);
    const view = new WebContentsView({
      webPreferences: createAccountWebPreferences({ partition }),
    });

    host.contentView.addChildView(view);

    // Install per-session security handlers. They reach into
    // `webContents.session` which is the per-partition session, so each
    // account view gets the same protections as a per-account BrowserWindow.
    if (!this.isolated) {
      try {
        // permissionHandler / headerFix expect a BrowserWindow argument so they
        // can use its session and id for dialog ownership. They both only ever
        // touch `window.webContents.session`. We construct a minimal proxy
        // that forwards just `webContents` to keep the call sites unchanged.
        // NOTE: for view-based accounts the dialog parent will be the host
        // window if the helper opens any modal, which is the correct UX.
        const sessionCarrier = asUnsafe<BrowserWindow & { webContents: WebContents }>(
          view,
          'view webContents'
        );
        installPermissionHandlers(sessionCarrier);
        installHeaderFix(sessionCarrier);
      } catch {
        log.warn(
          `[AccountViewManager] Failed to install security handlers for account ${accountIndex}`
        );
      }
    }

    const entry: AccountViewEntry = {
      view,
      accountIndex,
      createdAt: Date.now(),
      currentUrl: url,
      resourceState: 'visible',
    };
    this.views.set(accountIndex, entry);
    this.webContentsToAccountIndex.set(asWebContentsId(view.webContents.id), accountIndex);

    this.applyResourceTransition({ visible: accountIndex });
    if (!this.isolated) {
      getAccountActivityTracker().recordActivity(accountIndex);
    }

    try {
      void view.webContents.loadURL(url);
    } catch {
      log.warn(`[AccountViewManager] Initial loadURL failed for account ${accountIndex}`);
    }

    log.info(
      `[AccountViewManager] Created view for account ${accountIndex} (partition=${partition})`
    );

    this.emitWebContentsCreated(accountIndex, view.webContents);

    return host;
  }

  /**
   * Single WCV resource-state transition.
   *
   * Updates visibility/`resourceState` then reapplies throttle on every child
   * view (never the host WebContents):
   * - account 0: always unthrottled
   * - visible secondary: unthrottled
   * - hidden-live and dehydrated-parked secondary: throttled
   *
   * Parked accounts stay parked unless they are the new visible target (hydrate).
   */
  private applyResourceTransition(options: {
    visible: AccountIndex | null;
    park?: AccountIndex;
  }): void {
    if (options.park !== undefined) {
      const parked = this.views.get(options.park);
      if (parked && parked.accountIndex !== options.visible) {
        parked.resourceState = 'dehydrated-parked';
      }
    }

    if (options.visible !== null) {
      for (const entry of this.views.values()) {
        if (entry.accountIndex === options.visible) {
          entry.resourceState = 'visible';
        } else if (entry.resourceState !== 'dehydrated-parked') {
          entry.resourceState = 'hidden-live';
        }
      }
      this.mostRecentAccountIndex = options.visible;
    } else {
      this.mostRecentAccountIndex = null;
    }

    for (const entry of this.views.values()) {
      const throttle = entry.accountIndex !== 0 && entry.resourceState !== 'visible';
      try {
        entry.view.webContents.setBackgroundThrottling(throttle);
      } catch {
        // webContents may be destroyed mid-transition
      }
    }
    this.layoutVisibleView();
  }

  /**
   * Show `accountIndex`'s view and hide every other view. O(N views) — N is
   * tiny in practice (one per signed-in account) so the linear scan is
   * preferred over keeping a sorted z-order list.
   */
  private switchToAccount(accountIndex: AccountIndex): void {
    const target = this.views.get(accountIndex);
    if (!target) return;
    this.applyResourceTransition({ visible: accountIndex });
    if (!this.isolated) {
      getAccountActivityTracker().recordActivity(accountIndex);
    }
    if (this.hostWindow && !this.hostWindow.isDestroyed()) {
      if (this.hostWindow.isMinimized()) this.hostWindow.restore();
      if (!this.hostWindow.isVisible()) this.hostWindow.show();
      this.hostWindow.focus();
    }
    try {
      target.view.webContents.focus();
    } catch {
      // webContents may be destroyed mid-switch
    }
  }

  /**
   * Switch the visible WebContentsView to `accountIndex` and focus the host.
   */
  focusAccount(accountIndex: AccountIndex): void {
    this.switchToAccount(accountIndex);
  }

  // ─── Registry contract ────────────────────────────────────────────────────

  registerWindow(_window: BrowserWindow, _accountIndex: AccountIndex): void {
    // No-op for the view-based manager: views are created via
    // createAccountWindow which performs the equivalent registration.
    // External callers that pre-create a BrowserWindow are not supported
    // when the WebContentsView path is enabled.
  }

  getAccountIndex(window: BrowserWindow): AccountIndex | null {
    if (this.hostWindow && window === this.hostWindow) {
      return this.mostRecentAccountIndex;
    }
    return null;
  }

  getAccountWindow(accountIndex: AccountIndex): BrowserWindow | null {
    if (!this.hostWindow || this.hostWindow.isDestroyed()) return null;
    if (!this.views.has(accountIndex)) return null;
    return this.hostWindow;
  }

  getAccountWebContents(accountIndex: AccountIndex): WebContents | null {
    const entry = this.views.get(accountIndex);
    return entry?.view.webContents ?? null;
  }

  getAccountForWebContents(webContentsId: WebContentsId): AccountIndex | null {
    const idx = this.webContentsToAccountIndex.get(webContentsId);
    return idx ?? null;
  }

  /**
   * Enumerate every live child view WebContents (not the host window).
   * Host-only sampling would miss per-account renderers under WCV backend.
   */
  enumerateAccountWebContents(): AccountWebContentsInfo[] {
    const result: AccountWebContentsInfo[] = [];
    for (const [accountIndex, entry] of this.views) {
      const wc = entry.view.webContents;
      if (!wc || wc.isDestroyed()) continue;
      let osProcessId: number;
      try {
        osProcessId = wc.getOSProcessId();
      } catch {
        osProcessId = 0;
      }
      result.push({
        accountIndex,
        webContentsId: asWebContentsId(wc.id),
        osProcessId,
        backend: 'web-contents-view',
        webContents: wc,
      });
    }
    return result;
  }

  getAllWindows(): BrowserWindow[] {
    if (!this.hostWindow || this.hostWindow.isDestroyed() || this.views.size === 0) {
      return [];
    }
    // Only one physical window exists — the host. Returning [host] keeps
    // consumers that loop over windows happy without inventing fake windows
    // per view.
    return [this.hostWindow];
  }

  getMostRecentWindow(): BrowserWindow | null {
    if (!this.hostWindow || this.hostWindow.isDestroyed()) return null;
    return this.hostWindow;
  }

  hasAccount(accountIndex: AccountIndex): boolean {
    return this.views.has(accountIndex);
  }

  listAccountIndices(): AccountIndex[] {
    return Array.from(this.views.keys()).sort((a, b) => Number(a) - Number(b));
  }

  /**
   * Frontmost account view only (`resourceState === 'visible'`).
   * Switched-away (hidden-live) and dehydrated-parked return false.
   */
  isAccountVisible(accountIndex: AccountIndex): boolean {
    const entry = this.views.get(accountIndex);
    return entry?.resourceState === 'visible';
  }

  unregisterAccount(accountIndex: AccountIndex): void {
    const entry = this.views.get(accountIndex);
    if (!entry) return;
    const wasVisible = entry.resourceState === 'visible';
    const wasRecent = this.mostRecentAccountIndex === accountIndex;
    this.emitWebContentsDestroyed(accountIndex);
    try {
      this.webContentsToAccountIndex.delete(asWebContentsId(entry.view.webContents.id));
    } catch {
      // webContents may already be destroyed; ignore.
    }
    this.views.delete(accountIndex);
    if (!this.isolated) {
      _clearBootstrap(accountIndex);
      notifyAccountRemoved(accountIndex);
    }
    if (this.hostWindow && !this.hostWindow.isDestroyed()) {
      try {
        this.hostWindow.contentView.removeChildView(entry.view);
      } catch {
        log.warn(`[AccountViewManager] removeChildView failed for account ${accountIndex}`);
      }
    }
    try {
      // WebContentsView does not expose a direct destroy(); destroying its
      // webContents releases the renderer process for that account.
      const wc = entry.view.webContents;
      if (!wc.isDestroyed()) {
        wc.close();
      }
    } catch {
      log.warn(`[AccountViewManager] Closing webContents failed for account ${accountIndex}`);
    }
    if (this.views.size === 0) {
      this.mostRecentAccountIndex = null;
      this.layoutVisibleView();
      log.info(`[AccountViewManager] Unregistered account ${accountIndex}`);
      return;
    }
    if (wasVisible || wasRecent) {
      const fallback = this.pickVisibleFallback(accountIndex);
      if (fallback !== null) {
        this.applyResourceTransition({ visible: fallback });
      } else {
        this.mostRecentAccountIndex = null;
        this.layoutVisibleView();
      }
    } else {
      this.applyResourceTransition({ visible: this.mostRecentAccountIndex });
    }
    log.info(`[AccountViewManager] Unregistered account ${accountIndex}`);
  }

  getAccountCount(): number {
    return this.views.size;
  }

  destroyAll(): void {
    if (!this.isolated) {
      stopSessionMaintenance(this);
    }
    this.maintenanceStarted = false;
    for (const accountIndex of Array.from(this.views.keys())) {
      this.unregisterAccount(accountIndex);
    }
    if (this.hostWindow) {
      unwatchAccountWindow(this.hostWindow);
    }
    if (this.hostWindow && !this.hostWindow.isDestroyed()) {
      if (this.resizeHandler) {
        this.hostWindow.removeListener('resize', this.resizeHandler);
        this.hostWindow.removeListener('enter-full-screen', this.resizeHandler);
        this.hostWindow.removeListener('leave-full-screen', this.resizeHandler);
      }
      if (this.activityHandler) {
        this.hostWindow.removeListener('focus', this.activityHandler);
        this.hostWindow.removeListener('blur', this.activityHandler);
        this.hostWindow.removeListener('show', this.activityHandler);
        this.hostWindow.removeListener('hide', this.activityHandler);
      }
      this.hostWindow.destroy();
    }
    this.hostWindow = null;
    this.resizeHandler = null;
    this.activityHandler = null;
    this.mostRecentAccountIndex = null;
    if (!this.isolated) {
      clearAllBootstrap();
    }
    logger.window.info('[AccountViewManager] Destroyed all views and host window');
  }

  // ─── Bootstrap delegates ──────────────────────────────────────────────────

  markAsBootstrap(accountIndex: AccountIndex): void {
    if (!this.views.has(accountIndex)) {
      log.warn(
        `[AccountViewManager] markAsBootstrap: account ${accountIndex} not registered — ignored`
      );
      return;
    }
    if (this.isolated) {
      this.isolatedBootstrap.add(accountIndex);
      return;
    }
    _markAsBootstrap(accountIndex);
  }

  isBootstrap = (accountIndex: AccountIndex): boolean =>
    this.isolated
      ? this.isolatedBootstrap.has(accountIndex)
      : bootstrapDelegates.isBootstrap(accountIndex);

  promoteBootstrap = (accountIndex: AccountIndex): boolean => {
    if (this.isolated) {
      return this.isolatedBootstrap.delete(accountIndex);
    }
    return bootstrapDelegates.promoteBootstrap(accountIndex);
  };

  clearBootstrap = (accountIndex: AccountIndex): void => {
    if (this.isolated) {
      this.isolatedBootstrap.delete(accountIndex);
      return;
    }
    bootstrapDelegates.clearBootstrap(accountIndex);
  };

  getBootstrapAccounts = (): AccountIndex[] =>
    this.isolated ? [...this.isolatedBootstrap] : [...bootstrapDelegates.getBootstrapAccounts()];

  // ─── Per-account window state ─────────────────────────────────────────────

  /**
   * In the view-based path, account-specific bounds collapse to the host
   * window's bounds (only one window exists). We persist host-window state
   * under account-0 so {@link windowState} continues to work without
   * branching. Other account indices are intentional no-ops.
   */
  saveAccountWindowState(accountIndex: AccountIndex): void {
    if (accountIndex !== 0) return;
    if (!this.hostWindow || this.hostWindow.isDestroyed()) return;
    const captured = readNormalBounds(this.hostWindow);
    if (!captured) return;
    submitAccountWindowState(asAccountIndex(0), captured);
  }

  getAccountWindowState(accountIndex: AccountIndex): AccountWindowState | null {
    return readAccountWindowState(accountIndex);
  }

  // ─── Hydration (park / unpark; not create/destroy) ───────────────────────

  /**
   * Resource-park a non-primary account: mark dehydrated-parked, throttle
   * renderer, off-screen bounds. Does **not** destroy the view or session.
   * Works from visible or hidden-live; no-op if already parked.
   */
  dehydrateAccount(accountIndex: AccountIndex): void {
    const entry = this.views.get(accountIndex);
    if (!entry) return;
    if (this.isBootstrap(accountIndex)) return;
    if (accountIndex === 0) return; // never dehydrate primary account
    if (entry.resourceState === 'dehydrated-parked') return;

    const wasVisible = entry.resourceState === 'visible';
    if (wasVisible) {
      const fallback = this.pickVisibleFallback(accountIndex);
      // Never leave the host with zero visible accounts when parking the frontmost.
      if (fallback === null) {
        return;
      }
      this.applyResourceTransition({ park: accountIndex, visible: fallback });
      this.switchToAccount(fallback);
      log.info(
        `[AccountViewManager] Dehydrated (parked) account ${accountIndex}; promoted ${fallback}`
      );
      return;
    }

    this.applyResourceTransition({
      park: accountIndex,
      visible: this.mostRecentAccountIndex,
    });
    log.info(`[AccountViewManager] Dehydrated (parked) account ${accountIndex}`);
  }

  /**
   * Prefer account-0, else the lowest live non-parked index, excluding `exclude`.
   */
  private pickVisibleFallback(exclude: AccountIndex): AccountIndex | null {
    const zero = this.views.get(asAccountIndex(0));
    if (exclude !== 0 && zero && zero.resourceState !== 'dehydrated-parked') {
      return asAccountIndex(0);
    }
    const candidates = Array.from(this.views.keys()).sort((a, b) => Number(a) - Number(b));
    for (const idx of candidates) {
      if (idx === exclude) continue;
      const e = this.views.get(idx);
      if (e && e.resourceState !== 'dehydrated-parked') {
        return idx;
      }
    }
    return null;
  }

  /**
   * Bring a parked (or non-front) account to the front via switchToAccount.
   * For unknown accounts, returns null — matching the BrowserWindow manager.
   * Unthrottle is owned by {@link switchToAccount} (visible ⇒ unthrottled).
   */
  hydrateAccount(accountIndex: AccountIndex): BrowserWindow | null {
    const entry = this.views.get(accountIndex);
    if (!entry) return null;
    if (entry.resourceState !== 'visible') {
      this.switchToAccount(accountIndex);
      log.info(`[AccountViewManager] Hydrated (shown) account ${accountIndex}`);
    }
    return this.hostWindow;
  }

  /**
   * True only for resource-parked accounts — not for switched-away hidden-live.
   */
  isDehydrated(accountIndex: AccountIndex): boolean {
    const entry = this.views.get(accountIndex);
    if (!entry) return false;
    return entry.resourceState === 'dehydrated-parked';
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let accountViewManager: AccountViewManager | null = null;

export function getAccountViewManager(factory?: WindowFactory): AccountViewManager {
  if (!accountViewManager) {
    accountViewManager = new AccountViewManager(factory);
  }
  return accountViewManager;
}

export function destroyAccountViewManager(): void {
  if (accountViewManager) {
    accountViewManager.destroyAll();
    accountViewManager = null;
    log.info('[AccountViewManager] Manager destroyed');
  }
}

/**
 * Clear the module singleton without calling destroyAll.
 * Used by {@link destroyAccountWindowManager} after it has already destroyed
 * the shared instance (WCV is stored in both singletons — avoid double destroy).
 */
export function resetAccountViewManagerSingleton(): void {
  accountViewManager = null;
}

if (process.env['TESTING'] === 'true') {
  const testGlobal = asType<
    typeof globalThis & {
      __gogchatCreateAccountViewManager?: (factory?: WindowFactory) => AccountViewManager;
    }
  >(globalThis);
  testGlobal.__gogchatCreateAccountViewManager = (factory?: WindowFactory) =>
    new AccountViewManager(factory, { isolated: true });
}

// Re-export the factory parameter type for clarity at the call site even
// though it is unused by the WebContentsView path. Keeps the signature
// symmetric with getAccountWindowManager.
export type { WindowFactory };
