import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  evaluateBudgets,
  validateMetricsContract,
  PERF_EXPORT_SCHEMA_VERSION,
  BUDGETS,
} from './check-perf-budget.js';
import { mergeMedian } from './headless-startup.js';

const REQUIRED_MARKERS = [
  'app-start',
  'app-ready',
  'account-0-ready',
  'account-0-content-loaded',
  'features-loaded',
  'all-features-loaded',
];

function makeValidMetrics(overrides = {}) {
  const markers = {
    'app-start': 0,
    'app-ready': 100,
    'account-0-ready': 200,
    'account-0-content-loaded': 500,
    'features-loaded': 400,
    'all-features-loaded': 800,
    'store-init-start': 110,
    'store-init-end': 150,
    'deferred-features-start': 500,
  };
  return {
    schemaVersion: PERF_EXPORT_SCHEMA_VERSION,
    units: { memory: 'MB', time: 'ms' },
    capture: {
      complete: true,
      valid: true,
      requiredMarkers: REQUIRED_MARKERS,
      missingMarkers: [],
      rendererSampleCount: (overrides.rendererSnapshots ?? [{ type: 'renderer' }]).filter(
        (row) => row?.type === 'renderer'
      ).length,
    },
    startupTime: 800,
    markers,
    memorySnapshots: [
      { timestamp: 0, heapUsed: 40, heapTotal: 60, external: 1, rss: 120 },
      { timestamp: 800, heapUsed: 55, heapTotal: 80, external: 2, rss: 150 },
    ],
    rendererSnapshots: [
      {
        timestamp: 500,
        pid: 1,
        type: 'renderer',
        memory: { residentSet: 10, peakResidentSet: 12, private: 0 },
        cpuPercent: 1,
      },
    ],
    targetMet: true,
    warnings: [],
    timestamp: new Date().toISOString(),
    appVersion: '1.0.0',
    ...overrides,
  };
}

