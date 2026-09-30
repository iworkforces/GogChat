/**
 * Account Window Manager - Multi-account session management (Facade)
 *
 * Public API facade for per-account BrowserWindow management.
 * Delegates window registry operations to {@link AccountWindowRegistry}
 * and window creation/routing to {@link routeAccountWindow}.
 *
 * All consumers import from this module — internal structure is transparent.
 *
 * @module accountWindowManager
 */

import type { BrowserWindow } from 'electron';
import log from 'electron-log';
import { configGet } from '../../config.js';
import type {
  AccountManagerOptions,
  AccountWebContentsInfo,
  AccountWindowState,
  WindowFactory,
  IAccountWindowManager,
} from '../../../shared/types/window.js';
import type { AccountIndex, WebContentsId } from '../../../shared/types/branded.js';
import { asWebContentsId, toPartition } from '../../../shared/types/branded.js';
import { asType } from '../../../shared/typeUtils.js';
import { markAsBootstrap as _markAsBootstrap, clearAllBootstrap } from './bootstrapTracker.js';
import { bootstrapDelegates } from './accountLifecycleHelpers.js';
import { AccountWindowRegistry } from './accountWindowRegistry.js';
import { routeAccountWindow, type HydrationHook } from './accountRouter.js';
import {
  getAccountActivityTracker,
  startSessionMaintenance,
  stopSessionMaintenance,
} from './accountSessionMaintenance.js';
import {
  buildAccountWindowState,
  persistAccountWindowState,
  flushAccountWindowsWrites as _flushAccountWindowsWrites,
  readAccountWindowState as _getAccountWindowState,
} from './accountWindowsStore.js';
import { createTrackedTimeout } from '../lifecycle/resourceCleanup.js';
import { getAccountViewManager, resetAccountViewManagerSingleton } from './accountViewManager.js';
import {
  notifyAccountWebContentsCreated,
  notifyAccountWebContentsDestroyed,
  notifyAccountRemoved,
  setAccountWebContentsHooksManager,
} from './accountWebContentsHooks.js';

/**
 * Idle threshold after which a blurred or hidden non-primary
 * account window is dehydrated — the BrowserWindow is destroyed while its
 * `persist:account-N` partition (cookies/localStorage/IDB) survives.
 * Account-0 is permanently exempt to keep badges/notifications alive.
 * Independent of T11's 30-minute session-maintenance threshold.
 */
const DEFAULT_DEHYDRATE_THRESHOLD_MS = 90 * 1000; // 90 seconds

/**
 * Per-account state captured immediately before {@link AccountWindowManager.dehydrateAccount}
 * destroys the BrowserWindow. Used to recreate an equivalent window in
 * {@link AccountWindowManager.hydrateAccount}.
 */
interface DehydratedSnapshot {
  url: string;
  bounds: { x: number; y: number; width: number; height: number };
  isMaximized: boolean;
}

/**
 * Re-export of the shared write-queue flusher so existing tests and
 * callers continue to import it from this module.
 */
export const flushAccountWindowsWrites = _flushAccountWindowsWrites;

/**
 * Account Window Manager - Manages per-account BrowserWindow instances
 *
 * Facade that delegates to:
 * - {@link AccountWindowRegistry} for window registration/lookup/lifecycle
 * - {@link routeAccountWindow} for window creation routing
 */
