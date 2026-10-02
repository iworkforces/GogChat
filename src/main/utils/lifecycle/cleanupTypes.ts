/**
 * Cleanup Types
 * Shared type definitions for resource cleanup system.
 * Extracted to break circular dependency between resourceCleanup.ts and trackedResources.ts.
 */
import type { BrowserWindow } from 'electron';
import type { ScopedLogger } from './logger.js';

export interface CleanupTask {
  readonly name: string;
  readonly cleanup: () => void | Promise<void>;
  readonly critical?: boolean;
}

export interface GlobalCleanupCallback {
  readonly cleanup: () => void | Promise<void>;
  readonly label: string;
}

export interface CleanupRunContext {
  readonly config: CleanupConfig;
  readonly log: ScopedLogger;
  readonly start: number;
}

/**
 * Type for event handler functions
 */
export type EventHandler = (...args: unknown[]) => void;

/**
 * Type for event target with listener methods
 */
export interface EventTarget {
  on?: (event: string, handler: EventHandler) => void;
  addEventListener?: (event: string, handler: EventHandler) => void;
  removeListener?: (event: string, handler: EventHandler) => void;
  off?: (event: string, handler: EventHandler) => void;
}

/**
 * Resource cleanup configuration
 */
export interface CleanupConfig {
  window?: BrowserWindow;
  includeGlobalResources?: boolean;
  logDetails?: boolean;
}
