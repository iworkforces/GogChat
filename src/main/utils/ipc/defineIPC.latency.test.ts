import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants.js';
import { asType } from '../../../shared/typeUtils.js';
import { asAccountIndex } from '../../../shared/types/branded.js';

const mocks = vi.hoisted(() => ({ account: vi.fn(), peek: vi.fn() }));
vi.mock('../lifecycle/featureContextStore.js', () => ({
  getSharedFeatureContext: () => ({ accountWindowManager: mocks.peek() }),
}));
vi.mock('../../../environment.js', () => ({ default: { isDev: false } }));
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('electron', () => ({ app: { getVersion: () => 'test' } }));

import {
  getPerformanceMonitor,
  destroyPerformanceMonitor,
} from '../lifecycle/performanceMonitor.js';
import { runIPCHandler, startIPCHandlerSpan } from './defineIPC.js';

const sender = (destroyed = false) =>
  asType<IpcMainEvent>({ sender: { id: 91, isDestroyed: () => destroyed } });
const context = (event = sender()) => ({
  channel: IPC_CHANNELS.CHECK_IF_ONLINE,
  kind: 'on' as const,
  event,
});

describe('IPC handler execution spans', () => {
  let now = 100;
  beforeEach(() => {
    destroyPerformanceMonitor();
    now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    mocks.account.mockReset().mockReturnValue(asAccountIndex(2));
    mocks.peek.mockReset().mockReturnValue({ getAccountForWebContents: mocks.account });
  });
  afterEach(() => {
    destroyPerformanceMonitor();
    vi.restoreAllMocks();
  });

  it('returns synchronously and records the exact execution time and registry account', () => {
    const result = runIPCHandler(context(), () => {
      now += 4.25;
      return 7;
    });
    expect(result).toBe(7);
    expect(getPerformanceMonitor().getIpcLatencySamples()).toEqual([
      expect.objectContaining({
        channel: IPC_CHANNELS.CHECK_IF_ONLINE,
        kind: 'on',
        durationMs: 4.25,
        accountIndex: 2,
      }),
    ]);
    expect(mocks.account).toHaveBeenCalledWith(91);
  });

  it.each(['resolve', 'reject'] as const)(
    'records once when a promise settles by %s',
    async (outcome) => {
      const error = new Error('failure');
      const pending = Promise.withResolvers<number>();
      const result = runIPCHandler(context(), () => pending.promise);
      expect(getPerformanceMonitor().getIpcLatencySamples()).toEqual([]);
      now = 108;
      if (outcome === 'resolve') {
        pending.resolve(5);
        await expect(result).resolves.toBe(5);
      } else {
        pending.reject(error);
        await expect(result).rejects.toBe(error);
      }
      expect(getPerformanceMonitor().getIpcLatencySamples()).toEqual([
        expect.objectContaining({ durationMs: 8 }),
      ]);
    }
  );

  it('records a synchronous throw without replacing the error', () => {
    const error = new Error('failure');
    expect(() =>
      runIPCHandler(context(), () => {
        now = 103;
        throw error;
      })
    ).toThrow(error);
    expect(getPerformanceMonitor().getIpcLatencySamples()).toEqual([
      expect.objectContaining({ durationMs: 3 }),
    ]);
  });

  it('settles a custom thenable and records once', async () => {
    const thenable = asType<Promise<number>>(
      // oxlint-disable-next-line unicorn/no-thenable -- Deliberately exercise PromiseLike settlement.
      Object.defineProperty({}, 'then', {
        value: (resolve: (value: number) => void) => {
          now = 106;
          resolve(9);
        },
      })
    );
    await expect(runIPCHandler(context(), () => thenable)).resolves.toBe(9);
    expect(getPerformanceMonitor().getIpcLatencySamples()).toEqual([
      expect.objectContaining({ durationMs: 6 }),
    ]);
  });

  it('records without account identity when the sender is absent', () => {
    runIPCHandler({ ...context(), event: asType<IpcMainEvent>({}) }, () => 1);
    expect(getPerformanceMonitor().getIpcLatencySamples()).toEqual([
      {
        timestamp: expect.any(Number),
        channel: IPC_CHANNELS.CHECK_IF_ONLINE,
        kind: 'on',
        durationMs: 0,
      },
    ]);
    expect(mocks.peek).not.toHaveBeenCalled();
  });

  it.each(['absent', 'unregistered', 'destroyed'] as const)(
    'omits account identity for an %s sender',
    (state) => {
      if (state === 'absent') mocks.peek.mockReturnValue(null);
      if (state === 'unregistered') mocks.account.mockReturnValue(null);
      runIPCHandler(context(sender(state === 'destroyed')), () => undefined);
      expect(getPerformanceMonitor().getIpcLatencySamples()).toEqual([
        expect.objectContaining({ durationMs: 0 }),
      ]);
      expect(getPerformanceMonitor().getIpcLatencySamples()[0]).not.toHaveProperty('accountIndex');
      if (state === 'destroyed') expect(mocks.peek).not.toHaveBeenCalled();
    }
  );

  it('skips clocks and sampling when disabled without changing the return', () => {
    getPerformanceMonitor().setEnabled(false);
    expect(runIPCHandler(context(), () => false)).toBe(false);
    expect(startIPCHandlerSpan({ ...context(), kind: 'fast' })).toBeUndefined();
    expect(performance.now).not.toHaveBeenCalled();
    expect(getPerformanceMonitor().getIpcLatencySamples()).toEqual([]);
  });

  it('keeps a late completion out of the next monitor after destruction', async () => {
    const pending = Promise.withResolvers<number>();
    const result = runIPCHandler(context(), () => pending.promise);
    destroyPerformanceMonitor();
    const next = getPerformanceMonitor();
    now = 120;
    pending.resolve(1);
    await result;
    expect(next.getIpcLatencySamples()).toEqual([]);
  });

  it('records a falsy synchronous result without allocating a promise', () => {
    expect(runIPCHandler(context(), () => 0)).toBe(0);
    expect(getPerformanceMonitor().getIpcLatencySamples()).toEqual([
      expect.objectContaining({ durationMs: 0 }),
    ]);
  });
});
