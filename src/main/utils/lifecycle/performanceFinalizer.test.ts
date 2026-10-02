/**
 * Tests for one-shot performance finalizer (document-load + deferred + sample).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getAppMetricsMock = vi.hoisted(() => vi.fn(() => [] as Electron.ProcessMetric[]));
const writeFileSyncMock = vi.hoisted(() => vi.fn());
const trackedTimeouts = vi.hoisted(() => [] as Array<{ cb: () => void; delay: number }>);

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/fake/app/path',
    getVersion: () => '1.0.0',
    getPath: (name: string) => `/fake/path/${name}`,
    getAppMetrics: getAppMetricsMock,
  },
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    writeFileSync: writeFileSyncMock,
  },
}));

vi.mock('path', () => ({
  default: {
    join: (...args: string[]) => args.join('/'),
    dirname: (p: string) => p.split('/').slice(0, -1).join('/'),
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

vi.mock('./resourceCleanup.js', () => ({
  cancelTrackedTimeout: (handle: NodeJS.Timeout) => clearTimeout(handle),
  createTrackedTimeout: vi.fn((cb: () => void, delay: number) => {
    trackedTimeouts.push({ cb, delay });
    return setTimeout(() => {}, delay) as unknown as NodeJS.Timeout;
  }),
}));

import {
  armPerformanceFinalizer,
  notifyDeferredPhaseComplete,
  notifyDocumentLoadComplete,
  notifyDocumentLoadFailed,
  resetPerformanceFinalizerForTests,
  hasFinalizedPerformanceExport,
} from './performanceFinalizer.js';
import { destroyPerformanceMonitor, getPerformanceMonitor } from './performanceMonitor.js';

describe('performanceFinalizer', () => {
  beforeEach(() => {
    resetPerformanceFinalizerForTests();
    destroyPerformanceMonitor();
    writeFileSyncMock.mockClear();
    trackedTimeouts.length = 0;
    getAppMetricsMock.mockReturnValue([
      {
        type: 'Tab',
        pid: 99,
        memory: { workingSetSize: 2048, peakWorkingSetSize: 4096 },
        cpu: { percentCPUUsage: 0.5 },
      },
    ]);
    process.env['GOGCHAT_EXPORT_METRICS'] = '1';
    process.env['NODE_ENV'] = 'development';
  });

  afterEach(() => {
    resetPerformanceFinalizerForTests();
    destroyPerformanceMonitor();
    delete process.env['GOGCHAT_EXPORT_METRICS'];
  });

  function markAllRequired(): void {
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
  }

  it('does not export when only deferred completes (early export guard)', () => {
    armPerformanceFinalizer({ outputPath: '/fake/path/userData/performance-metrics.json' });
    markAllRequired();
    notifyDeferredPhaseComplete();
    expect(hasFinalizedPerformanceExport()).toBe(false);
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('exports exactly once after deferred + document load with complete+valid capture', () => {
    armPerformanceFinalizer({ outputPath: '/fake/path/userData/performance-metrics.json' });
    markAllRequired();
    notifyDeferredPhaseComplete();
    notifyDocumentLoadComplete();

    expect(hasFinalizedPerformanceExport()).toBe(true);
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
    const written = JSON.parse(writeFileSyncMock.mock.calls[0]![1] as string);
    expect(written.capture.complete).toBe(true);
    expect(written.capture.valid).toBe(true);
    expect(written.units.memory).toBe('MB');
    expect(written.schemaVersion).toBe(1);
    expect(written.capture.rendererSampleCount).toBeGreaterThanOrEqual(1);
  });

  it('exports invalid capture on document load failure', () => {
    armPerformanceFinalizer({ outputPath: '/fake/path/userData/performance-metrics.json' });
    markAllRequired();
    notifyDocumentLoadFailed('network error');

    expect(hasFinalizedPerformanceExport()).toBe(true);
    const written = JSON.parse(writeFileSyncMock.mock.calls[0]![1] as string);
    expect(written.capture.complete).toBe(false);
    expect(written.capture.valid).toBe(false);
    expect(written.capture.reason).toMatch(/network error/);
  });

  it('schedules one renderer re-sample when ready but no Tab metrics yet', () => {
    getAppMetricsMock.mockReturnValue([]);
    armPerformanceFinalizer({ outputPath: '/fake/path/userData/performance-metrics.json' });
    markAllRequired();
    notifyDeferredPhaseComplete();
    notifyDocumentLoadComplete();

    // First attempt defers export for re-sample
    expect(hasFinalizedPerformanceExport()).toBe(false);
    expect(writeFileSyncMock).not.toHaveBeenCalled();
    const resample = trackedTimeouts.find((t) => t.delay === 750);
    expect(resample).toBeDefined();

    getAppMetricsMock.mockReturnValue([
      {
        type: 'Tab',
        pid: 99,
        memory: { workingSetSize: 2048, peakWorkingSetSize: 4096 },
        cpu: { percentCPUUsage: 0.5 },
      },
    ]);
    resample!.cb();
    expect(hasFinalizedPerformanceExport()).toBe(true);
    const written = JSON.parse(writeFileSyncMock.mock.calls[0]![1] as string);
    expect(written.capture.valid).toBe(true);
  });

  it('exports invalid capture on capture timeout', () => {
    armPerformanceFinalizer({
      outputPath: '/fake/path/userData/performance-metrics.json',
      timeoutMs: 100,
    });
    expect(trackedTimeouts.length).toBe(1);
    trackedTimeouts[0]!.cb();

    expect(hasFinalizedPerformanceExport()).toBe(true);
    const written = JSON.parse(writeFileSyncMock.mock.calls[0]![1] as string);
    expect(written.capture.complete).toBe(false);
    expect(written.capture.valid).toBe(false);
    expect(written.capture.reason).toMatch(/timeout/i);
  });

  it('does not double-export after complete finalization', () => {
    armPerformanceFinalizer({ outputPath: '/fake/path/userData/performance-metrics.json' });
    markAllRequired();
    notifyDocumentLoadComplete();
    notifyDeferredPhaseComplete();
    notifyDeferredPhaseComplete();
    notifyDocumentLoadComplete();
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('skips writing when not in export mode', () => {
    delete process.env['GOGCHAT_EXPORT_METRICS'];
    process.env['NODE_ENV'] = 'production';
    armPerformanceFinalizer({ outputPath: '/fake/path/userData/performance-metrics.json' });
    markAllRequired();
    notifyDocumentLoadComplete();
    notifyDeferredPhaseComplete();
    expect(hasFinalizedPerformanceExport()).toBe(true);
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('re-arm after first arm updates account manager without double timeout', () => {
    const getMgr = vi.fn(() => undefined);
    armPerformanceFinalizer({
      outputPath: '/fake/path/userData/performance-metrics.json',
      timeoutMs: 50,
    });
    const timeoutsAfterFirst = trackedTimeouts.length;
    armPerformanceFinalizer({ getAccountManager: getMgr });
    expect(trackedTimeouts.length).toBe(timeoutsAfterFirst);
    markAllRequired();
    notifyDocumentLoadComplete();
    notifyDeferredPhaseComplete();
    expect(writeFileSyncMock).toHaveBeenCalled();
  });

  it('uses GOGCHAT_AUTO_QUIT_AFTER_MS as default timeout when set', () => {
    delete process.env['GOGCHAT_EXPORT_METRICS'];
    process.env['GOGCHAT_AUTO_QUIT_AFTER_MS'] = '7500';
    armPerformanceFinalizer({ outputPath: '/fake/path/userData/performance-metrics.json' });
    expect(trackedTimeouts[0]?.delay).toBe(7500);
    delete process.env['GOGCHAT_AUTO_QUIT_AFTER_MS'];
    process.env['GOGCHAT_EXPORT_METRICS'] = '1';
  });

  it('floors capture timeout to 45s when metrics export is requested', () => {
    process.env['GOGCHAT_EXPORT_METRICS'] = '1';
    process.env['GOGCHAT_AUTO_QUIT_AFTER_MS'] = '7500';
    armPerformanceFinalizer({ outputPath: '/fake/path/userData/performance-metrics.json' });
    expect(trackedTimeouts[0]?.delay).toBe(45_000);
    delete process.env['GOGCHAT_AUTO_QUIT_AFTER_MS'];
  });

  it('continues export when renderer sample throws', () => {
    const monitor = getPerformanceMonitor();
    vi.spyOn(monitor, 'sampleAllRenderers').mockImplementation(() => {
      throw new Error('sample boom');
    });
    armPerformanceFinalizer({ outputPath: '/fake/path/userData/performance-metrics.json' });
    markAllRequired();
    notifyDocumentLoadComplete();
    notifyDeferredPhaseComplete();
    // First attempt schedules re-sample after empty/throwing sample
    const resample = trackedTimeouts.find((t) => t.delay === 750);
    expect(resample).toBeDefined();
    resample!.cb();
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('defaults output path under userData when not overridden', () => {
    armPerformanceFinalizer();
    markAllRequired();
    notifyDocumentLoadComplete();
    notifyDeferredPhaseComplete();
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      '/fake/path/userData/performance-metrics.json',
      expect.any(String)
    );
  });
});
