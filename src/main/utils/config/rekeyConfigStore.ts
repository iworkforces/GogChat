/**
 * Re-encrypt a legacy config under the SafeStorage key.
 *
 * The new key and the new ciphertext are written beside the live files.
 * A journal names the commit step. Startup calls {@link recoverRekey}
 * before the store opens, so a kill mid-commit cannot leave the new key
 * beside legacy ciphertext. `clearInvalidConfig` would otherwise replace
 * that file with defaults and drop every setting.
 *
 * @module rekeyConfigStore
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, safeStorage } from 'electron';
import log from 'electron-log';
import Store from 'electron-store';
import type { StoreType } from '../../../shared/types/config.js';
import { asType } from '../../../shared/typeUtils.js';
import { schema } from './configSchema.js';

const CONFIG_NAME = 'config.json';
const LIVE_STORE_NAME = 'config';
const REKEY_STORE_NAME = 'config.rekey';
const REKEY_FILE_NAME = 'config.rekey.json';
const KEY_NAME = 'encryption-key.enc';
const KEY_STAGED_NAME = 'encryption-key.enc.new';
const JOURNAL_NAME = 'rekey.step';

type RekeyStep = 'prepared' | 'aside' | 'installed' | 'keyed';

interface RekeyPaths {
  file: string;
  backup: string;
  rekey: string;
  key: string;
  keyStaged: string;
  journal: string;
}

function isEnoent(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return error.code === 'ENOENT';
}

function openEncryptedStore(
  directory: string,
  name: string,
  encryptionKey: string
): Store<StoreType> {
  return new Store<StoreType>({
    cwd: directory,
    name,
    schema,
    encryptionKey,
    clearInvalidConfig: true,
  });
}

function rekeyPaths(directory: string): RekeyPaths {
  const file = path.join(directory, CONFIG_NAME);
  return {
    file,
    backup: `${file}.bak`,
    rekey: path.join(directory, REKEY_FILE_NAME),
    key: path.join(directory, KEY_NAME),
    keyStaged: path.join(directory, KEY_STAGED_NAME),
    journal: path.join(directory, JOURNAL_NAME),
  };
}

function exists(file: string): boolean {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function remove(file: string): void {
  fs.rmSync(file, { force: true });
}

/** Replace `file` with `backup`. Removes `file` first so Windows rename can replace it. */
function restoreBackup(file: string, backup: string): void {
  fs.rmSync(file, { force: true });
  fs.renameSync(backup, file);
}

function writeJournal(journal: string, step: RekeyStep): void {
  fs.writeFileSync(journal, step, 'utf8');
}

function readJournal(journal: string): RekeyStep | null {
  try {
    const text = fs.readFileSync(journal, 'utf8').trim();
    if (text === 'prepared' || text === 'aside' || text === 'installed' || text === 'keyed') {
      return text;
    }
    return null;
  } catch {
    return null;
  }
}

function dropSideFiles(paths: RekeyPaths): void {
  remove(paths.keyStaged);
  remove(paths.rekey);
  remove(paths.journal);
}

/**
 * Finish a commit that already moved the legacy file aside.
 * Installs the new ciphertext and then the new key. The key is last so a
 * kill before that rename still has no live key next to a partial config.
 */
function finishCommit(paths: RekeyPaths): void {
  if (!exists(paths.file) && exists(paths.rekey)) {
    fs.renameSync(paths.rekey, paths.file);
    writeJournal(paths.journal, 'installed');
  }
  if (exists(paths.keyStaged) && !exists(paths.key)) {
    fs.renameSync(paths.keyStaged, paths.key);
    writeJournal(paths.journal, 'keyed');
  }
  remove(paths.backup);
  remove(paths.rekey);
  remove(paths.keyStaged);
  remove(paths.journal);
}

/**
 * Repair a commit that stopped between renames.
 * Called before the encrypted store is constructed.
 */
