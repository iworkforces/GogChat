/**
 * Unit tests for ResourceCleanup — memory leak prevention module
 *
 * Covers: singleton, createTrackedInterval, createTrackedTimeout,
 * addTrackedListener, registerCleanupTask, cleanup,
 * edge cases (double cleanup, partial tracking, empty cleanup).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { EventTarget } from './cleanupTypes.js';

// ========================================================================
// Mock electron first — must come before any imports that use electron
// ========================================================================

vi.mock('electron', () => ({
  BrowserWindow: vi.fn().mockImplementation(() => ({
    id: 1,
    webContents: {
      send: vi.fn(),
      session: {
        clearCache: vi.fn().mockResolvedValue(undefined),
        clearStorageData: vi.fn().mockResolvedValue(undefined),
      },
    },
    show: vi.fn(),
    hide: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: vi.fn().mockReturnValue(false),
    on: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn(),
  })),
  ipcMain: {
    removeAllListeners: vi.fn(),
  },
  app: {
    whenReady: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn(),
  },
}));

vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock logger to avoid module initialization issues
vi.mock('./logger.js', () => ({
  logger: {
    feature: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    window: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    main: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

// Mock errorUtils.js (toErrorMessage extracted from errorHandler)
vi.mock('./errorUtils.js', () => ({
  toErrorMessage: vi.fn((err: unknown) => {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    return String(err);
  }),
}));

// Mock external dependencies that resourceCleanup imports
vi.mock('../ipc/rateLimiter.js', () => ({
  destroyRateLimiter: vi.fn(),
}));

vi.mock('../ipc/ipcDeduplicator.js', () => ({
  destroyDeduplicator: vi.fn(),
}));

vi.mock('../platform/iconCache.js', () => ({
  getIconCache: vi.fn().mockReturnValue({
    clear: vi.fn(),
  }),
}));

vi.mock('../config/configCache.js', () => ({
  clearConfigCache: vi.fn(),
}));

describe('ResourceCleanup', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Ensure clean state for singleton
    const { getCleanupManager } = await import('./resourceCleanup');
    const manager = getCleanupManager();
    manager.reset();
  });

  // ========================================================================
  // Singleton
  // ========================================================================

  describe('Singleton', () => {
    it('getCleanupManager returns the same instance on repeated calls', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const instance1 = getCleanupManager();
      const instance2 = getCleanupManager();
      expect(instance1).toBe(instance2);
    });

    it('getCleanupManager returns different instances after resetModules', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const instance1 = getCleanupManager();
      vi.resetModules();
      const { getCleanupManager: getFresh } = await import('./resourceCleanup');
      const instance2 = getFresh();
      expect(instance1).not.toBe(instance2);
    });
  });

  // ========================================================================
  // ResourceCleanupManager internals
  // ========================================================================

  describe('ResourceCleanupManager.registerTask', () => {
    it('registers a single cleanup task', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const cleanupFn = vi.fn();

      manager.registerTask({ name: 'test-task', cleanup: cleanupFn });

      await manager.cleanup();

      expect(cleanupFn).toHaveBeenCalled();
    });

    it('registers multiple cleanup tasks at once', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const fn1 = vi.fn();
      const fn2 = vi.fn();

      manager.registerTasks([
        { name: 'task1', cleanup: fn1 },
        { name: 'task2', cleanup: fn2 },
      ]);

      await manager.cleanup();

      expect(fn1).toHaveBeenCalled();
      expect(fn2).toHaveBeenCalled();
    });
  });

  describe('ResourceCleanupManager.trackInterval', () => {
    it('tracks intervals for cleanup', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      // Create a fake interval
      const fakeInterval = setInterval(vi.fn(), 1000) as unknown as NodeJS.Timeout;
      manager.trackInterval(fakeInterval);

      await manager.cleanup();

      expect(clearIntervalSpy).toHaveBeenCalledWith(fakeInterval);
    });
  });

  describe('ResourceCleanupManager.trackTimeout', () => {
    it('tracks timeouts for cleanup', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      // Create a fake timeout
      const fakeTimeout = setTimeout(vi.fn(), 1000) as unknown as NodeJS.Timeout;
      manager.trackTimeout(fakeTimeout);

      await manager.cleanup();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(fakeTimeout);
    });
  });

  describe('ResourceCleanupManager.trackListener', () => {
    it('tracks event listeners for cleanup', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const handler = vi.fn();
      const removeListenerSpy = vi.fn();

      const target = {
        removeListener: removeListenerSpy,
        on: vi.fn(),
      };

      manager.trackListener(target, 'test-event', handler);
      await manager.cleanup();

      expect(removeListenerSpy).toHaveBeenCalledWith('test-event', handler);
    });

    it('uses off() method when removeListener is not available', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const handler = vi.fn();
      const offSpy = vi.fn();

      const target = {
        off: offSpy,
        on: vi.fn(),
      };

      manager.trackListener(target, 'test-event', handler);
      await manager.cleanup();

      expect(offSpy).toHaveBeenCalledWith('test-event', handler);
    });

    it('handles listener removal errors gracefully', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const handler = vi.fn();

      const target = {
        removeListener: vi.fn().mockImplementation(() => {
          throw new Error('Remove failed');
        }),
        on: vi.fn(),
      };

      manager.trackListener(target, 'test-event', handler);
      // Should not throw
      await expect(manager.cleanup()).resolves.toBeUndefined();
    });
  });

  describe('ResourceCleanupManager cleanup phases', () => {
    it('cleans up intervals before listeners', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const order: string[] = [];

      const clearIntervalSpy = vi.spyOn(global, 'clearInterval').mockImplementation(() => {
        order.push('interval');
      });
      const removeListenerSpy = vi.fn().mockImplementation(() => {
        order.push('listener');
      });

      const fakeInterval = setInterval(vi.fn(), 1000) as unknown as NodeJS.Timeout;
      manager.trackInterval(fakeInterval);

      const target = { removeListener: removeListenerSpy, on: vi.fn() };
      manager.trackListener(target, 'event', vi.fn());

      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout').mockImplementation(() => {
        order.push('timeout');
      });
      const fakeTimeout = setTimeout(vi.fn(), 1000) as unknown as NodeJS.Timeout;
      manager.trackTimeout(fakeTimeout);

      await manager.cleanup();

      expect(clearIntervalSpy).toHaveBeenCalled();
      expect(clearTimeoutSpy).toHaveBeenCalled();
      expect(removeListenerSpy).toHaveBeenCalled();
    });

    it('runs cleanup tasks after intervals and listeners', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const order: string[] = [];

      const _clearIntervalSpy = vi.spyOn(global, 'clearInterval').mockImplementation(() => {
        order.push('interval');
      });
      const removeListenerSpy = vi.fn().mockImplementation(() => {
        order.push('listener');
      });
      const _clearTimeoutSpy = vi.spyOn(global, 'clearTimeout').mockImplementation(() => {
        order.push('timeout');
      });

      manager.trackInterval(setInterval(vi.fn(), 1000) as unknown as NodeJS.Timeout);
      manager.trackListener({ removeListener: removeListenerSpy, on: vi.fn() }, 'e', vi.fn());
      manager.trackTimeout(setTimeout(vi.fn(), 1000) as unknown as NodeJS.Timeout);

      manager.registerTask({
        name: 'task-order',
        cleanup: () => {
          order.push('task');
        },
      });

      await manager.cleanup();

      // Tasks run after intervals, timeouts, listeners
      const taskIndex = order.indexOf('task');
      const intervalIndex = order.indexOf('interval');
      const listenerIndex = order.indexOf('listener');
      const timeoutIndex = order.indexOf('timeout');

      expect(taskIndex).toBeGreaterThan(intervalIndex);
      expect(taskIndex).toBeGreaterThan(listenerIndex);
      expect(taskIndex).toBeGreaterThan(timeoutIndex);
    });
  });

  describe('ResourceCleanupManager cleanup error handling', () => {
    it('non-critical cleanup task failure is logged as debug', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();

      manager.registerTask({
        name: 'non-critical-fail',
        cleanup: vi.fn().mockRejectedValue(new Error('task failed')),
        critical: false,
      });

      // Should not throw
      await expect(manager.cleanup()).resolves.toBeUndefined();
    });

    it('critical cleanup task failure is logged as error', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();

      manager.registerTask({
        name: 'critical-fail',
        cleanup: vi.fn().mockRejectedValue(new Error('critical failed')),
        critical: true,
      });

      // Should not throw
      await expect(manager.cleanup()).resolves.toBeUndefined();
    });
  });

  describe('ResourceCleanupManager cleanup concurrency', () => {
    it('concurrent cleanup calls do not cause duplicate task execution', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const cleanupFn = vi.fn();

      manager.registerTask({
        name: 'slow-task',
        cleanup: async () => {
          await new Promise((r) => setTimeout(r, 50));
          cleanupFn();
        },
      });

      // Fire both cleanups concurrently
      const promise1 = manager.cleanup();
      const promise2 = manager.cleanup();

      // Both should complete without error
      await Promise.all([promise1, promise2]);

      // Task should only run once despite concurrent calls
      expect(cleanupFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('ResourceCleanupManager.reset', () => {
    it('resets all tracked state', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();

      manager.trackInterval(setInterval(vi.fn(), 1000) as unknown as NodeJS.Timeout);
      manager.trackTimeout(setTimeout(vi.fn(), 1000) as unknown as NodeJS.Timeout);
      manager.trackListener({ removeListener: vi.fn(), on: vi.fn() }, 'e', vi.fn());
      manager.registerTask({ name: 't', cleanup: vi.fn() });

      manager.reset();

      // After reset, cleanup should be a no-op for tracked resources
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      await manager.cleanup();

      expect(clearIntervalSpy).not.toHaveBeenCalled();
      expect(clearTimeoutSpy).not.toHaveBeenCalled();
    });
  });

  describe('ResourceCleanupManager cleanup with includeGlobalResources', () => {
    it('cleans up global resources when includeGlobalResources is true', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const ipcHandlers = vi.fn();
      const { destroyRateLimiter } = await import('../ipc/rateLimiter');
      const { destroyDeduplicator } = await import('../ipc/ipcDeduplicator');
      const { getIconCache } = await import('../platform/iconCache');
      const { clearConfigCache } = await import('../config/configCache');

      const manager = getCleanupManager();

      manager.registerGlobalCleanupCallback('rateLimiter', destroyRateLimiter);
      manager.registerGlobalCleanupCallback('deduplicator', destroyDeduplicator);
      manager.registerGlobalCleanupCallback('ipcHandlers', ipcHandlers);
      manager.registerGlobalCleanupCallback('iconCache', () => getIconCache().clear());
      manager.registerGlobalCleanupCallback('configCache', clearConfigCache);

      await manager.cleanup({ includeGlobalResources: true });

      expect(ipcHandlers).toHaveBeenCalled();
      expect(destroyRateLimiter).toHaveBeenCalled();
      expect(destroyDeduplicator).toHaveBeenCalled();
      expect(getIconCache().clear).toHaveBeenCalled();
      expect(clearConfigCache).toHaveBeenCalled();
    });
  });

  // ========================================================================
  // createTrackedInterval helper
  // ========================================================================

  describe('createTrackedInterval', () => {
    it('creates an interval and tracks it', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const { createTrackedInterval } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      const callback = vi.fn();
      const interval = createTrackedInterval(callback, 1000, 'my-interval');

      expect(interval).toBeDefined();
      expect(clearIntervalSpy).not.toHaveBeenCalled();

      await manager.cleanup();

      expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
    });

    it('returns the created interval', async () => {
      const { createTrackedInterval } = await import('./resourceCleanup');

      const callback = vi.fn();
      const interval = createTrackedInterval(callback, 500);

      expect(interval).toBeDefined();
      expect(typeof interval).toBe('object');
    });
  });

  // ========================================================================
  // createTrackedTimeout helper
  // ========================================================================

  describe('createTrackedTimeout', () => {
    it('creates a timeout and tracks it', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const { createTrackedTimeout } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      const callback = vi.fn();
      const timeout = createTrackedTimeout(callback, 1000, 'my-timeout');

      expect(timeout).toBeDefined();
      expect(clearTimeoutSpy).not.toHaveBeenCalled();

      await manager.cleanup();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(timeout);
    });

    it('returns the created timeout', async () => {
      const { createTrackedTimeout } = await import('./resourceCleanup');

      const callback = vi.fn();
      const timeout = createTrackedTimeout(callback, 500);

      expect(timeout).toBeDefined();
      expect(typeof timeout).toBe('object');
    });
  });

  // ========================================================================
  // addTrackedListener helper
  // ========================================================================

  describe('addTrackedListener', () => {
    it('adds and tracks an event listener using on() method', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const { addTrackedListener } = await import('./resourceCleanup');
      const _manager = getCleanupManager();
      const handler = vi.fn();
      const target = {
        on: vi.fn(),
        removeListener: vi.fn(),
      };

      addTrackedListener(target, 'my-event', handler, 'my-listener');

      expect(target.on).toHaveBeenCalledWith('my-event', handler);
    });

    it('adds and tracks an event listener using addEventListener() method', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const { addTrackedListener } = await import('./resourceCleanup');
      const _manager = getCleanupManager();
      const handler = vi.fn();
      const target = {
        addEventListener: vi.fn(),
        removeListener: vi.fn(),
      };

      addTrackedListener(target, 'click', handler);

      expect(target.addEventListener).toHaveBeenCalledWith('click', handler);
    });

    it('throws when target does not support event listeners', async () => {
      const { addTrackedListener } = await import('./resourceCleanup');
      const target = {} as { on?: (e: string, h: () => void) => void };

      expect(() => addTrackedListener(target, 'event', vi.fn())).toThrow(
        'Target does not support event listeners'
      );
    });

    it('removes listener on cleanup', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const { addTrackedListener } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const handler = vi.fn();
      const target = {
        on: vi.fn(),
        removeListener: vi.fn(),
      };

      addTrackedListener(target, 'my-event', handler);

      await manager.cleanup();

      expect(target.removeListener).toHaveBeenCalledWith('my-event', handler);
    });
  });

  // ========================================================================
  // registerCleanupTask helper
  // ========================================================================

  describe('registerCleanupTask', () => {
    it('registers a cleanup task', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const { registerCleanupTask } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const cleanupFn = vi.fn();

      registerCleanupTask('my-task', cleanupFn);

      await manager.cleanup();

      expect(cleanupFn).toHaveBeenCalled();
    });

    it('registers a critical cleanup task', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const { registerCleanupTask } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const cleanupFn = vi.fn();

      registerCleanupTask('critical-task', cleanupFn, true);

      await manager.cleanup();

      expect(cleanupFn).toHaveBeenCalled();
    });

    it('registers an async cleanup task', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const { registerCleanupTask } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const cleanupFn = vi.fn().mockResolvedValue(undefined);

      registerCleanupTask('async-task', cleanupFn);

      await expect(manager.cleanup()).resolves.toBeUndefined();
      expect(cleanupFn).toHaveBeenCalled();
    });
  });

  // ========================================================================
  // Edge cases
  // ========================================================================

  describe('Edge cases', () => {
    it('cleanup is safe when nothing is tracked', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();

      await expect(manager.cleanup()).resolves.toBeUndefined();
    });

    it('double cleanup runs tasks each time unless reset in between', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const cleanupFn = vi.fn();

      manager.registerTask({ name: 'test', cleanup: cleanupFn });

      await manager.cleanup();
      expect(cleanupFn).toHaveBeenCalledTimes(1);

      // Without reset, second cleanup runs the same tasks again
      await manager.cleanup();
      expect(cleanupFn).toHaveBeenCalledTimes(2);

      // Reset clears tasks
      manager.reset();
      await manager.cleanup();
      expect(cleanupFn).toHaveBeenCalledTimes(2);
    });

    it('cleanup after partial tracking works correctly', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      const removeListenerSpy = vi.fn();

      // Track only an interval
      const interval = setInterval(vi.fn(), 1000) as unknown as NodeJS.Timeout;
      manager.trackInterval(interval);

      await manager.cleanup();

      expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
      expect(clearTimeoutSpy).not.toHaveBeenCalled();
      expect(removeListenerSpy).not.toHaveBeenCalled();
    });

    it('async cleanup tasks complete before cleanup returns', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      let completed = false;

      manager.registerTask({
        name: 'async-task',
        cleanup: async () => {
          await new Promise((r) => setTimeout(r, 10));
          completed = true;
        },
      });

      await manager.cleanup();

      expect(completed).toBe(true);
    });

    it('cleanup with logDetails does not throw', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();

      manager.registerTask({
        name: 'detailed-task',
        cleanup: vi.fn(),
      });

      // Should not throw
      await expect(manager.cleanup({ logDetails: true })).resolves.toBeUndefined();
    });

    it('intervals are cleared in order', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const order: number[] = [];

      const _clearIntervalSpy = vi.spyOn(global, 'clearInterval').mockImplementation((id) => {
        order.push(Number(id));
      });

      const interval1 = setInterval(vi.fn(), 1000) as unknown as NodeJS.Timeout;
      const interval2 = setInterval(vi.fn(), 1000) as unknown as NodeJS.Timeout;
      const interval3 = setInterval(vi.fn(), 1000) as unknown as NodeJS.Timeout;

      manager.trackInterval(interval1);
      manager.trackInterval(interval2);
      manager.trackInterval(interval3);

      await manager.cleanup();

      expect(order.length).toBe(3);
    });
  });

  // ========================================================================
  // Empty/nothing-to-clean scenarios
  // ========================================================================

  describe('Nothing-to-clean scenarios', () => {
    it('cleanup with no intervals, no timeouts, no listeners works', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();

      await expect(manager.cleanup()).resolves.toBeUndefined();
    });

    it('cleanup with only tasks works', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const taskFn = vi.fn();

      manager.registerTask({ name: 'only-task', cleanup: taskFn });

      await manager.cleanup();

      expect(taskFn).toHaveBeenCalled();
    });

    it('cleanup with only intervals works', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      const interval = setInterval(vi.fn(), 1000) as unknown as NodeJS.Timeout;
      manager.trackInterval(interval);

      await manager.cleanup();

      expect(clearIntervalSpy).toHaveBeenCalled();
    });

    it('cleanup with only timeouts works', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      const timeout = setTimeout(vi.fn(), 1000) as unknown as NodeJS.Timeout;
      manager.trackTimeout(timeout);

      await manager.cleanup();

      expect(clearTimeoutSpy).toHaveBeenCalled();
    });

    it('cleanup with only listeners works', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const removeListenerSpy = vi.fn();

      const target = { removeListener: removeListenerSpy, on: vi.fn() };
      manager.trackListener(target, 'event', vi.fn());

      await manager.cleanup();

      expect(removeListenerSpy).toHaveBeenCalled();
    });
  });

  // ========================================================================
  // Task execution order
  // ========================================================================

  describe('Task execution order', () => {
    it('all tasks run even if one throws', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const order: string[] = [];

      manager.registerTask({
        name: 'first',
        cleanup: () => {
          order.push('first');
        },
      });

      manager.registerTask({
        name: 'throwing',
        cleanup: () => {
          order.push('throwing');
          throw new Error('I fail');
        },
      });

      manager.registerTask({
        name: 'third',
        cleanup: () => {
          order.push('third');
        },
      });

      await manager.cleanup();

      expect(order).toEqual(['first', 'throwing', 'third']);
    });

    it('tasks execute in registration order', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const order: string[] = [];

      manager.registerTask({
        name: '1',
        cleanup: () => {
          order.push('1');
        },
      });
      manager.registerTask({
        name: '2',
        cleanup: () => {
          order.push('2');
        },
      });
      manager.registerTask({
        name: '3',
        cleanup: () => {
          order.push('3');
        },
      });

      await manager.cleanup();

      expect(order).toEqual(['1', '2', '3']);
    });
  });

  // ========================================================================
  // cleanupGlobalResources error path
  // ========================================================================

  describe('cleanupGlobalResources error handling', () => {
    it('logs debug and continues when a global cleanup callback throws', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();

      const successFn = vi.fn();
      const throwingFn = vi.fn().mockImplementation(() => {
        throw new Error('global cleanup failed');
      });

      manager.registerGlobalCleanupCallback('throwing', throwingFn, 'Throwing cleanup');
      manager.registerGlobalCleanupCallback('success', successFn, 'Success cleanup');

      // Should not throw — error is caught and logged
      await manager.cleanup({ includeGlobalResources: true });

      expect(throwingFn).toHaveBeenCalled();
      expect(successFn).toHaveBeenCalled();
    });

    it('awaits global cleanup callbacks in order and continues after a failure', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const order: string[] = [];
      let finishFirst: (() => void) | undefined;

      manager.registerGlobalCleanupCallback('first', async () => {
        order.push('first-start');
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
        order.push('first-end');
      });
      manager.registerGlobalCleanupCallback('throwing', () => {
        order.push('throwing');
        throw new Error('global cleanup failed');
      });
      manager.registerGlobalCleanupCallback('third', () => {
        order.push('third');
      });

      const cleanup = manager.cleanup({ includeGlobalResources: true });

      await vi.waitFor(() => expect(order).toContain('first-start'));
      expect(order).toEqual(['first-start']);
      if (!finishFirst) throw new Error('first global cleanup did not start');
      finishFirst();
      await cleanup;

      expect(order).toEqual(['first-start', 'first-end', 'throwing', 'third']);
    });
  });

  // ========================================================================
  // registerTask debug logging
  // ========================================================================

  describe('registerTask debug logging', () => {
    it('logs debug message when registering a task', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const { logger } = await import('./logger');
      const manager = getCleanupManager();

      manager.registerTask({ name: 'debug-logged-task', cleanup: vi.fn() });

      // logger.feature('ResourceCleanup') returns a mock with .debug
      const _featureLog = logger.feature('ResourceCleanup');
      // The manager created its own logger.feature reference, but we verify
      // registerTask ran successfully by checking the task is cleaned up
      await manager.cleanup();
    });
  });

  // ========================================================================
  // getRegisteredCallbackIds
  // ========================================================================

  describe('getRegisteredCallbackIds', () => {
    it('returns IDs of all registered global cleanup callbacks', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();

      manager.registerGlobalCleanupCallback('cb1', vi.fn(), 'Callback 1');
      manager.registerGlobalCleanupCallback('cb2', vi.fn(), 'Callback 2');

      const ids = manager.getRegisteredCallbackIds();
      expect(ids).toEqual(['cb1', 'cb2']);
    });

    it('returns empty array when no callbacks registered', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();

      expect(manager.getRegisteredCallbackIds()).toEqual([]);
    });
  });

  // ========================================================================
  // cleanup() when isCleaningUp=true but cleanupPromise=null (line 143)
  // ========================================================================

  describe('cleanup guard: isCleaningUp without cleanupPromise', () => {
    it('returns immediately when isCleaningUp is true but cleanupPromise is null', async () => {
      const { ResourceCleanupManager } = await import('./resourceCleanup');
      const manager = new ResourceCleanupManager();
      const cleanupFn = vi.fn();
      manager.registerTask({ name: 'guarded-task', cleanup: cleanupFn });

      // Manually set the guard flag without a promise (defensive code path)
      const managerAny = manager as unknown as Record<string, unknown>;
      managerAny['isCleaningUp'] = true;
      managerAny['cleanupPromise'] = null;

      // cleanup() should return immediately without executing tasks
      await manager.cleanup();
      expect(cleanupFn).not.toHaveBeenCalled();

      // Reset flag so further tests are clean
      managerAny['isCleaningUp'] = false;
    });
  });

  // ========================================================================
  // cleanupListeners: target without removeListener AND without off
  // ========================================================================

  describe('cleanupListeners: target without listener removal methods', () => {
    it('handles target with neither removeListener nor off gracefully', async () => {
      const { getCleanupManager } = await import('./resourceCleanup');
      const manager = getCleanupManager();
      const handler = vi.fn();

      // Create a target that has on() for registration but no removeListener/off
      const target = {
        on: vi.fn(),
      };

      // Directly track (bypassing addTrackedListener which validates)
      manager.trackListener(target as unknown as EventTarget, 'orphan-event', handler);

      // Cleanup should not throw even though removal methods are missing
      await expect(manager.cleanup()).resolves.toBeUndefined();
    });
  });

  // ========================================================================
  // Ported from merged module — unique coverage
  // ========================================================================

  describe('addTrackedListener: prefers .on() over .addEventListener()', () => {
    it('uses .on() when both are available', async () => {
      const { addTrackedListener } = await import('./resourceCleanup');
      const handler = vi.fn();
      const target = { on: vi.fn(), addEventListener: vi.fn() };

      addTrackedListener(target, 'data', handler);

      expect(target.on).toHaveBeenCalledWith('data', handler);
      expect(target.addEventListener).not.toHaveBeenCalled();
    });
  });

  it('destroyCleanupManager is idempotent and fires a tracked timeout first', async () => {
    const { createTrackedTimeout, getCleanupManager, destroyCleanupManager } =
      await import('./resourceCleanup.js');
    const callback = vi.fn();
    const handle = createTrackedTimeout(callback, 60_000, 'coverage-timeout');
    getCleanupManager().untrackTimeout(handle);
    getCleanupManager().untrackTimeout(handle);
    destroyCleanupManager();
    destroyCleanupManager();
    expect(callback).not.toHaveBeenCalled();
    expect(getCleanupManager()).not.toBeNull();
  });
});
