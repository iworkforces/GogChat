/**
 * Crash recovery for the legacy-config rekey.
 * These tests use a real directory. config.test.ts mocks node:fs.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreType } from '../../../shared/types/config.js';

const h = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', () => ({
  app: {
    getName: () => 'GogChat',
    getAppPath: () => '/app',
    getPath: (name: string) => (name === 'userData' ? h.dir : join(h.dir, name)),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('unexpected ciphertext');
      return text.slice(4);
    },
  },
}));

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { safeStorage } from 'electron';
import Store from 'electron-store';
import { recoverRekey, rekeyConfigStore } from './rekeyConfigStore.js';

function write(name: string, contents: string | Buffer): void {
  writeFileSync(join(h.dir, name), contents);
}

function read(name: string): string {
  return readFileSync(join(h.dir, name), 'utf8');
}

function has(name: string): boolean {
  return existsSync(join(h.dir, name));
}

describe('rekeyConfigStore recovery', () => {
  beforeEach(() => {
    h.dir = mkdtempSync(join(tmpdir(), 'gogchat-rekey-'));
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
  });

  afterEach(() => {
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('re-encrypts the live config and leaves no side files', async () => {
    const legacy = new Store<StoreType>({
      cwd: h.dir,
      name: 'config',
      encryptionKey: 'legacy-key',
      clearInvalidConfig: true,
    });
    legacy.set('app', { autoCheckForUpdates: false });

    const next = await rekeyConfigStore(legacy);
    expect(next?.path).toBe(join(h.dir, 'config.json'));
    expect(next?.get('app')).toEqual(expect.objectContaining({ autoCheckForUpdates: false }));

    const hex = safeStorage.decryptString(readFileSync(join(h.dir, 'encryption-key.enc')));
    const opened = new Store<StoreType>({
      cwd: h.dir,
      name: 'config',
      encryptionKey: hex,
      clearInvalidConfig: true,
    });
    expect(opened.get('app')).toEqual(expect.objectContaining({ autoCheckForUpdates: false }));
    expect(has('config.json.bak')).toBe(false);
    expect(has('rekey.step')).toBe(false);
    expect(has('encryption-key.enc.new')).toBe(false);
    expect(has('config.rekey.json')).toBe(false);
  });

  it('does not move the config when SafeStorage is unavailable', async () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);
    write('config.json', 'legacy');
    const legacy = {
      store: { app: { autoCheckForUpdates: true } },
    } as Store<StoreType>;

    const next = await rekeyConfigStore(legacy);

    expect(next).toBeNull();
    expect(read('config.json')).toBe('legacy');
    expect(has('encryption-key.enc')).toBe(false);
    expect(has('config.json.bak')).toBe(false);
  });

  it('restores a bak left beside a key when there is no journal', () => {
    write('config.json.bak', 'legacy');
    write('encryption-key.enc', 'new-key');

    recoverRekey(h.dir);

    expect(read('config.json')).toBe('legacy');
    expect(has('config.json.bak')).toBe(false);
    expect(has('encryption-key.enc')).toBe(false);
  });

  it('drops side files from a prepared journal and keeps the live config', () => {
    write('config.json', 'legacy');
    write('rekey.step', 'prepared');
    write('encryption-key.enc.new', 'staged');
    write('config.rekey.json', 'staged-config');

    recoverRekey(h.dir);

    expect(read('config.json')).toBe('legacy');
    expect(has('rekey.step')).toBe(false);
    expect(has('encryption-key.enc.new')).toBe(false);
    expect(has('config.rekey.json')).toBe(false);
    expect(has('encryption-key.enc')).toBe(false);
  });

  it('puts the live file back when prepared died after the rename', () => {
    write('config.json.bak', 'legacy');
    write('rekey.step', 'prepared');
    write('encryption-key.enc.new', 'staged');
    write('config.rekey.json', 'staged-config');
    write('encryption-key.enc', 'too-early');

    recoverRekey(h.dir);

    expect(read('config.json')).toBe('legacy');
    expect(has('config.json.bak')).toBe(false);
    expect(has('encryption-key.enc')).toBe(false);
    expect(has('encryption-key.enc.new')).toBe(false);
    expect(has('config.rekey.json')).toBe(false);
  });

  it('finishes an aside commit when the staged config and key are both present', () => {
    write('config.json.bak', 'legacy');
    write('rekey.step', 'aside');
    write('config.rekey.json', 'new-config');
    write('encryption-key.enc.new', 'new-key');

    recoverRekey(h.dir);

    expect(read('config.json')).toBe('new-config');
    expect(read('encryption-key.enc')).toBe('new-key');
    expect(has('config.json.bak')).toBe(false);
    expect(has('rekey.step')).toBe(false);
    expect(has('config.rekey.json')).toBe(false);
    expect(has('encryption-key.enc.new')).toBe(false);
  });

  it('finishes the key install when aside already replaced the config', () => {
    write('config.json', 'new-config');
    write('config.json.bak', 'legacy');
    write('rekey.step', 'aside');
    write('encryption-key.enc.new', 'new-key');

    recoverRekey(h.dir);

    expect(read('config.json')).toBe('new-config');
    expect(read('encryption-key.enc')).toBe('new-key');
    expect(has('config.json.bak')).toBe(false);
  });

  it('finishes the key install when the journal is already installed', () => {
    write('config.json', 'new-config');
    write('config.json.bak', 'legacy');
    write('rekey.step', 'installed');
    write('encryption-key.enc.new', 'new-key');

    recoverRekey(h.dir);

    expect(read('config.json')).toBe('new-config');
    expect(read('encryption-key.enc')).toBe('new-key');
    expect(has('config.json.bak')).toBe(false);
    expect(has('rekey.step')).toBe(false);
    expect(has('encryption-key.enc.new')).toBe(false);
  });

  it('restores the bak when installed has no staged key', () => {
    write('config.json', 'partial');
    write('config.json.bak', 'legacy');
    write('rekey.step', 'installed');
    write('encryption-key.enc', 'new-key');

    recoverRekey(h.dir);

    expect(read('config.json')).toBe('legacy');
    expect(has('encryption-key.enc')).toBe(false);
    expect(has('config.json.bak')).toBe(false);
    expect(has('rekey.step')).toBe(false);
  });

  it('keeps the new config when installed has no bak and no staged key', () => {
    write('config.json', 'new-config');
    write('encryption-key.enc', 'new-key');
    write('rekey.step', 'installed');

    recoverRekey(h.dir);

    expect(read('config.json')).toBe('new-config');
    expect(read('encryption-key.enc')).toBe('new-key');
    expect(has('rekey.step')).toBe(false);
  });

  it('deletes only the bak after a keyed commit', () => {
    write('config.json', 'new-config');
    write('config.json.bak', 'legacy');
    write('encryption-key.enc', 'new-key');
    write('rekey.step', 'keyed');

    recoverRekey(h.dir);

    expect(read('config.json')).toBe('new-config');
    expect(read('encryption-key.enc')).toBe('new-key');
    expect(has('config.json.bak')).toBe(false);
    expect(has('rekey.step')).toBe(false);
  });

  it('deletes a leftover bak when the commit already finished without a journal', () => {
    write('config.json', 'new-config');
    write('config.json.bak', 'legacy');
    write('encryption-key.enc', 'new-key');

    recoverRekey(h.dir);

    expect(read('config.json')).toBe('new-config');
    expect(read('encryption-key.enc')).toBe('new-key');
    expect(has('config.json.bak')).toBe(false);
  });

  it('drops staged files from a crash before the journal and leaves the live config', () => {
    write('config.json', 'legacy');
    write('encryption-key.enc.new', 'staged');
    write('config.rekey.json', 'staged-config');

    recoverRekey(h.dir);

    expect(read('config.json')).toBe('legacy');
    expect(has('encryption-key.enc.new')).toBe(false);
    expect(has('config.rekey.json')).toBe(false);
    expect(has('encryption-key.enc')).toBe(false);
  });
});
