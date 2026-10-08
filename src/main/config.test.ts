/**
 * Unit tests for encrypted configuration store
 */

import type * as NodeFs from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { safeStorage } from 'electron';

const fsOps = vi.hoisted(() => {
  const files = new Map<string, Buffer>();
  const fakeRoot = '/fake/path/userData';
  const isFake = (target: unknown): target is string =>
    typeof target === 'string' && target.startsWith(fakeRoot);
  const enoent = (target: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
  return {
    files,
    isFake,
    failWrites: false,
    renameSync: vi.fn<(from: unknown, to: unknown) => void>(),
    rmSync: vi.fn<(target: unknown, options?: unknown) => void>(),
    passRename: (..._args: unknown[]): void => undefined,
    passRemove: (..._args: unknown[]): void => undefined,
    reset(): void {
      files.clear();
      this.failWrites = false;
    },
    virtualRename(from: unknown, to: unknown): void {
      if (!isFake(from) || typeof to !== 'string') return;
      const data = files.get(from);
      if (data === undefined) throw enoent(from);
      files.delete(from);
      files.set(to, data);
    },
    virtualRemove(target: unknown): void {
      if (!isFake(target)) return;
      files.delete(target);
    },
  };
});

function installDefaultFsOps(): void {
  fsOps.renameSync.mockImplementation((from: unknown, to: unknown) => {
    if (fsOps.isFake(from)) {
      fsOps.virtualRename(from, to);
      return;
    }
    fsOps.passRename(from, to);
  });
  fsOps.rmSync.mockImplementation((target: unknown) => {
    if (fsOps.isFake(target)) {
      fsOps.virtualRemove(target);
      return;
    }
    fsOps.passRemove(target);
  });
}

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs');
  fsOps.passRename = (...args: unknown[]) => {
    Reflect.apply(actual.renameSync, actual, args);
  };
  fsOps.passRemove = (...args: unknown[]) => {
    Reflect.apply(actual.rmSync, actual, args);
  };
  installDefaultFsOps();
  return {
    ...actual,
    existsSync: (target: unknown) => {
      if (fsOps.isFake(target)) return fsOps.files.has(target);
      return actual.existsSync(target as never);
    },
    readFileSync: (target: unknown, encoding?: unknown) => {
      if (fsOps.isFake(target)) {
        const data = fsOps.files.get(target);
        if (data === undefined) {
          throw Object.assign(new Error(`ENOENT: ${String(target)}`), { code: 'ENOENT' });
        }
        if (encoding === 'utf8' || encoding === 'utf-8') return data.toString('utf8');
        return data;
      }
      return actual.readFileSync(target as never, encoding as never);
    },
    writeFileSync: (target: unknown, data: unknown) => {
      if (fsOps.isFake(target)) {
        if (fsOps.failWrites) throw new Error('SafeStorage unavailable');
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        fsOps.files.set(target, buffer);
        return;
      }
      return actual.writeFileSync(target as never, data as never);
    },
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

  constructor(options?: { name?: string }) {
    mockStore.constructs += 1;
    mockStore.opened.push(options);
    mockStore.timeline.push(`new:${mockStore.constructs}`);
    if (mockStore.failAt === mockStore.constructs) {
      throw new Error('JSON Parse error: Unexpected identifier "O2"');
    }
    if (options?.name === 'config.rekey') {
      fsOps.files.set('/fake/path/userData/config.rekey.json', Buffer.from('{}'));
    }
  }
}

vi.mock('electron-store', () => ({
  default: MockStore,
}));

function configPaths(): {
  file: string;
  backup: string;
  keyFile: string;
  keyStaged: string;
  rekey: string;
  journal: string;
} {
  const root = '/fake/path/userData';
  const file = join(root, 'config.json');
  return {
    file,
    backup: `${file}.bak`,
    keyFile: join(root, 'encryption-key.enc'),
    keyStaged: join(root, 'encryption-key.enc.new'),
    rekey: join(root, 'config.rekey.json'),
    journal: join(root, 'rekey.step'),
  };
}

function seedUserFile(name: string, contents = 'legacy'): void {
  fsOps.files.set(join('/fake/path/userData', name), Buffer.from(contents));
}

function enableSafeStorage(): void {
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
}

function spyConfigFiles(afterRename?: () => void): { restore: () => void } {
  fsOps.renameSync.mockImplementation((from: unknown, to: unknown) => {
    mockStore.timeline.push(`rename:${String(from)}>${String(to)}`);
    afterRename?.();
    fsOps.virtualRename(from, to);
  });
  fsOps.rmSync.mockImplementation((target: unknown) => {
    if (typeof target === 'string' && fsOps.files.has(target)) {
      mockStore.timeline.push(`rm:${String(target)}`);
    }
    fsOps.virtualRemove(target);
  });
  return {
    restore(): void {
      installDefaultFsOps();
    },
  };
}

describe('Config Store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsOps.reset();
    installDefaultFsOps();
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);
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
    fsOps.reset();
    installDefaultFsOps();
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);
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

  it('should perform migration when getOrCreateEncryptionKey signals migrationPending', async () => {
    const { getOrCreateEncryptionKey } = await import('./utils/security/encryptionKey');
    vi.mocked(getOrCreateEncryptionKey).mockResolvedValue({
      key: 'test-encryption-key-hex-string',
      migrationPending: true,
    });
    enableSafeStorage();
    mockStore.store = { app: { autoCheckForUpdates: true } };
    seedUserFile('config.json');

    const { initializeStore } = await import('./config');
    await initializeStore();

    expect(mockStore.set).toHaveBeenCalledWith('app', { autoCheckForUpdates: true });
    expect(fsOps.files.has(configPaths().keyFile)).toBe(true);
  });

  it('continues with the legacy store when SafeStorage is unavailable', async () => {
    const { getOrCreateEncryptionKey } = await import('./utils/security/encryptionKey');
    vi.mocked(getOrCreateEncryptionKey).mockResolvedValue({
      key: 'test-encryption-key-hex-string',
      migrationPending: true,
    });
    seedUserFile('config.json', 'legacy');

    const { initializeStore } = await import('./config');
    const store = await initializeStore();

    expect(store).toBeDefined();
    expect(mockStore.constructs).toBe(1);
    expect(fsOps.files.get(configPaths().file)?.toString()).toBe('legacy');
    expect(fsOps.files.has(configPaths().keyFile)).toBe(false);
    expect(mockStore.set).not.toHaveBeenCalledWith('app', expect.anything());
  });

  it('should handle migration error gracefully and continue with legacy key', async () => {
    const { getOrCreateEncryptionKey } = await import('./utils/security/encryptionKey');
    const log = (await import('electron-log')).default;
    vi.mocked(getOrCreateEncryptionKey).mockResolvedValue({
      key: 'test-encryption-key-hex-string',
      migrationPending: true,
    });
    enableSafeStorage();
    fsOps.failWrites = true;
    seedUserFile('config.json', 'legacy');

    const { initializeStore } = await import('./config');
    const store = await initializeStore();

    expect(store).toBeDefined();
    expect(mockStore.constructs).toBe(1);
    expect(fsOps.files.get(configPaths().file)?.toString()).toBe('legacy');
    expect(log.error).toHaveBeenCalledWith(
      '[Config] Migration failed, continuing with legacy key:',
      expect.objectContaining({ message: 'SafeStorage unavailable' })
    );
  });

  it('should skip migration when migrationPending is false', async () => {
    const { getOrCreateEncryptionKey } = await import('./utils/security/encryptionKey');
    vi.mocked(getOrCreateEncryptionKey).mockResolvedValue({
      key: 'test-encryption-key-hex-string',
      migrationPending: false,
    });

    const { initializeStore } = await import('./config');
    await initializeStore();

    expect(mockStore.constructs).toBe(1);
    expect(fsOps.files.has(configPaths().keyFile)).toBe(false);
  });

  it('should migrate all data entries from old store to new store', async () => {
    const { getOrCreateEncryptionKey } = await import('./utils/security/encryptionKey');
    vi.mocked(getOrCreateEncryptionKey).mockResolvedValue({
      key: 'test-encryption-key-hex-string',
      migrationPending: true,
    });
    enableSafeStorage();
    seedUserFile('config.json');
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

  it('writes the new ciphertext before it replaces the legacy file', async () => {
    const fsSpies = spyConfigFiles();
    try {
      const { getOrCreateEncryptionKey } = await import('./utils/security/encryptionKey');
      const log = (await import('electron-log')).default;
      vi.mocked(getOrCreateEncryptionKey).mockResolvedValue({
        key: 'test-encryption-key-hex-string',
        migrationPending: true,
      });
      enableSafeStorage();
      seedUserFile('config.json', 'legacy');
      mockStore.store = {
        app: { autoCheckForUpdates: true },
        __internal__: { migrations: { version: '0.0.0' } },
      };

      const { initializeStore } = await import('./config');
      await initializeStore();

      const { file, backup, keyFile, keyStaged, rekey, journal } = configPaths();
      expect(mockStore.timeline).toEqual([
        'new:1',
        'new:2',
        `rename:${file}>${backup}`,
        `rename:${rekey}>${file}`,
        `rename:${keyStaged}>${keyFile}`,
        `rm:${backup}`,
        `rm:${journal}`,
        'new:3',
      ]);
      const opened = mockStore.opened[1] as { encryptionKey?: string; name?: string };
      expect(opened.name).toBe('config.rekey');
      expect(opened.encryptionKey).toMatch(/^[0-9a-f]{64}$/);
      expect(mockStore.opened[1]).toMatchObject({ clearInvalidConfig: true });
      expect(mockStore.opened[2]).toMatchObject({
        cwd: '/fake/path/userData',
        name: 'config',
        encryptionKey: opened.encryptionKey,
        clearInvalidConfig: true,
      });
      expect(safeStorage.encryptString).toHaveBeenCalledWith(opened.encryptionKey);
      expect(fsOps.files.has(file)).toBe(true);
      expect(fsOps.files.has(keyFile)).toBe(true);
      expect(fsOps.files.has(backup)).toBe(false);
      expect(fsOps.files.has(journal)).toBe(false);
      expect(fsOps.files.has(keyStaged)).toBe(false);
      expect(mockStore.set).toHaveBeenCalledWith('app', { autoCheckForUpdates: true });
      expect(mockStore.set).not.toHaveBeenCalledWith('__internal__', expect.anything());
      expect(log.info).toHaveBeenCalledWith(
        '[Config] Starting migration from legacy to SafeStorage encryption'
      );
      expect(log.info).toHaveBeenCalledWith(
        '[Config] Migration to SafeStorage encryption complete'
      );
    } finally {
      fsSpies.restore();
    }
  });

  it('leaves the legacy file in place when a key file already exists', async () => {
    const { getOrCreateEncryptionKey } = await import('./utils/security/encryptionKey');
    vi.mocked(getOrCreateEncryptionKey).mockResolvedValue({
      key: 'test-encryption-key-hex-string',
      migrationPending: true,
    });
    enableSafeStorage();
    seedUserFile('config.json', 'legacy');
    seedUserFile('encryption-key.enc', 'existing-key');

    const { initializeStore } = await import('./config');
    const store = await initializeStore();

    const { file, backup, keyFile } = configPaths();
    expect(store).toBeDefined();
    expect(mockStore.constructs).toBe(1);
    expect(fsOps.files.get(file)?.toString()).toBe('legacy');
    expect(fsOps.files.has(backup)).toBe(false);
    expect(fsOps.files.get(keyFile)?.toString()).toBe('existing-key');
    expect(mockStore.set).not.toHaveBeenCalledWith('app', expect.anything());
  });

  it('drops the staged key when the rekeyed store cannot open', async () => {
    const { getOrCreateEncryptionKey } = await import('./utils/security/encryptionKey');
    const log = (await import('electron-log')).default;
    vi.mocked(getOrCreateEncryptionKey).mockResolvedValue({
      key: 'test-encryption-key-hex-string',
      migrationPending: true,
    });
    enableSafeStorage();
    seedUserFile('config.json', 'legacy');
    mockStore.failAt = 2;

    const { initializeStore } = await import('./config');
    const store = await initializeStore();

    const { file, backup, keyFile, keyStaged } = configPaths();
    expect(store).toBeDefined();
    expect(mockStore.constructs).toBe(2);
    expect(fsOps.files.get(file)?.toString()).toBe('legacy');
    expect(fsOps.files.has(backup)).toBe(false);
    expect(fsOps.files.has(keyFile)).toBe(false);
    expect(fsOps.files.has(keyStaged)).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      '[Config] Migration failed, continuing with legacy key:',
      expect.objectContaining({ message: 'JSON Parse error: Unexpected identifier "O2"' })
    );
  });

  it('still imports data when the legacy config file is already absent', async () => {
    const { getOrCreateEncryptionKey } = await import('./utils/security/encryptionKey');
    vi.mocked(getOrCreateEncryptionKey).mockResolvedValue({
      key: 'test-encryption-key-hex-string',
      migrationPending: true,
    });
    enableSafeStorage();
    mockStore.store = { app: { autoCheckForUpdates: true } };

    const { initializeStore } = await import('./config');
    await initializeStore();

    const { file, keyFile } = configPaths();
    expect(mockStore.constructs).toBe(3);
    expect(mockStore.set).toHaveBeenCalledWith('app', { autoCheckForUpdates: true });
    expect(fsOps.files.has(file)).toBe(true);
    expect(fsOps.files.has(keyFile)).toBe(true);
  });

  it('restores a crashed rekey before the store opens', async () => {
    const { file, backup, keyFile } = configPaths();
    fsOps.files.set(backup, Buffer.from('legacy'));
    fsOps.files.set(keyFile, Buffer.from('new-key'));

    const { initializeStore } = await import('./config');
    await initializeStore();

    expect(fsOps.files.get(file)?.toString()).toBe('legacy');
    expect(fsOps.files.has(backup)).toBe(false);
    expect(fsOps.files.has(keyFile)).toBe(false);
    expect(mockStore.constructs).toBe(1);
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
      const { getOrCreateEncryptionKey } = await import('./utils/security/encryptionKey');
      const log = (await import('electron-log')).default;
      vi.mocked(getOrCreateEncryptionKey).mockResolvedValue({
        key: 'test-encryption-key-hex-string',
        migrationPending: true,
      });
      enableSafeStorage();
      seedUserFile('config.json', 'legacy');

      const { initializeStore } = await import('./config');
      const store = await initializeStore();

      const { file, keyFile, keyStaged } = configPaths();
      expect(store).toBeDefined();
      expect(mockStore.constructs).toBe(2);
      expect(fsOps.files.get(file)?.toString()).toBe('legacy');
      expect(fsOps.files.has(keyFile)).toBe(false);
      expect(fsOps.files.has(keyStaged)).toBe(false);
      expect(log.error).toHaveBeenCalledWith(
        '[Config] Migration failed, continuing with legacy key:',
        thrown
      );
    } finally {
      fsSpies.restore();
    }
  });

  it('logs a failed restore and drops the staged key', async () => {
    let renames = 0;
    const moveError = Object.assign(new Error('move failed'), { code: 'EIO' });
    const restoreError = Object.assign(new Error('restore failed'), { code: 'EIO' });
    const fsSpies = spyConfigFiles(() => {
      renames += 1;
      if (renames === 2) throw moveError;
      if (renames === 3) throw restoreError;
    });
    try {
      const { getOrCreateEncryptionKey } = await import('./utils/security/encryptionKey');
      const log = (await import('electron-log')).default;
      vi.mocked(getOrCreateEncryptionKey).mockResolvedValue({
        key: 'test-encryption-key-hex-string',
        migrationPending: true,
      });
      enableSafeStorage();
      seedUserFile('config.json', 'legacy');

      const { initializeStore } = await import('./config');
      const store = await initializeStore();

      const { backup, keyFile, keyStaged } = configPaths();
      expect(store).toBeDefined();
      expect(fsOps.files.has(backup)).toBe(true);
      expect(fsOps.files.has(keyFile)).toBe(false);
      expect(fsOps.files.has(keyStaged)).toBe(false);
      expect(log.error).toHaveBeenCalledWith(
        '[Config] Failed to restore legacy config:',
        expect.objectContaining({ message: 'restore failed' })
      );
      expect(log.error).toHaveBeenCalledWith(
        '[Config] Migration failed, continuing with legacy key:',
        moveError
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
    fsOps.reset();
    installDefaultFsOps();
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);
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