export class AccountWindowManager implements IAccountWindowManager {
  private readonly registry: AccountWindowRegistry;
  private maintenanceStarted = false;
  /**
   * Per-window activity listener handles, kept so we can detach on
   * re-registration (different accountIndex) and on unregister/destroy.
   * Without this, repeated `registerWindow` calls would leak listeners.
   */
  private readonly activityListeners = new Map<
    BrowserWindow,
    {
      record: () => void;
      onClosed: () => void;
      onIdleStart: () => void;
      onIdleCancel: () => void;
      onFocusThrottle: () => void;
      onBlurThrottle: () => void;
    }
  >();
  /**
   * T12/M3 — Sidecar map of accounts whose BrowserWindow has been destroyed
   * to free webContents memory. Entries persist URL/bounds/maximized so
   * {@link hydrateAccount} can recreate an equivalent window against the
   * same `persist:account-N` partition. The partition itself is owned by
   * Electron's session subsystem, NOT this map, so cookies/localStorage/IDB
   * survive even though the entry only stores presentation state.
   */
  private readonly dehydratedAccounts = new Map<AccountIndex, DehydratedSnapshot>();
  /**
   * T12/M3 — Pending dehydration timers per account. A timer is started by
   * blur/hide and cancelled by focus/show, hydrate, register, and destroy.
   * Tracked via {@link createTrackedTimeout} so app shutdown clears them.
   */
  private readonly dehydrateTimers = new Map<AccountIndex, NodeJS.Timeout>();
  /**
   * Effective dehydration threshold (ms). Resolved once at
   * construction time from `configGet('memory').dehydrationThresholdMs`,
   * with validation (60000–600000) and a 90s fallback. Read-only because
   * pending {@link createTrackedTimeout} timers cannot be retargeted; a
   * value change requires an app restart.
   */
  private readonly dehydrateThresholdMs: number;
  private readonly isolated: boolean;
  private readonly isolatedBootstrap = new Set<AccountIndex>();
  private readonly windowFactory?: WindowFactory;

  constructor(windowFactory?: WindowFactory, options?: AccountManagerOptions) {
    if (windowFactory !== undefined) {
      this.windowFactory = windowFactory;
    }
    this.isolated = options?.isolated === true;
    this.registry = new AccountWindowRegistry({
      preserveBootstrap: this.isolated,
      onAccountClosed: (accountIndex) => {
        this.emitWebContentsDestroyed(accountIndex);
        this.cancelDehydrate(accountIndex);
        this.emitAccountRemoved(accountIndex);
      },
    });
    if (!this.isolated) {
      // Reset shared bootstrap tracker so each manager instance starts clean
      clearAllBootstrap();
      this.startMaintenance();
    }
    // Read dehydration threshold from config, fall back to 90s default.
    // Validate range (60s–600s) to guard against typos in the hidden pref.
    const configured = configGet('memory')?.dehydrationThresholdMs;
    if (typeof configured === 'number' && configured >= 60000 && configured <= 600000) {
      this.dehydrateThresholdMs = configured;
    } else {
      this.dehydrateThresholdMs = DEFAULT_DEHYDRATE_THRESHOLD_MS;
    }
  }

  /**
   * Start the periodic session maintenance scheduler. Idempotent — safe to
   * call from the constructor and again from explicit init paths.
   */
  private startMaintenance(): void {
    if (this.isolated || this.maintenanceStarted) {
      return;
    }
    startSessionMaintenance(getAccountActivityTracker(), this);
    this.maintenanceStarted = true;
  }

  private emitWebContentsCreated(
    accountIndex: AccountIndex,
    webContents: Electron.WebContents
  ): void {
    if (this.isolated) {
      return;
    }
    notifyAccountWebContentsCreated({
      accountIndex,
      webContents,
      backend: 'browser-window',
    });
  }

  private emitWebContentsDestroyed(accountIndex: AccountIndex): void {
    if (this.isolated) {
      return;
    }
    notifyAccountWebContentsDestroyed(accountIndex);
  }

  private emitAccountRemoved(accountIndex: AccountIndex): void {
    if (!this.isolated) {
      notifyAccountRemoved(accountIndex);
    }
  }

  // ─── Registry delegates ──────────────────────────────────────────────────

  registerWindow(window: BrowserWindow, accountIndex: AccountIndex): void {
    this.detachActivityListeners(window);
    this.registry.registerWindow(window, accountIndex);
    if (!this.isolated) {
      this.attachActivityListeners(window, accountIndex);
    }
  }

