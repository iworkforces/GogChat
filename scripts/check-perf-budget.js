#!/usr/bin/env node

/**
 * CI Performance Regression Gate (PI1)
 *
 * Reads a versioned `performance-metrics.json` produced by the startup
 * finalizer (document-load + deferred + renderer sample) and compares metrics
 * against fixed budgets. Exits 1 if any **gated** metric fails or is missing.
 * Prints GitHub Actions annotations (`::error` / `::warning`) so failures
 * surface inline on PRs.
 *
 * Memory values are always megabytes (MB) end-to-end — never bytes.
 *
 * Usage:
 *   node scripts/check-perf-budget.js [path/to/performance-metrics.json]
 *
 * Defaults to `./performance-metrics.json` when no argument is given.
 *
 * Exit codes:
 *   0 — all gated budgets met (warn-only metrics may warn)
 *   1 — gated budget exceeded, gated metric missing, or schema/unit incompatible
 *
 * Side effects:
 *   - Writes `.perf-history.json` (last 20 runs) for trend tracking.
 *   - Updates `.perf-baseline.json` ONLY when the env var
 *     `PERF_UPDATE_BASELINE=1` is set (never automatically in CI).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/** Must match PERF_EXPORT_SCHEMA_VERSION in performanceTypes.ts */
export const PERF_EXPORT_SCHEMA_VERSION = 1;

const REQUIRED_STARTUP_MARKERS = [
  'app-start',
  'app-ready',
  'account-0-ready',
  'account-0-content-loaded',
  'features-loaded',
  'all-features-loaded',
];

const GATED_MARKER_PAIRS = [
  ['app-start', 'all-features-loaded'],
  ['app-ready', 'account-0-ready'],
  ['app-ready', 'features-loaded'],
  ['app-ready', 'account-0-content-loaded'],
];

function isNonnegativeFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

// ---------------------------------------------------------------------------
// Budget definitions
// ---------------------------------------------------------------------------

/** @typedef {{ name: string, budget: number, unit: string, gated: boolean, extract: (m: object) => number | null, describe: string }} BudgetSpec */

// Memory budgets are in MB (matching producer export). Bundle sizes remain bytes
// internally and are formatted as KB for display.
const KB = 1024;

