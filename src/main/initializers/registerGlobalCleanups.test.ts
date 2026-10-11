import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const registerGlobalCleanupCallback =
    vi.fn<(id: string, cleanup: () => void | Promise<void>, label?: string) => void>();

  return {
    getCleanupManager: vi.fn(() => ({ registerGlobalCleanupCallback })),
    registerGlobalCleanupCallback,
  };
});

vi.mock('../utils/lifecycle/resourceCleanup.js', () => ({
  getCleanupManager: mocks.getCleanupManager,
}));
vi.mock('../utils/ipc/rateLimiter.js', () => ({ destroyRateLimiter: vi.fn() }));
vi.mock('../utils/ipc/ipcDeduplicator.js', () => ({ destroyDeduplicator: vi.fn() }));
vi.mock('../utils/platform/iconCache.js', () => ({ getIconCache: vi.fn() }));
vi.mock('../utils/config/configCache.js', () => ({ clearConfigCache: vi.fn() }));

import { registerGlobalCleanups } from './registerGlobalCleanups.js';

describe('registerGlobalCleanups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers every built-in global cleanup callback ID in shutdown order', async () => {
    await registerGlobalCleanups();

    expect(mocks.registerGlobalCleanupCallback.mock.calls.map(([id]) => id)).toEqual([
      'rateLimiter',
      'deduplicator',
      'iconCache',
      'configCache',
      'sessionMaintenance',
    ]);
  });
});
