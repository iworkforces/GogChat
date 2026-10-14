import type { BrowserWindow } from 'electron';
import { getMostRecentWindow } from './utils/account/accountWindowManager.js';

let mainWindowGetter: () => BrowserWindow | null = () => null;

/** Installed by the main entry so Dock activate can read its window reference. */
export function setDockActivateMainWindowGetter(getter: () => BrowserWindow | null): void {
  mainWindowGetter = getter;
}

/**
 * Handler registered on `app` `activate` from the main entry.
 * Shows the existing window. Does not create a window.
 */
export function onDockActivate(): void {
  const windowToShow = getMostRecentWindow() ?? mainWindowGetter();
  if (!windowToShow || windowToShow.isDestroyed()) {
    return;
  }
  if (windowToShow.isMinimized()) {
    windowToShow.restore();
  }
  windowToShow.show();
  windowToShow.focus();
}
