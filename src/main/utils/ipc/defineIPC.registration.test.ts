import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants.js';
import { asType } from '../../../shared/typeUtils.js';

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: IpcMainEvent, payload: unknown) => unknown>(),
  allowed: vi.fn(() => true),
  deduplicate: vi.fn((_key: string, execute: () => Promise<unknown>) => execute()),
}));
vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  ipcMain: {
    on: (channel: string, listener: (event: IpcMainEvent, payload: unknown) => unknown) =>
      mocks.listeners.set(channel, listener),
    handle: (channel: string, listener: (event: IpcMainEvent, payload: unknown) => unknown) =>
      mocks.listeners.set(channel, listener),
    removeListener: vi.fn(),
    removeHandler: vi.fn(),
  },
}));
vi.mock('../../../environment.js', () => ({ default: { isDev: false } }));
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('../lifecycle/logger.js', () => ({
  logger: { ipc: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('./rateLimiter.js', () => ({ getRateLimiter: () => ({ isAllowed: mocks.allowed }) }));
vi.mock('./ipcDeduplicator.js', () => ({
  getDeduplicator: () => ({ deduplicate: mocks.deduplicate }),
}));

import { defineIPC } from './defineIPC.js';
import { registerFastHandler } from './ipcFastPath.js';
import {
  destroyPerformanceMonitor,
  getPerformanceMonitor,
} from '../lifecycle/performanceMonitor.js';

const channel = IPC_CHANNELS.CHECK_IF_ONLINE;
const event = () =>
  asType<IpcMainEvent>({ sender: { id: 97, isDestroyed: () => false }, reply: vi.fn() });
const samples = () => getPerformanceMonitor().getIpcLatencySamples();
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
const dispatch = (sender = event()) => mocks.listeners.get(channel)?.(sender, 1);

describe('registered IPC latency producers', () => {
  let now = 10;
  beforeEach(() => {
    destroyPerformanceMonitor();
    mocks.listeners.clear();
    now = 10;
    mocks.allowed.mockReset().mockReturnValue(true);
    mocks.deduplicate.mockReset().mockImplementation((_key, execute) => execute());
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    destroyPerformanceMonitor();
    vi.restoreAllMocks();
  });

  it.each(['on', 'reply', 'invoke'] as const)(
    'records one exact sample for %s before reply transport',
    async (kind) => {
      defineIPC({
        kind,
        channel,
        validator: () => undefined,
        handler: () => {
          now += 2.5;
          return asType<never>('result');
        },
      });
      const sender = event();
      vi.mocked(sender.reply).mockImplementation(() => {
        expect(samples()).toHaveLength(1);
        now += 100;
      });
      const result = dispatch(sender);
      await result;
      await flush();
      expect(samples()).toEqual([expect.objectContaining({ channel, kind, durationMs: 2.5 })]);
      expect(Number.isFinite(samples()[0]?.durationMs)).toBe(true);
      if (kind === 'invoke') expect(await result).toBe('result');
      if (kind === 'reply')
        expect(sender.reply).toHaveBeenCalledWith(`${channel}-reply`, {
          success: true,
          data: 'result',
        });
    }
  );

  it.each(['on', 'reply', 'invoke'] as const)(
    'records one sample for a throwing %s handler',
    async (kind) => {
      defineIPC({
        kind,
        channel,
        validator: () => undefined,
        handler: () => {
          now += 3;
          throw new Error('boom');
        },
      });
      const sender = event();
      if (kind === 'invoke') await expect(dispatch(sender)).rejects.toThrow('boom');
      else {
        dispatch(sender);
        await flush();
      }
      expect(samples()).toEqual([expect.objectContaining({ channel, kind, durationMs: 3 })]);
      if (kind === 'reply')
        expect(sender.reply).toHaveBeenCalledWith(`${channel}-reply`, {
          success: false,
          error: 'boom',
        });
    }
  );

  it.each(['on', 'reply', 'invoke'] as const)(
    'records one sample for a rejecting %s handler',
    async (kind) => {
      defineIPC({
        kind,
        channel,
        validator: () => undefined,
        handler: async () => {
          await Promise.resolve();
          now += 4;
          throw new Error('reject');
        },
      });
      if (kind === 'invoke') await expect(dispatch()).rejects.toThrow('reject');
      else {
        dispatch();
        await flush();
      }
      expect(samples()).toEqual([expect.objectContaining({ channel, kind, durationMs: 4 })]);
    }
  );

  it.each(['rate', 'validation', 'disabled'] as const)(
    'adds no sample when %s prevents timing',
    async (reason) => {
      if (reason === 'rate') mocks.allowed.mockReturnValue(false);
      if (reason === 'disabled') getPerformanceMonitor().setEnabled(false);
      defineIPC({
        kind: 'on',
        channel,
        rateLimit: 1,
        validator: () => {
          if (reason === 'validation') throw new Error('payload');
        },
        handler: () => {
          now += 1;
        },
      });
      dispatch();
      await flush();
      expect(samples()).toEqual([]);
      expect(performance.now).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])(
    'only samples the owner of deduplicated work (payload key=%s)',
    async (payloadKey) => {
      const pending = Promise.withResolvers<string>();
      let shared: Promise<unknown> | undefined;
      mocks.deduplicate.mockImplementation((_key, execute) => (shared ??= execute()));
      const handler = vi.fn(() => pending.promise);
      defineIPC({
        kind: 'invoke',
        channel,
        validator: () => 1,
        handler,
        ...(payloadKey ? { withDeduplication: { keyFn: () => 'key' } } : { deduplicate: true }),
      });
      const first = dispatch();
      const joined = dispatch();
      expect(samples()).toEqual([]);
      now = 15;
      pending.resolve('shared');
      expect(await first).toBe('shared');
      expect(await joined).toBe('shared');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(samples()).toEqual([expect.objectContaining({ durationMs: 5, kind: 'invoke' })]);
    }
  );

  it.each([false, true])(
    'keeps the fast path synchronous and records even when throwing=%s',
    (throws) => {
      registerFastHandler({
        channel,
        rateLimit: 5,
        validator: (value) => value,
        handler: () => {
          now += 1.25;
          if (throws) throw new Error('fast');
        },
      });
      expect(dispatch()).toBeUndefined();
      expect(samples()).toEqual([
        expect.objectContaining({ channel, kind: 'fast', durationMs: 1.25 }),
      ]);
    }
  );

  it.each(['rate', 'validation', 'disabled'] as const)(
    'fast path adds no sample for %s',
    (reason) => {
      if (reason === 'rate') mocks.allowed.mockReturnValue(false);
      if (reason === 'disabled') getPerformanceMonitor().setEnabled(false);
      registerFastHandler({
        channel,
        rateLimit: 1,
        validator: () => {
          if (reason === 'validation') throw new Error('payload');
        },
        handler: vi.fn(),
      });
      dispatch();
      expect(samples()).toEqual([]);
      expect(performance.now).not.toHaveBeenCalled();
    }
  );
});
