/**
 * Resource Cleanup Utility
 * Manages cleanup of resources when window closes or app quits
 * Prevents memory leaks and ensures graceful shutdown
 */

import { logger } from './logger.js';
import { toErrorMessage } from './errorUtils.js';
import type {
  EventHandler,
  EventTarget,
  CleanupConfig,
  CleanupTask,
  GlobalCleanupCallback,
} from './cleanupTypes.js';

const timerRegistrations = new WeakMap<NodeJS.Timeout, () => void>();

/**
 * Resource Cleanup Manager
 * Centralizes cleanup of various resources
 */
export class ResourceCleanupManager {
  private tasks: CleanupTask[] = [];
  private intervals = new Set<NodeJS.Timeout>();
  private timeouts = new Set<NodeJS.Timeout>();
  private timerAborter = new AbortController();
  private listeners: Array<{
    target: EventTarget;
    event: string;
    handler: EventHandler;
  }> = [];
  private readonly log = logger.feature('ResourceCleanup');
  private isCleaningUp = false;
  private cleanupPromise: Promise<void> | null = null;
  private hooks = new Map<string, GlobalCleanupCallback>();

  /**
   * Register a cleanup task
   */
  registerTask(task: CleanupTask): void {
    this.tasks.push(task);
    this.log.debug(`Registered cleanup task: ${task.name}`);
  }

  /**
   * Register multiple cleanup tasks
   */
  registerTasks(tasks: CleanupTask[]): void {
    tasks.forEach((task) => this.registerTask(task));
  }

  /**
   * Track an interval for cleanup
   */
  trackInterval(interval: NodeJS.Timeout): void {
    this.intervals.add(interval);
  }

  /**
   * Track a timeout for cleanup
   */
  trackTimeout(timeout: NodeJS.Timeout): void {
    this.timeouts.add(timeout);
  }

  /**
   * Untrack a timeout (e.g. when it fires naturally)
   */
  untrackTimeout(timeout: NodeJS.Timeout): void {
    this.timeouts.delete(timeout);
  }

  untrackInterval(interval: NodeJS.Timeout): void {
    this.intervals.delete(interval);
  }

  /**
   * Track an event listener for cleanup
   */
  trackListener(target: EventTarget, event: string, handler: EventHandler): void {
    this.listeners.push({ target, event, handler });
  }

  /**
   * Register a global cleanup callback
   * Replaces direct imports — util modules register their cleanup lazily
   */
  registerGlobalCleanupCallback(
    id: string,
    cleanup: () => void | Promise<void>,
    label?: string
  ): void {
    this.hooks.set(id, {
      cleanup,
      label: label ?? id,
    });
    this.log.debug(`Registered global cleanup callback: ${id}`);
  }

  /**
   * Get IDs of all registered global cleanup callbacks
   */
  getRegisteredCallbackIds(): string[] {
    return Array.from(this.hooks.keys());
  }

  /**
   * Clean up all tracked intervals
   */
  private cleanupTimers(): void {
    this.log.debug(
      `Aborting tracked timers (${this.intervals.size} intervals, ${this.timeouts.size} timeouts)`
    );
    this.timerAborter.abort();
    this.timerAborter = new AbortController();
    // Clear any direct-tracked timers (back-compat fallback)
    for (const interval of this.intervals) clearInterval(interval);
    for (const timeout of this.timeouts) clearTimeout(timeout);
    this.intervals.clear();
    this.timeouts.clear();
  }

  /**
   * Register a timer with the abort signal for fan-out cleanup
   */
  registerTimerSignal(
    id: NodeJS.Timeout,
    kind: 'interval' | 'timeout',
    label?: string
  ): () => void {
    const signal = this.timerAborter.signal;
    const release = (): void => {
      signal.removeEventListener('abort', abort);
      timerRegistrations.delete(id);
      if (kind === 'interval') this.untrackInterval(id);
      else this.untrackTimeout(id);
    };
    const abort = (): void => {
      release();
      if (kind === 'interval') clearInterval(id);
      else clearTimeout(id);
      this.log.debug(`Timer aborted: ${label ?? 'unnamed'}`);
    };
    signal.addEventListener('abort', abort, { once: true });
    timerRegistrations.set(id, release);
    return release;
  }

  /**
   * Clean up all tracked event listeners
   */
  private cleanupListeners(): void {
    this.log.debug(`Cleaning up ${this.listeners.length} event listeners`);
    for (const { target, event, handler } of this.listeners) {
      try {
        if (target && target.removeListener) {
          target.removeListener(event, handler);
        } else if (target && target.off) {
          target.off(event, handler);
        }
      } catch (error: unknown) {
        this.log.debug(`Failed to remove listener for ${event}:`, toErrorMessage(error));
      }
    }
    this.listeners = [];
  }

