/**
 * One live native notification and its single settlement.
 *
 * An entry ends exactly once whether the OS, the page, a tag replacement, the auto-dismiss timer,
 * a navigation/destruction, or feature cleanup ends it. Settlement never waits for an OS close
 * callback: state is released first, then the native close is attempted and its failure ignored.
 */

import type { Notification, WebContents } from 'electron';
import log from 'electron-log';
import type { NotificationInstanceRef } from '../../../shared/types/domain.js';
import { cancelTrackedTimeout } from '../lifecycle/resourceCleanup.js';
import { isStartupAdmissionOpen } from '../lifecycle/startupAdmission.js';
import {
  sendNotificationLifecycleEvent,
  unbindNotificationInstance,
} from './notificationLifecycle.js';
import type { InstanceRelease } from './notificationLifecycle.js';

export type PageInstance = {
  readonly sender: WebContents;
  readonly senderId: number;
  readonly ref: NotificationInstanceRef;
};

export type Settlement =
  InstanceRelease | 'replaced' | 'auto-dismiss' | 'native-close' | 'show-failed' | 'cleanup';

/**
 * The page hears one terminal close for outcomes it did not cause and that happen while its
 * document is live. A page-initiated close, a navigation/destruction, and feature cleanup stay silent.
 */
const NOTIFIES_PAGE = {
  replaced: true,
  'auto-dismiss': true,
  'native-close': true,
  'show-failed': true,
  'page-close': false,
  navigation: false,
  destroyed: false,
  cleanup: false,
} as const satisfies Record<Settlement, boolean>;

export type ActiveEntry = {
  readonly notification: Notification;
  readonly trackingKey: string;
  readonly page: PageInstance | undefined;
  timeout: ReturnType<typeof setTimeout> | undefined;
  detachNative: () => void;
  settled: boolean;
  clicked: boolean;
};

const activeNotifications = new Map<string, ActiveEntry>();

function closeNative(notification: Notification, reason: Settlement): void {
  try {
    notification.close();
  } catch (error: unknown) {
    log.warn('[NativeNotification] Native close failed during', reason, error);
  }
}

/** End an entry exactly once; a close() that throws, stays silent, or emits synchronously is safe. */
export function settleEntry(entry: ActiveEntry, reason: Settlement): void {
  if (entry.settled) {
    return;
  }
  entry.settled = true;
  entry.detachNative();
  if (entry.timeout !== undefined) {
    cancelTrackedTimeout(entry.timeout);
  }
  if (activeNotifications.get(entry.trackingKey) === entry) {
    activeNotifications.delete(entry.trackingKey);
  }
  const { page } = entry;
  if (page) {
    unbindNotificationInstance(page.senderId, page.ref);
  }
  if (reason !== 'native-close') {
    closeNative(entry.notification, reason);
  }
  if (page && NOTIFIES_PAGE[reason]) {
    sendNotificationLifecycleEvent(page.sender, page.ref, 'close');
  }
}

/** Tell the page a show that never reached the OS has ended (not that anything was displayed). */
export function announceUnshown(page: PageInstance | undefined): void {
  if (page) {
    sendNotificationLifecycleEvent(page.sender, page.ref, 'close');
  }
}

/**
 * Wire native click/close to a new entry. A correlated entry delivers at most one click; an
 * uncorrelated one (unread-delta) focuses on every click as before.
 */
export function createEntry(
  notification: Notification,
  trackingKey: string,
  page: PageInstance | undefined,
  focus: () => void
): ActiveEntry {
  const entry: ActiveEntry = {
    notification,
    trackingKey,
    page,
    timeout: undefined,
    detachNative: () => {},
    settled: false,
    clicked: false,
  };
  const onClick = (): void => {
    if (!isStartupAdmissionOpen() || entry.settled || (page && entry.clicked)) {
      return;
    }
    entry.clicked = true;
    try {
      focus();
      if (page) {
        sendNotificationLifecycleEvent(page.sender, page.ref, 'click');
      }
    } catch (error: unknown) {
      log.error('[NativeNotification] Failed to handle notification click:', error);
    }
  };
  const onClose = (): void => {
    settleEntry(entry, 'native-close');
    log.debug('[NativeNotification] Notification closed');
  };
  notification.on('click', onClick);
  notification.on('close', onClose);
  entry.detachNative = () => {
    notification.removeListener('click', onClick);
    notification.removeListener('close', onClose);
  };
  return entry;
}

/** Make `entry` the live notification for its tag, replacing any earlier one with the same tag. */
export function trackEntry(entry: ActiveEntry): void {
  const existing = activeNotifications.get(entry.trackingKey);
  if (existing) {
    settleEntry(existing, 'replaced');
  }
  activeNotifications.set(entry.trackingKey, entry);
}

/** Feature cleanup: settle everything silently. */
export function settleAllEntries(): void {
  for (const entry of activeNotifications.values()) {
    settleEntry(entry, 'cleanup');
  }
  activeNotifications.clear();
}
