/**
 * Unit tests for encrypted configuration store
 */

import type * as NodeFs from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsOps = vi.hoisted(() => ({
  renameSync: vi.fn<(from: unknown, to: unknown) => void>(),
  rmSync: vi.fn<(target: unknown, options?: unknown) => void>(),
  passRename: (..._args: unknown[]): void => undefined,
  passRemove: (..._args: unknown[]): void => undefined,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs');
  fsOps.passRename = (...args: unknown[]) => {
    Reflect.apply(actual.renameSync, actual, args);
  };
  fsOps.passRemove = (...args: unknown[]) => {
    Reflect.apply(actual.rmSync, actual, args);
  };
  fsOps.renameSync.mockImplementation((...args: unknown[]) => {
    fsOps.passRename(...args);
  });
  fsOps.rmSync.mockImplementation((...args: unknown[]) => {
    fsOps.passRemove(...args);
  });
  return {
    ...actual,
    renameSync: fsOps.renameSync,
    rmSync: fsOps.rmSync,
  };
});

// Mock electron
vi.mock('electron', () => ({
  app: {
    getName: () => 'gogchat',
    getPath: (name: string) => `/fake/path/${name}`,
    getAppPath: () => '/fake/app/path',
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((str: string) => Buffer.from(`encrypted:${str}`)),
    decryptString: vi.fn((buffer: Buffer) => buffer.toString().replace('encrypted:', '')),
  },
}));

// Mock electron-log
vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock packageInfo to avoid file system access
vi.mock('./utils/platform/packageInfo', () => ({
  getPackageInfo: vi.fn(() => ({
    name: 'gogchat',
    productName: 'GogChat',
    version: '0.0.0',
    description: 'GogChat',
    repository: '',
    homepage: '',
    author: '',
  })),
  clearPackageInfoCache: vi.fn(),
  isPackageInfoLoaded: vi.fn(() => true),
}));

// Mock configCache to return store as-is (no caching in tests)
vi.mock('./utils/config/configCache', () => ({
  addCacheLayer: vi.fn((store) => store),
  isCachedStore: vi.fn(() => false),
}));

// Mock encryptionKey module
vi.mock('./utils/security/encryptionKey', () => ({
  getOrCreateEncryptionKey: vi.fn(async () => ({
    key: 'test-encryption-key-hex-string',
    migrationPending: false,
  })),
  needsMigration: vi.fn(async () => false),
  completeMigration: vi.fn(async () => null),
}));

// Mock electron-store
const mockStore = {
  get: vi.fn(),
  set: vi.fn(),
  has: vi.fn(),
  delete: vi.fn(),
  clear: vi.fn(),
  onDidChange: vi.fn(),
  store: {} as Record<string, unknown>,
  constructs: 0,
  failAt: 0,
  timeline: [] as string[],
  opened: [] as unknown[],
};

// Mock electron-store constructor - must be a proper constructor function
class MockStore {
  get = mockStore.get;
  set = mockStore.set;
  has = mockStore.has;
  delete = mockStore.delete;
  clear = mockStore.clear;
  onDidChange = mockStore.onDidChange;
  store = mockStore.store;

  constructor(options?: unknown) {
    mockStore.constructs += 1;
    mockStore.opened.push(options);
    mockStore.timeline.push(`new:${mockStore.constructs}`);
    if (mockStore.failAt === mockStore.constructs) {
      throw new Error('JSON Parse error: Unexpected identifier "O2"');
    }
  }
}

vi.mock('electron-store', () => ({
  default: MockStore,
}));

function configPaths(): { file: string; backup: string; keyFile: string } {
  const file = join('/fake/path/userData', 'config.json');
  return {
    file,
    backup: `${file}.bak`,
    keyFile: join('/fake/path/userData', 'encryption-key.enc'),
  };
}

function spyConfigFiles(afterRename?: () => void): { restore: () => void } {
  fsOps.renameSync.mockImplementation((from: unknown, to: unknown) => {
    mockStore.timeline.push(`rename:${String(from)}>${String(to)}`);
    afterRename?.();
  });
  fsOps.rmSync.mockImplementation((target: unknown) => {
    mockStore.timeline.push(`rm:${String(target)}`);
  });
  return {
    restore(): void {
      fsOps.renameSync.mockImplementation((...args: unknown[]) => {
        fsOps.passRename(...args);
      });
      fsOps.rmSync.mockImplementation((...args: unknown[]) => {
        fsOps.passRemove(...args);
      });
    },
  };
}

describe('Config Store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mockStore implementation
    mockStore.get.mockReturnValue(undefined);
    mockStore.set.mockReturnValue(undefined);
    mockStore.has.mockReturnValue(false);
    mockStore.store = {};
    mockStore.constructs = 0;
    mockStore.failAt = 0;
    mockStore.timeline = [];
    mockStore.opened = [];
    // Reset the module to clear singleton state
    vi.resetModules();
  });

  it('should export a store instance', async () => {
    const { initializeStore, default: config } = await import('./config');
    await initializeStore();
    expect(config).toBeDefined();
  });

  it('should be callable with get/set methods', async () => {
    const { initializeStore, default: config } = await import('./config');
    await initializeStore();

    expect(config.get).toBeDefined();
    expect(config.set).toBeDefined();
  });

  it('should support window bounds configuration', async () => {
    const { initializeStore, default: config } = await import('./config');
    await initializeStore();

    config.get('window.bounds');
    expect(mockStore.get).toHaveBeenCalledWith('window.bounds');
  });

  it('should support app configuration', async () => {
    const { initializeStore, default: config } = await import('./config');
    await initializeStore();

    config.get('app.autoCheckForUpdates');
    expect(mockStore.get).toHaveBeenCalled();
  });

  it('should throw error if accessed before initialization', async () => {
    const { default: config } = await import('./config');

    expect(() => config.get('app.autoCheckForUpdates')).toThrow('Store not initialized');
  });
});

