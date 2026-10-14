/**
 * Tray image helpers. Startup and badge presentation do not call these.
 * `PlatformUtils.createTrayIcon` is likewise unused by startup.
 *
 * Owns image getters for the template tray assets. Nothing in startup calls
 * them, and badge presentation does not swap tray images.
 */

import type { NativeImage, Tray } from 'electron';
import log from 'electron-log';
import { getIconCache } from './iconCache.js';
import { platform } from './platformDetection.js';

let trayInstance: Tray | null = null;
let currentTrayUnread: boolean | null = null;

/**
 * macOS uses Template images for automatic dark/light mode adaptation.
 * The file must be named with the 'Template' suffix.
 */
export function getTrayIconImage(): NativeImage {
  return getIconCache().getIcon('resources/icons/tray/iconTemplate.png');
}

/**
 * Monochrome Template image with a filled dot — macOS auto-tints for light/dark.
 */
export function getTrayUnreadImage(): NativeImage {
  return getIconCache().getIcon('resources/icons/tray/iconUnreadTemplate.png');
}

/**
 * Register a Tray instance. Startup does not call this.
 * Pass `null` to clear the reference and reset state.
 */
export function setTrayInstance(tray: Tray | null): void {
  trayInstance = tray;
  currentTrayUnread = null;
}

/**
 * Update the tray icon to reflect unread message state.
 * Swaps between the default Template icon and the unread-dot Template icon.
 * No-ops if state is unchanged or the tray instance is missing/destroyed.
 */
export function setTrayUnread(hasUnread: boolean): void {
  if (!platform.config.useTemplateTrayIcon) return;
  if (!trayInstance || trayInstance.isDestroyed()) return;
  if (currentTrayUnread === hasUnread) return;

  currentTrayUnread = hasUnread;
  const image = hasUnread ? getTrayUnreadImage() : getTrayIconImage();
  trayInstance.setImage(image);
  log.debug(`[TrayIcon] Tray icon updated — unread: ${String(hasUnread)}`);
}
