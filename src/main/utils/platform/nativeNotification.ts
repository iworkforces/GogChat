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
 *
 * A bridge show may carry a document/instance reference (`lifecycle`). That instance is owned by
 * the IPC event's sender, delivers at most one click, and settles exactly once whether the OS,
 * the page, a tag replacement, the auto-dismiss timer, or a navigation/destruction ends it.
 * Settlement never waits for an OS close callback. Uncorrelated shows (unread-delta) keep the
 * original tag-keyed behaviour.
 */

import type { BrowserWindow, IpcMainEvent } from 'electron';
import { Notification } from 'electron';
import log from 'electron-log';
import { BADGE, TIMING } from '../../../shared/constants.js';
import type { AccountIndex } from '../../../shared/types/branded.js';
import type { NotificationInstanceRef } from '../../../shared/types/domain.js';
import { createTrackedTimeout } from '../lifecycle/resourceCleanup.js';
import { isStartupAdmissionOpen } from '../lifecycle/startupAdmission.js';
import {
  announceUnshown,
  createEntry,
  settleAllEntries,
  settleEntry,
  trackEntry,
} from './notificationEntry.js';
import type { ActiveEntry, PageInstance } from './notificationEntry.js';
import { focusNotificationSource } from './notificationFocus.js';
import {
  bindNotificationInstance,
  releaseNotificationInstanceFromPage,
  resetNotificationInstances,
} from './notificationLifecycle.js';
import {
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
  /** Page object this show belongs to; requires `ipcEvent`, whose sender owns the instance. */
  readonly lifecycle?: NotificationInstanceRef;
};

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
 * Returns false when unsupported, suppressed by cooldown, a duplicate live instance, or show
 * failed. A failed correlated show releases its registration and tells the page it ended; it
 * never claims the OS displayed anything.
 */
export function showNativeNotification(
  payload: NativeNotificationPayload,
  options: ShowNativeNotificationOptions
): boolean {
  if (!isStartupAdmissionOpen()) {
    return false;
  }
  const sender = options.ipcEvent?.sender;
  if (options.lifecycle !== undefined && (sender === undefined || sender.isDestroyed())) {
    log.debug('[NativeNotification] Ignoring correlated show without a live sender');
    return false;
  }
  const page: PageInstance | undefined =
    options.lifecycle !== undefined && sender !== undefined
      ? { sender, senderId: sender.id, ref: options.lifecycle }
      : undefined;
  let entry: ActiveEntry | undefined;
  try {
    if (!Notification.isSupported()) {
      log.warn('[NativeNotification] Desktop notifications are not supported; ignoring show');
      announceUnshown(page);
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
    const { focusWindow, ipcEvent } = options;
    const created = createEntry(notification, trackingKey, page, () =>
      focusNotificationSource(ipcEvent, focusWindow)
    );
    entry = created;

    if (
      page &&
      !bindNotificationInstance(page.sender, page.ref, (why) => settleEntry(created, why))
    ) {
      created.detachNative();
      log.warn('[NativeNotification] Ignoring show for an instance that is already live');
      return false;
    }

    trackEntry(created);

    notification.show();

    if (source === 'bridge') {
      markBridgeNotificationShown(accountIndex);
    }

    if (!created.settled) {
      created.timeout = createTrackedTimeout(
        () => {
          log.debug('[NativeNotification] Notification auto-dismissed after 10s:', payload.title);
          settleEntry(created, 'auto-dismiss');
        },
        TIMING.NOTIFICATION_AUTO_DISMISS,
        'notification-auto-dismiss'
      );
    }

    return true;
  } catch (error: unknown) {
    log.error('[NativeNotification] Failed to create notification:', error);
    if (entry) {
      settleEntry(entry, 'show-failed');
    } else {
      announceUnshown(page);
    }
    return false;
  }
}

/**
 * Page-requested dismissal. Authorized by the sender's own registrations, so another sender's or
 * document's ids (or a tag) never match. Returns false when nothing live matched.
 */
export function closeNativeNotificationFromPage(
  event: IpcMainEvent,
  ref: NotificationInstanceRef
): boolean {
  const sender = event.sender;
  if (sender.isDestroyed()) {
    return false;
  }
  return releaseNotificationInstanceFromPage(sender.id, ref);
}

/**
 * Close all tracked notifications and clear timers and listeners (feature cleanup).
 * Silent: pages get no event after cleanup begins.
 */
export function cleanupActiveNativeNotifications(): void {
  settleAllEntries();
  resetNotificationInstances();
}

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