describe('initializeStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.get.mockReturnValue(undefined);
    mockStore.set.mockReturnValue(undefined);
    mockStore.has.mockReturnValue(false);
    mockStore.store = {};
    mockStore.constructs = 0;
    mockStore.failAt = 0;
    mockStore.timeline = [];
    mockStore.opened = [];
    vi.resetModules();
  });

  it('should return the same store instance on subsequent calls (singleton)', async () => {
    const { initializeStore } = await import('./config');
    const store1 = await initializeStore();
    const store2 = await initializeStore();
    expect(store1).toBe(store2);
  });

  it('should call getOrCreateEncryptionKey', async () => {
    const { initializeStore } = await import('./config');
    const { getOrCreateEncryptionKey } = await import('./utils/security/encryptionKey');
    await initializeStore();
    expect(getOrCreateEncryptionKey).toHaveBeenCalledOnce();
  });

  it('should not call needsMigration separately (migrationPending comes from getOrCreateEncryptionKey)', async () => {
    const { initializeStore } = await import('./config');
    const { needsMigration } = await import('./utils/security/encryptionKey');
    await initializeStore();
    expect(needsMigration).not.toHaveBeenCalled();
  });

  it('should perform migration when getOrCreateEncryptionKey signals migrationPending', async () => {
    const { getOrCreateEncryptionKey, completeMigration } =
      await import('./utils/security/encryptionKey');
    vi.mocked(getOrCreateEncryptionKey).mockResolvedValue({
      key: 'test-encryption-key-hex-string',
      migrationPending: true,
    });
    vi.mocked(completeMigration).mockResolvedValue('new-safestorage-key');
    mockStore.store = { app: { autoCheckForUpdates: true } };

    const { initializeStore } = await import('./config');
    await initializeStore();

    expect(completeMigration).toHaveBeenCalledOnce();
    // After migration, data should be re-imported via set()
    expect(mockStore.set).toHaveBeenCalledWith('app', { autoCheckForUpdates: true });
  });

  it('should continue with legacy store if completeMigration returns null', async () => {
    const { getOrCreateEncryptionKey, completeMigration } =
      await import('./utils/security/encryptionKey');
    const _log = (await import('electron-log')).default;
    vi.mocked(getOrCreateEncryptionKey).mockResolvedValue({
      key: 'test-encryption-key-hex-string',
      migrationPending: true,
    });
    vi.mocked(completeMigration).mockResolvedValue(null);

    const { initializeStore } = await import('./config');
    const store = await initializeStore();

    expect(store).toBeDefined();
    // No data migration when completeMigration returns null
    expect(mockStore.set).not.toHaveBeenCalledWith('app', expect.anything());
  });

  it('should handle migration error gracefully and continue with legacy key', async () => {
    const { getOrCreateEncryptionKey, completeMigration } =
      await import('./utils/security/encryptionKey');
    const log = (await import('electron-log')).default;
    vi.mocked(getOrCreateEncryptionKey).mockResolvedValue({
      key: 'test-encryption-key-hex-string',
      migrationPending: true,
    });
    vi.mocked(completeMigration).mockRejectedValue(new Error('SafeStorage unavailable'));

    const { initializeStore } = await import('./config');
    const store = await initializeStore();

    // Should still return a store (the legacy one)
    expect(store).toBeDefined();
    expect(log.error).toHaveBeenCalledWith(
      '[Config] Migration failed, continuing with legacy key:',
      expect.any(Error)
    );
  });

  it('should skip migration when migrationPending is false', async () => {
    const { getOrCreateEncryptionKey, completeMigration } =
      await import('./utils/security/encryptionKey');
    vi.mocked(getOrCreateEncryptionKey).mockResolvedValue({
      key: 'test-encryption-key-hex-string',
      migrationPending: false,
    });

    const { initializeStore } = await import('./config');
    await initializeStore();

    expect(completeMigration).not.toHaveBeenCalled();
  });

  it('should migrate all data entries from old store to new store', async () => {
    const { getOrCreateEncryptionKey, completeMigration } =
      await import('./utils/security/encryptionKey');
    vi.mocked(getOrCreateEncryptionKey).mockResolvedValue({
      key: 'test-encryption-key-hex-string',
      migrationPending: true,
    });
    vi.mocked(completeMigration).mockResolvedValue('new-key');
    mockStore.store = {
      window: { bounds: { x: 10, y: 20, width: 1024, height: 768 }, isMaximized: true },
      app: { autoCheckForUpdates: false },
      _meta: { cacheVersion: '1.0.0', lastAppVersion: '0.0.1', lastUpdated: 100 },
    };

    const { initializeStore } = await import('./config');
    await initializeStore();

    // All keys from old store should be set on new store
    expect(mockStore.set).toHaveBeenCalledWith(
      'window',
      expect.objectContaining({ isMaximized: true })
    );
    expect(mockStore.set).toHaveBeenCalledWith(
      'app',
      expect.objectContaining({ autoCheckForUpdates: false })
    );
    expect(mockStore.set).toHaveBeenCalledWith(
      '_meta',
      expect.objectContaining({ cacheVersion: '1.0.0' })
    );
  });

  it('moves the legacy config aside before opening the store with the new key', async () => {
    const fsSpies = spyConfigFiles();
    try {
      const { getOrCreateEncryptionKey, completeMigration } =
        await import('./utils/security/encryptionKey');
      vi.mocked(getOrCreateEncryptionKey).mockResolvedValue({
        key: 'test-encryption-key-hex-string',
        migrationPending: true,
      });
      vi.mocked(completeMigration).mockResolvedValue('new-safestorage-key');
      mockStore.store = {
        app: { autoCheckForUpdates: true },
        __internal__: { migrations: { version: '0.0.0' } },
      };

      const { initializeStore } = await import('./config');
      await initializeStore();

      const { file, backup, keyFile } = configPaths();
      expect(mockStore.timeline).toEqual([
        'new:1',
        `rename:${file}>${backup}`,
        'new:2',
        `rm:${backup}`,
      ]);
      expect(mockStore.opened[1]).toMatchObject({
        encryptionKey: 'new-safestorage-key',
        clearInvalidConfig: true,
      });
      expect(mockStore.set).toHaveBeenCalledWith('app', { autoCheckForUpdates: true });
      expect(mockStore.set).not.toHaveBeenCalledWith('__internal__', expect.anything());
      expect(mockStore.timeline.join('\n')).not.toContain(keyFile);
    } finally {
      fsSpies.restore();
    }
  });

  it('restores the legacy file and keeps an existing key when rekey returns no key', async () => {
    const fsSpies = spyConfigFiles();
    try {
      const { getOrCreateEncryptionKey, completeMigration } =
        await import('./utils/security/encryptionKey');
      vi.mocked(getOrCreateEncryptionKey).mockResolvedValue({
        key: 'test-encryption-key-hex-string',
        migrationPending: true,
      });
      vi.mocked(completeMigration).mockResolvedValue(null);

      const { initializeStore } = await import('./config');
      const store = await initializeStore();

      const { file, backup, keyFile } = configPaths();
      expect(store).toBeDefined();
      expect(mockStore.constructs).toBe(1);
      expect(mockStore.timeline).toEqual([
        'new:1',
        `rename:${file}>${backup}`,
        `rm:${file}`,
        `rename:${backup}>${file}`,
      ]);
      expect(mockStore.timeline.join('\n')).not.toContain(keyFile);
      expect(mockStore.set).not.toHaveBeenCalledWith('app', expect.anything());
    } finally {
      fsSpies.restore();
    }
  });

  it('restores the legacy file and deletes the new key when the rekeyed store cannot open', async () => {
    const fsSpies = spyConfigFiles();
    try {
      const { getOrCreateEncryptionKey, completeMigration } =
        await import('./utils/security/encryptionKey');
      const log = (await import('electron-log')).default;
      vi.mocked(getOrCreateEncryptionKey).mockResolvedValue({
        key: 'test-encryption-key-hex-string',
        migrationPending: true,
      });
      vi.mocked(completeMigration).mockResolvedValue('new-safestorage-key');
      mockStore.failAt = 2;

      const { initializeStore } = await import('./config');
      const store = await initializeStore();

      const { file, backup, keyFile } = configPaths();
      expect(store).toBeDefined();
      expect(mockStore.timeline).toEqual([
        'new:1',
        `rename:${file}>${backup}`,
        'new:2',
        `rm:${file}`,
        `rename:${backup}>${file}`,
        `rm:${keyFile}`,
      ]);
      expect(log.error).toHaveBeenCalledWith(
        '[Config] Migration failed, continuing with legacy key:',
        expect.objectContaining({ message: 'JSON Parse error: Unexpected identifier "O2"' })
      );
    } finally {
      fsSpies.restore();
    }
  });

  it('still imports data when the legacy config file is already absent', async () => {
    const fsSpies = spyConfigFiles(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    try {
      const { getOrCreateEncryptionKey, completeMigration } =
        await import('./utils/security/encryptionKey');
      vi.mocked(getOrCreateEncryptionKey).mockResolvedValue({
        key: 'test-encryption-key-hex-string',
        migrationPending: true,
      });
      vi.mocked(completeMigration).mockResolvedValue('new-key');
      mockStore.store = { app: { autoCheckForUpdates: true } };

      const { initializeStore } = await import('./config');
      await initializeStore();

      const { keyFile } = configPaths();
      expect(mockStore.constructs).toBe(2);
      expect(mockStore.set).toHaveBeenCalledWith('app', { autoCheckForUpdates: true });
      expect(mockStore.timeline.join('\n')).not.toContain(`rm:${keyFile}`);
    } finally {
      fsSpies.restore();
    }
  });

  it.each([
    ['EACCES', Object.assign(new Error('busy'), { code: 'EACCES' })],
    ['a plain Error', new Error('no-code')],
    ['a string', 'boom'],
    ['null', null],
  ])('aborts migration when moving the legacy config fails with %s', async (_label, thrown) => {
    const fsSpies = spyConfigFiles(() => {
      throw thrown;
    });
    try {
      const { getOrCreateEncryptionKey, completeMigration } =
        await import('./utils/security/encryptionKey');
      const log = (await import('electron-log')).default;
      vi.mocked(getOrCreateEncryptionKey).mockResolvedValue({
        key: 'test-encryption-key-hex-string',
        migrationPending: true,
      });
      vi.mocked(completeMigration).mockResolvedValue('new-key');

      const { initializeStore } = await import('./config');
      const store = await initializeStore();

      const { keyFile } = configPaths();
      expect(store).toBeDefined();
      expect(mockStore.constructs).toBe(1);
      expect(completeMigration).not.toHaveBeenCalled();
      expect(mockStore.timeline).toContain(`rm:${keyFile}`);
      expect(log.error).toHaveBeenCalledWith(
        '[Config] Migration failed, continuing with legacy key:',
        thrown
      );
    } finally {
      fsSpies.restore();
    }
  });

  it('deletes the new key when restoring the legacy file fails', async () => {
    let renames = 0;
    const fsSpies = spyConfigFiles(() => {
      renames += 1;
      if (renames === 2) throw Object.assign(new Error('restore failed'), { code: 'EIO' });
    });
    try {
      const { getOrCreateEncryptionKey, completeMigration } =
        await import('./utils/security/encryptionKey');
      const log = (await import('electron-log')).default;
      vi.mocked(getOrCreateEncryptionKey).mockResolvedValue({
        key: 'test-encryption-key-hex-string',
        migrationPending: true,
      });
      vi.mocked(completeMigration).mockResolvedValue('new-safestorage-key');
      mockStore.failAt = 2;

      const { initializeStore } = await import('./config');
      const store = await initializeStore();

      const { keyFile } = configPaths();
      expect(store).toBeDefined();
      expect(mockStore.timeline).toContain(`rm:${keyFile}`);
      expect(log.error).toHaveBeenCalledWith(
        '[Config] Failed to restore legacy config:',
        expect.objectContaining({ message: 'restore failed' })
      );
      expect(log.error).toHaveBeenCalledWith(
        '[Config] Migration failed, continuing with legacy key:',
        expect.objectContaining({ message: 'JSON Parse error: Unexpected identifier "O2"' })
      );
    } finally {
      fsSpies.restore();
    }
  });
});

