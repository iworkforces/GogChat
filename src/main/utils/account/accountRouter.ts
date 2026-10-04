/**
 * Account Router - Window creation and routing logic
 *
 * Decides whether to create a new window, reuse an existing one,
 * or skip navigation for a bootstrap window mid-auth-flow.
 *
 * @module accountRouter
 */

import type { BrowserWindow } from 'electron';
import { isGoogleAuthUrl } from '../../../shared/urlValidators.js';
import type { WindowFactory } from '../../../shared/types/window.js';
import type { AccountIndex } from '../../../shared/types/branded.js';
import { toPartition } from '../../../shared/types/branded.js';
import log from 'electron-log';
import { isBootstrap as _isBootstrap } from './bootstrapTracker.js';
import type { AccountWindowRegistry } from './accountWindowRegistry.js';

/**
 * Optional hook letting the router transparently rehydrate a dehydrated
 * account before routing. When `isDehydrated(i)` returns true, the router
 * MUST delegate window creation to `hydrate(i)` instead of consulting the
 * registry or factory — the hook owns partition + state restoration.
 *
 * See {@link IAccountWindowManager.dehydrateAccount} for the dehydration
 * lifecycle (T12/M3).
 */
export interface HydrationHook {
  isDehydrated: (accountIndex: AccountIndex) => boolean;
  hydrate: (accountIndex: AccountIndex) => BrowserWindow | null;
}

/**
 * Required on the factory-created branch. The manager owns registration,
 * activity/throttle listeners, and the single WebContents-created notify.
 * Must not be invoked for existing or hydrated windows.
 */
export type RegisterNewAccountWindow = (window: BrowserWindow, accountIndex: AccountIndex) => void;

/**
 * Hydrate restores the snapshot URL via the factory. Callers that requested a
 * different Chat URL (deep link, cross-account open) still need that URL
 * applied — but never interrupt a bootstrap Google auth page.
 */
function applyRequestedUrlAfterHydrate(
  window: BrowserWindow,
  url: string,
  accountIndex: AccountIndex
): void {
  let currentUrl = '';
  try {
    currentUrl = window.webContents.getURL();
  } catch {
    log.warn(`[AccountRouter] getURL failed after hydrate for account ${accountIndex}`);
  }
  if (_isBootstrap(accountIndex) && isGoogleAuthUrl(currentUrl)) {
    log.info(`[AccountRouter] Skipping post-hydrate loadURL for account ${accountIndex}: mid-auth`);
    return;
  }
  if (currentUrl === url) {
    return;
  }
  void window.loadURL(url);
}

/**
 * Route a createAccountWindow request: reuse existing, skip if mid-auth, or create new.
 *
 * @param registry - The window registry to query/update
 * @param windowFactory - Optional factory for creating new BrowserWindows
 * @param url - The URL to load
 * @param accountIndex - The account index for this window
 * @param hydrationHook - Optional auto-hydrate hook (T12/M3). When provided
 *   and `isDehydrated(accountIndex)` is true, the hook's `hydrate` result is
 *   returned without invoking the factory.
 * @returns The created or existing BrowserWindow
 */
export function routeAccountWindow(
  registry: AccountWindowRegistry,
  windowFactory: WindowFactory | undefined,
  url: string,
  accountIndex: AccountIndex,
  hydrationHook?: HydrationHook,
  onNewWindow?: RegisterNewAccountWindow
): BrowserWindow {
  // Auto-hydrate path (T12/M3): if the account is currently dehydrated, the
  // hook recreates the window against the same persist:account-N partition.
  // The hook is the sole owner of window creation in this case — we MUST NOT
  // fall through to the registry/factory path, which would discard the
  // hydrated window or double-create.
  if (hydrationHook && hydrationHook.isDehydrated(accountIndex)) {
    const hydrated = hydrationHook.hydrate(accountIndex);
    if (hydrated) {
      applyRequestedUrlAfterHydrate(hydrated, url, accountIndex);
      return hydrated;
    }
    // Hook reported dehydrated but failed to produce a window — fall through
    // to the standard path so we still satisfy the BrowserWindow return type.
    log.warn(
      `[AccountRouter] Hydration hook returned null for account ${accountIndex}; falling back to factory path`
    );
  }

  const existingWindow = registry.getAccountWindow(accountIndex);
  if (existingWindow && !existingWindow.isDestroyed()) {
    if (existingWindow.isMinimized()) {
      existingWindow.restore();
    }
    existingWindow.show();
    existingWindow.focus();
    registry.setMostRecentAccountIndex(accountIndex);
    // If this is a bootstrap window already mid-auth-flow, do not interrupt
    // sign-in by calling loadURL again.
    const isBootstrapWindow = _isBootstrap(accountIndex);
    const currentUrl = existingWindow.webContents.getURL();
    if (isBootstrapWindow && isGoogleAuthUrl(currentUrl)) {
      log.info(`[AccountRouter] Skipping loadURL for account ${accountIndex}: mid-auth`);
      return existingWindow;
    }
    void existingWindow.loadURL(url);
    return existingWindow;
  }

  if (!windowFactory) {
    throw new Error('[AccountRouter] No WindowFactory injected — cannot create window');
  }
  if (!onNewWindow) {
    throw new Error(
      '[AccountRouter] New-window registration callback is required for factory-created windows'
    );
  }

  const partition = toPartition(accountIndex);
  const window = windowFactory.createWindow(url, partition);

  try {
    onNewWindow(window, accountIndex);
  } catch (error: unknown) {
    if (!window.isDestroyed()) {
      window.destroy();
    }
    throw error;
  }

  log.info(`[AccountRouter] Created account window ${accountIndex} with partition: ${partition}`);

  return window;
}
