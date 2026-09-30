/**
 * Characterization tests for `featureRunner` — the runtime engine that walks
 * the build-time `FEATURE_PLAN` and drives feature lifecycle.
 *
 * Covers:
 * - runPhase: phase ordering (security → critical → ui → deferred via runAllPhases)
 * - runPhase: empty phase short-circuit
 * - Batch parallelism: specs in same batch start concurrently
 * - Batch sequencing: batch N+1 awaits batch N
 * - cleanupAll: reverse-init order, only specs with cleanup, error-tolerant
 * - Per-spec error isolation: optional spec failure doesn't block batch peers
 * - Required-feature failure: throws and propagates
 * - getSummary: counts per phase + initialized
 * - _getInitializedForTest: returns snapshot
 *
 * NOTE: featureRunner holds module-level state (`initialized` array). Each test
 * uses `vi.resetModules()` + `vi.doMock(...)` to inject a controlled FEATURE_PLAN
 * and obtain a fresh module instance.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeatureContext, FeaturePriority, FeatureSpec } from './featureConfigTypes.js';

const perfMarkMock = vi.hoisted(() => vi.fn());

// ─── Static mocks (apply to every dynamic import below) ───────────────────────

vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./performanceMonitor.js', () => ({
  perfMonitor: {
    mark: perfMarkMock,
  },
}));

// Mock `electron` so any transitive import of the real generated plan (which
// pulls in `*.spec.ts` files that touch `app.isPackaged`) does not crash.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp'),
    getVersion: vi.fn(() => '0.0.0-test'),
    on: vi.fn(),
    once: vi.fn(),
    whenReady: vi.fn().mockResolvedValue(undefined),
  },
  BrowserWindow: vi.fn(),
  Tray: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn(), removeListener: vi.fn(), removeHandler: vi.fn() },
  session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  shell: { openExternal: vi.fn() },
  nativeImage: { createFromPath: vi.fn(() => ({ isEmpty: () => true })) },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Plan = Readonly<Record<FeaturePriority, readonly (readonly FeatureSpec[])[]>>;

function makeSpec(
  overrides: Partial<FeatureSpec> & Pick<FeatureSpec, 'name' | 'phase'>
): FeatureSpec {
  return {
    init: () => undefined,
    ...overrides,
  } as FeatureSpec;
}

function emptyPlan(): Plan {
  return {
    security: [],
    critical: [],
    ui: [],
    deferred: [],
  };
}

/**
 * Re-imports `featureRunner` with the supplied FEATURE_PLAN. Returns the freshly
 * loaded module, isolated from previous tests' module-level state.
 */
