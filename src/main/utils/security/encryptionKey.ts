import { safeStorage, app } from 'electron';
import { createHash, randomBytes } from 'crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import log from 'electron-log';
import { GogChatError } from '../lifecycle/errors.js';

/**
 * Check if a file exists (async equivalent of fs.existsSync)
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

const ENCRYPTION_KEY_FILE = 'encryption-key.enc';

/**
 * Generate the legacy deterministic key (for backward compatibility)
 * This is used when SafeStorage is unavailable or during migration
 */
function getLegacyEncryptionKey(): string {
  const keyMaterial = `${app.getName()}-${app.getPath('userData')}`;
  return createHash('sha256').update(keyMaterial).digest('hex');
}

/**
 * Get or create an encryption key using safeStorage (OS credential store).
 *
 * - If SafeStorage is available and key file exists → decrypt and return stored key
 * - If SafeStorage is available, key file missing, but config exists → migration needed, return legacy key
 * - If SafeStorage is available, fresh install → generate random 256-bit key, encrypt with SafeStorage, store
 * - If SafeStorage is unavailable → return deterministic legacy key
 *
 * MUST be called AFTER app.whenReady() so OS credential-store identity is stable.
 */
export interface EncryptionKeyResult {
  key: string;
  /**
   * True when the store was opened with the legacy deterministic key AND
   * SafeStorage is available — meaning the caller should migrate the data
   * to a new SafeStorage-backed key via rekeyConfigStore().
   * False in all other cases (fresh install, already migrated, SafeStorage unavailable).
   */
  migrationPending: boolean;
}

/**
 * Get or create an encryption key using safeStorage (OS credential store).
 *
 * - If SafeStorage is available and key file exists → decrypt and return stored key
 * - If SafeStorage is available, key file missing, but config exists → migration needed, return legacy key
 * - If SafeStorage is available, fresh install → generate random 256-bit key, encrypt with SafeStorage, store
 * - If SafeStorage is unavailable → return deterministic legacy key
 *
 * MUST be called AFTER app.whenReady() so OS credential-store identity is stable.
 */
export async function getOrCreateEncryptionKey(): Promise<EncryptionKeyResult> {
  // Try SafeStorage first (must be called after app.whenReady on macOS)
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return await handleSafeStorageKey();
    } catch (error: unknown) {
      log.warn('[EncryptionKey] SafeStorage failed, falling back to deterministic key:', error);
    }
  } else {
    log.warn('[EncryptionKey] SafeStorage not available, using deterministic key');
  }

  // Fallback to deterministic key — migration must NOT be attempted here
  // because SafeStorage either failed or is unavailable. Triggering migration
  // would generate a brand-new key unrelated to the data already on disk.
  return { key: getLegacyEncryptionKey(), migrationPending: false };
}

/**
 * Handle SafeStorage key retrieval/generation
 * Assumes SafeStorage.isEncryptionAvailable() returned true
 */
async function handleSafeStorageKey(): Promise<EncryptionKeyResult> {
  const keyFilePath = path.join(app.getPath('userData'), ENCRYPTION_KEY_FILE);

  // Check if encrypted key file exists
  if (await fileExists(keyFilePath)) {
    const encrypted = await fs.readFile(keyFilePath);
    try {
      const hexKey = safeStorage.decryptString(encrypted);
      log.info('[EncryptionKey] Retrieved encryption key from SafeStorage');
      return { key: hexKey, migrationPending: false };
    } catch (cause: unknown) {
      // Key file is stale (e.g., app identity changed). Remove it so
      // subsequent launches skip the decryption attempt entirely.
      await fs.unlink(keyFilePath).catch(() => {});
      log.info('[EncryptionKey] Removed stale key file');
      throw new GogChatError('SafeStorage decryption failed', 'ENCRYPTION_FAILED', { cause });
    }
  }

  // No key file exists — check if we need to migrate from deterministic key
  // (config file exists but no encryption-key.enc means migration needed)
  const configPath = path.join(app.getPath('userData'), 'config.json');
  if (await fileExists(configPath)) {
    // Migration scenario: return legacy key so the store opens successfully,
    // and signal that migration should follow.
    log.info('[EncryptionKey] Existing config detected, migration will be scheduled');
    return { key: getLegacyEncryptionKey(), migrationPending: true };
  }

  // Fresh install — generate new random key
  const newKey = randomBytes(32).toString('hex'); // 256-bit key as hex
  const encrypted = safeStorage.encryptString(newKey);
  await fs.writeFile(keyFilePath, encrypted);
  log.info('[EncryptionKey] Generated new encryption key, stored in SafeStorage');
  return { key: newKey, migrationPending: false };
}
