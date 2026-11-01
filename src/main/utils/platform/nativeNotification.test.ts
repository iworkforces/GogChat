/**
 * Unit tests for shared native OS notification helper and unread-delta policy.
 */

import { EventEmitter, getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FakeListener = () => void;

class FakeNotification {
  static all: FakeNotification[] = [];
  static history: FakeNotification[] = [];
  static isSupported = vi.fn().mockReturnValue(true);
  static lastOptions: Record<string, unknown> | null = null;
  static showFailure: Error | null = null;

  title: string;
  body?: string;
  icon?: string;
  subtitle?: string;
  groupId?: string;
  silent: boolean;
  closed = false;
  closeCalls = 0;
  showCalls = 0;
  closeMode: 'emit' | 'silent' | 'throw' = 'emit';
  private readonly handlers: Record<'click' | 'close', Set<FakeListener>> = {
    click: new Set(),
    close: new Set(),
  };

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
    FakeNotification.history.push(this);
  }

  on(event: 'click' | 'close', handler: FakeListener) {
    this.handlers[event].add(handler);
    return this;
  }

  removeListener(event: 'click' | 'close', handler: FakeListener) {
    this.handlers[event].delete(handler);
    return this;
  }

  listenerCount(event: 'click' | 'close') {
    return this.handlers[event].size;
  }

  /** Handlers as the OS would hold them: a late callback may still reach a stale snapshot. */
  snapshot(event: 'click' | 'close') {
    return [...this.handlers[event]];
  }

  show() {
    if (FakeNotification.showFailure) throw FakeNotification.showFailure;
    this.showCalls += 1;
  }

  close() {
    this.closeCalls += 1;
    if (this.closeMode === 'throw') throw new Error('close fail');
    this.closed = true;
    FakeNotification.all = FakeNotification.all.filter((n) => n !== this);
    if (this.closeMode === 'emit') this.emitClose();
  }

  /** Simulated OS callback; says nothing about real macOS delivery. */
  emitClose() {
    for (const handler of this.snapshot('close')) handler();
  }

  simulateClick() {
    for (const handler of this.snapshot('click')) handler();
  }

  static resetAll() {
    FakeNotification.all = [];
    FakeNotification.history = [];
    FakeNotification.lastOptions = null;
    FakeNotification.showFailure = null;
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
  IPC_CHANNELS: { NOTIFICATION_EVENT: 'notificationEvent' },
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

function makeSender(id: number) {
  const emitter = new EventEmitter();
  let destroyed = false;
  return Object.assign(emitter, {
    id,
    send: vi.fn(),
    isDestroyed: () => destroyed,
    destroy() {
      destroyed = true;
      emitter.emit('destroyed');
    },
  });
}

type FakeSender = ReturnType<typeof makeSender>;

const MAIN_FRAME_NAVIGATION = { isMainFrame: true, isSameDocument: false };

function lifecycleEvent(type: 'click' | 'close', instanceId: string, documentId = 'doc-1') {
  return ['notificationEvent', { documentId, instanceId, type }];
}

/** Native object created for `instanceId` (the fake titles each notification with its id). */
function nativeFor(instanceId: string) {
  const found = FakeNotification.history.find((n) => n.title === instanceId);
  if (!found) throw new Error(`no native notification for ${instanceId}`);
  return found;
}

/** Handlers as the OS may still hold them after the helper detached them. */
function captureStaleCallbacks(native: FakeNotification) {
  const callbacks = [...native.snapshot('click'), ...native.snapshot('close')];
  return () => {
    for (const callback of callbacks) callback();
  };
}

async function loadPageHelpers() {
  const mod = await import('./nativeNotification.js');
  const win = makeWindow();
  const show = (sender: FakeSender, instanceId: string, tag: string, documentId = 'doc-1') =>
    mod.showNativeNotification(
      { title: instanceId, tag },
      {
        focusWindow: win as never,
        ipcEvent: { sender } as never,
        source: 'bridge',
        accountIndex: 0 as never,
        lifecycle: { documentId, instanceId },
      }
    );
  const closeFromPage = (sender: FakeSender, instanceId: string, documentId = 'doc-1') =>
    mod.closeNativeNotificationFromPage({ sender } as never, { documentId, instanceId });
  return { mod, win, show, closeFromPage };
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

  describe('page-correlated instances', () => {
    it('blocks shows, focus, and page events while shutdown waits for earlier cleanup', async () => {
      const { mod, show, win, closeFromPage } = await loadPageHelpers();
      const { closeStartupAdmission } = await import('../lifecycle/startupAdmission.js');
      const sender = makeSender(1);
      show(sender, 'clicked', 'tag-clicked');
      show(sender, 'closed', 'tag-closed');
      const clicked = nativeFor('clicked');
      const closed = nativeFor('closed');
      clicked.closeMode = 'silent';
      const replayStale = captureStaleCallbacks(clicked);
      const earlierCleanup = Promise.withResolvers<void>();
      const cleanup = earlierCleanup.promise.then(() => mod.cleanupActiveNativeNotifications());

      // before-quit closes this shared admission synchronously, before awaiting feature cleanup.
      closeStartupAdmission();
      clicked.simulateClick();
      closed.emitClose();
      expect(show(sender, 'late', 'tag-late')).toBe(false);
      expect(
        mod.showNativeNotification(
          { title: 'late-delta' },
          { focusWindow: win as never, source: 'unread-delta' }
        )
      ).toBe(false);
      expect(FakeNotification.history).toHaveLength(2);
      expect(clicked.closeCalls).toBe(0);
      expect(sender.send).not.toHaveBeenCalled();
      expect(focusNotificationSourceMock).not.toHaveBeenCalled();

      earlierCleanup.resolve();
      await cleanup;
      mod.cleanupActiveNativeNotifications();
      replayStale();
      expect(clicked.closeCalls).toBe(1);
      expect(closed.closeCalls).toBe(0);
      expect(closeFromPage(sender, 'clicked')).toBe(false);
      expect(sender.listenerCount('did-start-navigation')).toBe(0);
      expect(sender.send).not.toHaveBeenCalled();
      expect(focusNotificationSourceMock).not.toHaveBeenCalled();
    });

    it('focuses then delivers a single click, and later duplicates do nothing', async () => {
      const { show, win } = await loadPageHelpers();
      const sender = makeSender(1);
      expect(show(sender, 'n1', 'tag-1')).toBe(true);
      const native = nativeFor('n1');

      native.simulateClick();
      native.simulateClick();

      expect(focusNotificationSourceMock).toHaveBeenCalledTimes(1);
      expect(focusNotificationSourceMock).toHaveBeenCalledWith({ sender }, win);
      expect(sender.send.mock.calls).toEqual([lifecycleEvent('click', 'n1')]);
      expect(focusNotificationSourceMock.mock.invocationCallOrder[0]).toBeLessThan(
        sender.send.mock.invocationCallOrder[0] ?? 0
      );
    });

    it('keeps focusing on every click for an uncorrelated show', async () => {
      const { mod, win } = await loadPageHelpers();
      mod.showNativeNotification({ title: 'delta', tag: 'delta' }, { focusWindow: win as never });
      const native = nativeFor('delta');

      native.simulateClick();
      native.simulateClick();

      expect(focusNotificationSourceMock).toHaveBeenCalledTimes(2);
    });

    it.each(['emit', 'silent', 'throw'] as const)(
      'settles a page close once without echo when native close %s',
      async (closeMode) => {
        const { show, closeFromPage } = await loadPageHelpers();
        const sender = makeSender(1);
        show(sender, 'n1', 'tag-1');
        const native = nativeFor('n1');
        native.closeMode = closeMode;
        const replayStale = captureStaleCallbacks(native);

        expect(closeFromPage(sender, 'n1')).toBe(true);
        expect(closeFromPage(sender, 'n1')).toBe(false);
        replayStale();

        expect(native.closeCalls).toBe(1);
        expect(sender.send).not.toHaveBeenCalled();
        expect(focusNotificationSourceMock).not.toHaveBeenCalled();
        expect(native.listenerCount('click') + native.listenerCount('close')).toBe(0);
        expect(sender.listenerCount('did-start-navigation')).toBe(0);
        expect(show(sender, 'n1', 'tag-2')).toBe(true);
      }
    );

    it('lets a replacement outlive callbacks and close requests of the instance it replaced', async () => {
      const { show, closeFromPage } = await loadPageHelpers();
      const sender = makeSender(1);
      show(sender, 'old', 'same-tag');
      const old = nativeFor('old');
      const replayStale = captureStaleCallbacks(old);

      show(sender, 'new', 'same-tag');
      const replacement = nativeFor('new');
      replayStale();
      expect(closeFromPage(sender, 'old')).toBe(false);
      replacement.simulateClick();

      expect(old.closeCalls).toBe(1);
      expect(replacement.closeCalls).toBe(0);
      expect(sender.send.mock.calls).toEqual([
        lifecycleEvent('close', 'old'),
        lifecycleEvent('click', 'new'),
      ]);
      expect(closeFromPage(sender, 'new')).toBe(true);
    });

    it('auto-dismisses after 10s with one terminal close and inert later callbacks', async () => {
      vi.useFakeTimers();
      const { show, closeFromPage } = await loadPageHelpers();
      const sender = makeSender(1);
      show(sender, 'n1', 'tag-1');
      const native = nativeFor('n1');
      const replayStale = captureStaleCallbacks(native);

      await vi.advanceTimersByTimeAsync(9999);
      expect(sender.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      replayStale();

      expect(native.closeCalls).toBe(1);
      expect(sender.send.mock.calls).toEqual([lifecycleEvent('close', 'n1')]);
      expect(focusNotificationSourceMock).not.toHaveBeenCalled();
      expect(closeFromPage(sender, 'n1')).toBe(false);
    });

    it('settles an observed native close once without closing the native object again', async () => {
      const { show } = await loadPageHelpers();
      const sender = makeSender(1);
      show(sender, 'n1', 'tag-1');
      const native = nativeFor('n1');
      const replayStale = captureStaleCallbacks(native);

      native.emitClose();
      replayStale();

      expect(native.closeCalls).toBe(0);
      expect(sender.send.mock.calls).toEqual([lifecycleEvent('close', 'n1')]);
      expect(sender.listenerCount('destroyed')).toBe(0);
    });

    it('rejects a duplicate live instance without touching the original', async () => {
      const { show } = await loadPageHelpers();
      const sender = makeSender(1);
      show(sender, 'n1', 'tag-1');
      const original = nativeFor('n1');

      expect(show(sender, 'n1', 'tag-2')).toBe(false);
      original.simulateClick();

      const shownCopies = FakeNotification.history.filter((n) => n.showCalls > 0);
      expect(shownCopies).toHaveLength(1);
      expect(shownCopies[0]).toBe(original);
      expect(original.closeCalls).toBe(0);
      expect(sender.send.mock.calls).toEqual([lifecycleEvent('click', 'n1')]);
    });

    it('refuses a correlated show whose sender is already destroyed', async () => {
      const { show } = await loadPageHelpers();
      const sender = makeSender(1);
      sender.destroy();

      expect(show(sender, 'n1', 'tag-1')).toBe(false);
      expect(FakeNotification.history).toHaveLength(0);
    });

    it('releases a failed show, tells the page once, and does not start the cooldown', async () => {
      const { mod, show } = await loadPageHelpers();
      const sender = makeSender(1);
      FakeNotification.showFailure = new Error('show failed');

      expect(show(sender, 'n1', 'tag-1')).toBe(false);

      const native = nativeFor('n1');
      expect(sender.send.mock.calls).toEqual([lifecycleEvent('close', 'n1')]);
      expect(native.closeCalls).toBe(1);
      expect(native.listenerCount('click') + native.listenerCount('close')).toBe(0);
      expect(sender.listenerCount('did-start-navigation')).toBe(0);
      expect(mod.wasBridgeNotificationRecentlyShown(0 as never)).toBe(false);
      FakeNotification.showFailure = null;
      expect(show(sender, 'n1', 'tag-1')).toBe(true);
    });

    it('tells the page once when notifications are unsupported', async () => {
      const { show } = await loadPageHelpers();
      const sender = makeSender(1);
      FakeNotification.isSupported.mockReturnValue(false);

      expect(show(sender, 'n1', 'tag-1')).toBe(false);

      expect(FakeNotification.history).toHaveLength(0);
      expect(sender.send.mock.calls).toEqual([lifecycleEvent('close', 'n1')]);
    });

    it('does not let a close request from another sender or document touch an instance', async () => {
      const { show, closeFromPage } = await loadPageHelpers();
      const first = makeSender(1);
      const second = makeSender(2);
      show(first, 'n1', 'tag-1');
      show(second, 'n1', 'tag-2');

      expect(closeFromPage(first, 'n1', 'doc-other')).toBe(false);
      expect(closeFromPage(first, 'n1')).toBe(true);

      expect(FakeNotification.all).toHaveLength(1);
      FakeNotification.all[0]?.simulateClick();
      expect(second.send.mock.calls).toEqual([lifecycleEvent('click', 'n1')]);
      expect(first.send).not.toHaveBeenCalled();
    });

    it('invalidates live instances on a cross-document navigation of a surviving WebContents', async () => {
      const { show, closeFromPage } = await loadPageHelpers();
      const sender = makeSender(1);
      show(sender, 'n1', 'tag-1');
      const native = nativeFor('n1');
      const replayStale = captureStaleCallbacks(native);

      sender.emit('did-start-navigation', MAIN_FRAME_NAVIGATION);
      replayStale();

      expect(native.closeCalls).toBe(1);
      expect(sender.send).not.toHaveBeenCalled();
      expect(focusNotificationSourceMock).not.toHaveBeenCalled();
      expect(closeFromPage(sender, 'n1')).toBe(false);
      expect(sender.listenerCount('did-start-navigation')).toBe(0);
      expect(sender.listenerCount('did-navigate')).toBe(0);
      expect(show(sender, 'n1', 'tag-1', 'doc-2')).toBe(true);
    });

    it('invalidates an instance shown while a navigation was pending when it commits', async () => {
      const { show } = await loadPageHelpers();
      const sender = makeSender(1);
      sender.emit('did-start-navigation', MAIN_FRAME_NAVIGATION);
      show(sender, 'n1', 'tag-1');

      sender.emit('did-navigate');

      expect(nativeFor('n1').closeCalls).toBe(1);
      expect(sender.send).not.toHaveBeenCalled();
    });

    it.each([
      ['an in-page navigation', { isMainFrame: true, isSameDocument: true }],
      ['a subframe navigation', { isMainFrame: false, isSameDocument: false }],
    ])('keeps instances live across %s', async (_name, details) => {
      const { show } = await loadPageHelpers();
      const sender = makeSender(1);
      show(sender, 'n1', 'tag-1');

      sender.emit('did-start-navigation', details);
      nativeFor('n1').simulateClick();

      expect(sender.send.mock.calls).toEqual([lifecycleEvent('click', 'n1')]);
    });

    it('releases instances silently when the sender is destroyed', async () => {
      const { show } = await loadPageHelpers();
      const sender = makeSender(1);
      show(sender, 'n1', 'tag-1');
      const native = nativeFor('n1');
      const replayStale = captureStaleCallbacks(native);

      sender.destroy();
      replayStale();

      expect(native.closeCalls).toBe(1);
      expect(sender.send).not.toHaveBeenCalled();
      expect(focusNotificationSourceMock).not.toHaveBeenCalled();
      expect(sender.listenerCount('did-start-navigation')).toBe(0);
    });

    it('cleanup settles every instance silently and leaves late callbacks inert', async () => {
      const { mod, show, closeFromPage } = await loadPageHelpers();
      const sender = makeSender(1);
      show(sender, 'n1', 'tag-1');
      show(sender, 'n2', 'tag-2');
      const natives = [nativeFor('n1'), nativeFor('n2')];
      const replays = natives.map(captureStaleCallbacks);

      mod.cleanupActiveNativeNotifications();
      for (const replay of replays) replay();

      expect(natives.map((n) => n.closeCalls)).toEqual([1, 1]);
      expect(sender.send).not.toHaveBeenCalled();
      expect(focusNotificationSourceMock).not.toHaveBeenCalled();
      expect(sender.listenerCount('did-start-navigation')).toBe(0);
      expect(closeFromPage(sender, 'n1')).toBe(false);
    });
  });
});