  /**
   * Wire focus/blur/show/hide BrowserWindow events to the activity tracker.
   * The registry already tracks focus/show for most-recent-window purposes; we
   * additionally record blur/hide so that any user interaction with the
   * window — gaining or losing OS focus — counts as recent activity.
   */
  private attachActivityListeners(window: BrowserWindow, accountIndex: AccountIndex): void {
    const tracker = getAccountActivityTracker();
    // Stamp activity immediately on registration so the window is not
    // immediately considered idle.
    tracker.recordActivity(accountIndex);
    const record = (): void => {
      tracker.recordActivity(accountIndex);
    };
    const onClosed = (): void => {
      this.detachActivityListeners(window);
    };
    // T12/M3 — idle dehydration timer. Bootstrap accounts are excluded:
    // dehydrating mid-auth would destroy the in-flight Google sign-in flow.
    const onIdleStart = (): void => {
      if (this.isBootstrap(accountIndex)) {
        return;
      }
      this.scheduleDehydrate(accountIndex);
    };
    const onIdleCancel = (): void => {
      this.cancelDehydrate(accountIndex);
    };
    // Toggle Chromium background throttling per focus state.
    // Account-0 stays unthrottled to preserve badge/notification reliability;
    // accounts 1+ throttle when blurred (5–15% renderer CPU savings) and
    // unthrottle when focused for snappy interaction.
    const applyThrottle = (focused: boolean): void => {
      if (window.isDestroyed()) return;
      if (accountIndex === 0) {
        window.webContents.setBackgroundThrottling(false);
        return;
      }
      window.webContents.setBackgroundThrottling(!focused);
    };
    const onFocusThrottle = (): void => {
      applyThrottle(true);
    };
    const onBlurThrottle = (): void => {
      applyThrottle(false);
    };
    // Establish initial throttling state synchronously: a freshly registered
    // window has not yet emitted focus/blur, so default to the throttled
    // (background) state for accounts 1+ until the user focuses it.
    applyThrottle(false);
    window.on('focus', record);
    window.on('blur', record);
    window.on('show', record);
    window.on('hide', record);
    window.on('blur', onIdleStart);
    window.on('hide', onIdleStart);
    window.on('focus', onIdleCancel);
    window.on('show', onIdleCancel);
    window.on('focus', onFocusThrottle);
    window.on('blur', onBlurThrottle);
    window.once('closed', onClosed);
    this.activityListeners.set(window, {
      record,
      onClosed,
      onIdleStart,
      onIdleCancel,
      onFocusThrottle,
      onBlurThrottle,
    });
  }

  private detachActivityListeners(window: BrowserWindow): void {
    const handle = this.activityListeners.get(window);
    if (!handle) {
      return;
    }
    if (!window.isDestroyed()) {
      window.removeListener('focus', handle.record);
      window.removeListener('blur', handle.record);
      window.removeListener('show', handle.record);
      window.removeListener('hide', handle.record);
      window.removeListener('blur', handle.onIdleStart);
      window.removeListener('hide', handle.onIdleStart);
      window.removeListener('focus', handle.onIdleCancel);
      window.removeListener('show', handle.onIdleCancel);
      window.removeListener('focus', handle.onFocusThrottle);
      window.removeListener('blur', handle.onBlurThrottle);
      window.removeListener('closed', handle.onClosed);
    }
    this.activityListeners.delete(window);
  }

  getAccountIndex(window: BrowserWindow): AccountIndex | null {
    return this.registry.getAccountIndex(window);
  }

  getAccountWindow(accountIndex: AccountIndex): BrowserWindow | null {
    // T12/M3 — a dehydrated account has no live BrowserWindow. Callers must
    // use {@link hydrateAccount} (or routeAccountWindow's hydration hook) to
    // bring the window back. Returning the registry value here would expose a
    // destroyed window, since `dehydrateAccount` calls `window.destroy()`.
    if (this.dehydratedAccounts.has(accountIndex)) {
      return null;
    }
    return this.registry.getAccountWindow(accountIndex);
  }

  getAccountWebContents(accountIndex: AccountIndex): Electron.WebContents | null {
    return this.registry.getAccountWebContents(accountIndex);
  }

  getAccountForWebContents(webContentsId: WebContentsId): AccountIndex | null {
    return this.registry.getAccountForWebContents(webContentsId);
  }

