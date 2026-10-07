/**
 * Re-encrypt a legacy config under the SafeStorage key.
 *
 * The legacy file is moved aside before the new store is opened. Constructing
 * that store on the old ciphertext throws or, with clearInvalidConfig, replaces
 * the file with defaults. A failed handoff restores the file and deletes the
 * key so the next launch does not wipe a config that is still on the legacy key.
 *
 * @module rekeyConfigStore
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import log from 'electron-log';
import Store from 'electron-store';
import type { StoreType } from '../../../shared/types/config.js';
import { asType } from '../../../shared/typeUtils.js';
import { completeMigration } from '../security/encryptionKey.js';
import { schema } from './configSchema.js';

const LEGACY_CONFIG_NAME = 'config.json';
const ENCRYPTION_KEY_NAME = 'encryption-key.enc';

function isEnoent(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return error.code === 'ENOENT';
}

/** Replace `file` with `backup`. Removes `file` first so Windows rename can replace it. */
function restoreBackup(file: string, backup: string): void {
  fs.rmSync(file, { force: true });
  fs.renameSync(backup, file);
}

export async function rekeyConfigStore(store: Store<StoreType>): Promise<Store<StoreType> | null> {
  log.info('[Config] Starting migration from legacy to SafeStorage encryption');
  const saved = { ...store.store };
  const directory = app.getPath('userData');
  const file = path.join(directory, LEGACY_CONFIG_NAME);
  const backup = `${file}.bak`;
  const keyFile = path.join(directory, ENCRYPTION_KEY_NAME);
  let moved = false;

  try {
    try {
      fs.renameSync(file, backup);
      moved = true;
    } catch (error: unknown) {
      if (!isEnoent(error)) throw error;
    }

    const newKey = await completeMigration();
    if (!newKey) {
      if (moved) restoreBackup(file, backup);
      return null;
    }

    const next = new Store<StoreType>({
      schema,
      encryptionKey: newKey,
      clearInvalidConfig: true,
    });
    for (const [key, value] of Object.entries(saved)) {
      // Conf reserves __internal__ and throws if a caller sets it.
      if (key === '__internal__') continue;
      next.set(asType<keyof StoreType>(key), value);
    }
    if (moved) fs.rmSync(backup, { force: true });
    log.info('[Config] Migration to SafeStorage encryption complete');
    return next;
  } catch (error: unknown) {
    try {
      if (moved) restoreBackup(file, backup);
    } catch (restoreError: unknown) {
      log.error('[Config] Failed to restore legacy config:', restoreError);
    } finally {
      // completeMigration may already have written this. Leaving it beside the
      // restored legacy file makes the next launch clear the whole config.
      fs.rmSync(keyFile, { force: true });
    }
    throw error;
  }
}
