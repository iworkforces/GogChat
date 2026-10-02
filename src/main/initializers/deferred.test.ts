import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asType } from '../../shared/typeUtils.js';
import type { FeatureContext } from '../utils/lifecycle/featureConfigTypes.js';

const setup = vi.hoisted(() => ({ ipc: vi.fn(), schedule: vi.fn(), dispose: vi.fn() }));
vi.mock('../features/inOnline.js', () => ({
  default: setup.ipc,
  scheduleInitialConnectivity: setup.schedule,
}));

describe('deferred connectivity ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup.schedule.mockReturnValue(setup.dispose);
  });

  it('captures the supplied account manager and registers its single disposer without a host window', async () => {
    const { DEFERRED_FEATURES } = await import('./deferred.spec.js');
    const feature = DEFERRED_FEATURES.find((entry) => entry.name === 'inOnline');
    const manager = {};
    const registerCleanupTask = vi.fn();
    await feature?.init(
      asType<FeatureContext>({
        accountWindowManager: manager,
        callbacks: { registerCleanupTask },
      })
    );
    expect(setup.schedule).toHaveBeenCalledWith(manager);
    expect(registerCleanupTask).toHaveBeenCalledExactlyOnceWith('inOnline', setup.dispose);
  });

  it('does not initialize account ownership when no manager was supplied', async () => {
    const { DEFERRED_FEATURES } = await import('./deferred.spec.js');
    await DEFERRED_FEATURES.find((entry) => entry.name === 'inOnline')?.init({});
    expect(setup.schedule).not.toHaveBeenCalled();
    expect(setup.ipc).not.toHaveBeenCalled();
  });
});
