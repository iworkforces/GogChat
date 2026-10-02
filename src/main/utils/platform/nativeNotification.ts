/**
 * Shared Electron (OS) notification display helper.
 *
 * Used by:
 *   - handleNotification (Chat web Notification bridge IPC)
 *   - badgeHelpers unread-delta fallback (generic banners when enabled)
 *
 * Owns tag de-dupe, auto-dismiss, click → focus, and per-account bridge cooldown.
 * Account identity (subtitle / groupId / namespaced tag) is applied by callers
 * or via buildAccountAwareNotificationPayload.
 */

import type { BrowserWindow, IpcMainEvent } from 'electron';
import { Notification } from 'electron';
import log from 'electron-log';
import { BADGE, TIMING } from '../../../shared/constants.js';
import type { AccountIndex } from '../../../shared/types/branded.js';
import { cancelTrackedTimeout, createTrackedTimeout } from '../lifecycle/resourceCleanup.js';
import { focusNotificationSource } from './notificationFocus.js';
import {
  UNREAD_DELTA_TAG_BASE,
  accountNotificationGroupId,
  formatAccountNotificationLabel,
  namespaceNotificationTag,
  resolveAccountIndexFromIpcEvent,
} from './accountNotificationIdentity.js';

export type NativeNotificationSource = 'bridge' | 'unread-delta';

export type NativeNotificationPayload = {
  readonly title: string;
  readonly body?: string;
  readonly icon?: string;
  /** Already namespaced when multi-account aware. */
  readonly tag?: string;
  /** macOS: account label under title (always set when using account-aware builder). */
  readonly subtitle?: string;
  /** macOS/Windows: group notifications per account. */
  readonly groupId?: string;
};

export type ShowNativeNotificationOptions = {
  readonly focusWindow: BrowserWindow;
  /** When set, click re-resolves account focus from this IPC event's sender. */
  readonly ipcEvent?: IpcMainEvent;
  /** Origin of the show — bridge marks per-account cooldown; unread-delta respects it. */
  readonly source?: NativeNotificationSource;
  /** Account used for cooldown bookkeeping (derived from sender). */
  readonly accountIndex?: AccountIndex | null;
};

type ActiveEntry = {
  notification: Notification;
  timeout: ReturnType<typeof setTimeout>;
  trackingKey: string;
};

const activeNotifications = new Map<string, ActiveEntry>();

/** Monotonic tracking keys for untagged notifications so cleanup can find them. */
let trackingIdCounter = 0;

/** Last bridge notification show time per account (null key = unknown account). */
const lastBridgeNotificationAtByAccount = new Map<string, number>();

function accountCooldownKey(accountIndex: AccountIndex | null | undefined): string {
  if (accountIndex === null || accountIndex === undefined) {
    return 'unknown';
  }
  return String(accountIndex);
}

/**
 * Reset bridge cooldown (unit tests only).
 */
export function resetBridgeNotificationCooldownForTests(): void {
  lastBridgeNotificationAtByAccount.clear();
}

export function markBridgeNotificationShown(
  accountIndex: AccountIndex | null | undefined,
  now = Date.now()
): void {
  lastBridgeNotificationAtByAccount.set(accountCooldownKey(accountIndex), now);
}

export function wasBridgeNotificationRecentlyShown(
  accountIndex: AccountIndex | null | undefined,
  now = Date.now()
): boolean {
  const at = lastBridgeNotificationAtByAccount.get(accountCooldownKey(accountIndex));
  if (at === undefined) {
    return false;
  }
  return now - at < TIMING.NOTIFICATION_BRIDGE_COOLDOWN_MS;
}

/**
 * Build payload with always-on account subtitle, groupId, and namespaced tag.
 */
export function buildAccountAwareNotificationPayload(options: {
  readonly title: string;
  readonly body?: string;
  readonly icon?: string;
  readonly chatTag?: string;
  readonly accountIndex: AccountIndex | null;
  readonly customAccountLabel?: string;
}): NativeNotificationPayload {
  const { accountIndex } = options;
  const tag = namespaceNotificationTag(accountIndex, options.chatTag);
  return {
    title: options.title,
    ...(options.body !== undefined && { body: options.body }),
    ...(options.icon !== undefined && { icon: options.icon }),
    tag,
    subtitle: formatAccountNotificationLabel(accountIndex, options.customAccountLabel),
    groupId: accountNotificationGroupId(accountIndex),
  };
}

/**
 * Show a validated native OS notification.
 * Returns false when unsupported, suppressed by cooldown, or show failed.
 */
