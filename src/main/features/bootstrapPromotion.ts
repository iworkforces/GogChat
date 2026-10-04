/**
 * Bootstrap Promotion Feature
 *
 * Detects when a bootstrap account window completes first-time authentication
 * and promotes it to a real authenticated session.
 *
 * On cold start without a saved session, Google serves the public landing page
 * in the bootstrap window.  After the user logs in, `did-navigate` fires with
 * an authenticated Chat URL.  This feature:
 *
 *  1. Attaches a `did-navigate` listener to the account window's webContents.
 *  2. On each navigation, checks `isAuthenticatedChatUrl()`.
 *  3. If authenticated AND the account is still marked as bootstrap:
 *     - Calls `promoteBootstrap(accountIndex)` to clear the bootstrap flag.
 *     - Removes itself (self-cleaning, no dangling listeners).
 *  4. Handles the child-window (popup) auth path:
 *     - Listens for `did-create-window` on the account window's webContents.
 *     - On the child window's `did-navigate`, checks the same condition.
 *     - On auth completion in the child, promotes the account and closes the
 *       child window if it is still open.  For account-0 it also reloads the
 *       main window to the authenticated Chat URL.
 *
 * `init()` is called once and attaches watchers for every account currently
 * registered as bootstrap (account-0, account-1, …).
 *
 * `watchBootstrapAccount(accountIndex)` is re-exported from `../utils/account/bootstrapWatcher.js`
 * so callers can attach a watcher for a single account at any time — e.g. when
 * a new secondary account window is created during a routed sign-in flow.
 */

import log from 'electron-log';
import { sanitizeLogError } from '../../shared/logSanitizer.js';
import { getAccountWindowManager } from '../utils/account/accountWindowManager.js';
import {
  watchBootstrapAccount,
  cleanupBootstrapPromotion,
} from '../utils/account/bootstrapWatcher.js';

// Re-export utility functions to preserve the existing public API
export { watchBootstrapAccount, cleanupBootstrapPromotion };

// ─── feature init ─────────────────────────────────────────────────────────────

export default function init(): void {
  try {
    const mgr = getAccountWindowManager();
    const bootstrapIndices = mgr.getBootstrapAccounts();

    if (bootstrapIndices.length === 0) {
      log.debug('[BootstrapPromotion] No bootstrap accounts — skipping');
      return;
    }

    for (const idx of bootstrapIndices) {
      watchBootstrapAccount(idx);
    }

    log.info(
      `[BootstrapPromotion] Feature initialized; watching accounts: ${bootstrapIndices.join(', ')}`
    );
  } catch (error: unknown) {
    log.error('[BootstrapPromotion] Failed to initialize:', sanitizeLogError(error));
  }
}
