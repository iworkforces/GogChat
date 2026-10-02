/**
 * One-shot startup performance finalization.
 *
 * Owns development metrics export so it runs exactly once after:
 *   1. Deferred phase marks (including `all-features-loaded`) are present, and
 *   2. Account-0 document load emits `account-0-content-loaded` (or fails), and
 *   3. An immediate renderer sample has been taken.
 *
 * A load failure or capture timeout exports an invalid (not complete) artifact.
 * Early export from deferred phase alone is intentionally not performed here.
 */

import { app } from 'electron';
import log from 'electron-log';
import path from 'path';

import type { IAccountWindowManager } from '../../../shared/types/window.js';
import { cancelTrackedTimeout, createTrackedTimeout } from './resourceCleanup.js';
import { getPerformanceMonitor } from './performanceMonitor.js';

export interface ArmPerformanceFinalizerOptions {
  /** Optional account manager for PID → account mapping during the final sample. */
  getAccountManager?: () => IAccountWindowManager | undefined;
  /**
   * Capture timeout in ms. Defaults to `GOGCHAT_AUTO_QUIT_AFTER_MS` when set,
   * otherwise 12s. On timeout the export is invalid, not complete.
   */
  timeoutMs?: number;
  /** Override metrics output path (defaults to userData/performance-metrics.json). */
  outputPath?: string;
}

interface FinalizerState {
  armed: boolean;
  deferredReady: boolean;
  contentReady: boolean;
  contentFailed: boolean;
  failReason?: string;
  exported: boolean;
  /** One re-sample attempt when markers are ready but no Tab process yet. */
  rendererResampleScheduled: boolean;
  getAccountManager?: () => IAccountWindowManager | undefined;
  outputPath?: string;
  timeoutHandle: NodeJS.Timeout | null;
}

const state: FinalizerState = {
  armed: false,
  deferredReady: false,
  contentReady: false,
  contentFailed: false,
  exported: false,
  rendererResampleScheduled: false,
  timeoutHandle: null,
};

function defaultTimeoutMs(): number {
  const fromEnv = Number(process.env['GOGCHAT_AUTO_QUIT_AFTER_MS']);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 12_000;
}

function resolveOutputPath(override?: string): string {
  if (override) return override;
  return path.join(app.getPath('userData'), 'performance-metrics.json');
}

function shouldExport(): boolean {
  // Export when metrics are requested (CI/dev harness) or in development.
  // Packaged production does not write startup metrics by default.
  if (process.env['GOGCHAT_EXPORT_METRICS'] === '1') return true;
  if (process.env['NODE_ENV'] === 'development') return true;
  return false;
}

function tryFinalize(reasonIfForced?: string): void {
  if (state.exported) return;
  if (!state.armed) return;

  const forcedFail = state.contentFailed || reasonIfForced !== undefined;
  const ready = state.deferredReady && state.contentReady;

  if (!ready && !forcedFail) {
    return;
  }

  if (!shouldExport()) {
    state.exported = true;
    if (state.timeoutHandle) {
      cancelTrackedTimeout(state.timeoutHandle);
      state.timeoutHandle = null;
    }
    log.debug('[Performance] Finalizer skipped export (not in export mode)');
    return;
  }

  const monitor = getPerformanceMonitor();
  const accountManager = state.getAccountManager?.();
  // Immediate renderer sample before export so empty renderer evidence cannot
  // be presented as a measured-zero run. Use getPerformanceMonitor() so tests
  // that destroy/recreate the singleton still hit the live instance.
  const sampleOnce = (): number => {
    try {
      monitor.sampleAllRenderers(accountManager);
    } catch (error: unknown) {
      log.warn('[Performance] Final renderer sample failed:', error);
    }
    return monitor.getRendererSnapshots().filter((s) => s.type === 'renderer').length;
  };

  let rendererCount = sampleOnce();
  // CI / just-created windows can report zero Tab metrics for a beat; schedule
  // exactly one re-sample before writing an otherwise-ready capture.
  if (ready && !forcedFail && rendererCount < 1 && !state.rendererResampleScheduled) {
    state.rendererResampleScheduled = true;
    createTrackedTimeout(
      () => {
        if (state.exported) return;
        tryFinalize(reasonIfForced);
      },
      750,
      'perf-export-renderer-resample'
    );
    return;
  }

  state.exported = true;
  if (state.timeoutHandle) {
    cancelTrackedTimeout(state.timeoutHandle);
    state.timeoutHandle = null;
  }

  if (rendererCount < 1) {
    rendererCount = sampleOnce();
  }

  const outputPath = resolveOutputPath(state.outputPath);
  const failReason =
    reasonIfForced ??
    state.failReason ??
    (forcedFail ? 'document load failed or timed out' : undefined);

  const complete = ready && !forcedFail;
  monitor.exportToJSON(outputPath, {
    complete,
    forceInvalid: !complete,
    ...(failReason !== undefined ? { reason: failReason } : {}),
  });

  log.info(
    `[Performance] Final export written (complete=${complete}, path=${outputPath}` +
      `, renderers=${rendererCount}` +
      `${failReason ? `, reason=${failReason}` : ''})`
  );
}