export function recoverRekey(directory = app.getPath('userData')): void {
  try {
    const paths = rekeyPaths(directory);
    const step = readJournal(paths.journal);
    if (step === 'prepared') {
      // The live file may already be the bak if we died before the aside mark.
      if (!exists(paths.file) && exists(paths.backup)) {
        restoreBackup(paths.file, paths.backup);
        remove(paths.key);
      }
      dropSideFiles(paths);
      return;
    }
    if (step === 'aside') {
      const configInstalled = exists(paths.file) && !exists(paths.rekey);
      const configStaged = !exists(paths.file) && exists(paths.rekey);
      if (exists(paths.keyStaged) && (configInstalled || configStaged)) {
        finishCommit(paths);
        return;
      }
      if (!exists(paths.file) && exists(paths.backup)) restoreBackup(paths.file, paths.backup);
      remove(paths.key);
      dropSideFiles(paths);
      return;
    }
    if (step === 'installed') {
      if (exists(paths.keyStaged)) {
        finishCommit(paths);
        return;
      }
      // No staged key. A bak is still the legacy ciphertext, so put it back.
      // If the bak is already gone, keep the new config and the live key.
      if (exists(paths.backup)) {
        restoreBackup(paths.file, paths.backup);
        remove(paths.key);
      }
      dropSideFiles(paths);
      return;
    }
    if (step === 'keyed') {
      remove(paths.backup);
      dropSideFiles(paths);
      return;
    }
    // No journal. A missing live file plus a bak is an interrupted rename.
    // Drop the key too: the bak is still the legacy ciphertext.
    if (!exists(paths.file) && exists(paths.backup)) {
      restoreBackup(paths.file, paths.backup);
      remove(paths.key);
    } else if (
      exists(paths.file) &&
      exists(paths.key) &&
      exists(paths.backup) &&
      !exists(paths.keyStaged) &&
      !exists(paths.rekey)
    ) {
      remove(paths.backup);
    }
    remove(paths.keyStaged);
    remove(paths.rekey);
  } catch (error: unknown) {
    log.error('[Config] Failed to restore legacy config:', error);
  }
}

function rollback(paths: RekeyPaths): void {
  // The new key is already live. Leave the files for recoverRekey.
  if (exists(paths.key)) return;
  try {
    const step = readJournal(paths.journal);
    const shouldRestore =
      exists(paths.backup) &&
      (step === 'aside' || step === 'installed' || (step === null && !exists(paths.file)));
    if (shouldRestore) restoreBackup(paths.file, paths.backup);
  } finally {
    dropSideFiles(paths);
  }
}

export function rekeyConfigStore(store: Store<StoreType>): Store<StoreType> | null {
  log.info('[Config] Starting migration from legacy to SafeStorage encryption');
  if (!safeStorage.isEncryptionAvailable()) return null;

  const directory = app.getPath('userData');
  const paths = rekeyPaths(directory);
  if (exists(paths.key)) return null;

  const saved = { ...store.store };
  try {
    const newKey = randomBytes(32).toString('hex');
    fs.writeFileSync(paths.keyStaged, safeStorage.encryptString(newKey));

    const next = openEncryptedStore(directory, REKEY_STORE_NAME, newKey);
    for (const [key, value] of Object.entries(saved)) {
      // Conf reserves __internal__ and throws if a caller sets it.
      if (key === '__internal__') continue;
      next.set(asType<keyof StoreType>(key), value);
    }

    writeJournal(paths.journal, 'prepared');
    if (exists(paths.file)) {
      // A leftover bak makes Windows rename fail with EEXIST.
      remove(paths.backup);
      try {
        fs.renameSync(paths.file, paths.backup);
      } catch (error: unknown) {
        if (!isEnoent(error)) throw error;
      }
    }
    writeJournal(paths.journal, 'aside');
    fs.renameSync(paths.rekey, paths.file);
    writeJournal(paths.journal, 'installed');
    fs.renameSync(paths.keyStaged, paths.key);
    try {
      writeJournal(paths.journal, 'keyed');
      remove(paths.backup);
      remove(paths.journal);
    } catch (error: unknown) {
      // The new key is already installed. recoverRekey finishes cleanup.
      log.error('[Config] Failed to finish encryption migration cleanup:', error);
    }
    log.info('[Config] Migration to SafeStorage encryption complete');
    // `next` still addresses config.rekey.json, which this commit just renamed away.
    return openEncryptedStore(directory, LIVE_STORE_NAME, newKey);
  } catch (error: unknown) {
    try {
      rollback(paths);
    } catch (restoreError: unknown) {
      log.error('[Config] Failed to restore legacy config:', restoreError);
    }
    throw error;
  }
}