describe('validateMetricsContract', () => {
  it.each([
    ['absent capture', (m) => delete m.capture, 'capture'],
    ['null capture', (m) => (m.capture = null), 'capture'],
    ['incomplete capture', (m) => (m.capture.complete = false), 'capture.complete'],
    ['missing validity', (m) => delete m.capture.valid, 'capture.valid'],
    ['missing marker metadata', (m) => delete m.capture.requiredMarkers, 'requiredMarkers'],
    [
      'duplicate marker metadata',
      (m) => m.capture.requiredMarkers.push('app-start'),
      'requiredMarkers',
    ],
    ['unknown marker metadata', (m) => (m.capture.requiredMarkers[0] = 'other'), 'requiredMarkers'],
    ['missing missingMarkers', (m) => delete m.capture.missingMarkers, 'missingMarkers'],
    [
      'contradictory missingMarkers',
      (m) => m.capture.missingMarkers.push('app-ready'),
      'missingMarkers',
    ],
    ['missing actual marker', (m) => delete m.markers['app-ready'], 'app-ready'],
    ['zero samples', (m) => (m.capture.rendererSampleCount = 0), 'rendererSampleCount'],
    ['fractional samples', (m) => (m.capture.rendererSampleCount = 1.5), 'rendererSampleCount'],
    ['mismatched samples', (m) => (m.capture.rendererSampleCount = 2), 'rendererSampleCount'],
    ['bad renderer PID', (m) => (m.rendererSnapshots[0].pid = NaN), 'pid'],
    ['fractional PID', (m) => (m.rendererSnapshots[0].pid = 1.5), 'pid'],
    ['missing renderer timestamp', (m) => delete m.rendererSnapshots[0].timestamp, 'timestamp'],
    [
      'bad renderer creationTime',
      (m) => (m.rendererSnapshots[0].creationTime = Infinity),
      'creationTime',
    ],
    ['missing renderer memory', (m) => delete m.rendererSnapshots[0].memory, 'memory'],
    [
      'bad renderer residentSet',
      (m) => (m.rendererSnapshots[0].memory.residentSet = -1),
      'residentSet',
    ],
    ['bad renderer CPU', (m) => (m.rendererSnapshots[0].cpuPercent = Infinity), 'cpuPercent'],
  ])('rejects %s with a field diagnostic', (_name, mutate, field) => {
    const metrics = makeValidMetrics();
    metrics.capture.requiredMarkers = [...REQUIRED_MARKERS];
    mutate(metrics);
    const result = validateMetricsContract(metrics);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(field);
    expect(
      evaluateBudgets(metrics, { silent: true })
        .results.filter((r) => r.gated)
        .every((r) => r.status === 'FAIL')
    ).toBe(true);
  });

  it.each([-1, NaN, Infinity, -Infinity, null, '55'])('rejects unusable gated heap %s', (value) => {
    const metrics = makeValidMetrics();
    metrics.memorySnapshots.at(-1).heapUsed = value;
    const result = validateMetricsContract(metrics);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('heapUsed');
  });

  it.each([
    ['app-start', 'all-features-loaded'],
    ['app-ready', 'account-0-ready'],
    ['app-ready', 'features-loaded'],
    ['app-ready', 'account-0-content-loaded'],
  ])('rejects reversed gated pair %s -> %s', (from, to) => {
    const metrics = makeValidMetrics();
    metrics.markers[to] = metrics.markers[from] - 1;
    const result = validateMetricsContract(metrics);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(to);
  });

  it.each(
    REQUIRED_MARKERS.flatMap((marker) =>
      [-1, NaN, Infinity, -Infinity].map((value) => [marker, value])
    )
  )('rejects nonfinite/negative operand %s=%s', (marker, value) => {
    const metrics = makeValidMetrics();
    metrics.markers[marker] = value;
    expect(validateMetricsContract(metrics).ok).toBe(false);
  });

  it.each(['single', 'median'])('accepts producer %s aggregation', (strategy) => {
    const metrics = makeValidMetrics();
    const runs = strategy === 'single' ? [metrics] : [metrics, makeValidMetrics()];
    expect(validateMetricsContract(mergeMedian(runs)).ok).toBe(true);
  });

  it('rejects single aggregation whose sample count disagrees with its rows', () => {
    const metrics = mergeMedian([makeValidMetrics()]);
    metrics.capture.rendererSampleCount = 2;
    const result = validateMetricsContract(metrics);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('rendererSampleCount');
  });

  it.each([
    ['null', null],
    ['unknown strategy', { strategy: 'mean' }],
    ['incomplete', { complete: false }],
    ['missing count', { runs: undefined }],
    ['fractional count', { successfulRuns: 1.5 }],
    ['zero count', { runs: 0, successfulRuns: 0 }],
    ['partial success', { runs: 3, successfulRuns: 2 }],
    ['invalid run', { invalidRuns: 1 }],
    ['missing invalidRuns', { invalidRuns: undefined }],
    ['multiple single runs', { strategy: 'single', runs: 2, successfulRuns: 2 }],
    ['one-run median', { strategy: 'median', runs: 1, successfulRuns: 1 }],
  ])('rejects %s aggregation', (_name, override) => {
    const metrics = makeValidMetrics({
      aggregation:
        override === null
          ? null
          : {
              strategy: 'median',
              runs: 2,
              successfulRuns: 2,
              invalidRuns: 0,
              complete: true,
              ...override,
            },
    });
    const result = validateMetricsContract(metrics);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('aggregation');
  });

  it('accepts median capture count from last run rather than representative rows', () => {
    const metrics = makeValidMetrics();
    const many = makeValidMetrics({
      rendererSnapshots: [
        metrics.rendererSnapshots[0],
        { ...metrics.rendererSnapshots[0], pid: 2 },
      ],
    });
    const merged = mergeMedian([many, many, metrics]);
    expect(merged.capture.rendererSampleCount).toBe(1);
    expect(merged.rendererSnapshots).toEqual(many.rendererSnapshots);
    expect(validateMetricsContract(merged).ok).toBe(true);
  });

  it('checks row count rather than identities and ignores nonrenderer rows', () => {
    const metrics = makeValidMetrics();
    metrics.rendererSnapshots.push({ ...metrics.rendererSnapshots[0] }, { type: 'gpu' });
    metrics.capture.rendererSampleCount = 2;
    expect(validateMetricsContract(metrics).ok).toBe(true);
    expect(
      evaluateBudgets(metrics, { silent: true }).results.find((r) => r.name === 'rendererCount')
        .actual
    ).toBe(1);
  });

  it('accepts unavailable private memory and optional signed/missing measurements', () => {
    const metrics = makeValidMetrics();
    metrics.rendererSnapshots[0].memory.private = null;
    metrics.rendererSnapshots[0].memory.privateSource = 'unavailable';
    metrics.markers['account-0-content-loaded'] = 2000;
    metrics.markers['store-init-start'] = 300;
    metrics.markers['store-init-end'] = 200;
    metrics.markers.extension = -10;
    metrics.memorySnapshots.at(-1).rss = null;
    metrics.ipcLatency = { p50: -2 };
    const result = evaluateBudgets(metrics, { silent: true });
    expect(result.contractErrors).toEqual([]);
    expect(result.results.find((r) => r.name === 'rssBaseline').status).toBe('SKIP');
    expect(result.results.find((r) => r.name === 'storeInit').actual).toBe(-100);
    expect(result.results.find((r) => r.name === 'ipcLatencyP50').status).toBe('PASS');
  });
  it('accepts a complete MB-unit schema-valid artifact', () => {
    expect(validateMetricsContract(makeValidMetrics()).ok).toBe(true);
  });

  it('rejects schema version mismatch', () => {
    const r = validateMetricsContract(makeValidMetrics({ schemaVersion: 0 }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('schemaVersion'))).toBe(true);
  });

  it('rejects MB/byte unit mismatch', () => {
    const r = validateMetricsContract(makeValidMetrics({ units: { memory: 'bytes', time: 'ms' } }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('units.memory'))).toBe(true);
  });

  it('rejects empty renderer evidence', () => {
    const r = validateMetricsContract(
      makeValidMetrics({ rendererSnapshots: [], capture: { complete: true, valid: true } })
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /renderer/i.test(e))).toBe(true);
  });
});

