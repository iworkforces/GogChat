import type { StoreType, StoreKeyPaths } from '../shared/types/config.js';
import Store from 'electron-store';
import { addCacheLayer, isCachedStore, type CachedStore } from './utils/config/configCache.js';
import log from 'electron-log';
import { getPackageInfo } from './utils/platform/packageInfo.js';
import { getOrCreateEncryptionKey } from './utils/security/encryptionKey.js';

import { schema, CACHE_VERSION } from './utils/config/configSchema.js';
import { ConfigError } from './utils/lifecycle/errors.js';
import { asType, asUnsafe } from '../shared/typeUtils.js';

/**
 * Initialize encrypted store
 * All configuration data is encrypted at rest using AES-256-GCM
 */
let storeInstance: Store<StoreType> | CachedStore<StoreType> | null = null;

/**
 * Initialize the electron-store instance
 * Now uses static import with ESM
 *
 * Migration strategy:
 * - If SafeStorage is available but the key file is missing while config exists,
 *   migrate from the legacy deterministic key to SafeStorage.
 * - rekeyConfigStore snapshots the data, moves the legacy file aside, then
 *   reopens the store with the new key. It is loaded on demand.
 */
export async function initializeStore(): Promise<Store<StoreType> | CachedStore<StoreType>> {
  if (storeInstance) {
    return storeInstance;
  }

  // Get or create encryption key (SafeStorage-backed or legacy)
  const { key: encryptionKey, migrationPending } = await getOrCreateEncryptionKey();

  // Create store with encryption
  let store: Store<StoreType> | CachedStore<StoreType> = new Store<StoreType>({
    schema,
    encryptionKey,
    clearInvalidConfig: true,
  });

  // Migration: only when getOrCreateEncryptionKey() explicitly signaled it.
  // Do NOT re-check independently — SafeStorage failures during key retrieval
  // must NOT trigger migration (the store was opened with the legacy key in that
  // case and a new random key would corrupt the data).
  if (migrationPending) {
    try {
      const { rekeyConfigStore } = await import('./utils/config/rekeyConfigStore.js');
      const rekeyed = await rekeyConfigStore(store);
      if (rekeyed) {
        store = rekeyed;
      }
    } catch (error: unknown) {
      log.error('[Config] Migration failed, continuing with legacy key:', error);
      // Continue with the legacy-key store - data is still accessible
    }
  }

  /**
   * Enable caching layer for improved performance
   * Adds in-memory cache to reduce encryption/decryption overhead
   * Cache is automatically invalidated on writes to maintain consistency
   *
   * Note: Disabled in test environment to preserve test spies
   */
  // Only enable cache layer if not in test environment
  if (process.env['NODE_ENV'] !== 'test' && process.env['VITEST'] !== 'true') {
    store = addCacheLayer(store);
  }

  // ⚡ OPTIMIZATION: Check and update cache version
  validateAndUpdateCacheVersion(store);

  storeInstance = store;
  return store;
}

/**
 * Validate cache version and clear if outdated
 * ⚡ OPTIMIZATION: Prevents stale data after app updates
 */
function validateAndUpdateCacheVersion(store: Store<StoreType> | CachedStore<StoreType>): void {
  try {
    const meta = store.get('_meta');
    const currentAppVersion = getPackageInfo().version;
    const storedCacheVersion = meta?.cacheVersion;
    const storedAppVersion = meta?.lastAppVersion;

    // Check if cache version or app version changed
    const cacheVersionChanged = storedCacheVersion !== CACHE_VERSION;
    const appVersionChanged = storedAppVersion !== currentAppVersion;

    if (cacheVersionChanged || appVersionChanged) {
      log.info(
        `[Config] Cache invalidation triggered - Cache version: ${storedCacheVersion} → ${CACHE_VERSION}, App version: ${storedAppVersion} → ${currentAppVersion}`
      );

      // Clear cache if store has caching layer
      if (isCachedStore(store)) {
        store.clearCache();
        log.info('[Config] In-memory cache cleared');
      }

      // Update metadata
      store.set('_meta', {
        cacheVersion: CACHE_VERSION,
        lastAppVersion: currentAppVersion,
        lastUpdated: Date.now(),
      });

      log.info('[Config] Cache version and metadata updated');
    } else {
      log.debug(
        `[Config] Cache version valid (${CACHE_VERSION}), app version: ${currentAppVersion}`
      );
    }
  } catch (error: unknown) {
    log.error('[Config] Failed to validate cache version:', error);
  }
}

