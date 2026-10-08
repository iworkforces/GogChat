/**
 * Global Cleanup Registration
 *
 * Registers built-in global cleanup callbacks with the cleanup manager.
 * Uses lazy dynamic imports (in parallel via Promise.all) to avoid coupling at module load time.
 *
 * Cleanup callbacks registered:
 * - rateLimiter: Destroys the IPC rate limiter
 * - deduplicator: Destroys the IPC deduplicator
 * - iconCache: Clears the icon cache
 * - configCache: Clears the config cache
 */

import { getCleanupManager } from '../utils/lifecycle/resourceCleanup.js';
import { asType } from '../../shared/typeUtils.js';

/**
 * Register all built-in global cleanup callbacks.
 *
 * Must be called after app.ready (lazy-imports util modules).
 */
export async function registerGlobalCleanups(): Promise<void> {
  const manager = getCleanupManager();
  const [
    { destroyRateLimiter },
    { destroyDeduplicator },
    { getIconCache: getIconCacheLazy },
    { clearConfigCache },
  ] = await Promise.all([
    import('../utils/ipc/rateLimiter.js'),
    import('../utils/ipc/ipcDeduplicator.js'),
    import('../utils/platform/iconCache.js'),
    import('../utils/config/configCache.js'),
  ]);
  manager.registerGlobalCleanupCallback('rateLimiter', destroyRateLimiter, 'Rate limiter');
  manager.registerGlobalCleanupCallback('deduplicator', destroyDeduplicator, 'Deduplicator');
  manager.registerGlobalCleanupCallback(
    'iconCache',
    () => getIconCacheLazy().clear(),
    'Icon cache'
  );
  manager.registerGlobalCleanupCallback('configCache', clearConfigCache, 'Config cache');
  manager.registerGlobalCleanupCallback(
    'sessionMaintenance',
    () => {
      // Lazy require avoids module-load-time coupling per AGENTS.md pattern.
      const mod = asType<{ stopSessionMaintenance: () => void }>(
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../utils/account/accountSessionMaintenance.js')
      );
      mod.stopSessionMaintenance();
    },
    'Session maintenance'
  );
}