/** @type {BudgetSpec[]} */
export const BUDGETS = [
  {
    name: 'totalStartup',
    budget: 2000,
    unit: 'ms',
    gated: true,
    describe: 'app-start → all-features-loaded',
    extract: (m) => diffMarkers(m, 'app-start', 'all-features-loaded'),
  },
  {
    // Native window readiness (BrowserWindow constructed + account-0 registered).
    // Not first paint and not first interaction.
    name: 'nativeWindowReady',
    budget: 1500,
    unit: 'ms',
    gated: true,
    describe: 'app-ready → account-0-ready (native window readiness)',
    extract: (m) => diffMarkers(m, 'app-ready', 'account-0-ready'),
  },
  {
    name: 'criticalPhase',
    budget: 1000,
    unit: 'ms',
    gated: true,
    describe: 'app-ready → features-loaded',
    extract: (m) => diffMarkers(m, 'app-ready', 'features-loaded'),
  },
  {
    name: 'heapBaseline',
    budget: 150, // MB
    unit: 'MB',
    gated: true,
    describe: 'last memorySnapshot.heapUsed (MB)',
    extract: (m) => lastMemoryField(m, 'heapUsed'),
  },
  {
    name: 'rssBaseline',
    budget: 350, // MB
    unit: 'MB',
    gated: false, // WARN only
    describe: 'last memorySnapshot.rss (MB)',
    extract: (m) => lastMemoryField(m, 'rss'),
  },
  {
    name: 'rendererCount',
    // Chromium site isolation routinely creates multiple Tab processes for a
    // single account document (e.g. main frame + subframe/utility hosts). The
    // gate still fails on runaway process growth; 1 was only realistic before
    // document-load sampling.
    budget: 4,
    unit: 'count',
    gated: true,
    describe: 'unique renderer identities after document-load sample ((pid, creationTime) or PID)',
    extract: (m) => uniqueRendererCount(m),
  },
  {
    name: 'mainBundleSize',
    budget: 100 * KB,
    unit: 'KB',
    gated: true,
    describe: 'lib/main/index.js',
    extract: () => fileSize(path.join(repoRoot, 'lib', 'main', 'index.js')),
  },
  {
    name: 'preloadBundleSize',
    budget: 50 * KB,
    unit: 'KB',
    gated: true,
    describe: 'sum(lib/preload/*.js)',
    extract: () => preloadBundleSize(),
  },
  {
    name: 'buildTimeMs',
    budget: 500,
    unit: 'ms',
    gated: false, // WARN only
    describe: 'last entry of .build-history.json',
    extract: () => lastBuildTimeMs(),
  },
  // Document-load completion (did-finish-load). Not authenticated first interaction.
  {
    name: 'contentDocumentLoaded',
    // Unauthenticated CI loads Google auth (or offline) over the network.
    // Cold macos-latest runners have measured ~3–9s; keep gated so runaway
    // hangs still fail, but allow network jitter without failing native gates.
    budget: 15_000,
    unit: 'ms',
    gated: true,
    describe: 'app-ready → account-0-content-loaded (document load, not first interaction)',
    extract: (m) => diffMarkers(m, 'app-ready', 'account-0-content-loaded'),
  },
  {
    name: 'storeInit',
    budget: 250,
    unit: 'ms',
    gated: false, // WARN only — first appearance, no historical baseline
    describe: 'store-init-start → store-init-end',
    extract: (m) => diffMarkers(m, 'store-init-start', 'store-init-end'),
  },
  {
    name: 'deferredBatchAggregate',
    budget: 1500,
    unit: 'ms',
    gated: false, // WARN only — batch composition shifts as features change
    describe: 'deferred-features-start → all-features-loaded',
    extract: (m) => diffMarkers(m, 'deferred-features-start', 'all-features-loaded'),
  },
  {
    name: 'memoryGrowth',
    budget: 50, // MB
    unit: 'MB',
    gated: false, // WARN only
    describe: 'last − first memorySnapshot.heapUsed (MB)',
    extract: (m) => memoryGrowth(m, 'heapUsed'),
  },
  {
    name: 'ipcLatencyP50',
    budget: 5,
    unit: 'ms',
    gated: false, // WARN only — no established baseline; never gate without producer
    describe: 'placeholder for future ipc-latency.p50 export',
    extract: (m) => ipcLatencyP50(m),
  },
];

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

function diffMarkers(metrics, from, to) {
  const markers = metrics?.markers;
  if (!markers || typeof markers !== 'object') return null;
  const a = markers[from];
  const b = markers[to];
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  return b - a;
}

function lastMemoryField(metrics, field) {
  const snaps = metrics?.memorySnapshots;
  if (!Array.isArray(snaps) || snaps.length === 0) return null;
  const last = snaps[snaps.length - 1];
  const v = last?.[field];
  return typeof v === 'number' ? v : null;
}

function memoryGrowth(metrics, field) {
  const snaps = metrics?.memorySnapshots;
  if (!Array.isArray(snaps) || snaps.length < 2) return null;
  const first = snaps[0]?.[field];
  const last = snaps[snaps.length - 1]?.[field];
  if (typeof first !== 'number' || typeof last !== 'number') return null;
  return Math.max(0, last - first);
}

/**
 * Placeholder extractor for IPC p50 latency.
 *
 * Reads `metrics.ipcLatency.p50` if the runtime ever exports it; otherwise
 * returns null so the budget reports SKIP rather than failing CI. This keeps
 * the budget visible and additive without coupling the gate to telemetry that
 * does not yet exist.
 */
