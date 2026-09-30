import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureContext, FeaturePriority, FeatureSpec } from './featureConfigTypes.js';
import type * as FeatureRunner from './featureRunner.js';

const { featurePlan } = vi.hoisted(() => {
  const featurePlan: Record<FeaturePriority, FeatureSpec[][]> = {
    security: [],
    critical: [],
    ui: [],
    deferred: [],
  };

  return { featurePlan };
});

vi.mock('electron-log', () => ({
  default: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../generated/featurePlan.js', () => ({ FEATURE_PLAN: featurePlan }));

vi.mock('./performanceMonitor.js', () => ({
  perfMonitor: { mark: vi.fn() },
}));

vi.mock('../platform/platformDetection.js', () => ({
  platform: { name: 'darwin' },
}));

let runner: typeof FeatureRunner;
beforeEach(async () => {
  vi.resetModules();
  runner = await import('./featureRunner.js');
});

const context: FeatureContext = {};
const budget = (): globalThis.AbortSignal => new globalThis.AbortController().signal;

function resetFeaturePlan(): void {
  featurePlan.security = [];
  featurePlan.critical = [];
  featurePlan.ui = [];
  featurePlan.deferred = [];
}

afterEach(() => {
  resetFeaturePlan();
});

describe('featureRunner', () => {
  it('cleans a held initializer once when it settles after cleanup starts', async () => {
    const held = Promise.withResolvers<void>();
    const cleaned = vi.fn();
    featurePlan.security = [
      [
        {
          name: 'held',
          phase: 'security',
          init: () => held.promise,
          cleanup: cleaned,
        },
      ],
    ];

    const phase = runner.runPhase('security', context);
    const cleanup = runner.cleanupAll(context, budget());
    held.resolve();
    await Promise.all([phase, cleanup]);

    expect(cleaned).toHaveBeenCalledTimes(1);
  });

  it('waits for concurrent sibling settlement before propagating a required failure', async () => {
    const trace: string[] = [];
    const requiredInit = Promise.withResolvers<void>();
    const siblingInit = Promise.withResolvers<void>();
    const requiredError = new Error('required init failed');
    const requiredFeature: FeatureSpec = {
      name: 'required',
      phase: 'security',
      required: true,
      init: () => {
        trace.push('required:start');
        return requiredInit.promise;
      },
    };
    const siblingFeature: FeatureSpec = {
      name: 'sibling',
      phase: 'security',
      init: () => {
        trace.push('sibling:start');
        return siblingInit.promise;
      },
    };
    featurePlan.security = [[requiredFeature, siblingFeature]];

    const phase = runner.runPhase('security', context);
    let phaseSettled = false;
    void phase.catch(() => {
      phaseSettled = true;
    });

    expect(trace).toEqual(['required:start', 'sibling:start']);

    requiredInit.reject(requiredError);
    for (let microtask = 0; microtask < 8; microtask += 1) {
      await Promise.resolve();
    }

    expect(phaseSettled).toBe(false);
    expect(runner._getInitializedForTest()).toEqual([]);

    const { closeStartupAdmission } = await import('./startupAdmission.js');
    closeStartupAdmission();
    siblingInit.resolve();

    await expect(phase).rejects.toBe(requiredError);
    expect(runner._getInitializedForTest()).toEqual([siblingFeature]);

    await runner.cleanupAll(context, budget());
  });

  it('cleans up reverse completion order sequentially and continues after a failure', async () => {
    const cleanupTrace: string[] = [];
    const firstInit = Promise.withResolvers<void>();
    const secondInit = Promise.withResolvers<void>();
    const secondCleanup = Promise.withResolvers<void>();
    const firstCleanup = Promise.withResolvers<void>();
    const firstCleanupStarted = Promise.withResolvers<void>();
    const firstFeature: FeatureSpec = {
      name: 'first',
      phase: 'security',
      init: () => firstInit.promise,
      cleanup: () => {
        cleanupTrace.push('first:cleanup:start');
        firstCleanupStarted.resolve();
        return firstCleanup.promise;
      },
    };
    const secondFeature: FeatureSpec = {
      name: 'second',
      phase: 'security',
      init: () => secondInit.promise,
      cleanup: () => {
        cleanupTrace.push('second:cleanup:start');
        return secondCleanup.promise;
      },
    };
    featurePlan.security = [[firstFeature, secondFeature]];

    const phase = runner.runPhase('security', context);
    firstInit.resolve();
    await Promise.resolve();
    secondInit.resolve();
    await phase;

    expect(runner._getInitializedForTest()).toEqual([firstFeature, secondFeature]);

    const cleanup = runner.cleanupAll(context, budget());

    expect(cleanupTrace).toEqual(['second:cleanup:start']);

    secondCleanup.reject(new Error('second cleanup failed'));
    await firstCleanupStarted.promise;

    expect(cleanupTrace).toEqual(['second:cleanup:start', 'first:cleanup:start']);

    firstCleanup.resolve();
    await cleanup;

    expect(runner._getInitializedForTest()).toEqual([]);
  });

  it('claims cleanup once and permits awaited reentrant cleanup without joining itself', async () => {
    const cleaned = vi.fn(async () => {
      await runner.cleanupAll(context, budget());
    });
    featurePlan.security = [
      [{ name: 'reentrant', phase: 'security', init: vi.fn(), cleanup: cleaned }],
    ];
    await runner.runPhase('security', context);

    const first = runner.cleanupAll(context, budget());
    await runner.cleanupAll(context, budget());
    await first;
    await runner.cleanupAll(context, budget());

    expect(cleaned).toHaveBeenCalledTimes(1);
  });

  it('tracks admission before invoking an initializer that synchronously starts cleanup', async () => {
    const held = Promise.withResolvers<void>();
    const cleaned = vi.fn();
    const later = vi.fn();
    let cleanup: Promise<void> | undefined;
    featurePlan.security = [
      [
        {
          name: 'reentrant-init',
          phase: 'security',
          init: () => {
            cleanup = runner.cleanupAll(context, budget());
            return held.promise;
          },
          cleanup: cleaned,
        },
        { name: 'later', phase: 'security', init: later },
      ],
    ];
    const phase = runner.runPhase('security', context);
    expect(cleaned).not.toHaveBeenCalled();
    held.resolve();
    await Promise.all([phase, cleanup]);
    expect(cleaned).toHaveBeenCalledTimes(1);
    expect(later).not.toHaveBeenCalled();
  });

  it('does not claim any cleanup when its budget is already expired', async () => {
    const cleaned = vi.fn();
    const spec: FeatureSpec = {
      name: 'success',
      phase: 'security',
      init: vi.fn(),
      cleanup: cleaned,
    };
    featurePlan.security = [[spec]];
    await runner.runPhase('security', context);
    await runner.cleanupAll(context, globalThis.AbortSignal.abort());
    expect(cleaned).not.toHaveBeenCalled();
    expect(runner._getInitializedForTest()).toEqual([spec]);
  });

  it('does not admit later specs or batches when an initializer closes admission synchronously', async () => {
    const { closeStartupAdmission } = await import('./startupAdmission.js');
    const later = vi.fn();
    const firstCleanup = vi.fn();
    featurePlan.security = [
      [
        { name: 'first', phase: 'security', init: closeStartupAdmission, cleanup: firstCleanup },
        { name: 'same-batch', phase: 'security', init: later },
      ],
      [{ name: 'later-batch', phase: 'security', init: later }],
    ];

    await runner.runPhase('security', context);
    await runner.cleanupAll(context, budget());

    expect(later).not.toHaveBeenCalled();
    expect(firstCleanup).toHaveBeenCalledTimes(1);
  });

  it('observes synchronous required failure and preserves its reason after admission closes', async () => {
    const { closeStartupAdmission } = await import('./startupAdmission.js');
    const failure = new Error('original required failure');
    featurePlan.security = [
      [
        {
          name: 'required',
          phase: 'security',
          required: true,
          init: () => {
            closeStartupAdmission();
            throw failure;
          },
        },
      ],
    ];

    await expect(runner.runPhase('security', context)).rejects.toBe(failure);
    await runner.cleanupAll(context, budget());
    expect(runner._getInitializedForTest()).toEqual([]);
  });

  it('abandons a hung settlement barrier without cleaning successes in the background', async () => {
    const controller = new globalThis.AbortController();
    const held = Promise.withResolvers<void>();
    const cleaned = vi.fn();
    const spec: FeatureSpec = {
      name: 'late',
      phase: 'security',
      init: () => held.promise,
      cleanup: cleaned,
    };
    featurePlan.security = [[spec]];
    const phase = runner.runPhase('security', context);
    const cleanup = runner.cleanupAll(context, controller.signal);

    controller.abort();
    await cleanup;
    held.resolve();
    await phase;
    await runner.cleanupAll(context, budget());

    expect(cleaned).not.toHaveBeenCalled();
    expect(runner._getInitializedForTest()).toEqual([spec]);
  });

  it('observes late cleanup rejection and leaves unclaimed registrations after expiry', async () => {
    const controller = new globalThis.AbortController();
    const held = Promise.withResolvers<void>();
    const earlierCleanup = vi.fn();
    const earlier: FeatureSpec = {
      name: 'earlier',
      phase: 'security',
      init: vi.fn(),
      cleanup: earlierCleanup,
    };
    featurePlan.security = [
      [earlier],
      [{ name: 'hung', phase: 'security', init: vi.fn(), cleanup: () => held.promise }],
    ];
    await runner.runPhase('security', context);
    const cleanup = runner.cleanupAll(context, controller.signal);

    controller.abort();
    await cleanup;
    const failure = new Error('late cleanup failure');
    held.reject(failure);
    const { default: log } = await import('electron-log');
    await vi.waitFor(() =>
      expect(log.error).toHaveBeenCalledWith('[FeatureRunner] ✗ cleanup failed:', failure)
    );

    expect(earlierCleanup).not.toHaveBeenCalled();
    expect(runner._getInitializedForTest()).toEqual([earlier]);
  });

  it('cleans an initialized success promptly while another initializer never settles', async () => {
    const controller = new globalThis.AbortController();
    const successInit = Promise.withResolvers<void>();
    const cleaned = vi.fn(() => expect(controller.signal.aborted).toBe(false));
    const success: FeatureSpec = {
      name: 'success',
      phase: 'security',
      init: () => successInit.promise,
      cleanup: cleaned,
    };
    featurePlan.security = [
      [success, { name: 'hung', phase: 'security', init: () => new Promise(() => undefined) }],
    ];
    void runner.runPhase('security', context);
    successInit.resolve();
    await successInit.promise;
    expect(runner._getInitializedForTest()).toEqual([success]);

    const cleanup = runner.cleanupAll(context, controller.signal);
    try {
      expect(cleaned).toHaveBeenCalledTimes(1);
      expect(controller.signal.aborted).toBe(false);
      expect(runner._getInitializedForTest()).toEqual([]);
      await runner.cleanupAll(context, controller.signal);
      expect(cleaned).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      await cleanup;
    }
  });

  it('cleans a success released during cleanup while another initializer never settles', async () => {
    const controller = new globalThis.AbortController();
    const signal = globalThis.AbortSignal.any([
      controller.signal,
      globalThis.AbortSignal.timeout(500),
    ]);
    const successInit = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    const cleaned = vi.fn(() => cleanupStarted.resolve());
    featurePlan.security = [
      [
        { name: 'held', phase: 'security', init: () => successInit.promise, cleanup: cleaned },
        { name: 'hung', phase: 'security', init: () => new Promise(() => undefined) },
      ],
    ];
    void runner.runPhase('security', context);

    const cleanup = runner.cleanupAll(context, signal);
    try {
      expect(cleaned).not.toHaveBeenCalled();
      successInit.resolve();
      expect(
        await Promise.race([cleanupStarted.promise.then(() => true), cleanup.then(() => false)])
      ).toBe(true);
      expect(signal.aborted).toBe(false);
      expect(cleaned).toHaveBeenCalledTimes(1);
      expect(runner._getInitializedForTest()).toEqual([]);
      await runner.cleanupAll(context, signal);
      expect(cleaned).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      await cleanup;
    }
  });

  it('claims newly settled successes newest-first after an in-flight cleanup', async () => {
    const controller = new globalThis.AbortController();
    const trace: string[] = [];
    const earlierInit = Promise.withResolvers<void>();
    const activeInit = Promise.withResolvers<void>();
    const laterInit = Promise.withResolvers<void>();
    const newestInit = Promise.withResolvers<void>();
    const activeCleanup = Promise.withResolvers<void>();
    const earlierCleanup = vi.fn(() => {
      expect(controller.signal.aborted).toBe(false);
      trace.push('earlier');
    });
    const activeCleanupStarted = vi.fn(() => {
      trace.push('active');
      return activeCleanup.promise;
    });
    const laterCleanup = vi.fn(() => {
      expect(controller.signal.aborted).toBe(false);
      trace.push('later');
    });
    const newestCleanup = vi.fn(() => {
      expect(controller.signal.aborted).toBe(false);
      trace.push('newest');
    });
    featurePlan.security = [
      [
        {
          name: 'earlier',
          phase: 'security',
          init: () => earlierInit.promise,
          cleanup: earlierCleanup,
        },
        {
          name: 'active',
          phase: 'security',
          init: () => activeInit.promise,
          cleanup: activeCleanupStarted,
        },
        { name: 'later', phase: 'security', init: () => laterInit.promise, cleanup: laterCleanup },
        {
          name: 'newest',
          phase: 'security',
          init: () => newestInit.promise,
          cleanup: newestCleanup,
        },
      ],
    ];
    const phase = runner.runPhase('security', context);
    earlierInit.resolve();
    await earlierInit.promise;
    activeInit.resolve();
    await activeInit.promise;

    const cleanup = runner.cleanupAll(context, controller.signal);
    try {
      expect(trace).toEqual(['active']);
      laterInit.resolve();
      await laterInit.promise;
      newestInit.resolve();
      await phase;
      expect(trace).toEqual(['active']);
      activeCleanup.resolve();
      await cleanup;

      expect(controller.signal.aborted).toBe(false);
      expect(trace).toEqual(['active', 'newest', 'later', 'earlier']);
      await runner.cleanupAll(context, controller.signal);
      for (const cleaned of [activeCleanupStarted, newestCleanup, laterCleanup, earlierCleanup]) {
        expect(cleaned).toHaveBeenCalledTimes(1);
      }
      expect(runner._getInitializedForTest()).toEqual([]);
    } finally {
      controller.abort();
      activeCleanup.resolve();
      earlierInit.resolve();
      activeInit.resolve();
      laterInit.resolve();
      newestInit.resolve();
      await Promise.all([phase, cleanup]);
    }
  });

  it('observes required initializer rejection after its cleanup budget expires', async () => {
    const controller = new globalThis.AbortController();
    const held = Promise.withResolvers<void>();
    featurePlan.security = [
      [{ name: 'late-required', phase: 'security', required: true, init: () => held.promise }],
    ];
    const phase = runner.runPhase('security', context);
    const failure = new Error('late required failure');
    const observed = expect(phase).rejects.toBe(failure);
    const cleanup = runner.cleanupAll(context, controller.signal);
    controller.abort();
    await cleanup;
    held.reject(failure);
    await observed;
    const { default: log } = await import('electron-log');
    expect(log.error).toHaveBeenCalledWith(
      "[FeatureRunner] ✗ REQUIRED feature 'late-required' failed:",
      failure
    );
  });
});
