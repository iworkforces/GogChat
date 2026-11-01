import type { BrowserWindow } from 'electron';
import log from 'electron-log';
import { IPC_CHANNELS, RATE_LIMITS } from '../../shared/constants.js';
import { defineIPC } from '../utils/ipc/defineIPC.js';
import { getRateLimiter } from '../utils/ipc/rateLimiter.js';
import {
  validateNotificationCloseRequest,
  validateNotificationData,
} from '../../shared/dataValidators.js';
import {
  buildAccountAwareNotificationPayload,
  cleanupActiveNativeNotifications,
  closeNativeNotificationFromPage,
  showNativeNotification,
} from '../utils/platform/nativeNotification.js';
import { resolveAccountIndexFromIpcEvent } from '../utils/platform/accountNotificationIdentity.js';
import {
  focusNotificationSource,
  resolveNotificationFocusWindow,
} from '../utils/platform/notificationFocus.js';

let notificationShowCleanup: (() => void) | null = null;
let notificationCloseCleanup: (() => void) | null = null;
let notificationClickedCleanup: (() => void) | null = null;

export default (window: BrowserWindow) => {
  void getRateLimiter();

  // Handle notification creation
  notificationShowCleanup = defineIPC({
    kind: 'on',
    channel: IPC_CHANNELS.NOTIFICATION_SHOW,
    validator: validateNotificationData,
    rateLimit: RATE_LIMITS.IPC_NOTIFICATION,
    description: 'Notification show',
    handler: (validated, event) => {
      const focusWindow = resolveNotificationFocusWindow(event, window);
      const accountIndex = resolveAccountIndexFromIpcEvent(event);
      const payload = buildAccountAwareNotificationPayload({
        title: validated.title,
        ...(validated.body !== undefined && { body: validated.body }),
        ...(validated.icon !== undefined && { icon: validated.icon }),
        ...(validated.tag !== undefined && { chatTag: validated.tag }),
        accountIndex,
      });
      const { documentId, instanceId } = validated;
      showNativeNotification(payload, {
        focusWindow,
        ipcEvent: event,
        source: 'bridge',
        accountIndex,
        ...(documentId !== undefined &&
          instanceId !== undefined && { lifecycle: { documentId, instanceId } }),
      });
    },
  });

  // Page close() dismisses its own native banner; ownership comes from the sender, not the payload
  notificationCloseCleanup = defineIPC({
    kind: 'on',
    channel: IPC_CHANNELS.NOTIFICATION_CLOSE,
    validator: validateNotificationCloseRequest,
    description: 'Notification close',
    handler: (request, event) => {
      closeNativeNotificationFromPage(event, request);
    },
  });

  // Handle notification click from preload (legacy support)
  notificationClickedCleanup = defineIPC({
    kind: 'on',
    channel: IPC_CHANNELS.NOTIFICATION_CLICKED,
    validator: () => undefined,
    rateLimit: 5,
    description: 'Notification clicked',
    handler: (_validated, event) => {
      focusNotificationSource(event, window);
    },
  });
};

/**
 * Cleanup function for notification handler
 */
export function cleanupNotificationHandler(): void {
  try {
    log.debug('[Notification] Cleaning up notification handler');

    // Stop intake first so nothing registers while owned notifications are drained
    if (notificationShowCleanup) {
      notificationShowCleanup();
      notificationShowCleanup = null;
    }

    if (notificationCloseCleanup) {
      notificationCloseCleanup();
      notificationCloseCleanup = null;
    }

    cleanupActiveNativeNotifications();

    if (notificationClickedCleanup) {
      notificationClickedCleanup();
      notificationClickedCleanup = null;
    }

    log.info('[Notification] Notification handler cleaned up');
  } catch (error: unknown) {
    log.error('[Notification] Failed to cleanup notification handler:', error);
  }
}