describe('evaluateBudgets', () => {
  it.each(
    ['mainBundleSize', 'preloadBundleSize'].flatMap((name) =>
      [-1, NaN, Infinity, -Infinity].map((value) => [name, value])
    )
  )('rejects unusable gated bundle bytes %s=%s', (name, value) => {
    const spec = BUDGETS.find((budget) => budget.name === name);
    const originalExtract = spec.extract;
    try {
      spec.extract = () => value;
      const result = evaluateBudgets(makeValidMetrics(), { silent: true });
      expect(result.contractErrors.join('\n')).toContain(name);
      expect(result.results.filter((row) => row.gated).every((row) => row.status === 'FAIL')).toBe(
        true
      );
    } finally {
      spec.extract = originalExtract;
    }
  });

  it('passes a complete compatible fixture', () => {
    const { results, failed, contractErrors } = evaluateBudgets(makeValidMetrics(), {
      silent: true,
    });
    expect(contractErrors).toEqual([]);
    // Gated timing/memory/renderer metrics present; bundle sizes may fail if lib missing
    const gatedByName = Object.fromEntries(
      results.filter((r) => r.gated).map((r) => [r.name, r.status])
    );
    expect(gatedByName.totalStartup).toBe('PASS');
    expect(gatedByName.nativeWindowReady).toBe('PASS');
    expect(gatedByName.contentDocumentLoaded).toBe('PASS');
    expect(gatedByName.heapBaseline).toBe('PASS');
    expect(gatedByName.rendererCount).toBe('PASS');
    // Memory formatted as MB once (budget is 150 MB, actual 55)
    const heap = results.find((r) => r.name === 'heapBaseline');
    expect(heap.actual).toBe(55);
    expect(heap.budget).toBe(150);
    void failed;
  });

  it('fails when a gated marker is missing (no SKIP for gated)', () => {
    const metrics = makeValidMetrics();
    delete metrics.markers['account-0-content-loaded'];
    const { results } = evaluateBudgets(metrics, { silent: true });
    const content = results.find((r) => r.name === 'contentDocumentLoaded');
    expect(content.status).toBe('FAIL');
    expect(content.actual).toBeNull();
  });

  it('fails when renderer samples are empty', () => {
    const metrics = makeValidMetrics({
      rendererSnapshots: [],
      capture: {
        complete: true,
        valid: false,
        requiredMarkers: REQUIRED_MARKERS,
        missingMarkers: [],
        rendererSampleCount: 0,
      },
    });
    const { failed, contractErrors } = evaluateBudgets(metrics, { silent: true });
    expect(contractErrors.some((e) => /renderer/i.test(e))).toBe(true);
    expect(failed).toBeGreaterThan(0);
  });

  it('keeps missing warn-only metrics as SKIP (non-blocking)', () => {
    const metrics = makeValidMetrics({ ipcLatencySamples: undefined });
    const { results, failed } = evaluateBudgets(metrics, { silent: true });
    const ipc = results.find((r) => r.name === 'ipcLatencyP50');
    expect(ipc.gated).toBe(false);
    expect(ipc.status).toBe('SKIP');
    // Contract-valid metrics should not force warn-only into FAIL
    void failed;
  });

  it('renamed nativeWindowReady is present and windowFirstPaint is not', () => {
    const names = BUDGETS.map((b) => b.name);
    expect(names).toContain('nativeWindowReady');
    expect(names).not.toContain('windowFirstPaint');
    expect(names).toContain('contentDocumentLoaded');
    expect(names).not.toContain('contentFirstPaint');
  });

  it('counts unique renderer identity by (pid, creationTime) when creationTime exists', () => {
    const metrics = makeValidMetrics({
      rendererSnapshots: [1, 2, 3, 4, 5].map((creationTime) => ({
        timestamp: creationTime,
        pid: 10,
        creationTime,
        type: 'renderer',
        memory: { residentSet: 10, peakResidentSet: 12, private: 0 },
        cpuPercent: 1,
      })),
    });
    const { results } = evaluateBudgets(metrics, { silent: true });
    const rendererCount = results.find((r) => r.name === 'rendererCount');
    expect(rendererCount.actual).toBe(5);
    expect(rendererCount.status).toBe('FAIL');
  });

  it('falls back to PID when renderer snapshots omit creationTime', () => {
    const metrics = makeValidMetrics({
      rendererSnapshots: [1, 2, 3].map((timestamp) => ({
        timestamp,
        pid: 10,
        type: 'renderer',
        memory: { residentSet: 10, peakResidentSet: 12, private: 0 },
        cpuPercent: 1,
      })),
    });
    const { results } = evaluateBudgets(metrics, { silent: true });
    const rendererCount = results.find((r) => r.name === 'rendererCount');
    expect(rendererCount.actual).toBe(1);
    expect(rendererCount.status).toBe('PASS');
  });

  it('cannot false-pass rendererCount from a final low-count run', () => {
    const highCount = Array.from({ length: 5 }, (_, i) => ({
      timestamp: 500 + i,
      pid: 10 + i,
      creationTime: 10_000 + i,
      type: 'renderer',
      memory: { residentSet: 10, peakResidentSet: 12, private: 0 },
      cpuPercent: 1,
    }));
    const lowCount = [
      {
        timestamp: 500,
        pid: 99,
        creationTime: 99_000,
        type: 'renderer',
        memory: { residentSet: 10, peakResidentSet: 12, private: 0 },
        cpuPercent: 1,
      },
    ];
    const runs = [
      makeValidMetrics({ timestamp: 'run-0', rendererSnapshots: highCount }),
      makeValidMetrics({ timestamp: 'run-1', rendererSnapshots: highCount }),
      makeValidMetrics({ timestamp: 'run-2', rendererSnapshots: highCount }),
      makeValidMetrics({ timestamp: 'run-3', rendererSnapshots: highCount }),
      makeValidMetrics({ timestamp: 'run-4', rendererSnapshots: lowCount }),
    ];
    const merged = mergeMedian(runs, { requestedRuns: 5, invalidRuns: 0 });
    const { results, failed } = evaluateBudgets(merged, { silent: true });
    const rendererCount = results.find((r) => r.name === 'rendererCount');
    // Representative is a 5-identity run (budget 4). Last-run copy would be 1 and PASS.
    expect(merged.rendererSnapshots).toEqual(highCount);
    expect(merged.rendererSnapshots).not.toEqual(lowCount);
    expect(rendererCount.actual).toBe(5);
    expect(rendererCount.status).toBe('FAIL');
    expect(failed).toBeGreaterThan(0);
  });
});

