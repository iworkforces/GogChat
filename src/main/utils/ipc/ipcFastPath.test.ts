/**
 * Coverage for ipcFastPath validation and error paths.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants.js';
import { asType } from '../../../shared/typeUtils.js';
import type * as RateLimiterModule from './rateLimiter.js';

const onMock = vi.fn();
const removeListenerMock = vi.fn();
const isAllowedMock = vi.fn().mockReturnValue(true);

const eventForSender = (id: number): IpcMainEvent =>
  asType<IpcMainEvent>({ sender: { id, isDestroyed: () => false } });

function registeredListener(): (event: IpcMainEvent, data: unknown) => void {
  return asType<(event: IpcMainEvent, data: unknown) => void>(onMock.mock.calls[0]?.[1]);
}

vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  ipcMain: {
    on: (...args: unknown[]) => onMock(...args),
    removeListener: (...args: unknown[]) => removeListenerMock(...args),
  },
}));

vi.mock('../../../environment.js', () => ({ default: { isDev: false } }));

vi.mock('./rateLimiter.js', () => ({
  getRateLimiter: () => ({ isAllowed: isAllowedMock }),
}));

const warnMock = vi.fn();
const errorMock = vi.fn();
vi.mock('../lifecycle/logger.js', () => ({
  logger: {
    feature: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    ipc: {
      warn: (...args: unknown[]) => warnMock(...args),
      error: (...args: unknown[]) => errorMock(...args),
    },
  },
}));

vi.mock('../lifecycle/errorUtils.js', () => ({
  toErrorMessage: (e: unknown) => String(e),
}));

describe('registerFastHandler', () => {
  beforeEach(() => {
    vi.resetModules();
    onMock.mockClear();
    removeListenerMock.mockClear();
    isAllowedMock.mockReset().mockReturnValue(true);
    warnMock.mockClear();
    errorMock.mockClear();
  });

  it('registers and invokes handler with validated data and event', async () => {
    const { registerFastHandler } = await import('./ipcFastPath.js');
    const handler = vi.fn();
    const off = registerFastHandler({
      channel: IPC_CHANNELS.UNREAD_COUNT,
      rateLimit: 5,
      validator: (d) => Number(d),
      handler,
    });

    expect(onMock).toHaveBeenCalled();
    const listener = registeredListener();
    const event = eventForSender(11);
    listener(event, 3);
    expect(handler).toHaveBeenCalledWith(3, event);
    expect(isAllowedMock).toHaveBeenCalledWith(IPC_CHANNELS.UNREAD_COUNT, 5, 11);

    off();
    expect(removeListenerMock).toHaveBeenCalled();
  });

  it('skips when rate limited', async () => {
    isAllowedMock.mockReturnValue(false);
    const { registerFastHandler } = await import('./ipcFastPath.js');
    const handler = vi.fn();
    registerFastHandler({
      channel: IPC_CHANNELS.UNREAD_COUNT,
      rateLimit: 5,
      validator: (d) => d,
      handler,
    });
    const listener = registeredListener();
    listener(eventForSender(11), 1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('logs and skips when validation throws', async () => {
    const { registerFastHandler } = await import('./ipcFastPath.js');
    const handler = vi.fn();
    registerFastHandler({
      channel: IPC_CHANNELS.UNREAD_COUNT,
      rateLimit: 5,
      validator: () => {
        throw new Error('bad');
      },
      handler,
    });
    const listener = registeredListener();
    expect(() => listener(eventForSender(11), 1)).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalled();
  });

  it('logs when handler throws', async () => {
    const { registerFastHandler } = await import('./ipcFastPath.js');
    registerFastHandler({
      channel: IPC_CHANNELS.UNREAD_COUNT,
      rateLimit: 5,
      validator: (d) => d,
      handler: () => {
        throw new Error('handler boom');
      },
    });
    const listener = registeredListener();
    expect(() => listener(eventForSender(11), 1)).not.toThrow();
    expect(errorMock).toHaveBeenCalled();
  });

  it('keeps interleaved sender quotas independent with the existing limiter', async () => {
    const { IPCRateLimiter } = await vi.importActual<typeof RateLimiterModule>('./rateLimiter.js');
    const limiter = new IPCRateLimiter();
    isAllowedMock.mockImplementation((channel: string, limit: number, senderId: number) =>
      limiter.isAllowed(channel, limit, senderId)
    );
    const { registerFastHandler } = await import('./ipcFastPath.js');
    const handler = vi.fn();
    const validator = vi.fn((value: unknown) => Number(value));
    const cleanup = registerFastHandler({
      channel: IPC_CHANNELS.UNREAD_COUNT,
      rateLimit: 2,
      validator,
      handler,
    });
    const listener = registeredListener();
    const first = eventForSender(11);
    const second = eventForSender(22);

    try {
      listener(first, 1);
      listener(second, 10);
      listener(first, 2);
      listener(first, 3);
      listener(second, 20);
      listener(second, 30);

      expect(handler.mock.calls).toEqual([
        [1, first],
        [10, second],
        [2, first],
        [20, second],
      ]);
      expect(validator).toHaveBeenCalledTimes(4);
    } finally {
      cleanup();
      limiter.destroy();
    }
  });
});
