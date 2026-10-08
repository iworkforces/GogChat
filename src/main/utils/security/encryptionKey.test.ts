/**
 * Unit tests for encryption key management using SafeStorage
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';

// Track file system mock state
let mockFiles: Map<string, Buffer> = new Map();
let mockFilePaths: Set<string> = new Set();

// Mock electron
vi.mock('electron', () => ({
  app: {
    getName: () => 'gogchat',
    getPath: (name: string) => {
      if (name === 'userData') return '/fake/path/userData';
      return `/fake/path/${name}`;
    },
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

// Mock fs/promises module
vi.mock('node:fs/promises', () => ({
  access: vi.fn((filePath: string) => {
    if (mockFilePaths.has(filePath)) {
      return Promise.resolve();
    }
    return Promise.reject(new Error(`ENOENT: no such file or directory, access '${filePath}'`));
  }),
  readFile: vi.fn((filePath: string) => {
    if (mockFiles.has(filePath)) {
      return Promise.resolve(mockFiles.get(filePath));
    }
    return Promise.reject(new Error(`File not found: ${filePath}`));
  }),
  writeFile: vi.fn((filePath: string, data: Buffer) => {
    mockFiles.set(filePath, data);
    mockFilePaths.add(filePath);
    return Promise.resolve();
  }),
  unlink: vi.fn((filePath: string) => {
    mockFiles.delete(filePath);
    mockFilePaths.delete(filePath);
    return Promise.resolve();
  }),
}));

describe('Encryption Key Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFiles.clear();
    mockFilePaths.clear();
  });

  describe('getOrCreateEncryptionKey', () => {
    it('should return legacy key when safeStorage is unavailable', async () => {
      const { getOrCreateEncryptionKey } = await import('./encryptionKey');

      const result = await getOrCreateEncryptionKey();

      // Should compute the legacy key: SHA256('gogchat-/fake/path/userData')
      expect(result.key).toBeDefined();
      expect(result.key).toHaveLength(64); // SHA256 hex is 64 chars
      expect(result.migrationPending).toBe(false);
    });

    it('should return SafeStorage key when available and key file exists', async () => {
      // Setup: safeStorage is available
      const { safeStorage } = await import('electron');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);

      const keyFilePath = path.join('/fake/path/userData', 'encryption-key.enc');
      const encryptedKey = Buffer.from('encrypted:supersecretkey123456789012345678901234567890');
      mockFiles.set(keyFilePath, encryptedKey);
      mockFilePaths.add(keyFilePath);

      const { getOrCreateEncryptionKey } = await import('./encryptionKey');

      const result = await getOrCreateEncryptionKey();

      // Should decrypt the stored key
      expect(result.key).toBe('supersecretkey123456789012345678901234567890');
      expect(result.migrationPending).toBe(false);
    });

    it('should generate new key on fresh install when SafeStorage available', async () => {
      // Setup: safeStorage is available but no key file
      const { safeStorage } = await import('electron');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);

      const { getOrCreateEncryptionKey } = await import('./encryptionKey');

      const result = await getOrCreateEncryptionKey();

      // Should generate a new 64-char hex key (256-bit)
      expect(result.key).toBeDefined();
      expect(result.key).toHaveLength(64);
      expect(safeStorage.encryptString).toHaveBeenCalledWith(result.key);
      expect(result.migrationPending).toBe(false);
    });

    it('should store a fresh Windows SafeStorage/DPAPI-backed key for later launches', async () => {
      const { safeStorage } = await import('electron');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);

      const { getOrCreateEncryptionKey } = await import('./encryptionKey');
      const result = await getOrCreateEncryptionKey();

      const keyFilePath = path.join('/fake/path/userData', 'encryption-key.enc');
      expect(mockFiles.get(keyFilePath)?.toString()).toBe(`encrypted:${result.key}`);
      expect(result.migrationPending).toBe(false);
    });

    it('should return legacy key when config exists but no key file (migration scenario)', async () => {
      // Setup: safeStorage is available, config exists, but no key file
      const { safeStorage } = await import('electron');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);

      const configPath = path.join('/fake/path/userData', 'config.json');
      mockFiles.set(configPath, Buffer.from('{}'));
      mockFilePaths.add(configPath);

      const { getOrCreateEncryptionKey } = await import('./encryptionKey');

      const result = await getOrCreateEncryptionKey();

      // Should return legacy key for migration, with migrationPending = true
      expect(result.key).toBeDefined();
      expect(result.key).toHaveLength(64);
      expect(result.migrationPending).toBe(true);
      // Should NOT have generated a new key yet
      expect(safeStorage.encryptString).not.toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    it('should fall back to legacy key when SafeStorage decrypt fails', async () => {
      // Setup: safeStorage is available, key file exists, but decrypt fails
      const { safeStorage } = await import('electron');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
      vi.mocked(safeStorage.decryptString).mockImplementation(() => {
        throw new Error('Decryption failed');
      });

      const keyFilePath = path.join('/fake/path/userData', 'encryption-key.enc');
      mockFiles.set(keyFilePath, Buffer.from('corrupted'));
      mockFilePaths.add(keyFilePath);

      const { getOrCreateEncryptionKey } = await import('./encryptionKey');

      const result = await getOrCreateEncryptionKey();

      // Should fall back to legacy key, migration must NOT be pending
      // (SafeStorage failed — triggering migration here would corrupt data)
      expect(result.key).toBeDefined();
      expect(result.key).toHaveLength(64);
      expect(result.migrationPending).toBe(false);
    });

    it('should remove a tampered SafeStorage key before falling back to the legacy key', async () => {
      const { safeStorage } = await import('electron');
      const fs = await import('node:fs/promises');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
      vi.mocked(safeStorage.decryptString).mockImplementation(() => {
        throw new Error('DPAPI tamper detected');
      });

      const keyFilePath = path.join('/fake/path/userData', 'encryption-key.enc');
      mockFiles.set(keyFilePath, Buffer.from('tampered'));
      mockFilePaths.add(keyFilePath);

      const { getOrCreateEncryptionKey } = await import('./encryptionKey');
      const result = await getOrCreateEncryptionKey();

      expect(fs.unlink).toHaveBeenCalledWith(keyFilePath);
      expect(mockFiles.has(keyFilePath)).toBe(false);
      expect(result.key).toHaveLength(64);
      expect(result.migrationPending).toBe(false);
    });
  });
});
