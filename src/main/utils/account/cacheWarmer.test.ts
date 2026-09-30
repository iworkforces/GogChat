/**
 * Tests for Cache Warmer
 *
 * Verifies that ADDITIONAL_ICON_PATHS (idle warmup) is the disjoint complement
 * of INITIAL_ICON_PATHS (critical-path warmup) in iconCache.ts, so that idle
 * warmup never re-fetches an icon already cached during the critical path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import { asType } from '../../../shared/typeUtils.js';
import type * as CacheWarmer from './cacheWarmer.js';
import type * as StartupAdmission from '../lifecycle/startupAdmission.js';
import type * as IconCache from '../platform/iconCache.js';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => path.join(__dirname, '../../..'),
    getName: () => 'gogchat',
    getPath: (name: string) => `/fake/path/${name}`,
    isPackaged: false,
  },
  nativeImage: {
    createFromPath: vi.fn((_path: string) => ({
      isEmpty: () => false,
      getSize: () => ({ width: 16, height: 16 }),
    })),
  },
}));

vi.mock('electron-log', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Avoid pulling perfMonitor / configProfiler side effects into this unit test;
// only the functions under test are exercised.
const createTrackedTimeoutMock = vi.hoisted(() => vi.fn());
const notifyDeferredMock = vi.hoisted(() => vi.fn());
const runPhaseMock = vi.hoisted(() => vi.fn(async () => undefined));
const compareStorePerformanceMock = vi.hoisted(() => vi.fn());

vi.mock('../lifecycle/performanceMonitor.js', () => ({
  perfMonitor: { mark: vi.fn(), logSummary: vi.fn(), exportToJSON: vi.fn() },
}));
vi.mock('../lifecycle/resourceCleanup.js', () => ({
  createTrackedTimeout: createTrackedTimeoutMock,
}));
vi.mock('../lifecycle/configProfiler.js', () => ({
  compareStorePerformance: compareStorePerformanceMock,
}));
vi.mock('../lifecycle/performanceFinalizer.js', () => ({
  notifyDeferredPhaseComplete: notifyDeferredMock,
}));
vi.mock('../lifecycle/featureRunner.js', () => ({
  runPhase: runPhaseMock,
}));

import {
  warmCachesOnIdle,
  warmInitialIcons,
  runDeferredPhase,
  runDevPostDeferred,
  scheduleIdleCacheWarming,
} from './cacheWarmer';
import { getIconCache, destroyIconCache, INITIAL_ICON_PATHS } from '../platform/iconCache';
import { nativeImage } from 'electron';
import { perfMonitor } from '../lifecycle/performanceMonitor.js';

/** Extract ADDITIONAL_ICON_PATHS from cacheWarmer.ts source for test assertions. */
function readAdditionalPaths(): string[] {
  const src = fs.readFileSync(path.join(__dirname, 'cacheWarmer.ts'), 'utf8');
  const match = src.match(/ADDITIONAL_ICON_PATHS\s*=\s*\[([\s\S]*?)\]\s*as const/);
  if (!match) throw new Error('ADDITIONAL_ICON_PATHS not found');
  return Array.from(match[1].matchAll(/'([^']+)'/g)).map((m) => m[1] as string);
}