  /**
   * Execute all cleanup tasks
   */
  async cleanup(config: CleanupConfig = {}): Promise<void> {
    // Prevent multiple concurrent cleanups
    if (this.isCleaningUp) {
      if (this.cleanupPromise) {
        return this.cleanupPromise;
      }
      return;
    }

    this.isCleaningUp = true;
    this.cleanupPromise = this.run(config);

    try {
      await this.cleanupPromise;
    } finally {
      this.isCleaningUp = false;
      this.cleanupPromise = null;
    }
  }

  /**
   * Perform the actual cleanup
   */
  private async run(config: CleanupConfig): Promise<void> {
    const startTime = Date.now();
    this.log.info('Starting resource cleanup...');

    // Clean up basic tracked resources
    this.cleanupTimers();
    this.cleanupListeners();

    const tasks = this.tasks;
    const callbacks = this.hooks;
    const context = { config, log: this.log, start: startTime };
    const { run } = await import('./resourceCleanupTasks.js');
    await run(tasks, callbacks, context);
  }

  /**
   * Reset the manager
   */
  reset(): void {
    this.tasks = [];
    this.intervals.clear();
    this.timeouts.clear();
    this.timerAborter.abort();
    this.timerAborter = new AbortController();
    this.listeners = [];
    this.hooks.clear();
    this.isCleaningUp = false;
    this.cleanupPromise = null;
  }
}

/**
 * Global cleanup manager instance
 */
let globalManager: ResourceCleanupManager | null = null;

/**
 * Get or create the global cleanup manager
 */
export function getCleanupManager(): ResourceCleanupManager {
  if (!globalManager) {
    globalManager = new ResourceCleanupManager();
  }
  return globalManager;
}

/**
 * Destroy the global cleanup manager singleton.
 * Runs `cleanupAll()` to flush registered tasks/intervals/timeouts/listeners,
 * then nulls the singleton so the next `getCleanupManager()` call returns a
 * fresh instance. Best-effort: the cleanup promise is fire-and-forget here
 * because callers in shutdown paths already await `cleanupAll()` directly.
 */
export function destroyCleanupManager(): void {
  if (globalManager) {
    void globalManager.cleanup();
    globalManager = null;
  }
}

/**
 * Helper to create a tracked interval
 */
export function createTrackedInterval(
  callback: () => void,
  delay: number,
  name?: string
): NodeJS.Timeout {
  const interval = setInterval(callback, delay);
  const manager = getCleanupManager();
  manager.registerTimerSignal(interval, 'interval', name);

  if (name) {
    logger.main.debug(`Created tracked interval: ${name}`);
  }

  return interval;
}

/**
 * Helper to create a tracked timeout
 */
export function createTrackedTimeout(
  callback: () => void,
  delay: number,
  name?: string
): NodeJS.Timeout {
  const manager = getCleanupManager();
  const timeout: NodeJS.Timeout = setTimeout(() => {
    release();
    callback();
  }, delay);
  const release = manager.registerTimerSignal(timeout, 'timeout', name);

  if (name) {
    logger.main.debug(`Created tracked timeout: ${name}`);
  }

  return timeout;
}

export function cancelTrackedTimeout(timeout: NodeJS.Timeout): void {
  clearTimeout(timeout);
  timerRegistrations.get(timeout)?.();
}

export function cancelTrackedInterval(interval: NodeJS.Timeout): void {
  clearInterval(interval);
  timerRegistrations.get(interval)?.();
}

/**
 * Helper to add a tracked event listener
 */
export function addTrackedListener(
  target: EventTarget,
  event: string,
  handler: EventHandler,
  name?: string
): void {
  if (target && target.on) {
    target.on(event, handler);
  } else if (target && target.addEventListener) {
    target.addEventListener(event, handler);
  } else {
    throw new Error(`Target does not support event listeners: ${event}`);
  }

  getCleanupManager().trackListener(target, event, handler);

  if (name) {
    logger.main.debug(`Added tracked listener: ${name} for ${event}`);
  }
}

/**
 * Register a custom cleanup task
 */
export function registerCleanupTask(
  name: string,
  cleanup: () => void | Promise<void>,
  critical = false
): void {
  getCleanupManager().registerTask({ name, cleanup, critical });
}
