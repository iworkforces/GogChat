/**
 * Performance Monitor Shared Types
 *
 * Standalone type and constant definitions shared between
 * {@link performanceMonitor} and {@link performanceExport}. Extracted into
 * its own module to break the type-only circular dependency that existed
 * between `performanceMonitor.ts` ↔ `performanceExport.ts`.
 *
 * Both modules import from this file. `performanceMonitor.ts` re-exports
 * these symbols for backward compatibility.
 *
 * @module performanceTypes
 */

/**
 * Performance target thresholds
 */
export const PERFORMANCE_TARGETS = {
  STARTUP_TIME_MS: 3000, // <3s target
  WARNING_THRESHOLD_MS: 2500,
  CRITICAL_THRESHOLD_MS: 3500,
} as const;

/**
 * Versioned export schema for unauthenticated CI startup artifacts.
 * Bump when required fields, units, or completeness semantics change.
 */
export const PERF_EXPORT_SCHEMA_VERSION = 1 as const;

/**
 * Canonical metric units for every producer, export, budget, and display path.
 * Memory is always megabytes (not bytes); time is always milliseconds.
 */
export const PERF_METRIC_UNITS = {
  memory: 'MB',
  time: 'ms',
} as const;

/**
 * Markers required for a complete unauthenticated CI startup capture.
 * Document load (`account-0-content-loaded`) is not first paint or first interaction.
 */
export const REQUIRED_STARTUP_MARKERS = [
  'app-start',
  'app-ready',
  'account-0-ready',
  'account-0-content-loaded',
  'features-loaded',
  'all-features-loaded',
] as const;

export type RequiredStartupMarker = (typeof REQUIRED_STARTUP_MARKERS)[number];

/**
 * Memory snapshot interface. All memory fields are in megabytes (MB).
 */
export interface MemorySnapshot {
  timestamp: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
}

/**
 * Per-renderer / GPU / utility process memory snapshot.
 * Captured periodically via `app.getAppMetrics()` to enable
 * measuring memory improvements introduced in later optimization phases.
 */
export interface RendererMemorySnapshot {
  /** Milliseconds since perf monitor start */
  timestamp: number;
  /** Renderer / GPU / utility process ID */
  pid: number;
  /** Which account (0, 1, 2…) if known. Undefined for non-renderer processes. */
  accountIndex?: number;
  /** Process kind reported by Electron */
  type: 'renderer' | 'gpu' | 'utility';
  /**
   * Memory metrics in MB (rounded to 2 decimals).
   * When private memory is unavailable (non-Windows), `private` is null and
   * `privateSource` is `'unavailable'` — never a misleading measured zero.
   */
  memory: {
    /** Working set size — currently pinned to physical RAM (mapped from `workingSetSize`) */
    residentSet: number;
    /** Peak working set size ever pinned (mapped from `peakWorkingSetSize`) */
    peakResidentSet: number;
    /**
     * Private (non-shared) memory in MB when available (Windows).
     * `null` when the platform does not report privateBytes.
     */
    private: number | null;
    /** Whether private was measured or is unavailable on this platform. */
    privateSource: 'measured' | 'unavailable';
  };
  /** CPU usage percentage as reported by Electron's ProcessMetric */
  cpuPercent: number;
  /** Electron ProcessMetric.creationTime (ms since epoch) for PID reuse disambiguation */
  creationTime?: number;
  /** Owning account backend when correlated via enumerateAccountWebContents */
  backend?: 'browser-window' | 'web-contents-view';
  /** webContents.id when correlated via account enumeration */
  webContentsId?: number;
}

/**
 * IPC handler execution time, excluding validation, rate limiting, dedup joins,
 * reply transport and renderer round trips. Backward-compatible optional export field.
 */
export interface IPCLatencySample {
  /** Milliseconds since perf monitor start when the sample was recorded. */
  timestamp: number;
  /** IPC channel name (must be a registered `IPCChannelName` at call sites). */
  channel: string;
  /** Monotonic milliseconds from handler entry until return or promise settlement. */
  durationMs: number;
  /** Account index resolved from the account registry, never the sender id. */
  accountIndex?: number;
  /** Discriminator for handler kind (`on` / `reply` / `invoke` / `fast`). */
  kind?: 'on' | 'reply' | 'invoke' | 'fast';
}

