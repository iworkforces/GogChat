/**
 * Unit tests for shared native OS notification helper and unread-delta policy.
 */

import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeNotification {
  static all: FakeNotification[] = [];
  static isSupported = vi.fn().mockReturnValue(true);
  static lastOptions: Record<string, unknown> | null = null;

  title: string;
  body?: string;
  icon?: string;
  subtitle?: string;
  groupId?: string;
  silent: boolean;
  closed = false;
  clickHandler: (() => void) | null = null;
  closeHandler: (() => void) | null = null;

  constructor(options: {
    title: string;
    body?: string;
    icon?: string;
    subtitle?: string;
    groupId?: string;
    silent?: boolean;
  }) {
    FakeNotification.lastOptions = options as Record<string, unknown>;
    this.title = options.title;
    this.body = options.body;
    this.icon = options.icon;
    this.subtitle = options.subtitle;
    this.groupId = options.groupId;
    this.silent = options.silent ?? false;
    FakeNotification.all.push(this);
  }

  on(event: 'click' | 'close', handler: () => void) {
    if (event === 'click') this.clickHandler = handler;
    else this.closeHandler = handler;
  }

  show() {}

  close() {
    this.closed = true;
    this.closeHandler?.();
    FakeNotification.all = FakeNotification.all.filter((n) => n !== this);
  }

  simulateClick() {
    this.clickHandler?.();
  }

  static resetAll() {
    FakeNotification.all = [];
    FakeNotification.lastOptions = null;
    FakeNotification.isSupported.mockReturnValue(true);
  }
}

const focusNotificationSourceMock = vi.fn();

vi.mock('electron', () => ({
  Notification: FakeNotification,
}));

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../shared/constants.js', () => ({
  TIMING: { NOTIFICATION_AUTO_DISMISS: 10000, NOTIFICATION_BRIDGE_COOLDOWN_MS: 8000 },
  BADGE: { DISPLAY_MAX: 99, MAX_COUNT: 9999, CACHE_LIMIT: 99 },
}));

vi.mock('../lifecycle/logger.js', () => ({
  logger: {
    feature: () => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
    main: { debug: vi.fn() },
  },
}));

vi.mock('./notificationFocus.js', () => ({
  focusNotificationSource: (...args: unknown[]) => focusNotificationSourceMock(...args),
}));

vi.mock('./accountLabelStore.js', () => ({
  getStoredAccountLabel: vi.fn().mockReturnValue(undefined),
}));

vi.mock('./accountNotificationIdentity.js', () => ({
  resolveAccountIndexFromIpcEvent: vi.fn().mockReturnValue(null),
  formatAccountNotificationLabel: (idx: number | null) =>
    idx === null ? 'GogChat' : `Account ${idx + 1}`,
  accountNotificationGroupId: (idx: number | null) =>
    idx === null ? 'gogchat-account-unknown' : `gogchat-account-${idx}`,
  namespaceNotificationTag: (idx: number | null, tag?: string) => {
    const prefix = idx === null ? 'a?' : `a${idx}`;
    return `${prefix}:${tag ?? 'notif'}`;
  },
  UNREAD_DELTA_TAG_BASE: 'gogchat-unread-delta',
}));