async function loadRunnerWithPlan(plan: Plan) {
  vi.resetModules();
  vi.doMock('../../generated/featurePlan.js', () => ({ FEATURE_PLAN: plan }));
  return await import('./featureRunner.js');
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('featureRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.doUnmock('../generated/featurePlan.js');
  });

  // ── runPhase: empty phase ───────────────────────────────────────────────────

  describe('runPhase — empty phase', () => {
    it('returns immediately when phase has no batches', async () => {
      const runner = await loadRunnerWithPlan(emptyPlan());
      const ctx: FeatureContext = {};

      await expect(runner.runPhase('security', ctx)).resolves.toBeUndefined();
      expect(runner._getInitializedForTest()).toHaveLength(0);
    });
  });

  // ── runPhase: ordering & init ───────────────────────────────────────────────

  describe('runPhase — initialization', () => {
    it('invokes spec.init with the provided context', async () => {
      const init = vi.fn();
      const plan: Plan = {
        ...emptyPlan(),
        security: [[makeSpec({ name: 'a', phase: 'security', init })]],
      };
      const runner = await loadRunnerWithPlan(plan);
      const ctx: FeatureContext = { trayIcon: null };

      await runner.runPhase('security', ctx);

      expect(init).toHaveBeenCalledTimes(1);
      expect(init).toHaveBeenCalledWith(ctx);
    });

    it('records initialized specs in init order', async () => {
      const order: string[] = [];
      const mk = (name: string): FeatureSpec =>
        makeSpec({
          name,
          phase: 'critical',
          init: () => {
            order.push(name);
          },
        });

      const plan: Plan = {
        ...emptyPlan(),
        critical: [[mk('a')], [mk('b')], [mk('c')]],
      };
      const runner = await loadRunnerWithPlan(plan);

      await runner.runPhase('critical', {});

      expect(order).toEqual(['a', 'b', 'c']);
      expect(runner._getInitializedForTest().map((s) => s.name)).toEqual(['a', 'b', 'c']);
    });
  });

  // ── Batch parallelism ───────────────────────────────────────────────────────

  describe('runPhase — batch parallelism', () => {
    it('runs specs within a single batch concurrently', async () => {
      let aResolve!: () => void;
      let bResolve!: () => void;
      const aStarted = vi.fn();
      const bStarted = vi.fn();

      const a = makeSpec({
        name: 'a',
        phase: 'ui',
        init: () =>
          new Promise<void>((res) => {
            aStarted();
            aResolve = res;
          }),
      });
      const b = makeSpec({
        name: 'b',
        phase: 'ui',
        init: () =>
          new Promise<void>((res) => {
            bStarted();
            bResolve = res;
          }),
      });

      const plan: Plan = { ...emptyPlan(), ui: [[a, b]] };
      const runner = await loadRunnerWithPlan(plan);

      const phasePromise = runner.runPhase('ui', {});

      // Yield once so init promises start; both should be in-flight before either resolves.
      await Promise.resolve();
      await Promise.resolve();

      expect(aStarted).toHaveBeenCalledTimes(1);
      expect(bStarted).toHaveBeenCalledTimes(1);

      aResolve();
      bResolve();
      await phasePromise;
    });

    it('awaits batch N before starting batch N+1', async () => {
      const events: string[] = [];
      let releaseA!: () => void;

      const a = makeSpec({
        name: 'a',
        phase: 'deferred',
        init: () =>
          new Promise<void>((res) => {
            events.push('a:start');
            releaseA = () => {
              events.push('a:end');
              res();
            };
          }),
      });
      const b = makeSpec({
        name: 'b',
        phase: 'deferred',
        init: () => {
          events.push('b:start');
        },
      });

      const plan: Plan = { ...emptyPlan(), deferred: [[a], [b]] };
      const runner = await loadRunnerWithPlan(plan);

      const phasePromise = runner.runPhase('deferred', {});
      await Promise.resolve();
      await Promise.resolve();

      // b must NOT have started yet — batch 1 hasn't completed
      expect(events).toEqual(['a:start']);

      releaseA();
      await phasePromise;

      expect(events).toEqual(['a:start', 'a:end', 'b:start']);
    });

    it('emits deferred batch timing markers around each deferred batch', async () => {
      const plan: Plan = {
        ...emptyPlan(),
        deferred: [
          [makeSpec({ name: 'a', phase: 'deferred' })],
          [makeSpec({ name: 'b', phase: 'deferred' }), makeSpec({ name: 'c', phase: 'deferred' })],
        ],
      };
      const runner = await loadRunnerWithPlan(plan);

      await runner.runPhase('deferred', {});

      expect(perfMarkMock).toHaveBeenCalledWith(
        'deferred:batch:1:start',
        'Deferred batch 1/2 starting (1 feature(s))'
      );
      expect(perfMarkMock).toHaveBeenCalledWith(
        'deferred:batch:1:end',
        'Deferred batch 1/2 completed'
      );
      expect(perfMarkMock).toHaveBeenCalledWith(
        'deferred:batch:2:start',
        'Deferred batch 2/2 starting (2 feature(s))'
      );
      expect(perfMarkMock).toHaveBeenCalledWith(
        'deferred:batch:2:end',
        'Deferred batch 2/2 completed'
      );
    });

    it('does not emit batch timing markers for non-deferred phases', async () => {
      const plan: Plan = {
        ...emptyPlan(),
        ui: [[makeSpec({ name: 'uiFeature', phase: 'ui' })]],
      };
      const runner = await loadRunnerWithPlan(plan);

      await runner.runPhase('ui', {});

      expect(perfMarkMock).not.toHaveBeenCalled();
    });
  });

  // ── Per-spec error isolation ────────────────────────────────────────────────

  describe('runPhase — error handling', () => {
    it('isolates failure of optional spec from same-batch peers', async () => {
      const peerInit = vi.fn();
      const failing = makeSpec({
        name: 'fails',
        phase: 'deferred',
        // required defaults to false → optional
        init: () => {
          throw new Error('boom');
        },
      });
      const peer = makeSpec({ name: 'peer', phase: 'deferred', init: peerInit });

      const plan: Plan = { ...emptyPlan(), deferred: [[failing, peer]] };
      const runner = await loadRunnerWithPlan(plan);

      await expect(runner.runPhase('deferred', {})).resolves.toBeUndefined();

      expect(peerInit).toHaveBeenCalledTimes(1);
      // Failed optional spec is NOT recorded as initialized.
      expect(runner._getInitializedForTest().map((s) => s.name)).toEqual(['peer']);
    });

    it('does not block subsequent batches when an optional spec fails', async () => {
      const next = vi.fn();
      const failing = makeSpec({
        name: 'fails',
        phase: 'ui',
        init: async () => {
          throw new Error('boom');
        },
      });
      const after = makeSpec({ name: 'after', phase: 'ui', init: next });

      const plan: Plan = { ...emptyPlan(), ui: [[failing], [after]] };
      const runner = await loadRunnerWithPlan(plan);

      await runner.runPhase('ui', {});

      expect(next).toHaveBeenCalledTimes(1);
    });

    it('propagates failure of a required spec', async () => {
      const failing = makeSpec({
        name: 'critical-fail',
        phase: 'security',
        required: true,
        init: () => {
          throw new Error('fatal');
        },
      });

      const plan: Plan = { ...emptyPlan(), security: [[failing]] };
      const runner = await loadRunnerWithPlan(plan);

      await expect(runner.runPhase('security', {})).rejects.toThrow('fatal');
      expect(runner._getInitializedForTest()).toHaveLength(0);
    });
  });

  // ── runAllPhases: phase ordering ────────────────────────────────────────────

  describe('runAllPhases', () => {
    it('runs phases in order: security → critical → ui → deferred', async () => {
      const order: string[] = [];
      const mk = (name: string, phase: FeaturePriority): FeatureSpec =>
        makeSpec({
          name,
          phase,
          init: () => {
            order.push(name);
          },
        });

      const plan: Plan = {
        security: [[mk('sec', 'security')]],
        critical: [[mk('crit', 'critical')]],
        ui: [[mk('ui', 'ui')]],
        deferred: [[mk('def', 'deferred')]],
      };
      const runner = await loadRunnerWithPlan(plan);

      await runner.runAllPhases({});

      expect(order).toEqual(['sec', 'crit', 'ui', 'def']);
    });
  });

  // ── cleanupAll ──────────────────────────────────────────────────────────────

  describe('cleanupAll', () => {
    it('runs cleanups in reverse-init order', async () => {
      const order: string[] = [];
      const mk = (name: string): FeatureSpec =>
        makeSpec({
          name,
          phase: 'critical',
          init: () => undefined,
          cleanup: () => {
            order.push(name);
          },
        });

      const plan: Plan = {
        ...emptyPlan(),
        critical: [[mk('a')], [mk('b')], [mk('c')]],
      };
      const runner = await loadRunnerWithPlan(plan);

      await runner.runPhase('critical', {});
      await runner.cleanupAll({}, new globalThis.AbortController().signal);

      expect(order).toEqual(['c', 'b', 'a']);
    });

    it('skips specs without a cleanup function', async () => {
      const cleanupB = vi.fn();
      const a = makeSpec({ name: 'a', phase: 'ui', init: () => undefined });
      const b = makeSpec({ name: 'b', phase: 'ui', init: () => undefined, cleanup: cleanupB });

      const plan: Plan = { ...emptyPlan(), ui: [[a, b]] };
      const runner = await loadRunnerWithPlan(plan);

      await runner.runPhase('ui', {});
      await runner.cleanupAll({}, new globalThis.AbortController().signal);

      expect(cleanupB).toHaveBeenCalledTimes(1);
    });

    it('continues when one cleanup rejects (Promise.allSettled semantics)', async () => {
      const cleanupB = vi.fn();
      const a = makeSpec({
        name: 'a',
        phase: 'deferred',
        init: () => undefined,
        cleanup: () => {
          throw new Error('cleanup-fail');
        },
      });
      const b = makeSpec({
        name: 'b',
        phase: 'deferred',
        init: () => undefined,
        cleanup: cleanupB,
      });

      const plan: Plan = { ...emptyPlan(), deferred: [[a, b]] };
      const runner = await loadRunnerWithPlan(plan);

      await runner.runPhase('deferred', {});
      await expect(
        runner.cleanupAll({}, new globalThis.AbortController().signal)
      ).resolves.toBeUndefined();

      expect(cleanupB).toHaveBeenCalledTimes(1);
    });

    it('clears the initialized list after cleanup', async () => {
      const a = makeSpec({
        name: 'a',
        phase: 'critical',
        init: () => undefined,
        cleanup: () => undefined,
      });

      const plan: Plan = { ...emptyPlan(), critical: [[a]] };
      const runner = await loadRunnerWithPlan(plan);

      await runner.runPhase('critical', {});
      expect(runner._getInitializedForTest()).toHaveLength(1);

      await runner.cleanupAll({}, new globalThis.AbortController().signal);
      expect(runner._getInitializedForTest()).toHaveLength(0);
    });

    it('is a no-op when nothing has been initialized', async () => {
      const runner = await loadRunnerWithPlan(emptyPlan());
      await expect(
        runner.cleanupAll({}, new globalThis.AbortController().signal)
      ).resolves.toBeUndefined();
    });
  });

  // ── getSummary ──────────────────────────────────────────────────────────────

  describe('getSummary', () => {
    it('reports per-phase and total feature counts plus initialized count', async () => {
      const plan: Plan = {
        security: [[makeSpec({ name: 's1', phase: 'security' })]],
        critical: [
          [
            makeSpec({ name: 'c1', phase: 'critical' }),
            makeSpec({ name: 'c2', phase: 'critical' }),
          ],
        ],
        ui: [],
        deferred: [
          [makeSpec({ name: 'd1', phase: 'deferred' })],
          [
            makeSpec({ name: 'd2', phase: 'deferred' }),
            makeSpec({ name: 'd3', phase: 'deferred' }),
          ],
        ],
      };
      const runner = await loadRunnerWithPlan(plan);

      const before = runner.getSummary();
      expect(before).toEqual({
        total: 6,
        initialized: 0,
        byPhase: { security: 1, critical: 2, ui: 0, deferred: 3 },
      });

      await runner.runPhase('security', {});
      const after = runner.getSummary();
      expect(after.initialized).toBe(1);
      expect(after.total).toBe(6);
    });
  });
  // ── Real generated plan integrity ───────────────────────────────────────────

  describe('FEATURE_PLAN (generated) integrity', () => {
    it('exposes all four phases as arrays', async () => {
      // Drop any prior `vi.doMock('../../generated/featurePlan.js')` registration
      // so this test loads the *actual* generated plan.
      vi.doUnmock('../generated/featurePlan.js');
      vi.resetModules();
      const { FEATURE_PLAN } = await import('../../generated/featurePlan.js');
      expect(Array.isArray(FEATURE_PLAN.security)).toBe(true);
      expect(Array.isArray(FEATURE_PLAN.critical)).toBe(true);
      expect(Array.isArray(FEATURE_PLAN.ui)).toBe(true);
      expect(Array.isArray(FEATURE_PLAN.deferred)).toBe(true);
    });
  });
});
