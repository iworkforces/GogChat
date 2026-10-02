import { EventEmitter, getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CleanupConfig } from './cleanupTypes.js';
import type * as CleanupCoordinator from './resourceCleanupTasks.js';
import {
  createTrackedTimeout,
  destroyCleanupManager,
  getCleanupManager,
  ResourceCleanupManager,
} from './resourceCleanup.js';

vi.mock('./logger.js', () => ({
  logger: {
    feature: () => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
    main: { debug: vi.fn() },
  },
}));

function pausedTask() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const cleanup = vi.fn(() => {
    entered.resolve();
    return release.promise;
  });
  return { entered, release, cleanup, name: 'paused' };
}

afterEach(() => {
  destroyCleanupManager();
  vi.useRealTimers();
});

describe('cleanup coordinator reference lifetime', () => {
  it('releases native timers and listeners synchronously while tasks remain pending', async () => {
    vi.useFakeTimers();
    const manager = getCleanupManager();
    const signal = manager['timerAborter'].signal;
    const emitter = new EventEmitter();
    const listener = vi.fn();
    emitter.on('event', listener);
    manager.trackListener(emitter, 'event', listener);
    createTrackedTimeout(vi.fn(), 100);
    const task = pausedTask();
    manager.registerTask(task);

    const completion = manager.cleanup();

    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    expect(emitter.listenerCount('event')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    task.release.resolve();
    await completion;
  });

  it('shares one task execution across concurrent cleanup callers', async () => {
    const manager = new ResourceCleanupManager();
    const task = pausedTask();
    manager.registerTask(task);
    const first = manager.cleanup();
    const second = manager.cleanup();
    await task.entered.promise;

    task.release.resolve();
    await Promise.all([first, second]);

    expect(task.cleanup).toHaveBeenCalledTimes(1);
  });

  it('visits tasks appended to the active array during an awaited task', async () => {
    const manager = new ResourceCleanupManager();
    const task = pausedTask();
    const appended = vi.fn();
    manager.registerTask(task);
    const completion = manager.cleanup();
    await task.entered.promise;

    manager.registerTask({ name: 'appended', cleanup: appended });
    task.release.resolve();
    await completion;

    expect(appended).toHaveBeenCalledTimes(1);
  });

  it('retains the active old array across reset and isolates new registrations', async () => {
    const manager = new ResourceCleanupManager();
    const task = pausedTask();
    const retained = vi.fn();
    const replacement = vi.fn();
    manager.registerTasks([task, { name: 'retained', cleanup: retained }]);
    const completion = manager.cleanup();
    await task.entered.promise;

    manager.reset();
    manager.registerTask({ name: 'replacement', cleanup: replacement });
    task.release.resolve();
    await completion;

    expect(retained).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
    await manager.cleanup();
    expect(replacement).toHaveBeenCalledTimes(1);
  });

  it('observes callback Map clear and re-registration during its awaited iteration', async () => {
    const manager = new ResourceCleanupManager();
    const callback = pausedTask();
    const removed = vi.fn();
    const replacement = vi.fn();
    manager.registerGlobalCleanupCallback('paused', callback.cleanup);
    manager.registerGlobalCleanupCallback('removed', removed);
    const completion = manager.cleanup({ includeGlobalResources: true });
    await callback.entered.promise;

    manager.reset();
    manager.registerGlobalCleanupCallback('replacement', replacement);
    callback.release.resolve();
    await completion;

    expect(removed).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledTimes(1);
  });

  it('keeps a destroyed singleton run separate from replacement ownership', async () => {
    const original = getCleanupManager();
    const task = pausedTask();
    const retained = vi.fn();
    original.registerTasks([task, { name: 'retained', cleanup: retained }]);
    destroyCleanupManager();
    const completion = original.cleanup();
    const replacement = getCleanupManager();
    const replacementTask = vi.fn();
    replacement.registerTask({ name: 'replacement', cleanup: replacementTask });
    await task.entered.promise;

    task.release.resolve();
    await completion;

    expect(replacement).not.toBe(original);
    expect(retained).toHaveBeenCalledTimes(1);
    expect(replacementTask).not.toHaveBeenCalled();
    await replacement.cleanup();
    expect(replacementTask).toHaveBeenCalledTimes(1);
    replacement.reset();
  });

  it('captures live collections and config before a deferred coordinator import resolves', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.doMock('./resourceCleanupTasks.js', async () => {
      entered.resolve();
      await release.promise;
      return vi.importActual<typeof CleanupCoordinator>('./resourceCleanupTasks.js');
    });
    const manager = new ResourceCleanupManager();
    const retained = vi.fn();
    const appended = vi.fn();
    const replacement = vi.fn();
    const removedCallback = vi.fn();
    const liveCallback = vi.fn();
    const config: CleanupConfig = {};
    manager.registerTask({ name: 'retained', cleanup: retained });
    manager.registerGlobalCleanupCallback('removed', removedCallback);
    const completion = manager.cleanup(config);

    try {
      await entered.promise;
      expect(retained).not.toHaveBeenCalled();
      manager.registerTask({ name: 'appended', cleanup: appended });
      manager.reset();
      manager.registerTask({ name: 'replacement', cleanup: replacement });
      manager.registerGlobalCleanupCallback('live', liveCallback);
      config.includeGlobalResources = true;
      release.resolve();
      await completion;

      expect(retained).toHaveBeenCalledTimes(1);
      expect(appended).toHaveBeenCalledTimes(1);
      expect(replacement).not.toHaveBeenCalled();
      expect(removedCallback).not.toHaveBeenCalled();
      expect(liveCallback).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await completion;
      vi.doUnmock('./resourceCleanupTasks.js');
    }
  });
});