function makeWindow() {
  return {
    isDestroyed: vi.fn().mockReturnValue(false),
    isMinimized: vi.fn().mockReturnValue(false),
    isVisible: vi.fn().mockReturnValue(false),
    isFocused: vi.fn().mockReturnValue(false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
}

describe('nativeNotification', () => {
  beforeEach(async () => {
    vi.resetModules();
    FakeNotification.resetAll();
    focusNotificationSourceMock.mockClear();
    const mod = await import('./nativeNotification.js');
    mod.resetBridgeNotificationCooldownForTests();
  });

  afterEach(async () => {
    const notifications = await import('./nativeNotification.js');
    notifications.cleanupActiveNativeNotifications();
    const cleanup = await import('../lifecycle/resourceCleanup.js');
    cleanup.destroyCleanupManager();
    vi.useRealTimers();
  });

  describe('buildAccountAwareNotificationPayload', () => {
    it('always sets subtitle and namespaces tag', async () => {
      const { buildAccountAwareNotificationPayload } = await import('./nativeNotification.js');
      const p = buildAccountAwareNotificationPayload({
        title: 'Alice',
        body: 'Hi',
        chatTag: 'room-1',
        accountIndex: 0 as never,
      });
      expect(p.subtitle).toBe('Account 1');
      expect(p.groupId).toBe('gogchat-account-0');
      expect(p.tag).toBe('a0:room-1');
      expect(p.title).toBe('Alice');
    });
  });

  describe('shouldShowUnreadDeltaNotification / body / clamp', () => {
    it('clamps display and builds 99+ body', async () => {
      const {
        clampBadgeDisplayCount,
        buildUnreadDeltaNotificationBody,
        shouldShowUnreadDeltaNotification,
      } = await import('./nativeNotification.js');
      expect(clampBadgeDisplayCount(150)).toBe(99);
      expect(clampBadgeDisplayCount(0)).toBe(0);
      expect(clampBadgeDisplayCount(-1)).toBe(0);
      expect(clampBadgeDisplayCount(3.7)).toBe(3);
      expect(buildUnreadDeltaNotificationBody(150)).toBe('You have 99+ unread messages');
      expect(buildUnreadDeltaNotificationBody(1)).toBe('You have a new unread message');
      expect(buildUnreadDeltaNotificationBody(0)).toBe('You have new unread messages');
      expect(buildUnreadDeltaNotificationBody(5)).toBe('You have 5 unread messages');
      expect(
        shouldShowUnreadDeltaNotification({
          enabled: true,
          previousCount: 1,
          nextCount: 2,
          isWindowFocused: false,
          bridgeCooldownActive: false,
        })
      ).toBe(true);
      expect(
        shouldShowUnreadDeltaNotification({
          enabled: false,
          previousCount: 1,
          nextCount: 2,
          isWindowFocused: false,
        })
      ).toBe(false);
      expect(
        shouldShowUnreadDeltaNotification({
          enabled: true,
          previousCount: 1,
          nextCount: 2,
          isWindowFocused: true,
        })
      ).toBe(false);
      expect(
        shouldShowUnreadDeltaNotification({
          enabled: true,
          previousCount: undefined,
          nextCount: 2,
          isWindowFocused: false,
        })
      ).toBe(false);
      expect(
        shouldShowUnreadDeltaNotification({
          enabled: true,
          previousCount: 3,
          nextCount: 2,
          isWindowFocused: false,
        })
      ).toBe(false);
    });
  });

  describe('showNativeNotification', () => {
    it('releases replaced registrations and the current registration on dismissal', async () => {
      vi.useFakeTimers();
      const { showNativeNotification } = await import('./nativeNotification.js');
      const { getCleanupManager } = await import('../lifecycle/resourceCleanup.js');
      const signal = getCleanupManager()['timerAborter'].signal;
      expect(showNativeNotification({ title: 'First', tag: 'same' }, {})).toBe(true);
      const first = FakeNotification.all[0];
      expect(getEventListeners(signal, 'abort')).toHaveLength(1);

      showNativeNotification({ title: 'Second', tag: 'same' }, {});

      expect(first?.closed).toBe(true);
      expect(getEventListeners(signal, 'abort')).toHaveLength(1);
      FakeNotification.all[0]?.close();
      expect(getEventListeners(signal, 'abort')).toHaveLength(0);
      vi.advanceTimersByTime(10000);
      expect(FakeNotification.all).toHaveLength(0);
    });

    it('releases every registration during notification cleanup', async () => {
      const { showNativeNotification, cleanupActiveNativeNotifications } =
        await import('./nativeNotification.js');
      const { getCleanupManager } = await import('../lifecycle/resourceCleanup.js');
      const signal = getCleanupManager()['timerAborter'].signal;
      showNativeNotification({ title: 'One', tag: 'one' }, {});
      showNativeNotification({ title: 'Two', tag: 'two' }, {});
      expect(getEventListeners(signal, 'abort')).toHaveLength(2);

      cleanupActiveNativeNotifications();

      expect(getEventListeners(signal, 'abort')).toHaveLength(0);
      expect(FakeNotification.all).toHaveLength(0);
    });

    it('passes subtitle and groupId to Electron Notification', async () => {
      const { showNativeNotification, buildAccountAwareNotificationPayload } =
        await import('./nativeNotification.js');
      const win = makeWindow();
      const payload = buildAccountAwareNotificationPayload({
        title: 'T',
        chatTag: 't',
        accountIndex: 1 as never,
      });
      showNativeNotification(payload, {
        focusWindow: win as never,
        source: 'bridge',
        accountIndex: 1 as never,
      });
      expect(FakeNotification.lastOptions).toMatchObject({
        title: 'T',
        subtitle: 'Account 2',
        groupId: 'gogchat-account-1',
      });
    });

    it('cooldown is per-account', async () => {
      const { showNativeNotification } = await import('./nativeNotification.js');
      const win = makeWindow();
      showNativeNotification(
        { title: 'A', tag: 'a0:x', subtitle: 'Account 1', groupId: 'gogchat-account-0' },
        { focusWindow: win as never, source: 'bridge', accountIndex: 0 as never }
      );
      // Same account unread-delta suppressed
      expect(
        showNativeNotification(
          { title: 'D0', tag: 'a0:delta', subtitle: 'Account 1' },
          { focusWindow: win as never, source: 'unread-delta', accountIndex: 0 as never }
        )
      ).toBe(false);
      // Other account unread-delta allowed
      expect(
        showNativeNotification(
          { title: 'D1', tag: 'a1:delta', subtitle: 'Account 2' },
          { focusWindow: win as never, source: 'unread-delta', accountIndex: 1 as never }
        )
      ).toBe(true);
    });

    it('tracks untagged notifications for cleanup', async () => {
      const { showNativeNotification, cleanupActiveNativeNotifications } =
        await import('./nativeNotification.js');
      const win = makeWindow();
      showNativeNotification({ title: 'No tag' }, { focusWindow: win as never });
      cleanupActiveNativeNotifications();
      expect(FakeNotification.all.every((n) => n.closed)).toBe(true);
    });

    it('replaces same-tag notification and returns false when unsupported throws path', async () => {
      const { showNativeNotification, cleanupActiveNativeNotifications } =
        await import('./nativeNotification.js');
      const win = makeWindow();
      showNativeNotification(
        { title: 'First', tag: 'same', subtitle: 'A', groupId: 'g' },
        { focusWindow: win as never, source: 'bridge', accountIndex: 0 as never }
      );
      const first = FakeNotification.all[0];
      showNativeNotification(
        { title: 'Second', tag: 'same', subtitle: 'A', groupId: 'g' },
        { focusWindow: win as never, source: 'bridge', accountIndex: 0 as never }
      );
      expect(first?.closed).toBe(true);

      FakeNotification.isSupported.mockImplementation(() => {
        throw new Error('boom');
      });
      expect(showNativeNotification({ title: 'X' }, { focusWindow: win as never })).toBe(false);
      FakeNotification.isSupported.mockReturnValue(true);
      cleanupActiveNativeNotifications();
    });

    it('handles auto-dismiss timeout callback', async () => {
      vi.useFakeTimers();
      const { showNativeNotification } = await import('./nativeNotification.js');
      const win = makeWindow();
      showNativeNotification(
        { title: 'Timed', tag: 't' },
        { focusWindow: win as never, source: 'bridge' }
      );
      const n = FakeNotification.all[0];
      expect(n?.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(10000);
      expect(n?.closed).toBe(true);
      vi.useRealTimers();
    });

    it('invokes click focus helper and close only removes matching entry', async () => {
      const { showNativeNotification } = await import('./nativeNotification.js');
      const win = makeWindow();
      const event = { sender: { id: 9 } };
      showNativeNotification(
        { title: 'ClickMe', tag: 'c1' },
        { focusWindow: win as never, ipcEvent: event as never, source: 'bridge' }
      );
      FakeNotification.all[0]?.simulateClick();
      expect(focusNotificationSourceMock).toHaveBeenCalledWith(event, win);
      FakeNotification.all[0]?.close();
    });

    it('buildAccountAwareNotificationPayload includes optional body and icon', async () => {
      const { buildAccountAwareNotificationPayload } = await import('./nativeNotification.js');
      const p = buildAccountAwareNotificationPayload({
        title: 'T',
        body: 'B',
        icon: 'https://example.com/i.png',
        accountIndex: null,
      });
      expect(p.body).toBe('B');
      expect(p.icon).toBe('https://example.com/i.png');
      expect(p.subtitle).toBe('GogChat');
    });

    it('survives close() throwing when replacing tag and on cleanup', async () => {
      const { showNativeNotification, cleanupActiveNativeNotifications } =
        await import('./nativeNotification.js');
      const win = makeWindow();
      showNativeNotification(
        { title: 'A', tag: 'x' },
        { focusWindow: win as never, source: 'bridge' }
      );
      const first = FakeNotification.all[0];
      if (first) {
        first.close = () => {
          throw new Error('close fail');
        };
      }
      expect(() =>
        showNativeNotification(
          { title: 'B', tag: 'x' },
          { focusWindow: win as never, source: 'bridge' }
        )
      ).not.toThrow();

      const second = FakeNotification.all.find((n) => n.title === 'B');
      if (second) {
        second.close = () => {
          throw new Error('cleanup close fail');
        };
      }
      expect(() => cleanupActiveNativeNotifications()).not.toThrow();
    });

    it('auto-dismiss swallows close errors', async () => {
      vi.useFakeTimers();
      const { showNativeNotification } = await import('./nativeNotification.js');
      const win = makeWindow();
      showNativeNotification({ title: 'Z', tag: 'z' }, { focusWindow: win as never });
      const n = FakeNotification.all[0];
      if (n) {
        n.close = () => {
          throw new Error('dismiss fail');
        };
      }
      await vi.advanceTimersByTimeAsync(10000);
      vi.useRealTimers();
    });
  });
});
