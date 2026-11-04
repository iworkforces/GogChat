// @vitest-environment jsdom

/**
 * Offline preload recovery: false replies must not reload; true replaces once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcRenderer: { send: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

const appUrl = 'https://mail.google.com/chat/u/0';

vi.mock('../urls.js', () => ({
  default: { appUrl: 'https://mail.google.com/chat/u/0' },
}));

import type { OnlineStatusData } from '../shared/types/domain.js';
import {
  handleOnlineStatus,
  handleCheckOnline,
  installOffline,
  clearOfflineCheck,
  ONLINE_CHECK_FAILED_EVENT,
  ONLINE_CHECK_DEADLINE_MS,
} from './offline.js';

describe('preload offline recovery', () => {
  let locationReplace: ReturnType<typeof vi.fn>;
  let locationReload: ReturnType<typeof vi.fn>;
  let failedEventCount: number;
  let failureDetails: unknown[];
  let onFailed: (event: Event) => void;

  beforeEach(() => {
    locationReplace = vi.fn();
    locationReload = vi.fn();
    failedEventCount = 0;
    failureDetails = [];
    onFailed = (event) => {
      failedEventCount += 1;
      failureDetails.push(event instanceof window.CustomEvent ? event.detail : undefined);
    };

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        replace: locationReplace,
        reload: locationReload,
        href: 'file:///offline.html',
      },
    });

    window.addEventListener(ONLINE_CHECK_FAILED_EVENT, onFailed);
  });

  afterEach(() => {
    window.removeEventListener(ONLINE_CHECK_FAILED_EVENT, onFailed);
    clearOfflineCheck();
    vi.useRealTimers();
  });

  it('does not reload on false online-status replies and signals the offline page', () => {
    handleOnlineStatus({ attemptId: handleCheckOnline(), outcome: 'network-error' });
    handleOnlineStatus({ attemptId: handleCheckOnline(), outcome: 'network-error' });
    handleOnlineStatus({ attemptId: handleCheckOnline(), outcome: 'network-error' });

    expect(locationReload).not.toHaveBeenCalled();
    expect(locationReplace).not.toHaveBeenCalled();
    expect(failedEventCount).toBe(3);
  });

  it('replaces with app URL exactly once on the current successful attempt', () => {
    handleOnlineStatus({ attemptId: handleCheckOnline(), outcome: 'network-error' });
    handleOnlineStatus({ attemptId: handleCheckOnline(), outcome: 'online' });

    expect(locationReload).not.toHaveBeenCalled();
    expect(locationReplace).toHaveBeenCalledTimes(1);
    expect(locationReplace).toHaveBeenCalledWith(appUrl);
    expect(failedEventCount).toBe(1);
  });

  it('ignores an older result after a newer retry begins', () => {
    const first = handleCheckOnline();
    const second = handleCheckOnline();
    handleOnlineStatus({ attemptId: first, outcome: 'online' });
    expect(locationReplace).not.toHaveBeenCalled();
    expect(failedEventCount).toBe(0);

    handleOnlineStatus({ attemptId: second, outcome: 'network-error' });
    expect(locationReplace).not.toHaveBeenCalled();
    expect(failedEventCount).toBe(1);
  });

  it('ignores an unknown attemptId so it cannot clear the deadline or navigate', () => {
    vi.useFakeTimers();
    handleCheckOnline();
    handleOnlineStatus({ attemptId: 'unknown', outcome: 'online' });
    handleOnlineStatus({ attemptId: 'unknown', outcome: 'network-error' });
    expect(locationReplace).not.toHaveBeenCalled();
    expect(failedEventCount).toBe(0);
    vi.advanceTimersByTime(ONLINE_CHECK_DEADLINE_MS);
    expect(failedEventCount).toBe(1);
    expect(locationReload).not.toHaveBeenCalled();
  });

  it('resets the 6s deadline when a newer check starts mid-window', () => {
    vi.useFakeTimers();
    handleCheckOnline();
    vi.advanceTimersByTime(ONLINE_CHECK_DEADLINE_MS / 2);
    expect(failedEventCount).toBe(0);
    handleCheckOnline();
    vi.advanceTimersByTime(ONLINE_CHECK_DEADLINE_MS / 2);
    expect(failedEventCount).toBe(0);
    expect(locationReplace).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ONLINE_CHECK_DEADLINE_MS / 2);
    expect(failedEventCount).toBe(1);
    expect(locationReload).not.toHaveBeenCalled();
  });

  it('ignores a stale response after the 6s deadline', () => {
    vi.useFakeTimers();
    const attemptId = handleCheckOnline();
    vi.advanceTimersByTime(ONLINE_CHECK_DEADLINE_MS);
    expect(failedEventCount).toBe(1);
    handleOnlineStatus({ attemptId, outcome: 'online' });
    handleOnlineStatus({ attemptId, outcome: 'network-error' });
    expect(locationReplace).not.toHaveBeenCalled();
    expect(failedEventCount).toBe(1);
    expect(locationReload).not.toHaveBeenCalled();
  });

  it('forwards checkIfOnline through the bridge with the current attemptId', () => {
    const checkIfOnline = vi.fn();
    window.gogchat = {
      sendUnreadCount: vi.fn(),
      sendFaviconChanged: vi.fn(),
      sendNotificationClicked: vi.fn(),
      checkIfOnline,
      reportPasskeyFailure: vi.fn(),
      onSearchShortcut: vi.fn(() => () => {}),
      onOnlineStatus: vi.fn(() => () => {}),
    };
    const attemptId = handleCheckOnline();
    expect(checkIfOnline).toHaveBeenCalledTimes(1);
    expect(checkIfOnline).toHaveBeenCalledWith(attemptId);
  });

  it('dispatches one failure event when the 6s deadline elapses', () => {
    vi.useFakeTimers();
    handleCheckOnline();
    expect(failedEventCount).toBe(0);
    vi.advanceTimersByTime(ONLINE_CHECK_DEADLINE_MS);
    expect(failedEventCount).toBe(1);
    vi.advanceTimersByTime(ONLINE_CHECK_DEADLINE_MS);
    expect(failedEventCount).toBe(1);
    expect(locationReload).not.toHaveBeenCalled();
  });

  it('clears the deadline on a false response so timeout does not fire', () => {
    vi.useFakeTimers();
    const attemptId = handleCheckOnline();
    handleOnlineStatus({ attemptId, outcome: 'network-error' });
    vi.advanceTimersByTime(ONLINE_CHECK_DEADLINE_MS);
    expect(failedEventCount).toBe(1);
    expect(locationReload).not.toHaveBeenCalled();
  });

  it('unload cancels the deadline and ignores a later status for that attempt', () => {
    vi.useFakeTimers();
    const checkIfOnline = vi.fn();
    const listeners: Array<(status: OnlineStatusData) => void> = [];
    window.gogchat = {
      sendUnreadCount: vi.fn(),
      sendFaviconChanged: vi.fn(),
      sendNotificationClicked: vi.fn(),
      checkIfOnline,
      reportPasskeyFailure: vi.fn(),
      onSearchShortcut: vi.fn(() => () => {}),
      onOnlineStatus: (callback) => {
        listeners.push(callback);
        return () => {
          const index = listeners.indexOf(callback);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
        };
      },
    };

    installOffline();
    window.dispatchEvent(new Event('DOMContentLoaded'));
    window.dispatchEvent(new Event('app:checkIfOnline'));
    const attemptId = checkIfOnline.mock.calls[0]?.[0] as string;
    expect(attemptId).toEqual(expect.any(String));

    window.dispatchEvent(new Event('beforeunload'));
    listeners[0]?.({ attemptId, outcome: 'online' });
    vi.advanceTimersByTime(ONLINE_CHECK_DEADLINE_MS);
    expect(locationReplace).not.toHaveBeenCalled();
    expect(failedEventCount).toBe(0);
    expect(locationReload).not.toHaveBeenCalled();
  });

  it('falls back to ipcRenderer when the gogchat bridge is absent', async () => {
    const { ipcRenderer } = await import('electron');
    const { IPC_CHANNELS } = await import('../shared/constants.js');
    delete (window as { gogchat?: unknown }).gogchat;
    vi.mocked(ipcRenderer.on).mockClear();
    vi.mocked(ipcRenderer.send).mockClear();
    vi.mocked(ipcRenderer.removeListener).mockClear();

    installOffline();
    window.dispatchEvent(new Event('DOMContentLoaded'));
    expect(ipcRenderer.on).toHaveBeenCalledWith(IPC_CHANNELS.ONLINE_STATUS, expect.any(Function));

    const statusListener = vi
      .mocked(ipcRenderer.on)
      .mock.calls.find((call) => call[0] === IPC_CHANNELS.ONLINE_STATUS)?.[1] as
      ((event: unknown, data: unknown) => void) | undefined;
    expect(statusListener).toBeTypeOf('function');

    window.dispatchEvent(new Event('app:checkIfOnline'));
    expect(ipcRenderer.send).toHaveBeenCalledWith(IPC_CHANNELS.CHECK_IF_ONLINE, {
      attemptId: expect.any(String),
    });
    const sent = vi
      .mocked(ipcRenderer.send)
      .mock.calls.find((call) => call[0] === IPC_CHANNELS.CHECK_IF_ONLINE);
    const attemptId = (sent?.[1] as { attemptId: string } | undefined)?.attemptId ?? '';

    statusListener?.({}, { attemptId: 'stale', outcome: 'network-error' });
    expect(failedEventCount).toBe(0);
    statusListener?.({}, { attemptId, outcome: 'network-error' });
    expect(failedEventCount).toBe(1);

    window.dispatchEvent(new Event('beforeunload'));
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.ONLINE_STATUS,
      expect.any(Function)
    );
  });

  it('invalidates a cancelled attempt before IPC and ignores its deadline and replies', async () => {
    vi.useFakeTimers();
    const { ipcRenderer } = await import('electron');
    const { IPC_CHANNELS } = await import('../shared/constants.js');
    delete (window as { gogchat?: unknown }).gogchat;
    installOffline();
    window.dispatchEvent(new Event('DOMContentLoaded'));
    const attemptId = handleCheckOnline();
    vi.mocked(ipcRenderer.send).mockImplementationOnce(() => {
      handleOnlineStatus({ attemptId, outcome: 'online' });
    });
    window.dispatchEvent(new Event('app:cancelOnlineCheck'));
    expect(ipcRenderer.send).toHaveBeenLastCalledWith(IPC_CHANNELS.CHECK_IF_ONLINE, {
      operation: 'cancel',
      attemptId,
    });
    handleOnlineStatus({ attemptId, outcome: 'network-error' });
    vi.advanceTimersByTime(ONLINE_CHECK_DEADLINE_MS);
    expect(locationReplace).not.toHaveBeenCalled();
    expect(failedEventCount).toBe(0);
    window.dispatchEvent(new Event('beforeunload'));
  });

  it.each([
    [{ outcome: 'http-error', httpStatus: 503 }],
    [{ outcome: 'network-error' }],
    [{ outcome: 'timeout' }],
  ] as const)('carries the %o failure on the DOM event and never navigates', (failure) => {
    handleOnlineStatus({ attemptId: handleCheckOnline(), ...failure });

    expect(failureDetails).toEqual([failure]);
    expect(locationReplace).not.toHaveBeenCalled();
    expect(locationReload).not.toHaveBeenCalled();
  });

  it('reports the preload deadline with the same timeout detail as a main-side timeout', () => {
    vi.useFakeTimers();
    handleCheckOnline();
    vi.advanceTimersByTime(ONLINE_CHECK_DEADLINE_MS);
    handleOnlineStatus({ attemptId: handleCheckOnline(), outcome: 'timeout' });

    expect(failureDetails).toEqual([{ outcome: 'timeout' }, { outcome: 'timeout' }]);
  });

  it('settles the deadline once when a failure lands one tick before it', () => {
    vi.useFakeTimers();
    const attemptId = handleCheckOnline();
    vi.advanceTimersByTime(ONLINE_CHECK_DEADLINE_MS - 1);
    handleOnlineStatus({ attemptId, outcome: 'http-error', httpStatus: 500 });
    vi.advanceTimersByTime(ONLINE_CHECK_DEADLINE_MS * 2);

    expect(failureDetails).toEqual([{ outcome: 'http-error', httpStatus: 500 }]);
  });

  it('lets a success one tick before the deadline navigate once with no timeout event', () => {
    vi.useFakeTimers();
    const attemptId = handleCheckOnline();
    vi.advanceTimersByTime(ONLINE_CHECK_DEADLINE_MS - 1);
    handleOnlineStatus({ attemptId, outcome: 'online' });
    handleOnlineStatus({ attemptId, outcome: 'online' });
    vi.advanceTimersByTime(ONLINE_CHECK_DEADLINE_MS * 2);

    expect(locationReplace).toHaveBeenCalledTimes(1);
    expect(failedEventCount).toBe(0);
  });

  it.each([
    [{ outcome: 'online' }],
    [{ outcome: 'http-error', httpStatus: 503 }],
    [{ outcome: 'network-error' }],
    [{ outcome: 'timeout' }],
  ] as const)('ignores a late %o reply after the preload deadline fired', (late) => {
    vi.useFakeTimers();
    const attemptId = handleCheckOnline();
    vi.advanceTimersByTime(ONLINE_CHECK_DEADLINE_MS);
    handleOnlineStatus({ attemptId, ...late });

    expect(failureDetails).toEqual([{ outcome: 'timeout' }]);
    expect(locationReplace).not.toHaveBeenCalled();
  });

  it('keeps a superseded attempt from restoring controls or navigating', () => {
    vi.useFakeTimers();
    const first = handleCheckOnline();
    handleCheckOnline();
    handleOnlineStatus({ attemptId: first, outcome: 'http-error', httpStatus: 503 });
    handleOnlineStatus({ attemptId: first, outcome: 'online' });

    expect(failedEventCount).toBe(0);
    expect(locationReplace).not.toHaveBeenCalled();
  });

  it.each([
    ['legacy boolean reply', { attemptId: 'ATTEMPT', online: true }],
    ['unknown outcome', { attemptId: 'ATTEMPT', outcome: 'offline' }],
    ['http-error without status', { attemptId: 'ATTEMPT', outcome: 'http-error' }],
    [
      'http-error with a 2xx status',
      { attemptId: 'ATTEMPT', outcome: 'http-error', httpStatus: 204 },
    ],
    ['status on a non-http outcome', { attemptId: 'ATTEMPT', outcome: 'online', httpStatus: 503 }],
    ['non-object', 'online'],
  ])('lets a malformed %s neither settle the attempt nor navigate over ipc', async (_name, bad) => {
    const { ipcRenderer } = await import('electron');
    delete (window as { gogchat?: unknown }).gogchat;
    vi.mocked(ipcRenderer.on).mockClear();
    vi.mocked(ipcRenderer.send).mockClear();
    installOffline();
    window.dispatchEvent(new Event('DOMContentLoaded'));
    const statusListener = vi.mocked(ipcRenderer.on).mock.calls.at(-1)?.[1] as (
      event: unknown,
      data: unknown
    ) => void;
    window.dispatchEvent(new Event('app:checkIfOnline'));
    const sentRequest = vi.mocked(ipcRenderer.send).mock.calls.at(-1)?.[1] as
      { attemptId: string } | undefined;
    const attemptId = sentRequest?.attemptId ?? '';
    const payload = typeof bad === 'object' ? { ...bad, attemptId } : bad;

    statusListener({}, payload);

    expect(failedEventCount).toBe(0);
    expect(locationReplace).not.toHaveBeenCalled();
    statusListener({}, { attemptId, outcome: 'http-error', httpStatus: 502 });
    expect(failureDetails).toEqual([{ outcome: 'http-error', httpStatus: 502 }]);
    window.dispatchEvent(new Event('beforeunload'));
  });
});
