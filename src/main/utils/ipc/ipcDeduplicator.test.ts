/**
 * Tests for ipcDeduplicator utility
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IPCDeduplicator, getDeduplicator, destroyDeduplicator } from './ipcDeduplicator';
import {
  deduplicationPatterns,
  createDeduplicatedHandler,
  withDeduplication,
} from './ipcDeduplicationPatterns';

// Mock electron-log
vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock logger
vi.mock('../lifecycle/logger.js', () => ({
  logger: {
    ipc: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

// Mock resourceCleanup to avoid pulling in real cleanup manager
vi.mock('../lifecycle/resourceCleanup.js', () => ({
  cancelTrackedTimeout: (handle: NodeJS.Timeout) => clearTimeout(handle),
  createTrackedTimeout: (callback: () => void, delay: number, _name?: string) =>
    setTimeout(callback, delay),
}));

describe('IPCDeduplicator', () => {
  let deduplicator: IPCDeduplicator;

  beforeEach(() => {
    vi.useFakeTimers();
    deduplicator = new IPCDeduplicator({
      windowMs: 100,
      maxCacheSize: 10,
      debug: false,
    });
  });

  afterEach(() => {
    deduplicator.destroy();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('Constructor', () => {
    it('should create instance with default config', () => {
      const ded = new IPCDeduplicator();
      expect(ded).toBeDefined();
      expect(ded.getCacheSize()).toBe(0);
      ded.destroy();
    });

    it('should accept custom config', () => {
      const ded = new IPCDeduplicator({
        windowMs: 200,
        maxCacheSize: 50,
        debug: true,
      });
      expect(ded).toBeDefined();
      ded.destroy();
    });

    it('should use default values for missing config', () => {
      const ded = new IPCDeduplicator({});
      expect(ded).toBeDefined();
      ded.destroy();
    });
  });

  describe('deduplicate()', () => {
    it('should execute function on first call', async () => {
      const fn = vi.fn().mockResolvedValue('result');

      const result = await deduplicator.deduplicate('key1', fn);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(result).toBe('result');
    });

    it('should not execute function on duplicate call within window', async () => {
      const fn = vi.fn().mockResolvedValue('result');

      const promise1 = deduplicator.deduplicate('key1', fn);
      const promise2 = deduplicator.deduplicate('key1', fn);

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(result1).toBe('result');
      expect(result2).toBe('result');
    });

    it('should deduplicate multiple calls to same key', async () => {
      const fn = vi.fn().mockResolvedValue('result');

      const promises = [
        deduplicator.deduplicate('key1', fn),
        deduplicator.deduplicate('key1', fn),
        deduplicator.deduplicate('key1', fn),
        deduplicator.deduplicate('key1', fn),
      ];

      const results = await Promise.all(promises);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(results).toEqual(['result', 'result', 'result', 'result']);
    });

    it('should execute function again after window expires', async () => {
      const fn = vi.fn().mockResolvedValue('result');

      await deduplicator.deduplicate('key1', fn);
      expect(fn).toHaveBeenCalledTimes(1);

      // Advance time past window
      vi.advanceTimersByTime(150);

      await deduplicator.deduplicate('key1', fn);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should handle different keys independently', async () => {
      const fn1 = vi.fn().mockResolvedValue('result1');
      const fn2 = vi.fn().mockResolvedValue('result2');

      const [result1, result2] = await Promise.all([
        deduplicator.deduplicate('key1', fn1),
        deduplicator.deduplicate('key2', fn2),
      ]);

      expect(fn1).toHaveBeenCalledTimes(1);
      expect(fn2).toHaveBeenCalledTimes(1);
      expect(result1).toBe('result1');
      expect(result2).toBe('result2');
    });

    it('should accept custom window time', async () => {
      const fn = vi.fn().mockResolvedValue('result');

      await deduplicator.deduplicate('key1', fn, 50); // 50ms window

      // Advance 40ms - still within custom window
      vi.advanceTimersByTime(40);
      await deduplicator.deduplicate('key1', fn, 50);

      expect(fn).toHaveBeenCalledTimes(1);

      // Advance 20ms more - past custom window
      vi.advanceTimersByTime(20);
      await deduplicator.deduplicate('key1', fn, 50);

      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should handle rejected promises', async () => {
      const error = new Error('Test error');
      const fn = vi.fn().mockRejectedValue(error);

      await expect(deduplicator.deduplicate('key1', fn)).rejects.toThrow('Test error');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should deduplicate rejected promises', async () => {
      const error = new Error('Test error');
      const fn = vi.fn().mockRejectedValue(error);

      const promise1 = deduplicator.deduplicate('key1', fn);
      const promise2 = deduplicator.deduplicate('key1', fn);

      await expect(promise1).rejects.toThrow('Test error');
      await expect(promise2).rejects.toThrow('Test error');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should track statistics', async () => {
      const fn = vi.fn().mockResolvedValue('result');

      await deduplicator.deduplicate('key1', fn); // miss
      await deduplicator.deduplicate('key1', fn); // hit
      await deduplicator.deduplicate('key1', fn); // hit

      const stats = deduplicator.getStats();
      expect(stats.cacheMisses).toBe(1);
      expect(stats.cacheHits).toBe(2);
      expect(stats.deduplicatedCount).toBe(2);
    });

    it('should clean cache when maxCacheSize exceeded', async () => {
      const fn = vi.fn().mockResolvedValue('result');

      // Fill cache to max (10 items)
      for (let i = 0; i < 10; i++) {
        await deduplicator.deduplicate(`key${i}`, fn);
      }

      expect(deduplicator.getCacheSize()).toBe(10);

      // Advance time to expire old entries
      vi.advanceTimersByTime(250);

      // Add one more - should trigger cleanup of old entries
      await deduplicator.deduplicate('key10', fn);

      // After cleanup, cache might have fewer items
      expect(deduplicator.getCacheSize()).toBeGreaterThan(0);
    });
  });

  describe('deduplicateWithKey()', () => {
    it('should use key function to generate key', async () => {
      const fn = vi.fn().mockImplementation((a: number, b: number) => Promise.resolve(a + b));
      const keyFn = (a: number, b: number) => `add-${a}-${b}`;

      const result = await deduplicator.deduplicateWithKey(keyFn, fn, 1, 2);

      expect(result).toBe(3);
      expect(fn).toHaveBeenCalledWith(1, 2);
    });

    it('should deduplicate calls with same key', async () => {
      const fn = vi.fn().mockImplementation((a: number, b: number) => Promise.resolve(a + b));
      const keyFn = (a: number, b: number) => `add-${a}-${b}`;

      const [result1, result2] = await Promise.all([
        deduplicator.deduplicateWithKey(keyFn, fn, 1, 2),
        deduplicator.deduplicateWithKey(keyFn, fn, 1, 2),
      ]);

      expect(result1).toBe(3);
      expect(result2).toBe(3);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should not deduplicate calls with different keys', async () => {
      const fn = vi.fn().mockImplementation((a: number, b: number) => Promise.resolve(a + b));
      const keyFn = (a: number, b: number) => `add-${a}-${b}`;

      const [result1, result2] = await Promise.all([
        deduplicator.deduplicateWithKey(keyFn, fn, 1, 2),
        deduplicator.deduplicateWithKey(keyFn, fn, 2, 3),
      ]);

      expect(result1).toBe(3);
      expect(result2).toBe(5);
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('createDeduplicated()', () => {
    it('should create deduplicated function', async () => {
      const fn = vi.fn().mockImplementation((a: number) => Promise.resolve(a * 2));
      const keyFn = (a: number) => `double-${a}`;

      const deduplicatedFn = deduplicator.createDeduplicated(fn, keyFn);

      const result = await deduplicatedFn(5);
      expect(result).toBe(10);
      expect(fn).toHaveBeenCalledWith(5);
    });

    it('should deduplicate calls to created function', async () => {
      const fn = vi.fn().mockImplementation((a: number) => Promise.resolve(a * 2));
      const keyFn = (a: number) => `double-${a}`;

      const deduplicatedFn = deduplicator.createDeduplicated(fn, keyFn);

      const [result1, result2, result3] = await Promise.all([
        deduplicatedFn(5),
        deduplicatedFn(5),
        deduplicatedFn(5),
      ]);

      expect(result1).toBe(10);
      expect(result2).toBe(10);
      expect(result3).toBe(10);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should accept custom window time', async () => {
      const fn = vi.fn().mockImplementation((a: number) => Promise.resolve(a * 2));
      const keyFn = (a: number) => `double-${a}`;

      const deduplicatedFn = deduplicator.createDeduplicated(fn, keyFn, 50);

      await deduplicatedFn(5);
      expect(fn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60);

      await deduplicatedFn(5);
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('clear()', () => {
    it('should remove specific key from cache', async () => {
      const fn = vi.fn().mockResolvedValue('result');

      await deduplicator.deduplicate('key1', fn);
      expect(deduplicator.getCacheSize()).toBe(1);

      deduplicator.clear('key1');
      expect(deduplicator.getCacheSize()).toBe(0);
    });

    it('should not affect other keys', async () => {
      const fn = vi.fn().mockResolvedValue('result');

      await deduplicator.deduplicate('key1', fn);
      await deduplicator.deduplicate('key2', fn);
      expect(deduplicator.getCacheSize()).toBe(2);

      deduplicator.clear('key1');
      expect(deduplicator.getCacheSize()).toBe(1);
    });

    it('should handle clearing non-existent key', () => {
      expect(() => deduplicator.clear('nonexistent')).not.toThrow();
    });
  });

  describe('clearAll()', () => {
    it('should clear all cached entries', async () => {
      const fn = vi.fn().mockResolvedValue('result');

      await deduplicator.deduplicate('key1', fn);
      await deduplicator.deduplicate('key2', fn);
      await deduplicator.deduplicate('key3', fn);

      expect(deduplicator.getCacheSize()).toBe(3);

      deduplicator.clearAll();

      expect(deduplicator.getCacheSize()).toBe(0);
    });

    it('should reset statistics', async () => {
      const fn = vi.fn().mockResolvedValue('result');

      await deduplicator.deduplicate('key1', fn);
      await deduplicator.deduplicate('key1', fn);

      let stats = deduplicator.getStats();
      expect(stats.cacheMisses).toBeGreaterThan(0);
      expect(stats.cacheHits).toBeGreaterThan(0);

      deduplicator.clearAll();

      stats = deduplicator.getStats();
      expect(stats.cacheMisses).toBe(0);
      expect(stats.cacheHits).toBe(0);
      expect(stats.deduplicatedCount).toBe(0);
    });

    it('should handle clearing empty cache', () => {
      expect(() => deduplicator.clearAll()).not.toThrow();
      expect(deduplicator.getCacheSize()).toBe(0);
    });
  });

  describe('getStats()', () => {
    it('should return statistics object', () => {
      const stats = deduplicator.getStats();

      expect(stats).toHaveProperty('deduplicatedCount');
      expect(stats).toHaveProperty('cacheHits');
      expect(stats).toHaveProperty('cacheMisses');
    });

    it('should return snapshot of stats', async () => {
      const fn = vi.fn().mockResolvedValue('result');

      await deduplicator.deduplicate('key1', fn);

      const stats1 = deduplicator.getStats();

      await deduplicator.deduplicate('key1', fn);

      const stats2 = deduplicator.getStats();

      // Stats1 should not be modified
      expect(stats1.cacheHits).toBeLessThan(stats2.cacheHits);
    });
  });

  describe('getCacheSize()', () => {
    it('should return current cache size', async () => {
      const fn = vi.fn().mockResolvedValue('result');

      expect(deduplicator.getCacheSize()).toBe(0);

      await deduplicator.deduplicate('key1', fn);
      expect(deduplicator.getCacheSize()).toBe(1);

      await deduplicator.deduplicate('key2', fn);
      expect(deduplicator.getCacheSize()).toBe(2);
    });

    it('should not count duplicate keys', async () => {
      const fn = vi.fn().mockResolvedValue('result');

      await deduplicator.deduplicate('key1', fn);
      await deduplicator.deduplicate('key1', fn);
      await deduplicator.deduplicate('key1', fn);

      expect(deduplicator.getCacheSize()).toBe(1);
    });
  });

  describe('Automatic cleanup', () => {
    it('should clean old entries when their expiry timer fires', async () => {
      const fn = vi.fn().mockResolvedValue('result');

      await deduplicator.deduplicate('key1', fn);
      expect(deduplicator.getCacheSize()).toBe(1);

      // Advance past expiration window (windowMs * 2 = 200ms)
      vi.advanceTimersByTime(250);

      // Cache should be cleaned by the on-demand timer
      expect(deduplicator.getCacheSize()).toBe(0);
    });

    it('should not clean entries within expiration window', async () => {
      const fn = vi.fn().mockResolvedValue('result');

      await deduplicator.deduplicate('key1', fn);
      expect(deduplicator.getCacheSize()).toBe(1);

      // Advance partially — entry not yet expired
      vi.advanceTimersByTime(100);

      expect(deduplicator.getCacheSize()).toBe(1);
    });
  });

  // ========================================================================
  // On-demand cleanup scheduling (replaces always-on interval)
  // ========================================================================

  describe('On-demand cleanup scheduling', () => {
    it('schedules zero timers when cache is empty', () => {
      const ded = new IPCDeduplicator({ windowMs: 100, maxCacheSize: 10, debug: false });
      expect(vi.getTimerCount()).toBe(0);
      ded.destroy();
    });

    it('schedules exactly one timer when entries exist', async () => {
      const ded = new IPCDeduplicator({ windowMs: 100, maxCacheSize: 10, debug: false });
      const fn = vi.fn().mockResolvedValue('result');

      await ded.deduplicate('k1', fn);
      expect(vi.getTimerCount()).toBe(1);

      await ded.deduplicate('k2', fn);
      // Still exactly one timer (earlier-or-equal expiry already pending)
      expect(vi.getTimerCount()).toBe(1);

      ded.destroy();
    });

    it('fires the cleanup timer at the correct delay for the soonest entry', async () => {
      const ded = new IPCDeduplicator({ windowMs: 100, maxCacheSize: 10, debug: false });
      const fn = vi.fn().mockResolvedValue('result');

      await ded.deduplicate('k1', fn);
      expect(ded.getCacheSize()).toBe(1);

      // Just before expiry (200ms = windowMs * 2)
      vi.advanceTimersByTime(199);
      expect(ded.getCacheSize()).toBe(1);

      // Cross expiry threshold
      vi.advanceTimersByTime(2);
      expect(ded.getCacheSize()).toBe(0);

      ded.destroy();
    });

    it('reschedules after partial cleanup when entries remain', async () => {
      const ded = new IPCDeduplicator({ windowMs: 100, maxCacheSize: 10, debug: false });
      const fn = vi.fn().mockResolvedValue('result');

      // Insert first entry at t=0
      await ded.deduplicate('old', fn);

      // Advance 150ms, then insert second entry at t=150 (expires at t=350)
      vi.advanceTimersByTime(150);
      await ded.deduplicate('new', fn);
      expect(ded.getCacheSize()).toBe(2);

      // Advance to t=210 — old entry (expires at 200) should be cleaned, new survives
      vi.advanceTimersByTime(60);
      expect(ded.getCacheSize()).toBe(1);

      // A new timer must be scheduled for the remaining entry
      expect(vi.getTimerCount()).toBe(1);

      // Advance to t=360 — new entry (expires at 350) should now be cleaned
      vi.advanceTimersByTime(150);
      expect(ded.getCacheSize()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);

      ded.destroy();
    });

    it('refreshes an expired key at the end of cleanup order', async () => {
      const ded = new IPCDeduplicator({ windowMs: 100, maxCacheSize: 10, debug: false });
      const fn = vi.fn().mockResolvedValue('result');

      await ded.deduplicate('refresh', fn);
      vi.advanceTimersByTime(150);
      await ded.deduplicate('middle', fn);
      vi.advanceTimersByTime(60);

      expect(ded.getCacheSize()).toBe(1);

      await ded.deduplicate('refresh', fn);
      expect(ded.getCacheSize()).toBe(2);

      vi.advanceTimersByTime(150);
      expect(ded.getCacheSize()).toBe(1);

      vi.advanceTimersByTime(60);
      expect(ded.getCacheSize()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);

      ded.destroy();
    });

    it('destroy() cancels the pending timer', async () => {
      const ded = new IPCDeduplicator({ windowMs: 100, maxCacheSize: 10, debug: false });
      const fn = vi.fn().mockResolvedValue('result');

      await ded.deduplicate('k1', fn);
      expect(vi.getTimerCount()).toBe(1);

      ded.destroy();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('clearAll() cancels the pending timer', async () => {
      const ded = new IPCDeduplicator({ windowMs: 100, maxCacheSize: 10, debug: false });
      const fn = vi.fn().mockResolvedValue('result');

      await ded.deduplicate('k1', fn);
      expect(vi.getTimerCount()).toBe(1);

      ded.clearAll();
      expect(vi.getTimerCount()).toBe(0);
      ded.destroy();
    });

    it('100 rapid deduplicate calls with same key keep exactly 1 active timer', async () => {
      const ded = new IPCDeduplicator({ windowMs: 100, maxCacheSize: 10, debug: false });
      const fn = vi.fn().mockResolvedValue('result');

      const promises: Promise<unknown>[] = [];
      for (let i = 0; i < 100; i++) {
        promises.push(ded.deduplicate('hot-key', fn));
      }
      await Promise.all(promises);

      expect(vi.getTimerCount()).toBe(1);
      expect(ded.getCacheSize()).toBe(1);
      expect(fn).toHaveBeenCalledTimes(1);

      ded.destroy();
    });

    it('does not rescan cache or reschedule when a cleanup timer is already pending', async () => {
      const ded = new IPCDeduplicator({ windowMs: 100, maxCacheSize: 10, debug: false });
      const fn = vi.fn().mockResolvedValue('result');

      await ded.deduplicate('k1', fn);
      expect(vi.getTimerCount()).toBe(1);

      // Spy on clearTimeout to detect reschedule attempts.
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

      // Burst of inserts with distinct keys; timer is already pending and valid.
      for (let i = 0; i < 20; i++) {
        await ded.deduplicate(`burst-${i}`, fn);
      }

      // No clearTimeout should have been called — pending timer must stand.
      expect(clearSpy).not.toHaveBeenCalled();
      // Still exactly one active timer.
      expect(vi.getTimerCount()).toBe(1);

      clearSpy.mockRestore();
      ded.destroy();
    });

    it('schedules a fresh timer for a new insert after the pending timer fires', async () => {
      const ded = new IPCDeduplicator({ windowMs: 100, maxCacheSize: 10, debug: false });
      const fn = vi.fn().mockResolvedValue('result');

      await ded.deduplicate('first', fn);
      expect(vi.getTimerCount()).toBe(1);

      // Let pending timer fire; cache empties; no timer remains.
      vi.advanceTimersByTime(250);
      expect(ded.getCacheSize()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);

      // A subsequent insert must schedule a new cleanup timer.
      await ded.deduplicate('second', fn);
      expect(vi.getTimerCount()).toBe(1);

      ded.destroy();
    });
  });

  describe('destroy()', () => {
    it('should stop cleanup interval', () => {
      const ded = new IPCDeduplicator();
      ded.destroy();

      // Should not throw
      expect(() => ded.destroy()).not.toThrow();
    });

    it('should clear all cache', async () => {
      const fn = vi.fn().mockResolvedValue('result');

      await deduplicator.deduplicate('key1', fn);
      expect(deduplicator.getCacheSize()).toBe(1);

      deduplicator.destroy();

      expect(deduplicator.getCacheSize()).toBe(0);
    });

    it('should reset statistics', async () => {
      const fn = vi.fn().mockResolvedValue('result');

      await deduplicator.deduplicate('key1', fn);
      await deduplicator.deduplicate('key1', fn);

      deduplicator.destroy();

      const stats = deduplicator.getStats();
      expect(stats.cacheMisses).toBe(0);
      expect(stats.cacheHits).toBe(0);
    });
  });

  describe('Singleton pattern', () => {
    beforeEach(() => {
      destroyDeduplicator();
    });

    afterEach(() => {
      destroyDeduplicator();
    });

    it('should return same instance', () => {
      const ded1 = getDeduplicator();
      const ded2 = getDeduplicator();

      expect(ded1).toBe(ded2);
    });

    it('should create new instance after destroy', () => {
      const ded1 = getDeduplicator();
      destroyDeduplicator();
      const ded2 = getDeduplicator();

      expect(ded1).not.toBe(ded2);
    });

    it('should handle multiple destroy calls', () => {
      getDeduplicator();
      destroyDeduplicator();
      destroyDeduplicator();
      destroyDeduplicator();

      // Should not throw
      expect(() => getDeduplicator()).not.toThrow();
    });
  });

  describe('deduplicationPatterns', () => {
    it('should provide byChannel pattern', () => {
      const key = deduplicationPatterns.byChannel('test-channel');
      expect(key).toBe('test-channel');
    });

    it('should provide byChannelAndData pattern', () => {
      const key = deduplicationPatterns.byChannelAndData('channel', { foo: 'bar' });
      expect(key).toContain('channel');
      expect(key).toContain('foo');
    });

    it('should provide byChannelAndFirstArg pattern', () => {
      const key = deduplicationPatterns.byChannelAndFirstArg('channel', 'arg1');
      expect(key).toBe('channel:arg1');
    });

    it('should provide byWindowOperation pattern', () => {
      const key1 = deduplicationPatterns.byWindowOperation('resize', 123);
      expect(key1).toBe('resize:123');

      const key2 = deduplicationPatterns.byWindowOperation('resize');
      expect(key2).toBe('resize');
    });

    it('should provide byFileOperation pattern', () => {
      const key = deduplicationPatterns.byFileOperation('save', '/path/to/file');
      expect(key).toBe('save:/path/to/file');
    });
  });

  describe('createDeduplicatedHandler', () => {
    beforeEach(() => {
      destroyDeduplicator();
    });

    afterEach(() => {
      destroyDeduplicator();
    });

    it('should create handler that deduplicates', async () => {
      const fn = vi.fn().mockResolvedValue('result');
      const handler = createDeduplicatedHandler('channel', fn);

      const [result1, result2] = await Promise.all([handler(), handler()]);

      expect(result1).toBe('result');
      expect(result2).toBe('result');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should accept custom window time', async () => {
      const fn = vi.fn().mockResolvedValue('result');
      const handler = createDeduplicatedHandler('channel', fn, 50);

      await handler();
      expect(fn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60);

      await handler();
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('withDeduplication', () => {
    beforeEach(() => {
      destroyDeduplicator();
    });

    afterEach(() => {
      destroyDeduplicator();
    });

    it('should wrap function with deduplication', async () => {
      const fn = vi.fn().mockImplementation((a: number) => Promise.resolve(a * 2));
      const wrapped = withDeduplication(fn, (a) => `key-${a}`);

      const [result1, result2] = await Promise.all([wrapped(5), wrapped(5)]);

      expect(result1).toBe(10);
      expect(result2).toBe(10);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should accept custom window time', async () => {
      const fn = vi.fn().mockImplementation((a: number) => Promise.resolve(a * 2));
      const wrapped = withDeduplication(fn, (a) => `key-${a}`, 50);

      await wrapped(5);
      expect(fn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60);

      await wrapped(5);
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  // ========================================================================
  // Debug mode — cache hit, miss, and cleanup logging
  // ========================================================================

  describe('Debug mode logging', () => {
    let debugDeduplicator: IPCDeduplicator;

    beforeEach(() => {
      debugDeduplicator = new IPCDeduplicator({
        windowMs: 100,
        maxCacheSize: 10,
        debug: true,
      });
    });

    afterEach(() => {
      debugDeduplicator.destroy();
    });

    it('logs debug on cache hit (deduplicating request)', async () => {
      const { logger } = await import('../lifecycle/logger');
      const fn = vi.fn().mockResolvedValue('result');

      await debugDeduplicator.deduplicate('key-hit', fn); // miss
      await debugDeduplicator.deduplicate('key-hit', fn); // hit

      expect(logger.ipc.debug).toHaveBeenCalledWith(
        expect.stringContaining('Deduplicating request: key-hit')
      );
    });

    it('logs debug on cache miss (executing new request)', async () => {
      const { logger } = await import('../lifecycle/logger');
      const fn = vi.fn().mockResolvedValue('result');

      await debugDeduplicator.deduplicate('key-miss', fn);

      expect(logger.ipc.debug).toHaveBeenCalledWith(
        expect.stringContaining('Executing new request: key-miss')
      );
    });

    it('logs debug when cleaning expired cache entries', async () => {
      const { logger } = await import('../lifecycle/logger');
      const fn = vi.fn().mockResolvedValue('result');

      // Fill cache to maxCacheSize (10)
      for (let i = 0; i < 10; i++) {
        await debugDeduplicator.deduplicate(`fill-${i}`, fn);
      }

      // Advance past expiration window (windowMs * 2 = 200ms)
      vi.advanceTimersByTime(250);

      // Next call triggers cleanOldEntries because cache is full
      await debugDeduplicator.deduplicate('trigger-clean', fn);

      expect(logger.ipc.debug).toHaveBeenCalledWith(
        expect.stringMatching(/Cleaned \d+ expired cache entries/)
      );
    });
  });

  // ========================================================================
  // Entry-cleared-before-resolution edge cases (lines 103, 111)
  // ========================================================================

  describe('Entry cleared before promise resolution', () => {
    it('handles entry removed from cache before .then() resolves', async () => {
      let resolveManual: (value: string) => void;
      const manualPromise = new Promise<string>((resolve) => {
        resolveManual = resolve;
      });

      const fn = vi.fn().mockReturnValue(manualPromise);

      const resultPromise = deduplicator.deduplicate('clear-then', fn);

      // Clear the cache entry before the promise resolves
      deduplicator.clear('clear-then');

      // Now resolve — .then() runs but entry is gone from cache
      resolveManual!('late-result');

      const result = await resultPromise;
      expect(result).toBe('late-result');
    });

    it('handles entry removed from cache before .catch() runs', async () => {
      let rejectManual: (error: Error) => void;
      const manualPromise = new Promise<string>((_resolve, reject) => {
        rejectManual = reject;
      });

      const fn = vi.fn().mockReturnValue(manualPromise);

      const resultPromise = deduplicator.deduplicate('clear-catch', fn);

      // Clear the cache entry before the promise rejects
      deduplicator.clear('clear-catch');

      // Now reject — .catch() runs but entry is gone from cache
      rejectManual!(new Error('late-error'));

      await expect(resultPromise).rejects.toThrow('late-error');
    });
  });

  // ========================================================================
  // cleanOldEntries with no expired entries (line 215 false branch)
  // ========================================================================

  describe('cleanOldEntries with no expired entries', () => {
    it('does nothing when all entries are within expiration window', async () => {
      // Use a longer window so entries survive the 1s cleanup interval
      const longWindowDed = new IPCDeduplicator({
        windowMs: 1000, // windowMs * 2 = 2000ms expiration
        maxCacheSize: 10,
        debug: false,
      });
      const fn = vi.fn().mockResolvedValue('result');

      await longWindowDed.deduplicate('survive-key', fn);
      expect(longWindowDed.getCacheSize()).toBe(1);

      // Advance 1000ms to trigger cleanup interval — entry is 1000ms old,
      // but expiration is windowMs * 2 = 2000ms, so it survives
      vi.advanceTimersByTime(1000);

      expect(longWindowDed.getCacheSize()).toBe(1);

      longWindowDed.destroy();
    });
  });
});