/**
 * Arm the one-shot finalizer. Safe to call once per process lifetime.
 * Arms a capture timeout that exports an invalid run if producers never finish.
 */
export function armPerformanceFinalizer(options: ArmPerformanceFinalizerOptions = {}): void {
  if (state.armed) {
    // Allow updating account manager / output path if re-armed after tests reset.
    if (options.getAccountManager) state.getAccountManager = options.getAccountManager;
    if (options.outputPath) state.outputPath = options.outputPath;
    return;
  }

  state.armed = true;
  state.deferredReady = false;
  state.contentReady = false;
  state.contentFailed = false;
  delete state.failReason;
  state.exported = false;
  state.rendererResampleScheduled = false;
  if (options.getAccountManager) state.getAccountManager = options.getAccountManager;
  if (options.outputPath) state.outputPath = options.outputPath;

  // Floor capture timeout when metrics export is requested so CI headless
  // runs are not invalidated by slow first-document loads under 12s.
  let timeoutMs = options.timeoutMs ?? defaultTimeoutMs();
  if (
    options.timeoutMs === undefined &&
    process.env['GOGCHAT_EXPORT_METRICS'] === '1' &&
    timeoutMs < 45_000
  ) {
    timeoutMs = 45_000;
  }
  state.timeoutHandle = createTrackedTimeout(
    () => {
      state.timeoutHandle = null;
      if (!state.exported) {
        tryFinalize('capture timeout waiting for document load / deferred phase');
      }
    },
    timeoutMs,
    'perf-export-capture-timeout'
  );

  log.debug(`[Performance] Finalizer armed (timeout=${timeoutMs}ms)`);
}

/** Signal that deferred phase (including `all-features-loaded`) has finished. */
export function notifyDeferredPhaseComplete(): void {
  state.deferredReady = true;
  tryFinalize();
}

/** Signal that account-0 document load completed (`account-0-content-loaded`). */
export function notifyDocumentLoadComplete(): void {
  state.contentReady = true;
  tryFinalize();
}

/** Signal document load failure; exports an invalid capture when deferred is ready or on timeout. */
export function notifyDocumentLoadFailed(reason: string): void {
  state.contentFailed = true;
  state.failReason = reason;
  // Export immediately as invalid so harnesses do not wait for timeout only.
  tryFinalize(reason);
}

/**
 * Reset finalizer state (tests only).
 * @internal
 */
export function resetPerformanceFinalizerForTests(): void {
  if (state.timeoutHandle) {
    cancelTrackedTimeout(state.timeoutHandle);
  }
  state.armed = false;
  state.deferredReady = false;
  state.contentReady = false;
  state.contentFailed = false;
  delete state.failReason;
  state.exported = false;
  state.rendererResampleScheduled = false;
  delete state.getAccountManager;
  delete state.outputPath;
  state.timeoutHandle = null;
}

/**
 * Whether a final export has already been written (tests / diagnostics).
 * @internal
 */
export function hasFinalizedPerformanceExport(): boolean {
  return state.exported;
}