describe('cacheWarmer', () => {
  beforeEach(() => {
    destroyIconCache();
    vi.mocked(nativeImage.createFromPath).mockClear();
  });

  afterEach(() => {
    destroyIconCache();
  });

  describe('Disjointness Invariant', () => {
    it('ADDITIONAL_ICON_PATHS must be disjoint from INITIAL_ICON_PATHS', () => {
      const additional = readAdditionalPaths();
      const initialSet = new Set<string>(INITIAL_ICON_PATHS);
      const overlap = additional.filter((p) => initialSet.has(p));
      expect(
        overlap,
        `Found overlap between INITIAL and ADDITIONAL: ${overlap.join(', ')}`
      ).toEqual([]);
    });

    it('ADDITIONAL_ICON_PATHS contains the expected complement set', () => {
      const additional = readAdditionalPaths();
      expect(additional.sort()).toEqual(
        [
          'resources/icons/normal/32.png',
          'resources/icons/normal/64.png',
          'resources/icons/normal/256.png',
          'resources/icons/offline/16.png',
          'resources/icons/offline/32.png',
        ].sort()
      );
    });
  });

  describe('warmCachesOnIdle', () => {
    it('does not re-fetch icons already loaded by warmInitialIcons (no overlap)', () => {
      // First, run the critical-path warmup
      warmInitialIcons();
      const initialCallCount = vi.mocked(nativeImage.createFromPath).mock.calls.length;
      expect(initialCallCount).toBe(INITIAL_ICON_PATHS.length);

      // Then, run idle warmup
      warmCachesOnIdle();
      const totalCallCount = vi.mocked(nativeImage.createFromPath).mock.calls.length;
      const additionalCallCount = totalCallCount - initialCallCount;

      // Each ADDITIONAL path triggered exactly one disk load (no INITIAL re-fetch)
      const additional = readAdditionalPaths();
      expect(additionalCallCount).toBe(additional.length);

      // Cache contains both sets, all unique
      const cache = getIconCache();
      const cachedIcons = cache.getStats().icons;
      expect(cachedIcons.length).toBe(INITIAL_ICON_PATHS.length + additional.length);
    });

    it('handles empty-image results without throwing', () => {
      vi.mocked(nativeImage.createFromPath).mockReturnValue({
        isEmpty: () => true,
        getSize: () => ({ width: 0, height: 0 }),
      } as ReturnType<typeof nativeImage.createFromPath>);

      expect(() => warmCachesOnIdle()).not.toThrow();
    });
  });

  describe('runDeferredPhase / finalizer signal', () => {
    beforeEach(() => {
      notifyDeferredMock.mockClear();
      runPhaseMock.mockClear();
      createTrackedTimeoutMock.mockClear();
      compareStorePerformanceMock.mockClear();
      vi.mocked(perfMonitor.mark).mockClear();
      vi.mocked(perfMonitor.logSummary).mockClear();
      delete process.env['ENABLE_CONFIG_PROFILING'];
    });

    it('returns early when main window is unavailable', async () => {
      await runDeferredPhase({
        context: {} as never,
        getMainWindow: () => null,
        isDev: true,
      });
      expect(runPhaseMock).not.toHaveBeenCalled();
      expect(notifyDeferredMock).not.toHaveBeenCalled();
    });

    it('runs deferred phase, logs summary, signals finalizer, schedules idle warm', async () => {
      const fakeWindow = {} as Electron.BrowserWindow;
      await runDeferredPhase({
        context: { mainWindow: fakeWindow } as never,
        getMainWindow: () => fakeWindow,
        isDev: false,
      });

      expect(runPhaseMock).toHaveBeenCalledWith('deferred', expect.anything());
      expect(perfMonitor.mark).toHaveBeenCalledWith('deferred-features-start', expect.any(String));
      expect(perfMonitor.mark).toHaveBeenCalledWith(
        'all-features-loaded',
        expect.any(String),
        true
      );
      expect(perfMonitor.logSummary).toHaveBeenCalled();
      expect(notifyDeferredMock).toHaveBeenCalledTimes(1);
      expect(createTrackedTimeoutMock).toHaveBeenCalled();
      // isDev false → no config profiling
      expect(compareStorePerformanceMock).not.toHaveBeenCalled();
    });

    it('runDevPostDeferred is a no-op when not dev', () => {
      process.env['ENABLE_CONFIG_PROFILING'] = 'true';
      runDevPostDeferred(false);
      expect(compareStorePerformanceMock).not.toHaveBeenCalled();
    });

    it('runDevPostDeferred profiles config when enabled in dev', () => {
      process.env['ENABLE_CONFIG_PROFILING'] = 'true';
      runDevPostDeferred(true);
      expect(compareStorePerformanceMock).toHaveBeenCalled();
    });

    it('runDevPostDeferred does not export metrics JSON', () => {
      runDevPostDeferred(true);
      expect(perfMonitor.exportToJSON).not.toHaveBeenCalled();
    });

    it('scheduleIdleCacheWarming registers tracked timeout', () => {
      scheduleIdleCacheWarming();
      expect(createTrackedTimeoutMock).toHaveBeenCalledWith(
        expect.any(Function),
        8000,
        'idle-cache-warming'
      );
    });
  });
});