  /**
   * Show and focus the BrowserWindow for `accountIndex` (hydrate if dehydrated).
   */
  focusAccount(accountIndex: AccountIndex): void {
    let window = this.getAccountWindow(accountIndex);
    if (!window || window.isDestroyed()) {
      try {
        window = this.hydrateAccount(accountIndex);
      } catch (error: unknown) {
        log.warn(`[AccountWindowManager] focusAccount hydrate failed for ${accountIndex}:`, error);
        return;
      }
    }
    if (!window || window.isDestroyed()) {
      return;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  }

  /**
   * Enumerate each live account window's WebContents (BrowserWindow backend).
   * Skips dehydrated and destroyed windows.
   */
  enumerateAccountWebContents(): AccountWebContentsInfo[] {
    const result: AccountWebContentsInfo[] = [];
    for (const window of this.registry.getAllWindows()) {
      if (window.isDestroyed()) continue;
      const wc = window.webContents;
      if (wc.isDestroyed()) continue;
      const accountIndex = this.registry.getAccountIndex(window);
      if (accountIndex === null) continue;
      if (this.dehydratedAccounts.has(accountIndex)) continue;
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
        backend: 'browser-window',
        webContents: wc,
      });
    }
    return result;
  }

  getAllWindows(): BrowserWindow[] {
    return this.registry.getAllWindows();
  }

  getMostRecentWindow(): BrowserWindow | null {
    return this.registry.getMostRecentWindow();
  }

  unregisterAccount(accountIndex: AccountIndex): void {
    const wasKnown = this.hasAccount(accountIndex);
    this.emitWebContentsDestroyed(accountIndex);
    const window = this.registry.getAccountWindow(accountIndex);
    if (window) {
      this.detachActivityListeners(window);
    }
    this.cancelDehydrate(accountIndex);
    this.dehydratedAccounts.delete(accountIndex);
    this.registry.unregisterAccount(accountIndex);
    if (wasKnown) {
      this.emitAccountRemoved(accountIndex);
    }
  }

  hasAccount(accountIndex: AccountIndex): boolean {
    // Dehydrated-parked accounts remain known (matches listAccountIndices / WCV).
    return this.registry.hasAccount(accountIndex) || this.dehydratedAccounts.has(accountIndex);
  }

  /**
   * Live registry indices plus dehydrated-parked indices, sorted ascending.
   */
  listAccountIndices(): AccountIndex[] {
    const indices = new Set<AccountIndex>(this.registry.listAccountIndices());
    for (const accountIndex of this.dehydratedAccounts.keys()) {
      indices.add(accountIndex);
    }
    return Array.from(indices).sort((a, b) => Number(a) - Number(b));
  }

  isAccountVisible(accountIndex: AccountIndex): boolean {
    if (this.dehydratedAccounts.has(accountIndex)) {
      return false;
    }
    const window = this.registry.getAccountWindow(accountIndex);
    if (!window || window.isDestroyed()) {
      return false;
    }
    return window.isVisible();
  }

  getAccountCount(): number {
    return this.registry.getAccountCount();
  }

  destroyAll(): void {
    if (!this.isolated) {
      stopSessionMaintenance(this);
    }
    this.maintenanceStarted = false;
    // Dispose multi-account WC hooks before tearing down windows (KD13 symmetry).
    for (const accountIndex of this.listAccountIndices()) {
      this.emitWebContentsDestroyed(accountIndex);
      this.emitAccountRemoved(accountIndex);
    }
    for (const accountIndex of this.dehydrateTimers.keys()) {
      this.cancelDehydrate(accountIndex);
    }
    this.dehydrateTimers.clear();
    this.dehydratedAccounts.clear();
    for (const window of this.activityListeners.keys()) {
      this.detachActivityListeners(window);
    }
    this.activityListeners.clear();
    this.registry.destroyAll();
  }

  // ─── Router delegate ─────────────────────────────────────────────────────

  // ─── Router delegate ──────────────────────────────────────────────────

  createAccountWindow(url: string, accountIndex: AccountIndex): BrowserWindow {
    // Pass our own dehydrate/hydrate hooks so the router transparently
    // rehydrates a dehydrated account before navigating (T12/M3).
    const hydrationHook: HydrationHook = {
      isDehydrated: (i) => this.isDehydrated(i),
      hydrate: (i) => this.hydrateAccount(i),
    };
    return routeAccountWindow(
      this.registry,
      this.windowFactory,
      url,
      accountIndex,
      hydrationHook,
      (created, createdIndex) => {
        this.registerNewlyCreatedWindow(created, createdIndex);
      }
    );
  }

  /**
   * Factory-created windows only. Register, attach activity/throttle listeners,
   * and emit exactly one WebContents-created notification. On failure, detach
   * partial state so the router can destroy the window.
   */
  private registerNewlyCreatedWindow(window: BrowserWindow, accountIndex: AccountIndex): void {
    try {
      this.registerWindow(window, accountIndex);
      if (
        window &&
        !window.isDestroyed() &&
        window.webContents &&
        !window.webContents.isDestroyed()
      ) {
        this.emitWebContentsCreated(accountIndex, window.webContents);
      }
    } catch (error: unknown) {
      this.detachActivityListeners(window);
      this.cancelDehydrate(accountIndex);
      if (this.registry.getAccountWindow(accountIndex) === window) {
        this.registry.unregisterAccount(accountIndex);
      }
      this.emitWebContentsDestroyed(accountIndex);
      throw error;
    }
  }

  // ─── Bootstrap window tracking ───────────────────────────────────────────

  markAsBootstrap(accountIndex: AccountIndex): void {
    if (!this.registry.hasAccount(accountIndex)) {
      log.warn(
        `[AccountWindowManager] markAsBootstrap: account ${accountIndex} not registered — ignored`
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

  // ─── Window state persistence ────────────────────────────────────────────

  saveAccountWindowState(accountIndex: AccountIndex): void {
    const window = this.getAccountWindow(accountIndex);
    if (!window || window.isDestroyed()) {
      return;
    }

    void persistAccountWindowState(accountIndex, buildAccountWindowState(window));
    log.debug(`[AccountWindowManager] Saved state for account ${accountIndex}`);
  }

  getAccountWindowState(accountIndex: AccountIndex): AccountWindowState | null {
    return _getAccountWindowState(accountIndex);
  }

  // ─── T12/M3 — Hydrate / Dehydrate ──────────────────────────────────────────

  isDehydrated(accountIndex: AccountIndex): boolean {
    return this.dehydratedAccounts.has(accountIndex);
  }

  /**
   * Destroy the BrowserWindow for an account, persisting URL/bounds/maximized
   * so {@link hydrateAccount} can recreate an equivalent window against the
   * same `persist:account-N` partition. The session partition itself is owned
   * by Electron and survives — cookies, localStorage, and IndexedDB are
   * preserved. Bootstrap accounts and unknown indices are no-ops to keep
   * mid-auth Google sign-in flows intact.
   */
  dehydrateAccount(accountIndex: AccountIndex): void {
    if (this.dehydratedAccounts.has(accountIndex)) {
      return;
    }
    if (this.isBootstrap(accountIndex)) {
      log.debug(
        `[AccountWindowManager] dehydrateAccount: skipped bootstrap account ${accountIndex}`
      );
      return;
    }
    const window = this.registry.getAccountWindow(accountIndex);
    if (!window || window.isDestroyed()) {
      return;
    }
    // Capture state BEFORE destroying — once destroyed, webContents/getURL
    // become unreliable.
    const bounds = window.getBounds();
    const snapshot: DehydratedSnapshot = {
      url: window.webContents.getURL(),
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      isMaximized: window.isMaximized(),
    };
    this.dehydratedAccounts.set(accountIndex, snapshot);
    this.cancelDehydrate(accountIndex);
    // Detach our listeners first so the closed handler does not race with the
    // explicit cleanup we are about to perform.
    this.detachActivityListeners(window);
    // Tear down per-account feature handlers (externalLinks, etc.) before destroy;
    // hydrate will re-notify create for the new WebContents.
    this.emitWebContentsDestroyed(accountIndex);
    this.registry.unregisterAccount(accountIndex);
    log.info(`[AccountWindowManager] Dehydrating account ${accountIndex} (url=${snapshot.url})`);
    window.destroy();
  }

  /**
   * Recreate a dehydrated account window against its original
   * `persist:account-N` partition and restore bounds/maximized state. Returns
   * the existing window when the account is already alive. Returns `null`
   * when the account is unknown to both the registry and the dehydration
   * sidecar. Throws when hydration is required but no {@link WindowFactory}
   * is configured — we cannot create a partitioned window without one.
   */
  hydrateAccount(accountIndex: AccountIndex): BrowserWindow | null {
    const snapshot = this.dehydratedAccounts.get(accountIndex);
    if (!snapshot) {
      // Already hydrated — return the live window if any.
      return this.registry.getAccountWindow(accountIndex);
    }
    if (!this.windowFactory) {
      throw new Error(
        `[AccountWindowManager] hydrateAccount(${accountIndex}): no WindowFactory configured — cannot recreate window`
      );
    }
    const partition = toPartition(accountIndex);
    const window = this.windowFactory.createWindow(snapshot.url, partition);
    // Clear sidecar BEFORE registering so getAccountWindow (which checks the
    // sidecar) returns the new window during downstream `registerWindow`
    // observers. Restored on any post-create failure so the account stays parked.
    this.dehydratedAccounts.delete(accountIndex);
    try {
      this.registerWindow(window, accountIndex);
      // Restore presentation state. setBounds first, then maximize, so that the
      // pre-maximize bounds are remembered for later unmaximize.
      window.setBounds(snapshot.bounds);
      if (snapshot.isMaximized) {
        window.maximize();
      }
      // Navigation is owned solely by the factory (windowWrapper calls loadURL
      // on create). A second loadURL here would double-navigate restored accounts.
      // Snapshot URL is factory input only — do not re-dispatch navigation.
      // Callers that need a *requested* URL apply it after hydrate (router).
      if (window.webContents && !window.webContents.isDestroyed()) {
        this.emitWebContentsCreated(accountIndex, window.webContents);
      }
    } catch (error: unknown) {
      this.detachActivityListeners(window);
      if (this.registry.getAccountWindow(accountIndex) === window) {
        this.registry.unregisterAccount(accountIndex);
      }
      this.emitWebContentsDestroyed(accountIndex);
      if (!window.isDestroyed()) {
        window.destroy();
      }
      this.dehydratedAccounts.set(accountIndex, snapshot);
      throw error;
    }
    log.info(
      `[AccountWindowManager] Hydrated account ${accountIndex} (partition=${partition}, url=${snapshot.url})`
    );
    return window;
  }

  /**
   * Schedule a dehydration after {@link AccountWindowManager#dehydrateThresholdMs}. Idempotent:
   * a pending timer for the same account is left in place so the original
   * blur/hide moment continues to drive the deadline (resetting on every
   * blur/hide would let frequent re-blurs delay dehydration indefinitely).
   */
  private scheduleDehydrate(accountIndex: AccountIndex): void {
    // Never dehydrate account-0 (keeps notifications/badges alive).
    // Bootstrap accounts are already guarded in attachActivityListeners.onIdleStart.
    if (accountIndex === 0) {
      return;
    }
    if (this.dehydrateTimers.has(accountIndex)) {
      return;
    }
    if (this.dehydratedAccounts.has(accountIndex)) {
      return;
    }
    const timer = createTrackedTimeout(
      () => {
        this.dehydrateTimers.delete(accountIndex);
        this.dehydrateAccount(accountIndex);
      },
      this.dehydrateThresholdMs,
      `dehydrate-account-${accountIndex}`
    );
    this.dehydrateTimers.set(accountIndex, timer);
  }

  private cancelDehydrate(accountIndex: AccountIndex): void {
    const timer = this.dehydrateTimers.get(accountIndex);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.dehydrateTimers.delete(accountIndex);
  }
}

// Singleton instance — typed as the abstract interface so the BrowserWindow
// path and the WebContentsView path are interchangeable behind the same
// module-level helpers. Selection happens once on first access via the
// `app.useWebContentsView` config flag.

let accountManagerSingleton: IAccountWindowManager | null = null;

/**
 * Get the global account window manager instance.
 *
 * Reads `app.useWebContentsView` from the config store (when initialized)
 * to decide whether to construct the legacy {@link AccountWindowManager}
 * (BrowserWindow per account) or the experimental WebContentsView-backed
 * manager. Both satisfy {@link IAccountWindowManager}, so all consumers are
 * agnostic to the choice.
 */
/**
 * Return the live singleton without constructing one. Shutdown diagnostics
 * must use this after accounts are torn down — {@link getAccountWindowManager}
 * would recreate an empty manager.
 */
export function peekAccountWindowManager(): IAccountWindowManager | null {
  return accountManagerSingleton;
}

export function getAccountWindowManager(factory?: WindowFactory): IAccountWindowManager {
  if (!accountManagerSingleton) {
    let useViews = false;
    try {
      const appCfg = configGet('app');
      useViews = appCfg?.useWebContentsView === true;
    } catch {
      // Store not yet initialized — leave default (false).
    }
    const next: IAccountWindowManager = useViews
      ? getAccountViewManager(factory)
      : new AccountWindowManager(factory);
    if (useViews) {
      log.info(
        '[AccountWindowManager] Using WebContentsView backend (app.useWebContentsView=true)'
      );
    }
    accountManagerSingleton = next;
    setAccountWebContentsHooksManager(next);
    return next;
  }
  return accountManagerSingleton;
}

/**
 * Destroy the account window manager singleton (whichever backend is active).
 *
 * KD15: destroyAll runs at most once. When WebContentsView is active, the same
 * instance lives in this facade singleton and the accountViewManager module
 * singleton — after destroyAll, only null the view singleton (no second destroyAll).
 */
export function destroyAccountWindowManager(): void {
  if (accountManagerSingleton) {
    accountManagerSingleton.destroyAll();
    accountManagerSingleton = null;
    log.info('[AccountWindowManager] Manager destroyed');
  }
  setAccountWebContentsHooksManager(null);
  // Clear WCV module pointer whether or not it was the active facade instance.
  resetAccountViewManagerSingleton();
}

/**
 * Convenience function: Get the most recently created account window.
 * Routes to whichever backend is active.
 */
export function getMostRecentWindow(): BrowserWindow | null {
  if (!accountManagerSingleton) return null;
  return accountManagerSingleton.getMostRecentWindow();
}

/**
 * Convenience function: Get the BrowserWindow for a specific account index.
 * For the WebContentsView backend, this returns the SHARED host window when
 * the account's view exists.
 */
export function getWindowForAccount(accountIndex: AccountIndex): BrowserWindow | null {
  if (!accountManagerSingleton) return null;
  return accountManagerSingleton.getAccountWindow(accountIndex);
}

export function getAccountIndex(window: BrowserWindow): AccountIndex | null {
  if (!accountManagerSingleton) return null;
  return accountManagerSingleton.getAccountIndex(window);
}

/**
 * Convenience function: Create a new account window with isolated session partition
 * Shorthand for getAccountWindowManager().createAccountWindow(url, accountIndex)
 */
export function createAccountWindow(url: string, accountIndex: AccountIndex): BrowserWindow {
  return getAccountWindowManager().createAccountWindow(url, accountIndex);
}

export function getAccountForWebContents(webContentsId: WebContentsId): AccountIndex | null {
  if (!accountManagerSingleton) return null;
  return accountManagerSingleton.getAccountForWebContents(webContentsId);
}

if (process.env['TESTING'] === 'true') {
  const testGlobal = asType<
    typeof globalThis & {
      __gogchatGetAccountWindowManager?: typeof getAccountWindowManager;
      __gogchatPeekAccountWindowManager?: typeof peekAccountWindowManager;
      __gogchatCreateAccountWindowManager?: (factory?: WindowFactory) => IAccountWindowManager;
    }
  >(globalThis);
  testGlobal.__gogchatGetAccountWindowManager = getAccountWindowManager;
  testGlobal.__gogchatPeekAccountWindowManager = peekAccountWindowManager;
  testGlobal.__gogchatCreateAccountWindowManager = (factory?: WindowFactory) =>
    new AccountWindowManager(factory, { isolated: true });
}
