/**
 * Centralized error handling for the main process
 *
 * This module provides:
 * - Global error handlers for unhandled rejections and exceptions
 * - Error context tracking (feature name, initialization phase)
 * - Graceful shutdown on critical errors
 * - Type-safe error utilities for catch blocks
 *
 * @module errorHandler
 */

import { app } from 'electron';
import log from 'electron-log';
import type Store from 'electron-store';
import { sanitizeLogError } from '../../../shared/logSanitizer.js';
import type { StoreType } from '../../../shared/types/config.js';

/**
 * Error context provides additional information about where/when an error occurred
 */
export interface ErrorContext {
  feature?: string; // Feature name (e.g., 'badgeIcons', 'closeToTray')
  phase?: 'security' | 'critical' | 'ui' | 'deferred'; // Initialization phase
  operation?: string; // Operation being performed (e.g., 'initialization', 'cleanup')
  metadata?: Record<string, unknown>; // Additional context
}

/**
 * Error handler configuration
 */
export interface ErrorHandlerConfig {
  gracefulShutdown?: boolean; // Whether to gracefully shutdown on critical errors
}

/**
 * Singleton error handler instance
 */
class ErrorHandler {
  private config: ErrorHandlerConfig;
  private errorContextStack: ErrorContext[] = [];
  private isInitialized = false;

  constructor(config: ErrorHandlerConfig = {}) {
    this.config = {
      gracefulShutdown: true,
      ...config,
    };
  }

  /**
   * Initialize the error handler
   * Sets up global handlers for unhandledRejection and uncaughtException
   */
  initialize(_store?: Store<StoreType>): void {
    if (this.isInitialized) {
      log.warn('[ErrorHandler] Already initialized');
      return;
    }

    log.info('[ErrorHandler] Initializing centralized error handler');

    // Register global error handlers
    this.registerGlobalHandlers();

    this.isInitialized = true;
    log.info('[ErrorHandler] Centralized error handler initialized');
  }

  /**
   * Register global error handlers
   */
  private registerGlobalHandlers(): void {
    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
      this.handleUnhandledRejection(reason, promise);
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error: Error) => {
      this.handleUncaughtException(error);
    });

    log.debug('[ErrorHandler] Global error handlers registered');
  }

  /**
   * Handle unhandled promise rejections
   */
  private handleUnhandledRejection(reason: unknown, _promise: Promise<unknown>): void {
    log.error('[ErrorHandler] Unhandled Promise Rejection:', sanitizeLogError(reason));

    // Don't quit on unhandled rejections, just log them
    // The app should continue running
  }

  /**
   * Handle uncaught exceptions
   */
  private handleUncaughtException(error: Error): void {
    log.error('[ErrorHandler] Uncaught Exception:', sanitizeLogError(error));

    // Graceful shutdown on critical errors
    if (this.config.gracefulShutdown) {
      log.error('[ErrorHandler] Critical error, initiating graceful shutdown');

      // NOTE: Intentionally bare setTimeout — cannot use createTrackedTimeout here
      // because resourceCleanup.ts imports from errorHandler.ts (toErrorMessage),
      // creating a circular dependency. This is acceptable since it only fires
      // during critical shutdown (uncaughtException) when cleanup is moot anyway.
      setTimeout(() => {
        app.quit();
      }, 1000);
    }
  }

  /**
   * Push an error context onto the stack
   * Use this when entering a feature initialization or operation
   *
   * @param context - Error context
   * @returns Cleanup function to pop the context
   */
  pushContext(context: ErrorContext): () => void {
    this.errorContextStack.push(context);

    // Return cleanup function
    return () => {
      this.popContext();
    };
  }

  /**
   * Pop the current error context from the stack
   */
  private popContext(): void {
    this.errorContextStack.pop();
  }

  /**
   * Handle a feature initialization error
   * Logs the error with context
   *
   * @param feature - Feature name
   * @param error - Error that occurred
   * @param phase - Initialization phase
   */
  handleFeatureError(feature: string, error: unknown, phase?: string): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    log.error(`[ErrorHandler] Feature '${feature}' failed${phase ? ` during ${phase}` : ''}:`, {
      message: errorMessage,
      stack,
    });
  }

  /**
   * Wrap an async operation with error handling and context
   *
   * @param context - Error context
   * @param operation - Async operation to execute
   * @returns Promise that resolves with the operation result
   */
  async wrapAsync<T>(context: ErrorContext, operation: () => Promise<T>): Promise<T> {
    const cleanup = this.pushContext(context);

    try {
      const result = await operation();
      cleanup();
      return result;
    } catch (error: unknown) {
      cleanup();
      this.handleFeatureError(context.feature || 'unknown', error, context.phase);
      throw error;
    }
  }

  /**
   * Wrap a synchronous operation with error handling and context
   *
   * @param context - Error context
   * @param operation - Sync operation to execute
   * @returns Operation result
   */
  wrapSync<T>(context: ErrorContext, operation: () => T): T {
    const cleanup = this.pushContext(context);

    try {
      const result = operation();
      cleanup();
      return result;
    } catch (error: unknown) {
      cleanup();
      this.handleFeatureError(context.feature || 'unknown', error, context.phase);
      throw error;
    }
  }
}

// Export singleton instance
let errorHandler: ErrorHandler | null = null;

/**
 * Get the global error handler instance
 */
export function getErrorHandler(config?: ErrorHandlerConfig): ErrorHandler {
  if (!errorHandler) {
    errorHandler = new ErrorHandler(config);
  }
  return errorHandler;
}

/**
 * Initialize the global error handler
 * Should be called early in the application lifecycle
 */
export function initializeErrorHandler(
  config?: ErrorHandlerConfig,
  store?: Store<StoreType>
): void {
  const handler = getErrorHandler(config);
  handler.initialize(store);
}

/**
 * Destroy the global error handler instance.
 * Clears the singleton so the next call to {@link getErrorHandler} creates a
 * fresh handler. Note: process-level `unhandledRejection`/`uncaughtException`
 * listeners registered by `initialize()` are intentionally left in place —
 * Node.js does not surface a handle for them here, and they remain useful
 * for the remainder of the process lifetime.
 */
export function destroyErrorHandler(): void {
  errorHandler = null;
}