describe('cacheWarmer shutdown admission', () => {
  let warmer: typeof CacheWarmer;
  let admission: typeof StartupAdmission;
  let monitor: typeof perfMonitor;
  let icons: typeof IconCache;
  const originalProfiling = process.env['ENABLE_CONFIG_PROFILING'];

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    runPhaseMock.mockResolvedValue(undefined);
    warmer = await import('./cacheWarmer.js');
    admission = await import('../lifecycle/startupAdmission.js');
    ({ perfMonitor: monitor } = await import('../lifecycle/performanceMonitor.js'));
    icons = await import('../platform/iconCache.js');
    process.env['ENABLE_CONFIG_PROFILING'] = 'true';
  });

  afterEach(() => {
    icons.destroyIconCache();
    if (originalProfiling === undefined) delete process.env['ENABLE_CONFIG_PROFILING'];
    else process.env['ENABLE_CONFIG_PROFILING'] = originalProfiling;
  });

  it('guards all public warming/profiling entrypoints after admission closes', async () => {
    const getMainWindow = vi.fn();
    admission.closeStartupAdmission();
    warmer.warmInitialIcons();
    warmer.warmSoonDeferredIcons();
    warmer.warmCachesOnIdle();
    warmer.scheduleIdleCacheWarming();
    warmer.runDevPostDeferred(true);
    await warmer.runDeferredPhase({ context: {}, getMainWindow, isDev: true });

    expect(nativeImage.createFromPath).not.toHaveBeenCalled();
    expect(createTrackedTimeoutMock).not.toHaveBeenCalled();
    expect(compareStorePerformanceMock).not.toHaveBeenCalled();
    expect(runPhaseMock).not.toHaveBeenCalled();
    expect(getMainWindow).not.toHaveBeenCalled();
    expect(monitor.mark).not.toHaveBeenCalled();
  });

  it('does not mark, profile, notify, or schedule when admitted deferred work resumes after quit', async () => {
    const held = Promise.withResolvers<void>();
    runPhaseMock.mockImplementation(() => held.promise);
    const deferred = warmer.runDeferredPhase({
      context: {},
      getMainWindow: () => asType<Electron.BrowserWindow>({}),
      isDev: true,
    });
    expect(runPhaseMock).toHaveBeenCalledTimes(1);
    admission.closeStartupAdmission();
    held.resolve();
    await deferred;

    expect(monitor.mark).not.toHaveBeenCalledWith('all-features-loaded', expect.any(String), true);
    expect(monitor.logSummary).not.toHaveBeenCalled();
    expect(compareStorePerformanceMock).not.toHaveBeenCalled();
    expect(notifyDeferredMock).not.toHaveBeenCalled();
    expect(createTrackedTimeoutMock).not.toHaveBeenCalled();
  });

  it('does not warm when an already scheduled idle callback runs after quit', () => {
    warmer.scheduleIdleCacheWarming();
    const callback = createTrackedTimeoutMock.mock.calls[0]?.[0];
    admission.closeStartupAdmission();
    callback();
    expect(nativeImage.createFromPath).not.toHaveBeenCalled();
  });

  it('preserves the original late deferred failure for its caller', async () => {
    const held = Promise.withResolvers<void>();
    runPhaseMock.mockImplementation(() => held.promise);
    const deferred = warmer.runDeferredPhase({
      context: {},
      getMainWindow: () => asType<Electron.BrowserWindow>({}),
      isDev: true,
    });
    const failure = new Error('late required deferred failure');
    const observed = expect(deferred).rejects.toBe(failure);
    admission.closeStartupAdmission();
    held.reject(failure);
    await observed;
    expect(notifyDeferredMock).not.toHaveBeenCalled();
  });
});
