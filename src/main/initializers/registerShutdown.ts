/**
 * Shutdown Handler Initializer
 *
 * Extracts the before-quit handler from index.ts.
 * Handles graceful shutdown with async cleanup. Diagnostics logging is
 * delegated to `shutdownDiagnostics.ts` and singleton destruction to
 * `singletonDestroyers.ts`.
 */

import { app } from 'electron';
import log from 'electron-log';
import { cleanupAll } from '../utils/lifecycle/featureRunner.js';
import { getSharedFeatureContext } from '../utils/lifecycle/featureContextStore.js';
import { getCleanupManager } from '../utils/lifecycle/resourceCleanup.js';
import {
  destroyAccountWindowManager,
  peekAccountWindowManager,
} from '../utils/account/accountWindowManager.js';
import type { AccountIndex } from '../../shared/types/branded.js';
import { destroyAllSingletons } from './singletonDestroyers.js';
import { closeStartupAdmission } from '../utils/lifecycle/startupAdmission.js';

export const SHUTDOWN_STAGE_TIMEOUT_MS = 2_000;
export const SHUTDOWN_OVERALL_TIMEOUT_MS = 8_000;

export interface ShutdownDeadlineFactory {
  createStageSignal: () => AbortSignal;
  createOverallSignal: () => AbortSignal;
}

export function createProductionShutdownDeadlines(): ShutdownDeadlineFactory {
  return {
    createStageSignal: () => AbortSignal.timeout(SHUTDOWN_STAGE_TIMEOUT_MS),
    createOverallSignal: () => AbortSignal.timeout(SHUTDOWN_OVERALL_TIMEOUT_MS),
  };
}

async function runShutdownStage(
  name: string,
  cleanup: (signal: AbortSignal) => void | Promise<void>,
  createStageSignal: () => AbortSignal
): Promise<void> {
  const signal = createStageSignal();
  const work = Promise.resolve()
    .then(() => cleanup(signal))
    .catch((error: unknown) => {
      log.error(`[Main] ${name} failed:`, error);
    });
  if (signal.aborted) {
    log.warn(`[Main] ${name} abandoned — deadline already expired`);
    return;
  }

  const deadline = Promise.withResolvers<void>();
  const onAbort = (): void => {
    log.warn(`[Main] ${name} abandoned after deadline`);
    deadline.resolve();
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    await Promise.race([work, deadline.promise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Register the application shutdown handler.
 *
 * Cleanup order:
 * 1. Feature cleanup via featureRunner (reverse init order)
 * 2. Global resource cleanup
 * 3. Account window manager destruction
 * 4. Comprehensive cache statistics logging
 * 5. Singleton destruction (performance monitor, deduplicator, rate limiter, icon cache)
 * 6. app.exit() to allow quit to proceed
 */
export function registerShutdownHandler(
  deadlines: ShutdownDeadlineFactory = createProductionShutdownDeadlines()
): void {
  let isShuttingDown = false;
  let didExit = false;
  const exitOnce = (): void => {
    if (didExit) {
      return;
    }
    didExit = true;
    app.exit();
  };

  app.on('before-quit', (event) => {
    closeStartupAdmission();
    event.preventDefault(); // Prevent immediate quit until cleanup is done
    if (isShuttingDown) return;
    isShuttingDown = true;
    const overall = deadlines.createOverallSignal();
    const createStageSignal = (): AbortSignal =>
      AbortSignal.any([deadlines.createStageSignal(), overall]);

    void (async () => {
      log.info('[Main] ========== Application Shutdown ==========');

      const hangStage = process.env['GOGCHAT_TEST_HANG_SHUTDOWN'];
      const hang = (): Promise<void> => new Promise(() => undefined);
      let diagnosticAccountIndices: readonly AccountIndex[] = [];

      log.info('[Main] Cleaning up feature resources...');
      await runShutdownStage(
        'Feature cleanup',
        hangStage === 'feature' ? hang : (signal) => cleanupAll(getSharedFeatureContext(), signal),
        createStageSignal
      );
      await runShutdownStage(
        'Global resource cleanup',
        hangStage === 'global'
          ? hang
          : () => getCleanupManager().cleanup({ includeGlobalResources: true, logDetails: true }),
        createStageSignal
      );
      await runShutdownStage(
        'Account window manager cleanup',
        hangStage === 'accounts'
          ? hang
          : () => {
              const manager = peekAccountWindowManager();
              if (manager) {
                diagnosticAccountIndices = manager.listAccountIndices();
              }
              destroyAccountWindowManager();
            },
        createStageSignal
      );
      await runShutdownStage(
        'Shutdown diagnostics',
        hangStage === 'diagnostics'
          ? hang
          : async () => {
              // Keep diagnostic log strings out of lib/main/index.js.
              const { logShutdownDiagnostics } = await import('./shutdownDiagnostics.js');
              await logShutdownDiagnostics({ accountIndices: diagnosticAccountIndices });
            },
        createStageSignal
      );
      await runShutdownStage(
        'Singleton destruction',
        hangStage === 'singletons' ? hang : destroyAllSingletons,
        createStageSignal
      );

      log.info('[Main] =====================================================');
    })()
      .catch((error: unknown) => {
        log.error('[Main] Shutdown sequence failed:', error);
      })
      .finally(exitOnce);

    const onOverall = (): void => {
      log.warn('[Main] Overall shutdown abandoned after deadline');
      exitOnce();
    };
    if (overall.aborted) {
      onOverall();
    } else {
      overall.addEventListener('abort', onOverall, { once: true });
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
