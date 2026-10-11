/**
 * badgeIcon feature — thin registration layer.
 *
 * Delegates all IPC handler logic (favicon → icon type, unread count →
 * dock badge) to ../utils/platform/badgeHelpers.ts. This module only owns the feature
 * lifecycle: holding cleanup references and exposing cleanupBadgeIcon().
 */

import type { BrowserWindow } from 'electron';
import log from 'electron-log';
import { toErrorMessage } from '../utils/lifecycle/errorUtils.js';
import { setupBadgeHandlers } from '../utils/platform/badgeHelpers.js';
import type { BadgeHandlerCleanups } from '../utils/platform/badgeHelpers.js';

let handlerCleanups: BadgeHandlerCleanups | null = null;

export default (window: BrowserWindow): void => {
  handlerCleanups = setupBadgeHandlers(window);
};

/**
 * Cleanup function for badge icon feature.
 */
export function cleanupBadgeIcon(): void {
  const cleanups = handlerCleanups;
  handlerCleanups = null;
  if (!cleanups) return;
  log.debug('[BadgeIcon] Cleaning up badge icon listeners');
  const cleanupCallbacks: readonly (() => void)[] = [
    cleanups.faviconCleanup,
    cleanups.unreadCleanup,
    cleanups.webContentsCleanup,
    cleanups.accountRemovedCleanup,
    cleanups.sessionCleanup,
  ];
  for (const cleanup of cleanupCallbacks) {
    try {
      cleanup();
    } catch (error: unknown) {
      log.error('[BadgeIcon] Failed to cleanup badge icon:', toErrorMessage(error));
    }
  }
  log.info('[BadgeIcon] Badge icon cleaned up');
}
