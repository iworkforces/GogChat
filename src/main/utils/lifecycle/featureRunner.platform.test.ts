import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeaturePriority, FeatureSpec } from './featureConfigTypes.js';
import type { PlatformName } from '../platform/platformDetection.js';

const platformNameMock = vi.hoisted<{ current: PlatformName }>(() => ({ current: 'darwin' }));

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
    mark: vi.fn(),
  },
}));

vi.mock('../platform/platformDetection.js', () => ({
  platform: {
    get name() {
      return platformNameMock.current;
    },
  },
}));

type Plan = Readonly<Record<FeaturePriority, readonly (readonly FeatureSpec[])[]>>;

function emptyPlan(): Plan {
  return {
    security: [],
    critical: [],
    ui: [],
    deferred: [],
  };
}

async function loadRunnerWithPlan(plan: Plan) {
  vi.resetModules();
  vi.doMock('../../generated/featurePlan.js', () => ({ FEATURE_PLAN: plan }));
  return await import('./featureRunner.js');
}

describe('featureRunner platform gating', () => {
  beforeEach(() => {
    platformNameMock.current = 'darwin';
    vi.clearAllMocks();
  });

  it('skips a required spec when the active platform is unsupported', async () => {
    platformNameMock.current = 'win32';
    const init = vi.fn(() => {
      throw new Error('should not initialize');
    });
    const cleanup = vi.fn();
    const unsupported: FeatureSpec = {
      name: 'mac-only-required',
      phase: 'deferred',
      required: true,
      platforms: ['darwin'],
      init,
      cleanup,
    };

    const runner = await loadRunnerWithPlan({ ...emptyPlan(), deferred: [[unsupported]] });

    await expect(runner.runPhase('deferred', {})).resolves.toBeUndefined();
    await runner.cleanupAll({}, new AbortController().signal);

    expect(init).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(runner._getInitializedForTest()).toHaveLength(0);
  });

  it('initializes a platform-scoped spec when the active platform is supported', async () => {
    const init = vi.fn();
    const supported: FeatureSpec = {
      name: 'mac-only-supported',
      phase: 'deferred',
      platforms: ['darwin'],
      init,
    };

    const runner = await loadRunnerWithPlan({ ...emptyPlan(), deferred: [[supported]] });

    await runner.runPhase('deferred', {});

    expect(init).toHaveBeenCalledTimes(1);
    expect(runner._getInitializedForTest().map((spec) => spec.name)).toEqual([
      'mac-only-supported',
    ]);
  });
});