/**
 * Get the store instance (synchronous)
 * WARNING: Only use this after initializeStore() has been called
 * Throws an error if store hasn't been initialized
 */
export function getStore(): Store<StoreType> | CachedStore<StoreType> {
  if (!storeInstance) {
    throw new ConfigError(
      'Store not initialized. Call initializeStore() before using the store.',
      'CONFIG_READ_FAILED'
    );
  }
  return storeInstance;
}

// Create a proxy object that lazy-loads the store
// This maintains backward compatibility with existing code
const storeProxy = new Proxy(asType<Store<StoreType> | CachedStore<StoreType>>({}), {
  get(_target, prop) {
    const store = getStore();
    // Store methods are rebound immediately below; access is intentional.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- rebound via .bind(store)
    const value = store[asType<keyof typeof store>(prop)];
    // Bind methods to the actual store instance to preserve 'this' context
    if (typeof value === 'function') {
      return value.bind(store);
    }
    return value;
  },
  set(_target, prop, value) {
    return Reflect.set(getStore(), prop, value);
  },
  has(_target, prop) {
    return prop in getStore();
  },
  ownKeys(_target) {
    return Reflect.ownKeys(getStore());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Reflect.getOwnPropertyDescriptor(getStore(), prop);
  },
});

/**
 * Path-typed value extractor for nested StoreType keys.
 * Resolves dot-notation paths (e.g. 'app.autoCheckForUpdates') to their value type.
 */
type PathValue<T, P extends string> = P extends `${infer K}.${infer Rest}`
  ? K extends keyof T
    ? PathValue<NonNullable<T[K]>, Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never;

/**
 * Type-safe config getter. Returns the value at the given dot-notation path,
 * or undefined if not set.
 *
 * @example
 *   const val = configGet('app.autoCheckForUpdates'); // boolean | undefined
 */
export function configGet<K extends StoreKeyPaths<StoreType>>(
  key: K
): PathValue<StoreType, K> | undefined {
  // electron-store's `.get()` overload set is not generic over dot-notation paths;
  // `K extends StoreKeyPaths<StoreType>` is wider than the runtime-accepted union, so
  // the typed key collapses to `never` at the call boundary. Validation is structural
  // (StoreKeyPaths) — the cast bridges the proxy variance only.
  return asType<PathValue<StoreType, K> | undefined>(
    getStore().get(
      asUnsafe<never>(key, 'electron-store .get() overload variance vs StoreKeyPaths dot-notation')
    )
  );
}

/**
 * Type-safe config setter. Sets the value at the given dot-notation path.
 *
 * @example
 *   configSet('app.startHidden', true);
 */
export function configSet<K extends StoreKeyPaths<StoreType>>(
  key: K,
  value: PathValue<StoreType, K>
): void {
  // Same overload-variance reason as configGet: both `key` and `value` parameters of
  // electron-store's `.set()` collapse to `never` under our path-typed generic. The
  // pair of casts is intentional and bounded to this single helper.
  getStore().set(
    asUnsafe<never>(
      key,
      'electron-store .set() key overload variance vs StoreKeyPaths dot-notation'
    ),
    asUnsafe<never>(
      value,
      'electron-store .set() value overload variance vs PathValue<StoreType, K>'
    )
  );
}

export default storeProxy;
