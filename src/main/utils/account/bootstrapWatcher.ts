/**
 * Bootstrap Watcher Utility
 *
 * Watches bootstrap account windows for authentication completion.
 * Extracted from bootstrapPromotion.ts to break the feature→feature import
 * between externalLinks→bootstrapPromotion.
 *
 * Used by both bootstrapPromotion.ts (init) and externalLinks.ts (routing).
 */

import type { BrowserWindow, WebContents } from 'electron';
import log from 'electron-log';
import { sanitizeLogError } from '../../../shared/logSanitizer.js';
import { isAuthenticatedChatUrl } from '../../../shared/urlValidators.js';
import { getAccountWindowManager } from './accountWindowManager.js';
import { loadAccountURL } from './accountNavigation.js';
import type { AccountIndex } from '../../../shared/types/branded.js';
import { asAccountIndex } from '../../../shared/types/branded.js';

// ─── module-level cleanup refs ────────────────────────────────────────────────

/**
 * One cleanup function per account index currently being watched.
 * Each entry is removed (set to null / deleted from the map) once the watcher
 * fires or is explicitly cleaned up.
 */
const cleanupByAccount = new Map<AccountIndex, (() => void) | null>();

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Attach a `did-navigate` watcher to `win`. Calls `onAuth` the first time an
 * authenticated Chat URL is detected, then removes itself automatically.
 *
 * Returns a detach function for early removal.
 */
function watchForAuth(wc: WebContents, onAuth: (url: string) => void): () => void {
  const handler = (_event: Electron.Event, url: string) => {
    if (isAuthenticatedChatUrl(url)) {
      // Self-remove before calling back (prevents double-fire if caller
      // synchronously triggers another navigation).
      detach();
      onAuth(url);
    }
  };

  const detach = () => {
    try {
      if (!wc.isDestroyed()) {
        wc.removeListener('did-navigate', handler);
      }
    } catch {
      // webContents already garbage-collected in some edge cases
    }
  };

  wc.on('did-navigate', handler);
  return detach;
}

// ─── per-account watcher ──────────────────────────────────────────────────────

/**
 * Start watching a single bootstrap account window for authentication.
 *
 * - No-ops if the account is not currently marked as bootstrap.
 * - No-ops if the account window does not exist or is already destroyed.
 * - Attaches both Path A (direct navigation) and Path B (OAuth popup) watchers.
 * - Self-cleans on promotion or window closure.
 *
 * Returns a detach function that removes all listeners early (idempotent).
 * The returned function is also stored internally so `cleanupBootstrapPromotion`
 * can reach it.
 */
export function watchBootstrapAccount(accountIndex: AccountIndex): () => void {
  const mgr = getAccountWindowManager();

  const noop = () => {
    /* intentional no-op */
  };

  if (!mgr.isBootstrap(accountIndex)) {
    log.debug(`[BootstrapPromotion] Account-${accountIndex} is not a bootstrap window — skipping`);
    return noop;
  }

  const accountWc = mgr.getAccountWebContents(accountIndex);
  if (!accountWc || accountWc.isDestroyed()) {
    log.warn(`[BootstrapPromotion] Account-${accountIndex} WebContents not found — skipping`);
    return noop;
  }

  // Host/window for child-window events and close cleanup (BW account window or WCV host).
  const win = mgr.getAccountWindow(accountIndex);

  log.info(`[BootstrapPromotion] Watching account-${accountIndex} for authentication`);

  // ── Path A: user authenticates inside the same account document ────────────
  const detachMain = watchForAuth(accountWc, () => {
    log.info(`[BootstrapPromotion] Account-${accountIndex} authenticated in main window`);
    detachChildCreated();
    if (mgr.isBootstrap(accountIndex)) {
      mgr.promoteBootstrap(accountIndex);
    }
    cleanupByAccount.delete(accountIndex);
  });

  // ── Path B: Google opens an OAuth popup / child window for login ───────────
  let detachChild: (() => void) | null = null;

  const childCreatedHandler = (
    childWindow: BrowserWindow,
    _details: Electron.DidCreateWindowDetails
  ) => {
    log.debug(
      `[BootstrapPromotion] Account-${accountIndex} child window created — watching for auth redirect`
    );

    // If a previous child watcher is still attached, remove it first.
    detachChild?.();

    detachChild = watchForAuth(childWindow.webContents, (url) => {
      log.info(`[BootstrapPromotion] Account-${accountIndex} authenticated via child window`);
      detachMain();
      detachChildCreated();

      if (mgr.isBootstrap(accountIndex)) {
        mgr.promoteBootstrap(accountIndex);
      }

      if (accountIndex === asAccountIndex(0)) {
        loadAccountURL(mgr, asAccountIndex(0), url);
      }

      // Close the child window if still alive.
      if (!childWindow.isDestroyed()) {
        log.debug(
          `[BootstrapPromotion] Closing account-${accountIndex} child auth window after promotion`
        );
        childWindow.destroy();
      }

      cleanupByAccount.delete(accountIndex);
    });

    // Also detach child watcher if the popup is closed before auth completes.
    childWindow.once('closed', () => {
      detachChild = null;
    });
  };

  const detachChildCreated = () => {
    try {
      if (!accountWc.isDestroyed()) {
        accountWc.removeListener('did-create-window', childCreatedHandler);
      }
    } catch {
      // webContents already garbage-collected
    }
    detachChild?.();
    detachChild = null;
  };

  // `did-create-window` is emitted on webContents when a new BrowserWindow is
  // opened as a child (e.g. the Google OAuth popup).
  accountWc.on('did-create-window', childCreatedHandler);

  // Also self-clean if the account window/host is closed before auth completes.
  if (win && !win.isDestroyed()) {
    win.once('closed', () => {
      detachMain();
      detachChildCreated();
      cleanupByAccount.delete(accountIndex);
      log.debug(`[BootstrapPromotion] Account-${accountIndex} window closed — listeners removed`);
    });
  }

  const fullCleanup = () => {
    detachMain();
    detachChildCreated();
    log.debug(
      `[BootstrapPromotion] Cleaned up bootstrap promotion listeners for account-${accountIndex}`
    );
  };

  cleanupByAccount.set(accountIndex, fullCleanup);
  return fullCleanup;
}

// ─── cleanup export ───────────────────────────────────────────────────────────

/**
 * Explicitly remove all listeners attached by this module.
 * Called by the feature manager on app quit, or by tests after each scenario.
 */
export function cleanupBootstrapPromotion(): void {
  try {
    for (const [idx, fn] of cleanupByAccount) {
      if (fn) {
        fn();
      }
      cleanupByAccount.delete(idx);
    }
    log.debug('[BootstrapPromotion] Cleanup complete');
  } catch (error: unknown) {
    log.error('[BootstrapPromotion] Failed to cleanup:', sanitizeLogError(error));
  }
}