/**
 * Single memory-pressure latency sample. Used to track the wall-clock cost
 * of memory-related operations (e.g. `clearCodeCaches`, hydrate/dehydrate)
 * so later waves can budget them. Backward-compatible: consumers may ignore
 * the field.
 */
export interface MemoryLatencySample {
  /** Milliseconds since perf monitor start when the sample was recorded. */
  timestamp: number;
  /** Operation label (e.g. `'clearCodeCaches'`, `'dehydrateAccount'`). */
  operation: string;
  /** Measured duration in milliseconds. */
  durationMs: number;
  /** Optional account index for per-account memory ops. */
  accountIndex?: number;
}

/**
 * Metric unit metadata embedded in every export so consumers never guess
 * whether memory is MB or bytes.
 */
export interface PerformanceMetricUnits {
  memory: typeof PERF_METRIC_UNITS.memory;
  time: typeof PERF_METRIC_UNITS.time;
}

/**
 * Per-run capture completeness. A complete + valid run has every required
 * marker, at least one renderer sample taken after document load, and no
 * load failure/timeout. Incomplete or invalid runs must not feed medians.
 */
export interface CaptureCompleteness {
  /** True when the final export path ran after required producers finished. */
  complete: boolean;
  /** True when required markers and renderer evidence are present. */
  valid: boolean;
  /** Required marker names checked for this schema version. */
  requiredMarkers: readonly string[];
  /** Required markers absent from this run. */
  missingMarkers: string[];
  /** Count of renderer-type snapshots at export time. */
  rendererSampleCount: number;
  /** Human-readable reason when incomplete or invalid. */
  reason?: string;
}

/**
 * Aggregate completeness when multiple runs are merged (median harness).
 */
export interface AggregateCompleteness {
  strategy: 'median' | 'single';
  runs: number;
  successfulRuns: number;
  invalidRuns: number;
  /** True only when every requested run was complete and valid. */
  complete: boolean;
}

/**
 * Performance metrics export interface (schema-versioned).
 * Memory values are always in MB; times always in ms.
 */
export interface PerformanceMetrics {
  /** Export schema version; consumers must reject incompatible versions. */
  schemaVersion: number;
  /** Explicit units for memory and time fields. */
  units: PerformanceMetricUnits;
  /** Per-run capture completeness metadata. */
  capture: CaptureCompleteness;
  startupTime: number;
  markers: Record<string, number>;
  memorySnapshots: MemorySnapshot[];
  rendererSnapshots: RendererMemorySnapshot[];
  /**
   * Optional IPC latency samples recorded during the run. Optional so older
   * exports / external readers without this field remain valid.
   */
  ipcLatencySamples?: IPCLatencySample[];
  /**
   * Optional memory-operation latency samples recorded during the run.
   * Optional so older exports / external readers without this field remain valid.
   */
  memoryLatencySamples?: MemoryLatencySample[];
  targetMet: boolean;
  warnings: string[];
  timestamp: string;
  appVersion: string;
  /** Present on multi-run harness aggregates only. */
  aggregation?: AggregateCompleteness;
}

/**
 * Read-only view of {@link PerformanceMonitor} consumed by the export/log
 * helpers in `performanceExport.ts`. Defining it here (instead of importing
 * the concrete `PerformanceMonitor` class type) breaks the type-only
 * circular dependency between `performanceMonitor.ts` and
 * `performanceExport.ts`. The concrete class structurally satisfies this
 * interface.
 */
export interface PerformanceMonitorReader {
  getTotalElapsed(): number;
  getMetrics(): Record<string, number>;
  getMemorySnapshotList(): MemorySnapshot[];
  isTargetMet(): boolean;
  getWarningsList(): string[];
  isEnabled(): boolean;
  getMemoryStats(): {
    initial: MemorySnapshot;
    current: MemorySnapshot;
    peak: MemorySnapshot;
  } | null;
  getRendererSnapshots(): RendererMemorySnapshot[];
  /**
   * Internal accessor for the IPC latency samples list. Default implementations
   * may return an empty array if no samples were recorded.
   * @internal
   */
  getIpcLatencySamples(): IPCLatencySample[];
  /**
   * Internal accessor for the memory latency samples list. Default implementations
   * may return an empty array if no samples were recorded.
   * @internal
   */
  getMemoryLatencySamples(): MemoryLatencySample[];
}
