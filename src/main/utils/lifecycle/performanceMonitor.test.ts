/**
 * Tests for performanceMonitor utility
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getPerformanceMonitor,
  destroyPerformanceMonitor,
  perfMonitor,
} from './performanceMonitor';
import type { IAccountWindowManager } from '../../../shared/types/window.js';
import { asAccountIndex, asWebContentsId } from '../../../shared/types/branded.js';

// Hoisted mock for app.getAppMetrics so individual tests can swap return values.
const getAppMetricsMock = vi.hoisted(() => vi.fn(() => [] as Electron.ProcessMetric[]));

// Mock electron
vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/fake/app/path',
    getVersion: () => '1.0.0',
    getAppMetrics: getAppMetricsMock,
  },
}));

// Mock fs
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

// Mock path
vi.mock('path', () => ({
  default: {
    join: (...args: string[]) => args.join('/'),
    dirname: (p: string) => p.split('/').slice(0, -1).join('/'),
  },
}));

// Mock electron-log
vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

describe('PerformanceMonitor', () => {
  beforeEach(() => {
    // Reset singleton before each test
    destroyPerformanceMonitor();
    vi.clearAllMocks();
  });

  afterEach(() => {
    destroyPerformanceMonitor();
  });

  describe('Singleton pattern', () => {
    it('should return same instance on multiple calls', () => {
      const instance1 = getPerformanceMonitor();
      const instance2 = getPerformanceMonitor();

      expect(instance1).toBe(instance2);
    });

    it('should export convenience singleton', () => {
      // perfMonitor is created at module load time, so just verify it exists and works
      expect(perfMonitor).toBeDefined();
      expect(perfMonitor.mark).toBeDefined();
      expect(perfMonitor.getMetrics).toBeDefined();
    });

    it('should create new instance after destroy', () => {
      const instance1 = getPerformanceMonitor();
      destroyPerformanceMonitor();
      const instance2 = getPerformanceMonitor();

      // Should be different instances
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('mark()', () => {
    it('should record a marker', () => {
      const monitor = getPerformanceMonitor();
      monitor.mark('test-marker');

      const metrics = monitor.getMetrics();
      expect(metrics).toHaveProperty('test-marker');
      expect(typeof metrics['test-marker']).toBe('number');
    });

    it('should record multiple markers', () => {
      const monitor = getPerformanceMonitor();

      monitor.mark('marker1');
      monitor.mark('marker2');
      monitor.mark('marker3');

      const metrics = monitor.getMetrics();
      expect(metrics).toHaveProperty('marker1');
      expect(metrics).toHaveProperty('marker2');
      expect(metrics).toHaveProperty('marker3');
    });

    it('should record markers with increasing timestamps', () => {
      const monitor = getPerformanceMonitor();

      monitor.mark('first');
      monitor.mark('second');
      monitor.mark('third');

      const metrics = monitor.getMetrics();
      expect(metrics['first']).toBeLessThanOrEqual(metrics['second']);
      expect(metrics['second']).toBeLessThanOrEqual(metrics['third']);
    });

    it('should accept custom log message', () => {
      const monitor = getPerformanceMonitor();

      // Should not throw with custom message
      expect(() => {
        monitor.mark('marker', 'Custom message');
      }).not.toThrow();
    });

    it('should update existing marker if called again', () => {
      const monitor = getPerformanceMonitor();

      monitor.mark('marker');
      const firstTime = monitor.getMetrics()['marker'];

      // Wait a bit
      const start = Date.now();
      while (Date.now() - start < 10) {
        // Busy wait 10ms
      }

      monitor.mark('marker');
      const secondTime = monitor.getMetrics()['marker'];

      expect(secondTime).toBeGreaterThan(firstTime);
    });

    it('should respect enabled state', () => {
      const monitor = getPerformanceMonitor();

      monitor.setEnabled(false);
      monitor.mark('disabled-marker');

      const metrics = monitor.getMetrics();
      expect(metrics).not.toHaveProperty('disabled-marker');
    });
  });

  describe('measure()', () => {
    it('should measure time between two markers', () => {
      const monitor = getPerformanceMonitor();

      monitor.mark('start');

      // Simulate some work
      const workStart = Date.now();
      while (Date.now() - workStart < 5) {
        // Busy wait 5ms
      }

      monitor.mark('end');

      const duration = monitor.measure('start', 'end');

      expect(duration).not.toBeNull();
      expect(duration).toBeGreaterThanOrEqual(0);
      expect(typeof duration).toBe('number');
    });

    it('should return positive duration for sequential markers', () => {
      const monitor = getPerformanceMonitor();

      monitor.mark('first');
      monitor.mark('second');

      const duration = monitor.measure('first', 'second');

      expect(duration).not.toBeNull();
      expect(duration!).toBeGreaterThanOrEqual(0);
    });

    it('should return null if start marker not found', () => {
      const monitor = getPerformanceMonitor();

      monitor.mark('end');

      const duration = monitor.measure('nonexistent', 'end');

      expect(duration).toBeNull();
    });

    it('should return null if end marker not found', () => {
      const monitor = getPerformanceMonitor();

      monitor.mark('start');

      const duration = monitor.measure('start', 'nonexistent');

      expect(duration).toBeNull();
    });

    it('should return null if both markers not found', () => {
      const monitor = getPerformanceMonitor();

      const duration = monitor.measure('nonexistent1', 'nonexistent2');

      expect(duration).toBeNull();
    });

    it('should measure multiple intervals', () => {
      const monitor = getPerformanceMonitor();

      monitor.mark('a');
      monitor.mark('b');
      monitor.mark('c');
      monitor.mark('d');

      const ab = monitor.measure('a', 'b');
      const bc = monitor.measure('b', 'c');
      const cd = monitor.measure('c', 'd');

      expect(ab).not.toBeNull();
      expect(bc).not.toBeNull();
      expect(cd).not.toBeNull();
    });
  });

  describe('getMetrics()', () => {
    it('should return all recorded markers', () => {
      const monitor = getPerformanceMonitor();

      monitor.mark('marker1');
      monitor.mark('marker2');
      monitor.mark('marker3');

      const metrics = monitor.getMetrics();

      expect(Object.keys(metrics)).toHaveLength(3);
      expect(metrics).toHaveProperty('marker1');
      expect(metrics).toHaveProperty('marker2');
      expect(metrics).toHaveProperty('marker3');
    });

    it('should return empty object if no markers', () => {
      const monitor = getPerformanceMonitor();

      const metrics = monitor.getMetrics();

      expect(metrics).toEqual({});
      expect(Object.keys(metrics)).toHaveLength(0);
    });

    it('should return snapshot of metrics', () => {
      const monitor = getPerformanceMonitor();

      monitor.mark('marker1');
      const metrics1 = monitor.getMetrics();

      monitor.mark('marker2');
      const metrics2 = monitor.getMetrics();

      // First snapshot should not be affected by later marks
      expect(Object.keys(metrics1)).toHaveLength(1);
      expect(Object.keys(metrics2)).toHaveLength(2);
    });
  });

  describe('getTotalElapsed()', () => {
    it('should return elapsed time since start', () => {
      const monitor = getPerformanceMonitor();

      // Wait a bit
      const start = Date.now();
      while (Date.now() - start < 10) {
        // Busy wait 10ms
      }

      const elapsed = monitor.getTotalElapsed();

      expect(elapsed).toBeGreaterThanOrEqual(10);
      expect(typeof elapsed).toBe('number');
    });

    it('should increase over time', () => {
      const monitor = getPerformanceMonitor();

      const elapsed1 = monitor.getTotalElapsed();

      // Wait a bit
      const start = Date.now();
      while (Date.now() - start < 5) {
        // Busy wait 5ms
      }

      const elapsed2 = monitor.getTotalElapsed();

      expect(elapsed2).toBeGreaterThan(elapsed1);
    });
  });

  describe('logSummary()', () => {
    it('should log all markers', () => {
      const monitor = getPerformanceMonitor();

      monitor.mark('marker1');
      monitor.mark('marker2');

      // Should not throw
      expect(() => monitor.logSummary()).not.toThrow();
    });

    it('should respect enabled state', () => {
      const monitor = getPerformanceMonitor();

      monitor.mark('marker1');
      monitor.setEnabled(false);

      // Should not throw even when disabled
      expect(() => monitor.logSummary()).not.toThrow();
    });

    it('should handle empty metrics', () => {
      const monitor = getPerformanceMonitor();

      // Should not throw with no markers
      expect(() => monitor.logSummary()).not.toThrow();
    });
  });

  describe('setEnabled()', () => {
    it('should enable monitoring', () => {
      const monitor = getPerformanceMonitor();

      monitor.setEnabled(true);
      monitor.mark('enabled-marker');

      const metrics = monitor.getMetrics();
      expect(metrics).toHaveProperty('enabled-marker');
    });

    it('should disable monitoring', () => {
      const monitor = getPerformanceMonitor();

      monitor.setEnabled(false);
      monitor.mark('disabled-marker');

      const metrics = monitor.getMetrics();
      expect(metrics).not.toHaveProperty('disabled-marker');
    });

    it('should toggle monitoring state', () => {
      const monitor = getPerformanceMonitor();

      monitor.setEnabled(false);
      monitor.mark('disabled1');

      monitor.setEnabled(true);
      monitor.mark('enabled1');

      monitor.setEnabled(false);
      monitor.mark('disabled2');

      const metrics = monitor.getMetrics();
      expect(metrics).not.toHaveProperty('disabled1');
      expect(metrics).toHaveProperty('enabled1');
      expect(metrics).not.toHaveProperty('disabled2');
    });
  });

  describe('reset()', () => {
    it('should clear all markers', () => {
      const monitor = getPerformanceMonitor();

      monitor.mark('marker1');
      monitor.mark('marker2');

      monitor.reset();

      const metrics = monitor.getMetrics();
      expect(Object.keys(metrics)).toHaveLength(0);
    });

    it('should reset start time', () => {
      const now = vi.spyOn(Date, 'now');
      now
        .mockReturnValueOnce(1_000)
        .mockReturnValueOnce(1_000)
        .mockReturnValueOnce(1_015)
        .mockReturnValueOnce(2_000)
        .mockReturnValueOnce(2_000)
        .mockReturnValueOnce(2_000);

      const monitor = getPerformanceMonitor();
      const elapsedBefore = monitor.getTotalElapsed();
      monitor.reset();
      const elapsedAfter = monitor.getTotalElapsed();

      expect(elapsedBefore).toBe(15);
      expect(elapsedAfter).toBe(0);
      now.mockRestore();
    });

    it('should allow marking after reset', () => {
      const monitor = getPerformanceMonitor();

      monitor.mark('before-reset');
      monitor.reset();
      monitor.mark('after-reset');

      const metrics = monitor.getMetrics();
      expect(metrics).not.toHaveProperty('before-reset');
      expect(metrics).toHaveProperty('after-reset');
    });
  });

  describe('destroyPerformanceMonitor()', () => {
    it('should reset the monitor', () => {
      const monitor = getPerformanceMonitor();

      monitor.mark('marker1');
      destroyPerformanceMonitor();

      // Get new instance
      const newMonitor = getPerformanceMonitor();
      const metrics = newMonitor.getMetrics();

      expect(Object.keys(metrics)).toHaveLength(0);
    });

    it('should handle being called multiple times', () => {
      getPerformanceMonitor();

      destroyPerformanceMonitor();
      destroyPerformanceMonitor();
      destroyPerformanceMonitor();

      // Should not throw
      expect(() => getPerformanceMonitor()).not.toThrow();
    });

    it('should handle being called without instance', () => {
      // Don't create instance first
      expect(() => destroyPerformanceMonitor()).not.toThrow();
    });
  });

  describe('Real-world usage scenarios', () => {
    it('should track startup sequence', () => {
      const monitor = getPerformanceMonitor();

      monitor.mark('app-start');
      monitor.mark('config-loaded');
      monitor.mark('window-created');
      monitor.mark('app-ready');

      const metrics = monitor.getMetrics();
      expect(Object.keys(metrics)).toHaveLength(4);

      // Verify sequential timing
      expect(metrics['app-start']).toBeLessThanOrEqual(metrics['config-loaded']);
      expect(metrics['config-loaded']).toBeLessThanOrEqual(metrics['window-created']);
      expect(metrics['window-created']).toBeLessThanOrEqual(metrics['app-ready']);
    });

    it('should measure feature initialization times', () => {
      const monitor = getPerformanceMonitor();

      monitor.mark('feature-start');
      // Simulate work
      const start = Date.now();
      while (Date.now() - start < 5) {
        // Busy wait
      }
      monitor.mark('feature-end');

      const duration = monitor.measure('feature-start', 'feature-end');
      expect(duration).not.toBeNull();
      expect(duration!).toBeGreaterThanOrEqual(5);
    });

    it('should track multiple parallel operations', () => {
      const monitor = getPerformanceMonitor();

      monitor.mark('op1-start');
      monitor.mark('op2-start');
      monitor.mark('op1-end');
      monitor.mark('op2-end');

      const op1Duration = monitor.measure('op1-start', 'op1-end');
      const op2Duration = monitor.measure('op2-start', 'op2-end');

      expect(op1Duration).not.toBeNull();
      expect(op2Duration).not.toBeNull();
    });
  });

  describe('exportToJSON()', () => {
    it('should return metrics without writing to file when no path provided', () => {
      const monitor = getPerformanceMonitor();
      monitor.mark('test-marker');

      const metrics = monitor.exportToJSON();

      expect(metrics).toBeDefined();
      expect(metrics.startupTime).toBeGreaterThanOrEqual(0);
      expect(metrics.markers).toHaveProperty('test-marker');
      expect(metrics.targetMet).toBeDefined();
      expect(metrics.appVersion).toBe('1.0.0');
      expect(metrics.timestamp).toBeDefined();
      expect(metrics.schemaVersion).toBe(1);
      expect(metrics.units).toEqual({ memory: 'MB', time: 'ms' });
      expect(metrics.capture).toBeDefined();
      expect(metrics.capture.complete).toBe(false);
      expect(metrics.capture.valid).toBe(false);
    });

    it('marks capture complete+valid only when markers and renderer samples exist', () => {
      const monitor = getPerformanceMonitor();
      for (const name of [
        'app-start',
        'app-ready',
        'account-0-ready',
        'account-0-content-loaded',
        'features-loaded',
        'all-features-loaded',
      ]) {
        monitor.mark(name);
      }
      // Inject a renderer sample via sampleAllRenderers mock metrics
      getAppMetricsMock.mockReturnValueOnce([
        {
          type: 'Tab',
          pid: 42,
          memory: { workingSetSize: 1024, peakWorkingSetSize: 2048 },
          cpu: { percentCPUUsage: 1 },
        },
      ]);
      monitor.sampleAllRenderers();

      const metrics = monitor.exportToJSON(undefined, { complete: true });
      expect(metrics.capture.complete).toBe(true);
      expect(metrics.capture.valid).toBe(true);
      expect(metrics.capture.rendererSampleCount).toBeGreaterThanOrEqual(1);
      expect(metrics.capture.missingMarkers).toEqual([]);
      expect(metrics.units.memory).toBe('MB');
    });

    it('marks incomplete when required markers are absent even if complete flag is set', () => {
      const monitor = getPerformanceMonitor();
      const metrics = monitor.exportToJSON(undefined, { complete: true });
      expect(metrics.capture.complete).toBe(true);
      expect(metrics.capture.valid).toBe(false);
      expect(metrics.capture.missingMarkers.length).toBeGreaterThan(0);
    });

    it('should write metrics to file when outputPath provided', async () => {
      const fs = await import('fs');
      const monitor = getPerformanceMonitor();
      monitor.mark('test-marker');

      const metrics = monitor.exportToJSON('/fake/output/metrics.json');

      expect(fs.default.existsSync).toHaveBeenCalledWith('/fake/output');
      expect(fs.default.mkdirSync).toHaveBeenCalledWith('/fake/output', { recursive: true });
      expect(fs.default.writeFileSync).toHaveBeenCalledWith(
        '/fake/output/metrics.json',
        expect.any(String)
      );
      expect(metrics).toBeDefined();
    });

    it('should create directory if it does not exist', async () => {
      const fs = await import('fs');
      vi.mocked(fs.default.existsSync).mockReturnValueOnce(false);

      const monitor = getPerformanceMonitor();
      monitor.exportToJSON('/new/dir/metrics.json');

      expect(fs.default.mkdirSync).toHaveBeenCalledWith('/new/dir', { recursive: true });
    });

    it('should not create directory if it already exists', async () => {
      const fs = await import('fs');
      vi.mocked(fs.default.existsSync).mockReturnValueOnce(true);

      const monitor = getPerformanceMonitor();
      monitor.exportToJSON('/existing/dir/metrics.json');

      expect(fs.default.mkdirSync).not.toHaveBeenCalled();
    });

    it('should handle write errors gracefully', async () => {
      const fs = await import('fs');
      const log = await import('electron-log');

      vi.mocked(fs.default.writeFileSync).mockImplementationOnce(() => {
        throw new Error('Write failed');
      });

      const monitor = getPerformanceMonitor();
      const metrics = monitor.exportToJSON('/fake/output/metrics.json');

      // Should still return metrics even on write error
      expect(metrics).toBeDefined();
      expect(metrics.startupTime).toBeGreaterThanOrEqual(0);
      expect(log.default.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to export metrics'),
        expect.anything()
      );
    });
  });

  describe('mark() threshold warnings', () => {
    it('should log warning when marker approaches target threshold', () => {
      vi.useFakeTimers();
      const monitor = getPerformanceMonitor();

      // Advance time to between WARNING and CRITICAL thresholds (2500-3500ms)
      vi.advanceTimersByTime(2700);
      monitor.mark('slow-marker');

      vi.useRealTimers();
    });

    it('should log error when marker exceeds critical threshold', async () => {
      vi.useFakeTimers();
      const log = await import('electron-log');
      const monitor = getPerformanceMonitor();

      // Advance time past CRITICAL_THRESHOLD_MS (3500ms)
      vi.advanceTimersByTime(3600);
      monitor.mark('critical-marker');

      expect(log.default.error).toHaveBeenCalledWith(
        expect.stringContaining('EXCEEDS target threshold')
      );

      vi.useRealTimers();
    });

    it('should capture memory snapshot when captureMemory is true', () => {
      const monitor = getPerformanceMonitor();

      monitor.mark('mem-marker', undefined, true);

      const memStats = monitor.getMemoryStats();
      expect(memStats).not.toBeNull();
      // Should have at least 2 snapshots: startup + this marker
      expect(memStats!.initial).toBeDefined();
      expect(memStats!.current).toBeDefined();
    });
  });

  describe('logSummary() with warnings and target missed', () => {
    it('should log target missed when startup exceeds threshold', async () => {
      vi.useFakeTimers();
      const log = await import('electron-log');
      const monitor = getPerformanceMonitor();

      // Advance past STARTUP_TIME_MS (3000ms)
      vi.advanceTimersByTime(3100);

      monitor.logSummary();

      expect(log.default.error).toHaveBeenCalledWith(expect.stringContaining('Target MISSED'));

      vi.useRealTimers();
    });

    it('should log warnings section when warnings exist', async () => {
      vi.useFakeTimers();
      const log = await import('electron-log');
      const monitor = getPerformanceMonitor();

      // Create a warning by marking past warning threshold
      vi.advanceTimersByTime(2700);
      monitor.mark('warning-marker');

      // Reset mock to only check logSummary calls
      vi.mocked(log.default.warn).mockClear();

      monitor.logSummary();

      // Should log each warning in the warnings section
      expect(log.default.warn).toHaveBeenCalledWith(expect.stringContaining('warning-marker'));

      vi.useRealTimers();
    });

    it('should return memory stats with peak tracking', () => {
      const monitor = getPerformanceMonitor();

      monitor.mark('snapshot1', undefined, true);
      monitor.mark('snapshot2', undefined, true);

      const memStats = monitor.getMemoryStats();

      expect(memStats).not.toBeNull();
      expect(memStats!.initial).toBeDefined();
      expect(memStats!.current).toBeDefined();
      expect(memStats!.peak).toBeDefined();
      expect(memStats!.peak.heapUsed).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Array cap enforcement', () => {
    it('should cap memorySnapshots at MAX_SNAPSHOTS (100) with FIFO eviction', () => {
      vi.useFakeTimers();
      const monitor = getPerformanceMonitor();
      // Constructor already adds 1 snapshot ('startup') at time 0
      // Add 110 more snapshots via mark(..., captureMemory=true) → total 111 pushes
      for (let i = 0; i < 110; i++) {
        vi.advanceTimersByTime(10); // advance 10ms per snapshot so timestamps differ
        monitor.mark(`snap-${i}`, undefined, true);
      }

      const metrics = monitor.exportToJSON();
      // Should be capped at 100
      expect(metrics.memorySnapshots.length).toBe(100);
      // The startup snapshot (timestamp ~0) should have been evicted
      // First remaining snapshot should have timestamp > 0
      expect(metrics.memorySnapshots[0]!.timestamp).toBeGreaterThan(0);

      vi.useRealTimers();
    });

    it('should cap warnings at MAX_WARNINGS (50) with FIFO eviction', () => {
      vi.useFakeTimers();
      const monitor = getPerformanceMonitor();

      // Generate 60 warnings by advancing time past CRITICAL_THRESHOLD_MS (3500ms)
      // each mark at >3500ms adds a warning
      for (let i = 0; i < 60; i++) {
        vi.setSystemTime(Date.now() + 3600);
        monitor.mark(`warn-${i}`);
      }

      const metrics = monitor.exportToJSON();
      expect(metrics.warnings.length).toBeLessThanOrEqual(50);
      // Oldest warnings should have been evicted — first warning should NOT be warn-0
      expect(metrics.warnings[0]).not.toContain("'warn-0'");
      // The most recent warning should still be present
      expect(metrics.warnings[metrics.warnings.length - 1]).toContain("'warn-59'");

      vi.useRealTimers();
    });

    it('should evict oldest snapshot (FIFO) when at capacity', () => {
      vi.useFakeTimers();
      const monitor = getPerformanceMonitor();
      // Reset to clear the startup snapshot, then reset adds 1 snapshot at time 0
      monitor.reset();

      // Fill to exactly MAX_SNAPSHOTS: reset already added 1, add 99 more
      for (let i = 0; i < 99; i++) {
        vi.advanceTimersByTime(10);
        monitor.mark(`fill-${i}`, undefined, true);
      }

      const metricsBefore = monitor.exportToJSON();
      expect(metricsBefore.memorySnapshots.length).toBe(100);
      const firstTimestamp = metricsBefore.memorySnapshots[0]!.timestamp;

      // Add one more — should evict the oldest
      vi.advanceTimersByTime(10);
      monitor.mark('overflow', undefined, true);

      const metricsAfter = monitor.exportToJSON();
      expect(metricsAfter.memorySnapshots.length).toBe(100);
      // The first entry should now have a different (later) timestamp
      expect(metricsAfter.memorySnapshots[0]!.timestamp).toBeGreaterThan(firstTimestamp);

      vi.useRealTimers();
    });

    it('records IPC latency samples, exports them, and enforces FIFO cap', () => {
      const monitor = getPerformanceMonitor();

      for (let i = 0; i < 1001; i++) {
        monitor.recordIpcLatency(`channel-${i}`, i, { accountIndex: i % 3, kind: 'on' });
      }

      const metrics = monitor.exportToJSON();
      expect(metrics.ipcLatencySamples).toHaveLength(1000);
      expect(metrics.ipcLatencySamples![0]).toEqual({
        timestamp: expect.any(Number),
        channel: 'channel-1',
        durationMs: 1,
        accountIndex: 1,
        kind: 'on',
      });
      expect(metrics.ipcLatencySamples![999]!.channel).toBe('channel-1000');
      expect(
        monitor
          .getIpcLatencySamples()
          .every((sample) => Number.isFinite(sample.durationMs) && sample.durationMs >= 0)
      ).toBe(true);
    });

    it('records memory latency samples, exports them, and enforces FIFO cap', () => {
      const monitor = getPerformanceMonitor();

      for (let i = 0; i < 501; i++) {
        monitor.recordMemoryLatency(`operation-${i}`, i, { accountIndex: i % 2 });
      }

      const metrics = monitor.exportToJSON();
      expect(metrics.memoryLatencySamples).toHaveLength(500);
      expect(metrics.memoryLatencySamples![0]).toEqual({
        timestamp: expect.any(Number),
        operation: 'operation-1',
        durationMs: 1,
        accountIndex: 1,
      });
      expect(metrics.memoryLatencySamples![499]!.operation).toBe('operation-500');
    });

    it('does not record latency samples when monitoring is disabled', () => {
      const monitor = getPerformanceMonitor();
      monitor.setEnabled(false);

      monitor.recordIpcLatency('channel', 1, { kind: 'fast' });
      monitor.recordMemoryLatency('operation', 1);

      const metrics = monitor.exportToJSON();
      expect(metrics.ipcLatencySamples).toBeUndefined();
      expect(metrics.memoryLatencySamples).toBeUndefined();
    });

    it('clears latency sample buffers on reset', () => {
      const monitor = getPerformanceMonitor();
      monitor.recordIpcLatency('channel', 1, { kind: 'invoke' });
      monitor.recordMemoryLatency('operation', 2);

      monitor.reset();

      const metrics = monitor.exportToJSON();
      expect(metrics.ipcLatencySamples).toBeUndefined();
      expect(metrics.memoryLatencySamples).toBeUndefined();
      expect(monitor.getIpcLatencySamples()).toEqual([]);
    });

    it('clears IPC samples on destruction on both the retired and next instances', () => {
      const monitor = getPerformanceMonitor();
      monitor.recordIpcLatency('channel', 3, { kind: 'fast' });
      destroyPerformanceMonitor();
      expect(monitor.getIpcLatencySamples()).toEqual([]);
      expect(getPerformanceMonitor().getIpcLatencySamples()).toEqual([]);
    });
  });

  describe('renderer memory tracking', () => {
    /** Build a fake ProcessMetric list. Memory values are in KB per Electron docs. */
    function makeMetric(
      pid: number,
      type: Electron.ProcessMetric['type'],
      workingSetKB: number,
      cpuPercent = 5
    ): Electron.ProcessMetric {
      return {
        pid,
        type,
        cpu: {
          percentCPUUsage: cpuPercent,
          cumulativeCPUUsage: 0,
          idleWakeupsPerSecond: 0,
        },
        creationTime: Date.now(),
        memory: {
          workingSetSize: workingSetKB,
          peakWorkingSetSize: workingSetKB,
          // privateBytes is Windows-only; omit to mirror macOS / Linux runtime.
        },
        // sandboxed/integrityLevel/name are optional in the API surface
      } as Electron.ProcessMetric;
    }

    beforeEach(() => {
      getAppMetricsMock.mockReset();
    });

    it('sampleAllRenderers() populates renderer snapshots', () => {
      getAppMetricsMock.mockReturnValue([
        makeMetric(101, 'Browser', 200_000), // skipped (Browser is main process)
        makeMetric(202, 'Tab', 150_000, 12), // 150_000 KB → ~146.48 MB
        makeMetric(303, 'GPU', 80_000, 3),
        makeMetric(404, 'Utility', 50_000, 1),
      ]);

      const monitor = getPerformanceMonitor();
      monitor.sampleAllRenderers();

      const snaps = monitor.getRendererMemoryStats();
      // Browser is filtered out; remaining 3 should be captured.
      expect(snaps.length).toBe(3);

      const tab = snaps.find((s) => s.pid === 202);
      expect(tab).toBeDefined();
      expect(tab!.type).toBe('renderer');
      expect(tab!.cpuPercent).toBe(12);
      // 150_000 KB / 1024 ≈ 146.48 MB
      expect(tab!.memory.residentSet).toBeCloseTo(146.48, 1);
      expect(tab!.memory.peakResidentSet).toBeCloseTo(146.48, 1);
      // privateBytes omitted in the mock → unavailable (not measured zero)
      expect(tab!.memory.private).toBeNull();
      expect(tab!.memory.privateSource).toBe('unavailable');
      expect(tab!.accountIndex).toBeUndefined();

      expect(snaps.find((s) => s.pid === 303)?.type).toBe('gpu');
      expect(snaps.find((s) => s.pid === 404)?.type).toBe('utility');
    });

    it('getRendererMemoryStats() returns the snapshot list', () => {
      getAppMetricsMock.mockReturnValue([makeMetric(11, 'Tab', 1024)]);
      const monitor = getPerformanceMonitor();
      monitor.sampleAllRenderers();
      const stats = monitor.getRendererMemoryStats();
      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBe(1);
    });

    it('getRendererSnapshots() satisfies the reader interface contract', () => {
      getAppMetricsMock.mockReturnValue([makeMetric(22, 'Tab', 2048)]);
      const monitor = getPerformanceMonitor();
      monitor.sampleAllRenderers();

      // The reader-shaped accessor used by performanceExport.
      const reader = monitor.getRendererSnapshots();
      expect(reader.length).toBe(1);
      expect(reader[0]!.pid).toBe(22);
    });

    it('enforces MAX_RENDERER_SNAPSHOTS limit (FIFO eviction)', () => {
      // Each call adds 1 snapshot. Need 1001 calls to overflow the 1000 cap.
      const monitor = getPerformanceMonitor();
      // First sample uses pid=1 so we can detect when it gets evicted.
      getAppMetricsMock.mockReturnValueOnce([makeMetric(1, 'Tab', 1024)]);
      monitor.sampleAllRenderers();

      // Fill the rest of the buffer with pid=999.
      getAppMetricsMock.mockReturnValue([makeMetric(999, 'Tab', 1024)]);
      for (let i = 0; i < 1000; i++) {
        monitor.sampleAllRenderers();
      }

      const snaps = monitor.getRendererMemoryStats();
      expect(snaps.length).toBe(1000);
      // The original pid=1 snapshot should have been evicted (FIFO).
      expect(snaps.find((s) => s.pid === 1)).toBeUndefined();
    });

    it('correlates renderer PIDs with account index when manager provided', () => {
      const fakeWebContents = {
        id: 42,
        isDestroyed: () => false,
        getOSProcessId: () => 555,
      } as unknown as Electron.WebContents;

      const fakeManager: Pick<IAccountWindowManager, 'enumerateAccountWebContents'> = {
        enumerateAccountWebContents: () => [
          {
            accountIndex: asAccountIndex(2),
            webContentsId: asWebContentsId(42),
            osProcessId: 555,
            backend: 'browser-window',
            webContents: fakeWebContents,
          },
        ],
      };

      getAppMetricsMock.mockReturnValue([
        makeMetric(555, 'Tab', 100_000, 8),
        makeMetric(666, 'Tab', 200_000, 4), // unmapped PID → no accountIndex
      ]);

      const monitor = getPerformanceMonitor();
      monitor.sampleAllRenderers(fakeManager as IAccountWindowManager);

      const snaps = monitor.getRendererMemoryStats();
      const mapped = snaps.find((s) => s.pid === 555);
      const unmapped = snaps.find((s) => s.pid === 666);
      expect(mapped?.accountIndex).toBe(2);
      expect(mapped?.backend).toBe('browser-window');
      expect(mapped?.webContentsId).toBe(42);
      expect(unmapped?.accountIndex).toBeUndefined();
    });

    it('maps WebContentsView child renderers, not host-only', () => {
      const childA = {
        id: 10,
        isDestroyed: () => false,
        getOSProcessId: () => 1001,
      } as unknown as Electron.WebContents;
      const childB = {
        id: 11,
        isDestroyed: () => false,
        getOSProcessId: () => 1002,
      } as unknown as Electron.WebContents;

      const fakeManager: Pick<IAccountWindowManager, 'enumerateAccountWebContents'> = {
        enumerateAccountWebContents: () => [
          {
            accountIndex: asAccountIndex(0),
            webContentsId: asWebContentsId(10),
            osProcessId: 1001,
            backend: 'web-contents-view',
            webContents: childA,
          },
          {
            accountIndex: asAccountIndex(1),
            webContentsId: asWebContentsId(11),
            osProcessId: 1002,
            backend: 'web-contents-view',
            webContents: childB,
          },
        ],
      };

      getAppMetricsMock.mockReturnValue([
        makeMetric(1001, 'Tab', 50_000, 1),
        makeMetric(1002, 'Tab', 60_000, 2),
        makeMetric(9999, 'Tab', 10_000, 0), // host or unrelated — unmapped
      ]);

      const monitor = getPerformanceMonitor();
      monitor.sampleAllRenderers(fakeManager as IAccountWindowManager);
      const snaps = monitor.getRendererMemoryStats();
      expect(snaps.find((s) => s.pid === 1001)?.accountIndex).toBe(0);
      expect(snaps.find((s) => s.pid === 1002)?.accountIndex).toBe(1);
      expect(snaps.find((s) => s.pid === 1001)?.backend).toBe('web-contents-view');
      expect(snaps.find((s) => s.pid === 9999)?.accountIndex).toBeUndefined();
    });

    it('produces snapshots that match the RendererMemorySnapshot shape', () => {
      getAppMetricsMock.mockReturnValue([makeMetric(77, 'Tab', 4096, 9)]);
      const monitor = getPerformanceMonitor();
      monitor.sampleAllRenderers();
      const snap = monitor.getRendererMemoryStats()[0]!;

      // Spot-check every required field exists with the right primitive shape.
      // private is null + unavailable when platform omits privateBytes (macOS).
      expect(snap.pid).toBe(77);
      expect(snap.type).toBe('renderer');
      expect(snap.memory.private).toBeNull();
      expect(snap.memory.privateSource).toBe('unavailable');
      expect(typeof snap.timestamp).toBe('number');
      expect(typeof snap.cpuPercent).toBe('number');
    });

    it('records measured private memory when privateBytes is present', () => {
      getAppMetricsMock.mockReturnValue([
        {
          ...makeMetric(88, 'Tab', 4096, 1),
          memory: {
            workingSetSize: 4096,
            peakWorkingSetSize: 8192,
            privateBytes: 2048,
          },
        },
      ]);
      const monitor = getPerformanceMonitor();
      monitor.sampleAllRenderers();
      const snap = monitor.getRendererMemoryStats()[0]!;
      expect(snap.memory.private).toBe(2); // 2048 KB → 2 MB
      expect(snap.memory.privateSource).toBe('measured');
    });
  });
});