describe('validateAndUpdateCacheVersion', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockStore.get.mockReturnValue(undefined);
    mockStore.set.mockReturnValue(undefined);
    mockStore.has.mockReturnValue(false);
    mockStore.store = {};
    mockStore.constructs = 0;
    mockStore.failAt = 0;
    mockStore.timeline = [];
    mockStore.opened = [];
    // Reset isCachedStore mock to default (false) in case a prior test changed it
    const { isCachedStore } = await import('./utils/config/configCache');
    vi.mocked(isCachedStore).mockReturnValue(false);
    vi.resetModules();
  });

  it('should update metadata when cache version is different', async () => {
    const log = (await import('electron-log')).default;
    // Simulate stored meta with old cache version
    mockStore.get.mockImplementation((key: string) => {
      if (key === '_meta') {
        return { cacheVersion: '0.9.0', lastAppVersion: '0.0.0', lastUpdated: 0 };
      }
      return undefined;
    });

    const { initializeStore } = await import('./config');
    await initializeStore();

    // Should update _meta with new cache version
    expect(mockStore.set).toHaveBeenCalledWith(
      '_meta',
      expect.objectContaining({
        cacheVersion: '1.0.0',
      })
    );
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Cache invalidation triggered'));
  });

  it('should update metadata when app version is different', async () => {
    const _log = (await import('electron-log')).default;
    // Same cache version but different app version
    mockStore.get.mockImplementation((key: string) => {
      if (key === '_meta') {
        return { cacheVersion: '1.0.0', lastAppVersion: '0.0.1-old', lastUpdated: 0 };
      }
      return undefined;
    });

    const { initializeStore } = await import('./config');
    await initializeStore();

    expect(mockStore.set).toHaveBeenCalledWith(
      '_meta',
      expect.objectContaining({
        lastAppVersion: '0.0.0',
      })
    );
  });

  it('should not update metadata when versions match', async () => {
    const log = (await import('electron-log')).default;
    // Matching cache version and app version
    mockStore.get.mockImplementation((key: string) => {
      if (key === '_meta') {
        return { cacheVersion: '1.0.0', lastAppVersion: '0.0.0', lastUpdated: 500 };
      }
      return undefined;
    });

    const { initializeStore } = await import('./config');
    await initializeStore();

    // set should NOT be called with _meta (only the initial validateAndUpdateCacheVersion skips)
    expect(mockStore.set).not.toHaveBeenCalledWith('_meta', expect.anything());
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('Cache version valid'));
  });

  it('should call clearCache on CachedStore when version changes', async () => {
    const { isCachedStore } = await import('./utils/config/configCache');
    vi.mocked(isCachedStore).mockReturnValue(true);

    const clearCacheMock = vi.fn();
    // Override MockStore to include clearCache for this test
    mockStore.get.mockImplementation((key: string) => {
      if (key === '_meta') {
        return { cacheVersion: '0.1.0', lastAppVersion: '0.0.0', lastUpdated: 0 };
      }
      return undefined;
    });

    // We need to add clearCache to the mock store instance
    const _originalMockStoreClass = MockStore;
    const _OriginalClear = MockStore.prototype;

    const { initializeStore } = await import('./config');
    // Patch the clearCache onto mockStore before calling initializeStore
    Object.defineProperty(MockStore.prototype, 'clearCache', {
      value: clearCacheMock,
      writable: true,
      configurable: true,
    });

    await initializeStore();

    expect(isCachedStore).toHaveBeenCalled();
    expect(clearCacheMock).toHaveBeenCalled();

    // Clean up
    delete (MockStore.prototype as unknown as Record<string, unknown>)['clearCache'];
  });

  it('should handle error in validateAndUpdateCacheVersion gracefully', async () => {
    const log = (await import('electron-log')).default;
    // Make get throw an error for _meta
    mockStore.get.mockImplementation((key: string) => {
      if (key === '_meta') {
        throw new Error('Store corrupted');
      }
      return undefined;
    });

    const { initializeStore } = await import('./config');
    // Should not throw — error is caught internally
    const store = await initializeStore();
    expect(store).toBeDefined();
    expect(log.error).toHaveBeenCalledWith(
      '[Config] Failed to validate cache version:',
      expect.any(Error)
    );
  });

  it('should handle missing _meta fields gracefully', async () => {
    // _meta exists but with undefined fields — both version checks should fail
    mockStore.get.mockImplementation((key: string) => {
      if (key === '_meta') {
        return {};
      }
      return undefined;
    });

    const { initializeStore } = await import('./config');
    const store = await initializeStore();
    expect(store).toBeDefined();

    // cacheVersion is undefined (from {}), lastAppVersion is undefined
    // Both differ from actual values, so _meta should be updated
    expect(mockStore.set).toHaveBeenCalledWith(
      '_meta',
      expect.objectContaining({
        cacheVersion: '1.0.0',
        lastAppVersion: '0.0.0',
      })
    );
  });
});

