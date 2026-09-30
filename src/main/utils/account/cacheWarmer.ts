/**
 * Cache Warmer
 *
 * Idle-time cache warming utilities. Schedules and executes warming of
 * commonly accessed data (icons, etc.) during and after critical app init.
 *
 * Also encapsulates the deferred-phase orchestration (deferred features,
 * perf summary, optional dev profiling/export, and idle warming scheduling)
 * so the app-ready orchestrator stays lean.
 */

import { type BrowserWindow } from 'electron';
import log from 'electron-log';
import { perfMonitor } from '../lifecycle/performanceMonitor.js';
import { getIconCache, SOON_DEFERRED_ICON_PATHS } from '../platform/iconCache.js';
import { createTrackedTimeout } from '../lifecycle/resourceCleanup.js';
import { compareStorePerformance } from '../lifecycle/configProfiler.js';
import { runPhase } from '../lifecycle/featureRunner.js';
import type { FeatureContext } from '../lifecycle/featureConfigTypes.js';
import { notifyDeferredPhaseComplete } from '../lifecycle/performanceFinalizer.js';
import { isStartupAdmissionOpen } from '../lifecycle/startupAdmission.js';

/** Delay (ms) before idle cache warming fires after deferred features load. */
const IDLE_WARM_DELAY_MS = 8000;

/**
 * Additional icons preloaded during idle to reduce later UI latency.
 *
 * DISJOINTNESS INVARIANT: Triple-set partition — INITIAL_ICON_PATHS ⊕
 * SOON_DEFERRED_ICON_PATHS (both in iconCache.ts) ⊕ ADDITIONAL_ICON_PATHS (here)
 * MUST be the disjoint complement covering the complete preload set — no overlap,
 * no gaps. Adding a path here requires removing it from the other two sets.
 */
const ADDITIONAL_ICON_PATHS = [
  'resources/icons/normal/32.png',
  'resources/icons/normal/64.png',
  'resources/icons/normal/256.png',
  'resources/icons/offline/16.png',
  'resources/icons/offline/32.png',
] as const;

/**
 * Warm the initial icon cache (called during the blocking critical path,
 * before the UI phase). Sets the 'icons-cached' perf mark.
 */
export function warmInitialIcons(): void {
  if (!isStartupAdmissionOpen()) return;
  getIconCache().warmCache();
  perfMonitor.mark('icons-cached', 'Icons pre-loaded');
}

/**
 * Warm the soon-deferred icon cache (called on setImmediate after the critical
 * path, before the 8s idle warm). Loads tray unread + badge variants so the first
 * notification can render the correct icon within ~50ms of startup.
 */
export function warmSoonDeferredIcons(): void {
  if (!isStartupAdmissionOpen()) return;
  const iconCache = getIconCache();
  for (const iconPath of SOON_DEFERRED_ICON_PATHS) {
    iconCache.getIcon(iconPath);
  }
  perfMonitor.mark('icons-soon-deferred-cached', 'Soon-deferred icons pre-loaded');
}

/**
 * Options for runDeferredPhase.
 */
export interface DeferredPhaseOptions {
  context: FeatureContext;
  getMainWindow: () => BrowserWindow | null;
  isDev: boolean;
}

/**
 * Run the deferred-phase initialization body.
 *
 * - Verifies main window availability
 * - Triggers deferred feature initialization
 * - Logs perf summary
 * - In dev mode: runs optional config profiling and exports perf metrics
 * - Schedules idle cache warming via tracked timeout
 */
export async function runDeferredPhase(options: DeferredPhaseOptions): Promise<void> {
  if (!isStartupAdmissionOpen()) return;
  const { context, getMainWindow, isDev } = options;

  const currentMainWindow = getMainWindow();
  if (!currentMainWindow) {
    log.error('[Main] Main window not available for deferred features');
    return;
  }

  log.debug('[Main] Loading non-critical features with dynamic imports');
  perfMonitor.mark('deferred-features-start', 'Starting deferred feature loading');

  // Initialize deferred features (parallel within precomputed dep batches)
  await runPhase('deferred', context);
  if (!isStartupAdmissionOpen()) return;

  perfMonitor.mark('all-features-loaded', 'All features initialized', true);
  log.info('[Main] All features initialized');

  // Log performance summary
  perfMonitor.logSummary();

  // Dev-only post-deferred side effects (profiling only — metrics export is
  // owned by performanceFinalizer after document-load + renderer sample).
  runDevPostDeferred(isDev);

  // Signal that deferred producers finished so the finalizer can export once
  // account-0 document load (and an immediate renderer sample) also complete.
  notifyDeferredPhaseComplete();

  // ⚡ OPTIMIZATION: Warm caches on idle (after all features loaded)
  scheduleIdleCacheWarming();
}

/**
 * Run dev-only post-deferred side effects: optional config profiling.
 * Metrics export is intentionally NOT performed here — early export omits
 * `account-0-content-loaded` and renderer evidence. See performanceFinalizer.
 */
export function runDevPostDeferred(isDev: boolean): void {
  if (!isStartupAdmissionOpen() || !isDev) return;

  if (process.env['ENABLE_CONFIG_PROFILING'] === 'true') {
    log.info('[Main] Running config store performance analysis...');
    compareStorePerformance();
  }
}

/**
 * Schedule idle cache warming via a tracked timeout.
 *
 * ⚡ OPTIMIZATION: Preloads commonly accessed data after all features loaded.
 */
export function scheduleIdleCacheWarming(): void {
  if (!isStartupAdmissionOpen()) return;
  createTrackedTimeout(
    () => {
      warmCachesOnIdle();
    },
    IDLE_WARM_DELAY_MS,
    'idle-cache-warming'
  );
}

/**
 * Warm various caches during idle time.
 * ⚡ OPTIMIZATION: Preloads commonly accessed data to improve responsiveness.
 */
export function warmCachesOnIdle(): void {
  if (!isStartupAdmissionOpen()) return;
  try {
    log.debug('[Main] Starting idle cache warming...');

    const iconCache = getIconCache();

    let warmed = 0;
    ADDITIONAL_ICON_PATHS.forEach((iconPath) => {
      const icon = iconCache.getIcon(iconPath);
      if (!icon.isEmpty()) {
        warmed++;
      }
    });

    log.info(
      `[Main] Cache warming complete - ${warmed}/${ADDITIONAL_ICON_PATHS.length} additional icons loaded`
    );

    // Log final cache statistics
    const stats = iconCache.getStats();
    log.debug(
      `[Main] Icon cache stats - Size: ${stats.size}/${stats.maxSize}, Total accesses: ${stats.totalAccesses}, Most accessed: ${stats.mostAccessed}`
    );
  } catch (error: unknown) {
    log.error('[Main] Failed to warm caches:', error);
  }
}