function ipcLatencyP50(metrics) {
  const ipc = metrics?.ipcLatency;
  if (ipc && typeof ipc === 'object') {
    const v = ipc.p50;
    if (typeof v === 'number') return v;
  }

  const samples = metrics?.ipcLatencySamples;
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const values = samples
    .map((sample) => sample?.durationMs)
    .filter((value) => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];
}

function uniqueRendererCount(metrics) {
  const snaps = metrics?.rendererSnapshots;
  if (!Array.isArray(snaps)) return 0;
  const ids = new Set();
  for (const snap of snaps) {
    if (snap?.type !== 'renderer' || typeof snap?.pid !== 'number') continue;
    ids.add(
      typeof snap.creationTime === 'number' ? `${snap.pid}:${snap.creationTime}` : `pid:${snap.pid}`
    );
  }
  return ids.size;
}

function fileSize(absPath) {
  try {
    return fs.statSync(absPath).size;
  } catch {
    return null;
  }
}

function preloadBundleSize() {
  const dir = path.join(repoRoot, 'lib', 'preload');
  let total = 0;
  let found = false;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.js')) {
        total += fs.statSync(path.join(dir, entry.name)).size;
        found = true;
      }
    }
  } catch {
    return null;
  }
  return found ? total : null;
}

function lastBuildTimeMs() {
  const file = path.join(repoRoot, '.build-history.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw?.builds;
    if (!Array.isArray(list) || list.length === 0) return null;
    const last = list[list.length - 1];
    const v = last?.buildTimeMs ?? last?.durationMs ?? last?.elapsed;
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatValue(value, unit) {
  if (value == null) return 'N/A';
  switch (unit) {
    case 'ms':
      return `${Math.round(value)}ms`;
    case 'MB':
      // Values are already megabytes from the producer contract.
      return `${Number(value).toFixed(2)}MB`;
    case 'KB':
      return `${(value / KB).toFixed(2)}KB`;
    case 'count':
      return String(value);
    default:
      return String(value);
  }
}

/**
 * Validate capture evidence and gated operands before comparing budgets.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateMetricsContract(metrics) {
  const errors = [];
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
    return { ok: false, errors: ['metrics is not an object'] };
  }
  if (metrics.schemaVersion !== PERF_EXPORT_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion mismatch: expected ${PERF_EXPORT_SCHEMA_VERSION}, got ${metrics.schemaVersion}`
    );
  }
  if (metrics.units?.memory !== 'MB') {
    errors.push(`units.memory must be "MB" (got ${metrics.units?.memory})`);
  }
  if (metrics.units?.time !== 'ms') {
    errors.push(`units.time must be "ms" (got ${metrics.units?.time})`);
  }
  const capture = metrics.capture;
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) {
    errors.push('capture completeness metadata must be an object');
  } else {
    if (capture.complete !== true) errors.push('capture.complete must be true');
    if (capture.valid !== true) {
      errors.push(`capture.valid must be true${capture.reason ? `: ${capture.reason}` : ''}`);
    }
    if (
      !Array.isArray(capture.requiredMarkers) ||
      capture.requiredMarkers.length !== REQUIRED_STARTUP_MARKERS.length ||
      new Set(capture.requiredMarkers).size !== REQUIRED_STARTUP_MARKERS.length ||
      !REQUIRED_STARTUP_MARKERS.every((name) => capture.requiredMarkers.includes(name))
    ) {
      errors.push(
        'capture.requiredMarkers must contain each canonical startup marker exactly once'
      );
    }
    if (!Array.isArray(capture.missingMarkers) || capture.missingMarkers.length !== 0) {
      errors.push('capture.missingMarkers must be an empty array for a valid capture');
    }
    if (!isPositiveInteger(capture.rendererSampleCount)) {
      errors.push('capture.rendererSampleCount must be a positive integer');
    }
  }

  const aggregation = metrics.aggregation;
  if (Object.hasOwn(metrics, 'aggregation')) {
    if (!aggregation || typeof aggregation !== 'object' || Array.isArray(aggregation)) {
      errors.push('aggregation must be an object when present');
    } else {
      if (aggregation.strategy !== 'single' && aggregation.strategy !== 'median') {
        errors.push('aggregation.strategy must be single or median');
      }
      if (aggregation.complete !== true) errors.push('aggregation.complete must be true');
      for (const field of ['runs', 'successfulRuns']) {
        if (!isPositiveInteger(aggregation[field])) {
          errors.push(`aggregation.${field} must be a positive integer`);
        }
      }
      if (aggregation.runs !== aggregation.successfulRuns) {
        errors.push('aggregation.runs must equal aggregation.successfulRuns');
      }
      if (aggregation.invalidRuns !== 0) errors.push('aggregation.invalidRuns must be 0');
      if (aggregation.strategy === 'single' && aggregation.runs !== 1) {
        errors.push('aggregation.single must describe exactly one run');
      }
      if (aggregation.strategy === 'median' && aggregation.runs < 2) {
        errors.push('aggregation.median must describe at least two runs');
      }
    }
  }

  for (const name of REQUIRED_STARTUP_MARKERS) {
    if (!isNonnegativeFinite(metrics.markers?.[name])) {
      errors.push(`markers.${name} must be a finite nonnegative number`);
    }
  }
  for (const [from, to] of GATED_MARKER_PAIRS) {
    const start = metrics.markers?.[from];
    const end = metrics.markers?.[to];
    if (isNonnegativeFinite(start) && isNonnegativeFinite(end) && end < start) {
      errors.push(`markers.${to} must be >= markers.${from}`);
    }
  }
  if (!isNonnegativeFinite(lastMemoryField(metrics, 'heapUsed'))) {
    errors.push('memorySnapshots[last].heapUsed must be a finite nonnegative number (MB)');
  }

  const snaps = metrics.rendererSnapshots;
  const rendererRows = Array.isArray(snaps) ? snaps.filter((s) => s?.type === 'renderer') : [];
  if (rendererRows.length === 0) {
    errors.push('empty renderer evidence (no renderer-type samples)');
  }
  if (aggregation?.strategy !== 'median' && capture?.rendererSampleCount !== rendererRows.length) {
    errors.push('capture.rendererSampleCount must equal the number of renderer-type rows');
  }
  for (const [index, row] of rendererRows.entries()) {
    const fieldPath = `rendererSnapshots[renderer ${index}]`;
    if (!isPositiveInteger(row.pid)) errors.push(`${fieldPath}.pid must be a positive integer`);
    for (const field of ['timestamp', 'cpuPercent']) {
      if (!isNonnegativeFinite(row[field])) {
        errors.push(`${fieldPath}.${field} must be a finite nonnegative number`);
      }
    }
    if (Object.hasOwn(row, 'creationTime') && !isNonnegativeFinite(row.creationTime)) {
      errors.push(`${fieldPath}.creationTime must be a finite nonnegative number when present`);
    }
    for (const field of ['residentSet', 'peakResidentSet']) {
      if (!isNonnegativeFinite(row.memory?.[field])) {
        errors.push(`${fieldPath}.memory.${field} must be a finite nonnegative number (MB)`);
      }
    }
    if (row.memory?.private !== null && !isNonnegativeFinite(row.memory?.private)) {
      errors.push(`${fieldPath}.memory.private must be null or a finite nonnegative number (MB)`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Evaluate budgets against metrics. Pure helper for tests.
 * @returns {{ results: object[], failed: number, warned: number, skipped: number, contractErrors: string[] }}
 */
export function evaluateBudgets(metrics, options = {}) {
  const contract = validateMetricsContract(metrics);
  const measurements = BUDGETS.map((spec) => {
    let actual = null;
    try {
      if (contract.ok) actual = spec.extract(metrics);
    } catch (err) {
      if (!options.silent) {
        process.stderr.write(`[perf-budget] extractor "${spec.name}" threw: ${err.message}\n`);
      }
    }

    if (spec.gated && actual != null && !isNonnegativeFinite(actual)) {
      contract.errors.push(`${spec.name} must be a finite nonnegative measurement (${spec.unit})`);
    }

    return { ...spec, actual };
  });
  contract.ok = contract.errors.length === 0;

  const results = measurements.map((measurement) => {
    const { actual, gated, budget } = measurement;
    let status;
    if (gated && !contract.ok) {
      status = 'FAIL';
    } else if (actual == null) {
      // Missing gated metrics FAIL; warn-only stay non-blocking WARN/SKIP.
      status = gated ? 'FAIL' : 'SKIP';
    } else if (actual <= budget) {
      status = 'PASS';
    } else {
      status = gated ? 'FAIL' : 'WARN';
    }

    return { ...measurement, status };
  });

  const failed = results.filter((r) => r.status === 'FAIL').length;
  const warned = results.filter((r) => r.status === 'WARN').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  return { results, failed, warned, skipped, contractErrors: contract.errors };
}

function pct(actual, budget) {
  if (actual == null || !budget) return 'N/A';
  return `${((actual / budget) * 100).toFixed(1)}%`;
}

function annotate(level, message) {
  // GitHub Actions workflow command: ::error:: / ::warning::
  process.stdout.write(`::${level}::${message}\n`);
}

// ---------------------------------------------------------------------------
// History / baseline
// ---------------------------------------------------------------------------

function loadJSONSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeHistory(results) {
  const file = path.join(repoRoot, '.perf-history.json');
  const prev = loadJSONSafe(file);
  const list = Array.isArray(prev) ? prev : [];
  const entry = {
    timestamp: new Date().toISOString(),
    sha: process.env.GITHUB_SHA || null,
    ref: process.env.GITHUB_REF || null,
    metrics: Object.fromEntries(results.map((r) => [r.name, r.actual])),
  };
  list.push(entry);
  while (list.length > 20) list.shift();
  try {
    fs.writeFileSync(file, JSON.stringify(list, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`[perf-budget] Failed to write history: ${err.message}\n`);
  }
}

function maybeUpdateBaseline(results, metrics) {
  if (process.env.PERF_UPDATE_BASELINE !== '1') return;
  const file = path.join(repoRoot, '.perf-baseline.json');
  const baseline = {
    schemaVersion: PERF_EXPORT_SCHEMA_VERSION,
    units: { memory: 'MB', time: 'ms' },
    timestamp: new Date().toISOString(),
    sha: process.env.GITHUB_SHA || null,
    metrics: Object.fromEntries(results.map((r) => [r.name, r.actual])),
  };
  try {
    fs.writeFileSync(file, JSON.stringify(baseline, null, 2) + '\n');
    process.stdout.write(`[perf-budget] Baseline updated: ${file}\n`);
  } catch (err) {
    process.stderr.write(`[perf-budget] Failed to write baseline: ${err.message}\n`);
  }
  void metrics;
}

/**
 * Load baseline only when schema/units are compatible. Incompatible baselines
 * (e.g. old byte-based memory) are rejected — regenerate with PERF_UPDATE_BASELINE=1.
 */
function loadBaseline() {
  const baseline = loadJSONSafe(path.join(repoRoot, '.perf-baseline.json'));
  if (!baseline) return null;
  if (baseline.schemaVersion !== PERF_EXPORT_SCHEMA_VERSION) {
    process.stderr.write(
      `[perf-budget] Ignoring incompatible baseline schemaVersion=${baseline.schemaVersion} ` +
        `(expected ${PERF_EXPORT_SCHEMA_VERSION}); re-generate with PERF_UPDATE_BASELINE=1\n`
    );
    return null;
  }
  if (baseline.units?.memory !== 'MB') {
    process.stderr.write(
      `[perf-budget] Ignoring baseline with non-MB memory units; re-generate with PERF_UPDATE_BASELINE=1\n`
    );
    return null;
  }
  return baseline;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function main(argv = process.argv.slice(2)) {
  const arg = argv[0] || './performance-metrics.json';
  const metricsPath = path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);

  let metrics;
  try {
    metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  } catch (err) {
    annotate('error', `Cannot read metrics file ${metricsPath}: ${err.message}`);
    process.exitCode = 1;
    return 1;
  }

  const { results, failed, warned, skipped, contractErrors } = evaluateBudgets(metrics);
  if (contractErrors.length > 0) {
    for (const error of contractErrors) annotate('error', `Perf contract — ${error}`);
    process.exitCode = 1;
    return 1;
  }

  const baseline = loadBaseline();
  const baselineMetrics = baseline?.metrics || {};
  for (const r of results) {
    r.baseline = baselineMetrics[r.name] ?? null;
  }

  // ---------- Report ----------
  const COL = { name: 26, status: 6, actual: 14, budget: 14, util: 8, delta: 14 };
  const pad = (s, n) => String(s).padEnd(n);

  process.stdout.write('\n');
  process.stdout.write('Performance Budget Report\n');
  process.stdout.write('=========================\n');
  process.stdout.write(
    `${pad('METRIC', COL.name)}${pad('STATE', COL.status)}${pad('ACTUAL', COL.actual)}` +
      `${pad('BUDGET', COL.budget)}${pad('USED', COL.util)}${pad('Δ vs BASE', COL.delta)}\n`
  );
  process.stdout.write(
    `${'-'.repeat(COL.name + COL.status + COL.actual + COL.budget + COL.util + COL.delta)}\n`
  );

  for (const r of results) {
    const actualStr = formatValue(r.actual, r.unit);
    const budgetStr = formatValue(r.budget, r.unit);
    const utilStr = pct(r.actual, r.budget);
    let deltaStr = 'n/a';
    if (r.actual != null && typeof r.baseline === 'number') {
      const diff = r.actual - r.baseline;
      deltaStr = `${diff >= 0 ? '+' : '-'}${formatValue(Math.abs(diff), r.unit)}`;
    }
    const tag = r.gated ? '' : ' (warn)';
    process.stdout.write(
      `${pad(r.name + tag, COL.name)}${pad(r.status, COL.status)}${pad(actualStr, COL.actual)}` +
        `${pad(budgetStr, COL.budget)}${pad(utilStr, COL.util)}${pad(deltaStr, COL.delta)}\n`
    );
  }
  process.stdout.write('\n');

  // ---------- Annotations ----------
  for (const r of results) {
    const msg =
      `${r.name} (${r.describe}): actual=${formatValue(r.actual, r.unit)} ` +
      `budget=${formatValue(r.budget, r.unit)} (${pct(r.actual, r.budget)})`;
    if (r.status === 'FAIL') {
      annotate(
        'error',
        r.actual == null ? `Perf gated metric missing — ${msg}` : `Perf budget exceeded — ${msg}`
      );
    } else if (r.status === 'WARN') {
      annotate('warning', `Perf budget exceeded (warn-only) — ${msg}`);
    } else if (r.status === 'SKIP') {
      annotate('warning', `Perf metric unavailable (warn-only) — ${msg}`);
    }
  }

  writeHistory(results);
  maybeUpdateBaseline(results, metrics);

  const exitFailed = failed > 0 ? 1 : 0;
  process.stdout.write(
    `Summary: ${results.filter((r) => r.status === 'PASS').length} pass, ` +
      `${failed} fail, ${warned} warn, ${skipped} skip\n`
  );

  process.exitCode = exitFailed;
  return exitFailed;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const code = main();
  process.exit(code);
}