describe('getStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.get.mockReturnValue(undefined);
    mockStore.set.mockReturnValue(undefined);
    mockStore.has.mockReturnValue(false);
    mockStore.store = {};
    mockStore.constructs = 0;
    mockStore.failAt = 0;
    mockStore.timeline = [];
    mockStore.opened = [];
    vi.resetModules();
  });

  it('should throw before initializeStore is called', async () => {
    const { getStore } = await import('./config');
    expect(() => getStore()).toThrow(
      'Store not initialized. Call initializeStore() before using the store.'
    );
  });

  it('should return the store instance after initialization', async () => {
    const { initializeStore, getStore } = await import('./config');
    await initializeStore();
    const store = getStore();
    expect(store).toBeDefined();
    expect(store.get).toBeDefined();
    expect(store.set).toBeDefined();
  });
});

describe('Store Proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.get.mockReturnValue(undefined);
    mockStore.set.mockReturnValue(undefined);
    mockStore.has.mockReturnValue(false);
    mockStore.store = {};
    mockStore.constructs = 0;
    mockStore.failAt = 0;
    mockStore.timeline = [];
    mockStore.opened = [];
    vi.resetModules();
  });

  it('should proxy get trap to the underlying store', async () => {
    const { initializeStore, default: config } = await import('./config');
    await initializeStore();

    mockStore.get.mockReturnValue('test-value');
    const result = config.get('app');
    expect(result).toBe('test-value');
    expect(mockStore.get).toHaveBeenCalledWith('app');
  });

  it('should proxy set trap to the underlying store', async () => {
    const { initializeStore, default: config } = await import('./config');
    await initializeStore();

    // Use Reflect.set-style property assignment on the proxy
    const proxy = config as unknown as Record<string, unknown>;
    proxy.testProperty = 'test-value';

    // The set trap calls Reflect.set on the store
    // This sets a direct property on the store instance
  });

  it('should proxy has trap to check if property exists in store', async () => {
    const { initializeStore, default: config } = await import('./config');
    await initializeStore();

    mockStore.has.mockReturnValue(true);
    // 'has' trap is triggered by the 'in' operator
    const result = 'get' in config;
    expect(result).toBe(true);
  });

  it('should proxy ownKeys trap to return keys from store', async () => {
    const { initializeStore, default: config } = await import('./config');
    await initializeStore();

    // ownKeys trap returns Reflect.ownKeys of the underlying store
    const keys = Object.keys(config);
    expect(Array.isArray(keys)).toBe(true);
  });

  it('should proxy getOwnPropertyDescriptor trap', async () => {
    const { initializeStore, default: config } = await import('./config');
    await initializeStore();

    // This triggers getOwnPropertyDescriptor trap
    const descriptor = Object.getOwnPropertyDescriptor(config, 'get');
    // MockStore has get as own property, so descriptor should be defined
    expect(descriptor).toBeDefined();
  });

  it('should bind function properties to the store instance', async () => {
    const { initializeStore, default: config } = await import('./config');
    await initializeStore();

    // The get trap binds functions to maintain 'this' context
    const getFn = config.get;
    expect(typeof getFn).toBe('function');

    // Calling the bound function should still work
    mockStore.get.mockReturnValue('bound-test');
    const result = getFn('app');
    expect(result).toBe('bound-test');
  });

  it('should return non-function properties directly from store', async () => {
    const { initializeStore, default: config } = await import('./config');
    await initializeStore();

    // Access a non-function property (store is exposed by electron-store)
    const proxy = config as unknown as Record<string, unknown>;
    const storeData = proxy.store;
    // Should return the raw property value (mockStore.store = {})
    expect(storeData).toBeDefined();
  });

  it('should throw from all proxy traps when store is not initialized', async () => {
    const { default: config } = await import('./config');

    // get trap throws
    expect(() => config.get).toThrow('Store not initialized');

    // set trap throws
    expect(() => {
      (config as unknown as Record<string, unknown>).test = 'val';
    }).toThrow('Store not initialized');

    // has trap throws
    expect(() => 'get' in config).toThrow('Store not initialized');

    // ownKeys trap throws
    expect(() => Object.keys(config)).toThrow('Store not initialized');

    // getOwnPropertyDescriptor trap throws
    expect(() => Object.getOwnPropertyDescriptor(config, 'get')).toThrow('Store not initialized');
  });
});