export function showNativeNotification(
  payload: NativeNotificationPayload,
  options: ShowNativeNotificationOptions
): boolean {
  try {
    if (!Notification.isSupported()) {
      log.warn('[NativeNotification] Desktop notifications are not supported; ignoring show');
      return false;
    }

    const source = options.source ?? 'bridge';
    const accountIndex =
      options.accountIndex !== undefined
        ? options.accountIndex
        : resolveAccountIndexFromIpcEvent(options.ipcEvent);

    if (source === 'unread-delta' && wasBridgeNotificationRecentlyShown(accountIndex)) {
      log.debug(
        '[NativeNotification] Suppressing unread-delta banner (recent bridge for this account)'
      );
      return false;
    }

    log.debug(
      '[NativeNotification] Creating notification:',
      payload.title,
      'subtitle=',
      payload.subtitle ?? '(none)',
      'tag=',
      payload.tag ?? '(none)',
      'account=',
      accountIndex ?? 'unknown',
      'source=',
      source
    );

    const notification = new Notification({
      title: payload.title,
      ...(payload.body !== undefined && { body: payload.body }),
      ...(payload.icon !== undefined && { icon: payload.icon }),
      ...(payload.subtitle !== undefined && { subtitle: payload.subtitle }),
      ...(payload.groupId !== undefined && { groupId: payload.groupId }),
      silent: false,
    });

    const trackingKey = payload.tag ?? `__gogchat-notif-${trackingIdCounter++}`;
    const focusWindow = options.focusWindow;
    const ipcEvent = options.ipcEvent;

    notification.on('click', () => {
      try {
        focusNotificationSource(ipcEvent, focusWindow);
      } catch (error: unknown) {
        log.error('[NativeNotification] Failed to handle notification click:', error);
      }
    });

    notification.on('close', () => {
      const entry = activeNotifications.get(trackingKey);
      if (entry && entry.notification === notification) {
        cancelTrackedTimeout(entry.timeout);
        activeNotifications.delete(trackingKey);
      }
      log.debug('[NativeNotification] Notification closed:', payload.title);
    });

    if (payload.tag) {
      const existing = activeNotifications.get(trackingKey);
      if (existing) {
        cancelTrackedTimeout(existing.timeout);
        activeNotifications.delete(trackingKey);
        try {
          existing.notification.close();
        } catch {
          // ignore
        }
      }
    }

    notification.show();

    if (source === 'bridge') {
      markBridgeNotificationShown(accountIndex);
    }

    const timeout = createTrackedTimeout(
      () => {
        try {
          notification.close();
          log.debug('[NativeNotification] Notification auto-dismissed after 10s:', payload.title);
        } catch (error: unknown) {
          log.error('[NativeNotification] Failed to auto-dismiss notification:', error);
        }
      },
      TIMING.NOTIFICATION_AUTO_DISMISS,
      'notification-auto-dismiss'
    );

    activeNotifications.set(trackingKey, { notification, timeout, trackingKey });

    return true;
  } catch (error: unknown) {
    log.error('[NativeNotification] Failed to create notification:', error);
    return false;
  }
}

/**
 * Close all tracked notifications and clear timers (feature cleanup).
 */
export function cleanupActiveNativeNotifications(): void {
  activeNotifications.forEach((entry) => {
    cancelTrackedTimeout(entry.timeout);
    try {
      entry.notification.close();
    } catch {
      // ignore
    }
  });
  activeNotifications.clear();
}

/** @deprecated Use UNREAD_DELTA_TAG_BASE + namespaceNotificationTag */
export const UNREAD_DELTA_NOTIFICATION_TAG = UNREAD_DELTA_TAG_BASE;

/**
 * Pure policy: whether an unread-count transition should produce a synthetic banner.
 * First observed count (previous undefined) never notifies — avoids login spam.
 */
export function shouldShowUnreadDeltaNotification(options: {
  readonly enabled: boolean;
  readonly previousCount: number | undefined;
  readonly nextCount: number;
  readonly isWindowFocused: boolean;
  readonly bridgeCooldownActive?: boolean;
}): boolean {
  if (!options.enabled) {
    return false;
  }
  if (options.isWindowFocused) {
    return false;
  }
  if (options.bridgeCooldownActive === true) {
    return false;
  }
  if (options.previousCount === undefined) {
    return false;
  }
  return options.nextCount > options.previousCount && options.nextCount > 0;
}

/**
 * Cap count for user-facing display (dock + banner body) at BADGE.DISPLAY_MAX (99).
 */
export function clampBadgeDisplayCount(count: number): number {
  if (count <= 0) return 0;
  if (count > BADGE.DISPLAY_MAX) return BADGE.DISPLAY_MAX;
  return Math.floor(count);
}

export function buildUnreadDeltaNotificationBody(count: number): string {
  if (count <= 0) {
    return 'You have new unread messages';
  }
  if (count === 1) {
    return 'You have a new unread message';
  }
  if (count > BADGE.DISPLAY_MAX) {
    return `You have ${BADGE.DISPLAY_MAX}+ unread messages`;
  }
  return `You have ${count} unread messages`;
}