describe('fixture files', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gogchat-budget-')));
    fs.mkdirSync(path.join(tmp, 'scripts'));
    fs.copyFileSync(
      new URL('./check-perf-budget.js', import.meta.url),
      path.join(tmp, 'scripts', 'check-perf-budget.mjs')
    );
    for (const directory of ['main', 'preload']) {
      fs.mkdirSync(path.join(tmp, 'lib', directory), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'lib', directory, 'index.js'), 'export {};\n');
    }
    fs.writeFileSync(path.join(tmp, '.perf-history.json'), '[{"seed":true}]\n');
    fs.writeFileSync(path.join(tmp, '.perf-baseline.json'), '{"schemaVersion":0,"seed":true}\n');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.each([
    'captureless',
    'incomplete',
    'aggregate mismatch',
    'one-run median',
    'negative heap',
    'reversed pair',
    'malformed JSON',
  ])('rejects %s CLI input without reading or changing saved evidence', (scenario) => {
    const metrics = makeValidMetrics();
    if (scenario === 'captureless') delete metrics.capture;
    if (scenario === 'incomplete') metrics.capture.complete = false;
    if (scenario === 'aggregate mismatch')
      metrics.aggregation = {
        strategy: 'median',
        runs: 3,
        successfulRuns: 2,
        invalidRuns: 0,
        complete: true,
      };
    if (scenario === 'one-run median') {
      metrics.aggregation = mergeMedian([metrics]).aggregation;
      metrics.aggregation.strategy = 'median';
    }
    if (scenario === 'negative heap') metrics.memorySnapshots.at(-1).heapUsed = -1;
    if (scenario === 'reversed pair') metrics.markers['features-loaded'] = 99;
    const file = path.join(tmp, 'metrics.json');
    fs.writeFileSync(file, scenario === 'malformed JSON' ? '{' : JSON.stringify(metrics));
    const saved = ['.perf-history.json', '.perf-baseline.json'].map((name) =>
      fs.readFileSync(path.join(tmp, name))
    );
    const result = spawnSync(
      process.execPath,
      [path.join(tmp, 'scripts', 'check-perf-budget.mjs'), file],
      { cwd: tmp, env: { ...process.env, PERF_UPDATE_BASELINE: '1' }, encoding: 'utf8' }
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::');
    expect(result.stdout).not.toContain('Performance Budget Report');
    expect(result.stderr).not.toContain('Ignoring incompatible baseline');
    expect(
      ['.perf-history.json', '.perf-baseline.json'].map((name) =>
        fs.readFileSync(path.join(tmp, name))
      )
    ).toEqual(saved);
  });

  it.each([false, true])(
    'records a valid over-budget CLI capture with baseline update=%s',
    (update) => {
      const metrics = makeValidMetrics();
      metrics.markers['all-features-loaded'] = 3000;
      const file = path.join(tmp, 'metrics.json');
      fs.writeFileSync(file, JSON.stringify(metrics));
      const baselineBefore = fs.readFileSync(path.join(tmp, '.perf-baseline.json'));
      const historyBefore = fs.readFileSync(path.join(tmp, '.perf-history.json'));
      const result = spawnSync(
        process.execPath,
        [path.join(tmp, 'scripts', 'check-perf-budget.mjs'), file],
        {
          cwd: tmp,
          env: { ...process.env, PERF_UPDATE_BASELINE: update ? '1' : '0' },
          encoding: 'utf8',
        }
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('Performance Budget Report');
      expect(fs.readFileSync(path.join(tmp, '.perf-history.json'))).not.toEqual(historyBefore);
      expect(
        JSON.parse(fs.readFileSync(path.join(tmp, '.perf-history.json'), 'utf8')).at(-1).metrics
          .totalStartup
      ).toBe(3000);
      const baselineAfter = fs.readFileSync(path.join(tmp, '.perf-baseline.json'));
      if (update) expect(baselineAfter).not.toEqual(baselineBefore);
      else expect(baselineAfter).toEqual(baselineBefore);
    }
  );

  it('passes a valid raw capture through the isolated CLI', () => {
    const file = path.join(tmp, 'metrics.json');
    fs.writeFileSync(file, JSON.stringify(makeValidMetrics()));
    const result = spawnSync(
      process.execPath,
      [path.join(tmp, 'scripts', 'check-perf-budget.mjs'), file],
      { cwd: tmp, env: { ...process.env, PERF_UPDATE_BASELINE: '0' }, encoding: 'utf8' }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('0 fail');
  });

  it('writes missing-gated-marker fixture and evaluates FAIL', () => {
    const metrics = makeValidMetrics();
    delete metrics.markers['account-0-content-loaded'];
    const file = path.join(tmp, 'missing-gated-marker.json');
    fs.writeFileSync(file, JSON.stringify(metrics, null, 2));
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { results } = evaluateBudgets(loaded, { silent: true });
    expect(results.find((r) => r.name === 'contentDocumentLoaded').status).toBe('FAIL');
  });
});