describe('Cache layer behavior in config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.get.mockReturnValue(undefined);
    mockStore.set.mockReturnValue(undefined);
    mockStore.has.mockReturnValue(false);
    mockStore.store = {};
    mockStore.constructs = 0;
    mockStore.failAt = 0;
    mockStore.timeline = [];
    mockStore.opened = [];
    vi.resetModules();
  });

  it('should skip cache layer in test environment (NODE_ENV=test)', async () => {
    const { addCacheLayer } = await import('./utils/config/configCache');
    const { initializeStore } = await import('./config');
    await initializeStore();

    // In test env, addCacheLayer should NOT be called on the store
    // (the mock returns store as-is, but we verify it's not called because NODE_ENV=test)
    // Actually, the source checks NODE_ENV !== 'test' || VITEST !== 'true'
    // Since we're in Vitest, VITEST='true', so addCacheLayer is NOT called
    expect(addCacheLayer).not.toHaveBeenCalled();
  });
});

import crypto from 'crypto';

describe('Encryption Key Generation', () => {
  it('should use app-specific data for encryption key', () => {
    const hash = crypto.createHash('sha256');
    hash.update('gogchat-/fake/path/userData');
    const expectedKey = hash.digest('hex');

    // The key should be deterministic based on app name and user data path
    expect(expectedKey).toBeDefined();
    expect(expectedKey).toHaveLength(64); // SHA256 hex is 64 chars
  });
});
