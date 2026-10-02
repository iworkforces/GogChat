import type { CleanupTask, GlobalCleanupCallback, CleanupRunContext } from './cleanupTypes.js';
import { toErrorMessage } from './errorUtils.js';

export async function run(
  tasks: readonly CleanupTask[],
  callbacks: ReadonlyMap<string, GlobalCleanupCallback>,
  { config, log, start }: CleanupRunContext
): Promise<void> {
  for (const task of tasks) {
    try {
      if (config.logDetails) {
        log.debug(`Running cleanup task: ${task.name}`);
      }
      await task.cleanup();
    } catch (error: unknown) {
      if (task.critical) {
        log.error(`Critical cleanup task failed: ${task.name}`, toErrorMessage(error));
      } else {
        log.debug(`Cleanup task failed: ${task.name}`, toErrorMessage(error));
      }
    }
  }

  if (config.includeGlobalResources) {
    log.debug('Cleaning up global resources...');
    for (const [_id, { cleanup, label }] of callbacks) {
      try {
        await cleanup();
        log.debug(`${label} cleaned up`);
      } catch (error: unknown) {
        log.debug(`Failed to cleanup ${label}:`, toErrorMessage(error));
      }
    }
  }

  const elapsed = Date.now() - start;
  log.info(`Resource cleanup completed in ${elapsed}ms`);
}
