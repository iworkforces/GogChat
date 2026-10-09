import type { BrowserWindow } from 'electron';
import { app } from 'electron';
import log from 'electron-log';
import { platform } from '../utils/platform/platformDetection.js';
import { getAccountWindowManager } from '../utils/account/accountWindowManager.js';
import type { IAccountWindowManager } from '../../shared/types/window.js';

let willQuit = false;
let beforeQuitHandler: (() => void) | null = null;
let closeHandler: ((event: Electron.Event) => void) | null = null;

export default (window: BrowserWindow) => {
  // Allow Mac users to exit from app via Dock context menu "Quit" item
  beforeQuitHandler = () => {
    willQuit = true;
  };
  app.on('before-quit', beforeQuitHandler);

  closeHandler = (event: Electron.Event) => {
    if (!willQuit) {
      event.preventDefault();

      // Dehydrate background accounts 1+ when hiding.
      // Account-0 stays alive for badge/notification updates.
      try {
        const manager = getAccountWindowManager();
        dehydrateBackgroundAccounts(manager);
      } catch {
        // Fail silently — dehydration is a memory optimization, not critical.
      }

      if (platform.isMac) {
        app.hide();
      } else {
        window.hide();
      }
    }
  };
  window.on('close', closeHandler);
};

/**
 * Dehydrate every non-primary account so tray-only state holds only
 * account-0 in memory. Uses sparse `listAccountIndices()` (not 0..count-1)
 * so holes like accounts {0, 2} still park account 2.
 * Account-0 is preserved for badges/notifications while hidden.
 */
function dehydrateBackgroundAccounts(manager: IAccountWindowManager): void {
  for (const idx of manager.listAccountIndices()) {
    if (Number(idx) === 0) continue;
    if (manager.isDehydrated(idx)) continue;
    manager.dehydrateAccount(idx);
    log.debug(`[CloseToTray] Dehydrated account ${idx} on tray close`);
  }
}

/**
 * Cleanup function for close to tray feature
 */
export function cleanupCloseToTray(window: BrowserWindow): void {
  try {
    log.debug('[CloseToTray] Cleaning up close to tray handlers');

    // Remove event listeners
    if (beforeQuitHandler) {
      app.removeListener('before-quit', beforeQuitHandler);
    }

    if (closeHandler && !window.isDestroyed()) {
      window.removeListener('close', closeHandler);
    }

    // Clear handler references
    beforeQuitHandler = null;
    closeHandler = null;
    willQuit = false;

    log.info('[CloseToTray] Close to tray cleaned up');
  } catch (error: unknown) {
    log.error('[CloseToTray] Failed to cleanup close to tray:', error);
  }
}
