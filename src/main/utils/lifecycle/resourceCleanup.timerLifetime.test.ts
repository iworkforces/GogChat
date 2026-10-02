import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cleanup from './resourceCleanup.js';

vi.mock('./logger.js', () => ({
  logger: {
    feature: () => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
    main: { debug: vi.fn() },
  },
}));

describe('tracked timer registration lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cleanup.getCleanupManager().reset();
  });

  afterEach(() => {
    cleanup.destroyCleanupManager();
    vi.useRealTimers();
  });

  it('releases the real abort listener before a timeout callback runs', () => {
    const signal = cleanup.getCleanupManager()['timerAborter'].signal;
    const observed: number[] = [];
    cleanup.createTrackedTimeout(
      () => observed.push(getEventListeners(signal, 'abort').length),
      10
    );
    expect(getEventListeners(signal, 'abort')).toHaveLength(1);

    vi.advanceTimersByTime(10);

    expect(observed).toEqual([0]);
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });

  it('releases registration before a throwing callback', () => {
    const signal = cleanup.getCleanupManager()['timerAborter'].signal;
    const failure = new Error('callback failure');
    cleanup.createTrackedTimeout(() => {
      throw failure;
    }, 10);

    expect(() => vi.advanceTimersByTime(10)).toThrow(failure);

    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });

  it('releases registration before callback-triggered cleanup', async () => {
    const manager = cleanup.getCleanupManager();
    const signal = manager['timerAborter'].signal;
    let listenersAtCleanup = -1;
    let completion: Promise<void> | undefined;
    cleanup.createTrackedTimeout(() => {
      listenersAtCleanup = getEventListeners(signal, 'abort').length;
      completion = manager.cleanup();
    }, 10);

    vi.advanceTimersByTime(10);
    await completion;

    expect(listenersAtCleanup).toBe(0);
  });

  it('does not retain callbacks after a thousand sequential completions', () => {
    const signal = cleanup.getCleanupManager()['timerAborter'].signal;
    for (let index = 0; index < 1000; index++) {
      cleanup.createTrackedTimeout(() => {}, 1);
      vi.advanceTimersByTime(1);
    }

    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });

  it('keeps one interval registration across ticks and releases it on repeated owned cancellation', () => {
    const signal = cleanup.getCleanupManager()['timerAborter'].signal;
    const callback = vi.fn();
    const interval = cleanup.createTrackedInterval(callback, 10);
    vi.advanceTimersByTime(30);
    expect(callback).toHaveBeenCalledTimes(3);
    expect(getEventListeners(signal, 'abort')).toHaveLength(1);

    cleanup.cancelTrackedInterval(interval);
    cleanup.cancelTrackedInterval(interval);
    vi.advanceTimersByTime(30);

    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it('releases a pending timeout on repeated owned cancellation without firing it', () => {
    const signal = cleanup.getCleanupManager()['timerAborter'].signal;
    const callback = vi.fn();
    const timeout = cleanup.createTrackedTimeout(callback, 10);

    cleanup.cancelTrackedTimeout(timeout);
    cleanup.cancelTrackedTimeout(timeout);
    vi.advanceTimersByTime(10);

    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not retain registrations after a thousand owned cancellations', () => {
    const signal = cleanup.getCleanupManager()['timerAborter'].signal;
    const callback = vi.fn();
    for (let index = 0; index < 1000; index++) {
      cleanup.cancelTrackedTimeout(cleanup.createTrackedTimeout(callback, 10));
      cleanup.cancelTrackedInterval(cleanup.createTrackedInterval(callback, 10));
    }
    vi.advanceTimersByTime(20);

    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    expect(callback).not.toHaveBeenCalled();
  });

  it.each(['cleanup', 'reset', 'destroy'] as const)(
    'releases old registrations and preserves fresh generation work after %s',
    async (operation) => {
      const manager = cleanup.getCleanupManager();
      const oldSignal = manager['timerAborter'].signal;
      const stale = vi.fn();
      const oldTimeout = cleanup.createTrackedTimeout(stale, 10);
      const oldInterval = cleanup.createTrackedInterval(stale, 10);
      if (operation === 'cleanup') await manager.cleanup();
      else if (operation === 'reset') manager.reset();
      else cleanup.destroyCleanupManager();
      expect(oldSignal.aborted).toBe(true);
      expect(getEventListeners(oldSignal, 'abort')).toHaveLength(0);

      const freshManager = cleanup.getCleanupManager();
      const freshSignal = freshManager['timerAborter'].signal;
      const fresh = vi.fn();
      cleanup.createTrackedTimeout(fresh, 10);
      cleanup.cancelTrackedTimeout(oldTimeout);
      cleanup.cancelTrackedInterval(oldInterval);
      if (operation === 'destroy') await manager.cleanup();
      expect(freshSignal).not.toBe(oldSignal);
      expect(freshSignal.aborted).toBe(false);
      expect(getEventListeners(freshSignal, 'abort')).toHaveLength(1);
      vi.advanceTimersByTime(10);

      expect(fresh).toHaveBeenCalledTimes(1);
      expect(stale).not.toHaveBeenCalled();
      expect(getEventListeners(freshSignal, 'abort')).toHaveLength(0);
    }
  );

  it('still aborts pending helper timers after legacy untracking', async () => {
    const manager = cleanup.getCleanupManager();
    const signal = manager['timerAborter'].signal;
    const callback = vi.fn();
    const timeout = cleanup.createTrackedTimeout(callback, 10);
    const interval = cleanup.createTrackedInterval(callback, 10);
    manager.trackTimeout(timeout);
    manager.trackInterval(interval);
    manager.untrackTimeout(timeout);
    manager.untrackInterval(interval);
    expect(getEventListeners(signal, 'abort')).toHaveLength(2);

    await manager.cleanup();
    vi.advanceTimersByTime(20);

    expect(callback).not.toHaveBeenCalled();
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });

  it('allows a fresh timer created inside cleanup to finish', async () => {
    const manager = cleanup.getCleanupManager();
    const callback = vi.fn();
    manager.registerTask({
      name: 'fresh timer',
      cleanup: () => {
        cleanup.createTrackedTimeout(callback, 10);
      },
    });

    await manager.cleanup();
    vi.advanceTimersByTime(10);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(getEventListeners(manager['timerAborter'].signal, 'abort')).toHaveLength(0);
  });

  it('releases registrations promptly while cleanup tasks are still pending', async () => {
    const manager = cleanup.getCleanupManager();
    const signal = manager['timerAborter'].signal;
    const task = Promise.withResolvers<void>();
    manager.registerTask({ name: 'pending task', cleanup: () => task.promise });
    cleanup.createTrackedTimeout(() => {}, 10);
    cleanup.createTrackedInterval(() => {}, 10);

    const completion = manager.cleanup();

    expect(signal.aborted).toBe(true);
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    task.resolve();
    await completion;
  });

  it('does not cancel a replacement singleton when old cleanup finishes asynchronously', async () => {
    const manager = cleanup.getCleanupManager();
    const task = Promise.withResolvers<void>();
    manager.registerTask({ name: 'pending task', cleanup: () => task.promise });
    const oldTimeout = cleanup.createTrackedTimeout(() => {}, 10);
    cleanup.destroyCleanupManager();
    const freshManager = cleanup.getCleanupManager();
    const signal = freshManager['timerAborter'].signal;
    const callback = vi.fn();
    cleanup.createTrackedTimeout(callback, 10);

    cleanup.cancelTrackedTimeout(oldTimeout);
    task.resolve();
    await manager.cleanup();
    vi.advanceTimersByTime(10);

    expect(signal.aborted).toBe(false);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });

  it('returns native timeout handles and releases before real clock completion', async () => {
    vi.useRealTimers();
    const signal = cleanup.getCleanupManager()['timerAborter'].signal;
    const completion = Promise.withResolvers<void>();
    let listenersAtCompletion = -1;
    const timeout = cleanup.createTrackedTimeout(() => {
      listenersAtCompletion = getEventListeners(signal, 'abort').length;
      completion.resolve();
    }, 0);
    expect(timeout.ref()).toBe(timeout);
    expect(timeout.unref()).toBe(timeout);
    expect(timeout.hasRef()).toBe(false);
    timeout.ref();

    await completion.promise;

    expect(listenersAtCompletion).toBe(0);
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });
});
