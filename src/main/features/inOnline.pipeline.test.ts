/**
 * Real defineIPC pipeline for CHECK_IF_ONLINE.
 * Proves a same-sender replacement is not dropped before supersession.
 */
/* global AbortSignal */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { electronMock } from '../../../tests/mocks/electron';
import { IPC_CHANNELS } from '../../shared/constants.js';

vi.mock('electron', () => electronMock);

vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../utils/ipc/rateLimiter.js', () => ({
  getRateLimiter: () => ({
    isAllowed: vi.fn(() => true),
  }),
}));

vi.mock('../utils/platform/iconCache.js', () => ({
  getIconCache: () => ({
    getIcon: vi.fn(() => ({})),
  }),
}));

function makeSenderEvent(id: number) {
  const sender = new EventEmitter() as EventEmitter & {
    id: number;
    isDestroyed: () => boolean;
  };
  sender.id = id;
  sender.isDestroyed = () => false;
  return {
    sender,
    reply: vi.fn(),
  };
}

describe('inOnline defineIPC pipeline', () => {
  beforeEach(() => {
    electronMock.reset();
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('runs a same-sender replacement through real defineIPC without dropping it', async () => {
    vi.useFakeTimers();
    const pending: Array<{
      resolve: (value: { ok: boolean }) => void;
      aborted: boolean;
    }> = [];
    const fetchMock = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise<{ ok: boolean }>((resolve, reject) => {
        const signal = init?.signal;
        const entry = { resolve, aborted: Boolean(signal?.aborted) };
        const onAbort = (): void => {
          entry.aborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        };
        if (signal?.aborted) {
          onAbort();
          pending.push(entry);
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        pending.push(entry);
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const feature = await import('./inOnline.js');
    feature.default({} as never);

    const event = makeSenderEvent(7);
    electronMock.ipcMain.emit(IPC_CHANNELS.CHECK_IF_ONLINE, event, { attemptId: 'one' });
    electronMock.ipcMain.emit(IPC_CHANNELS.CHECK_IF_ONLINE, event, { attemptId: 'two' });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(pending[0]?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(feature.ONLINE_FETCH_MIN_INTERVAL_MS);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    pending[1]?.resolve({ ok: true });
    await vi.waitFor(() =>
      expect(event.reply).toHaveBeenCalledWith(IPC_CHANNELS.ONLINE_STATUS, {
        attemptId: 'two',
        outcome: 'online',
      })
    );
    expect(event.reply).toHaveBeenCalledTimes(1);
    feature.cleanupConnectivityHandler();
  });

  it('validates cancellation through the real IPC pipeline and aborts without a reply', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
        signal = init?.signal;
        return new Promise((_resolve, reject) =>
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            {
              once: true,
            }
          )
        );
      })
    );
    const feature = await import('./inOnline.js');
    feature.default();
    const event = makeSenderEvent(9);
    electronMock.ipcMain.emit(IPC_CHANNELS.CHECK_IF_ONLINE, event, { attemptId: 'current' });
    electronMock.ipcMain.emit(IPC_CHANNELS.CHECK_IF_ONLINE, event, {
      attemptId: 'current',
      operation: 'cancel',
    });
    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(event.reply).not.toHaveBeenCalled();
    feature.cleanupConnectivityHandler();
  });
});
