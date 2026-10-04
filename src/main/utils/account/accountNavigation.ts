/**
 * WebContents-first account navigation helpers (KD1).
 *
 * Prefer these over `getAccountWindow(i).webContents.loadURL(...)` so BrowserWindow
 * and WebContentsView backends both target the account document, not the WCV host.
 */

import log from 'electron-log';
import type { IAccountWindowManager } from '../../../shared/types/window.js';
import type { AccountIndex } from '../../../shared/types/branded.js';
import { isGoogleAuthUrl } from '../../../shared/urlValidators.js';

/**
 * Load `url` in the account's WebContents unless it is mid Google auth.
 * @returns true if loadURL was invoked; false if no WC, destroyed, or auth protected.
 */
function initiateAccountLoad(
  manager: IAccountWindowManager,
  accountIndex: AccountIndex,
  url: string
): Promise<boolean> | null {
  const webContents = manager.getAccountWebContents(accountIndex);
  if (!webContents || webContents.isDestroyed() || manager.isDehydrated(accountIndex)) {
    log.debug(
      `[AccountNavigation] loadAccountURL: no live WebContents for account ${accountIndex}`
    );
    return null;
  }

  try {
    const current = webContents.getURL();
    if (isGoogleAuthUrl(current)) {
      log.info(
        `[AccountNavigation] Skipping loadURL for account ${accountIndex} — Google auth page active`
      );
      return null;
    }
  } catch {
    log.warn(`[AccountNavigation] getURL failed for account ${accountIndex}`);
  }

  try {
    return webContents.loadURL(url).then(
      () => true,
      () => {
        log.warn(`[AccountNavigation] loadURL failed for account ${accountIndex}`);
        return false;
      }
    );
  } catch {
    log.warn(`[AccountNavigation] loadURL failed for account ${accountIndex}`);
    return null;
  }
}

export function loadAccountURL(
  manager: IAccountWindowManager,
  accountIndex: AccountIndex,
  url: string
): boolean {
  return initiateAccountLoad(manager, accountIndex, url) !== null;
}

export async function loadAccountURLAndWait(
  manager: IAccountWindowManager,
  accountIndex: AccountIndex,
  url: string
): Promise<boolean> {
  return (await initiateAccountLoad(manager, accountIndex, url)) ?? false;
}

/**
 * @returns Current URL of the account WebContents, or null if unavailable.
 */
export function getAccountURL(
  manager: IAccountWindowManager,
  accountIndex: AccountIndex
): string | null {
  const webContents = manager.getAccountWebContents(accountIndex);
  if (!webContents || webContents.isDestroyed()) {
    return null;
  }
  try {
    return webContents.getURL();
  } catch {
    return null;
  }
}

/**
 * Send an IPC channel to the account WebContents (main → renderer).
 * @returns true if send was called.
 */
export function sendToAccount(
  manager: IAccountWindowManager,
  accountIndex: AccountIndex,
  channel: string,
  ...args: unknown[]
): boolean {
  const webContents = manager.getAccountWebContents(accountIndex);
  if (!webContents || webContents.isDestroyed()) {
    return false;
  }
  webContents.send(channel, ...args);
  return true;
}
