/**
 * Unit tests for ErrorHandler — centralized error handling
 *
 * Covers: ErrorHandler class, wrapAsync, wrapSync, global handlers
 * (unhandledRejection, uncaughtException), singleton pattern, and context stack.
 *
 * Note: toErrorMessage, toError, isError utilities are tested in errorUtils.test.ts
 * (extracted to break circular dependency).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SECRET_AUTH_URL,
  expectNoSentinels,
  makeSecretError,
  spiesOf,
} from '../../../../tests/mocks/logCapture';

// Mock electron first - must come before any imports that use electron
vi.mock('electron', () => ({
  app: {
    whenReady: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn(),
  },
  BrowserWindow: vi.fn().mockImplementation(() => ({
    id: 1,
    webContents: { send: vi.fn() },
    show: vi.fn(),
    hide: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: vi.fn().mockReturnValue(false),
  })),
  Tray: vi.fn().mockImplementation(() => ({
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    destroy: vi.fn(),
  })),
}));

vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

describe('ErrorHandler', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  // ========================================================================
  // Singleton
  // ========================================================================

  describe('Singleton', () => {
    it('getErrorHandler returns the same instance on repeated calls', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const instance1 = getErrorHandler();
      const instance2 = getErrorHandler();
      expect(instance1).toBe(instance2);
    });

    it('getErrorHandler returns different instances after resetModules', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const instance1 = getErrorHandler();
      vi.resetModules();
      const { getErrorHandler: getFresh } = await import('./errorHandler');
      const instance2 = getFresh();
      expect(instance1).not.toBe(instance2);
    });

    it('getErrorHandler accepts config on first call', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const handler = getErrorHandler({ gracefulShutdown: false });
      expect(handler).toBeDefined();
      vi.resetModules();
      const { getErrorHandler: getFresh } = await import('./errorHandler');
      const freshHandler = getFresh({ gracefulShutdown: true });
      expect(freshHandler).toBeDefined();
    });
  });

  // ========================================================================
  // ErrorHandler.initialize()
  // ========================================================================

  describe('initialize()', () => {
    it('is idempotent - second call logs warning', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const log = await import('electron-log');
      const handler = getErrorHandler();

      handler.initialize();
      handler.initialize();

      const warnCalls = log.default.warn.mock.calls;
      expect(warnCalls.some((call) => call[0]?.includes('Already initialized'))).toBe(true);
    });

    it('logs initialization messages', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const log = await import('electron-log');

      const handler = getErrorHandler();
      handler.initialize();

      const infoCalls = log.default.info.mock.calls;
      expect(infoCalls.some((call) => call[0]?.includes('Initializing'))).toBe(true);
      expect(infoCalls.some((call) => call[0]?.includes('initialized'))).toBe(true);
    });
  });

  // ========================================================================
  // Context stack: pushContext
  // ========================================================================

  describe('pushContext()', () => {
    it('returns cleanup function that pops context', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const handler = getErrorHandler();

      const cleanup1 = handler.pushContext({ feature: 'test1' });
      const cleanup2 = handler.pushContext({ feature: 'test2' });

      // Both cleanups should work without throwing
      expect(typeof cleanup1).toBe('function');
      expect(typeof cleanup2).toBe('function');

      cleanup2();
      cleanup1();
    });

    it('allows nested contexts', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const handler = getErrorHandler();

      handler.pushContext({ feature: 'outer', phase: 'security' });
      handler.pushContext({ feature: 'inner', operation: 'init' });

      // Cleanup in reverse order
      const innerCleanup = handler.pushContext({ feature: 'deepest' });
      innerCleanup();
    });
  });

  // ========================================================================
  // handleFeatureError
  // ========================================================================

  describe('handleFeatureError()', () => {
    it('logs error with feature name and phase', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const log = await import('electron-log');
      const handler = getErrorHandler();

      handler.handleFeatureError('myFeature', new Error('init failed'), 'critical');

      const errorCalls = log.default.error.mock.calls;
      expect(errorCalls.some((call) => call[0]?.includes("'myFeature'"))).toBe(true);
      expect(errorCalls.some((call) => call[0]?.includes('critical'))).toBe(true);
    });

    it('handles string errors', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const log = await import('electron-log');
      const handler = getErrorHandler();

      handler.handleFeatureError('strError', 'string error message', 'ui');

      const errorCalls = log.default.error.mock.calls;
      // String error is passed as message property in the second argument object
      expect(errorCalls.some((call) => call[1]?.message === 'string error message')).toBe(true);
    });

    it('handles unknown errors', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const log = await import('electron-log');
      const handler = getErrorHandler();

      handler.handleFeatureError('unknownErr', 42, 'deferred');

      const errorCalls = log.default.error.mock.calls;
      expect(errorCalls.length).toBeGreaterThan(0);
    });

    it('works without phase', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const log = await import('electron-log');
      const handler = getErrorHandler();

      handler.handleFeatureError('noPhase', new Error('no phase'));

      const errorCalls = log.default.error.mock.calls;
      expect(errorCalls.some((call) => call[0]?.includes("'noPhase'"))).toBe(true);
    });
  });

  // ========================================================================
  // wrapAsync
  // ========================================================================

  describe('wrapAsync()', () => {
    it('executes operation and returns result on success', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const handler = getErrorHandler();

      const result = await handler.wrapAsync({ feature: 'test' }, async () => {
        return 42;
      });

      expect(result).toBe(42);
    });

    it('re-throws error after logging', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const log = await import('electron-log');
      const handler = getErrorHandler();

      const error = new Error('async failed');
      await expect(
        handler.wrapAsync({ feature: 'asyncTest', phase: 'critical' }, async () => {
          throw error;
        })
      ).rejects.toThrow('async failed');

      const errorCalls = log.default.error.mock.calls;
      expect(errorCalls.some((call) => call[0]?.includes('asyncTest'))).toBe(true);
    });

    it('includes context in error logging', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const log = await import('electron-log');
      const handler = getErrorHandler();

      try {
        await handler.wrapAsync(
          { feature: 'contextTest', phase: 'ui', operation: 'update' },
          async () => {
            throw new Error('op failed');
          }
        );
      } catch {
        // expected to throw
      }

      const errorCalls = log.default.error.mock.calls;
      expect(errorCalls.some((call) => call[0]?.includes('contextTest'))).toBe(true);
    });

    it('works without optional context fields', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const handler = getErrorHandler();

      const result = await handler.wrapAsync({}, async () => 'ok');
      expect(result).toBe('ok');
    });

    it('handles async operation that returns promise', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const handler = getErrorHandler();

      const result = await handler.wrapAsync({ feature: 'promiseTest' }, async () => {
        return Promise.resolve('promised');
      });

      expect(result).toBe('promised');
    });

    it('cleans up context even when operation throws', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const handler = getErrorHandler();

      // Should not throw when calling twice - context is cleaned up
      try {
        await handler.wrapAsync({ feature: 'cleanupTest' }, async () => {
          throw new Error('first');
        });
      } catch {
        // ignore
      }

      // Second call should still work
      const result = await handler.wrapAsync({ feature: 'cleanupTest' }, async () => 'second');
      expect(result).toBe('second');
    });

    it('uses "unknown" as feature name when context.feature is missing and operation throws', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const log = await import('electron-log');
      const handler = getErrorHandler();

      await expect(
        handler.wrapAsync({}, async () => {
          throw new Error('no-feature error');
        })
      ).rejects.toThrow('no-feature error');

      const errorCalls = log.default.error.mock.calls;
      expect(errorCalls.some((call) => call[0]?.includes("'unknown'"))).toBe(true);
    });
  });

  // ========================================================================
  // wrapSync
  // ========================================================================

  describe('wrapSync()', () => {
    it('executes operation and returns result on success', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const handler = getErrorHandler();

      const result = handler.wrapSync({ feature: 'syncTest' }, () => {
        return 'sync result';
      });

      expect(result).toBe('sync result');
    });

    it('re-throws error after logging', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const log = await import('electron-log');
      const handler = getErrorHandler();

      const error = new Error('sync failed');
      expect(() => {
        handler.wrapSync({ feature: 'syncFail', phase: 'critical' }, () => {
          throw error;
        });
      }).toThrow('sync failed');

      const errorCalls = log.default.error.mock.calls;
      expect(errorCalls.some((call) => call[0]?.includes('syncFail'))).toBe(true);
    });

    it('includes context in error logging', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const log = await import('electron-log');
      const handler = getErrorHandler();

      try {
        handler.wrapSync({ feature: 'syncContext', phase: 'ui', operation: 'compute' }, () => {
          throw new Error('compute failed');
        });
      } catch {
        // expected
      }

      const errorCalls = log.default.error.mock.calls;
      expect(errorCalls.some((call) => call[0]?.includes('syncContext'))).toBe(true);
    });

    it('works without optional context fields', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const handler = getErrorHandler();

      const result = handler.wrapSync({}, () => 'ok');
      expect(result).toBe('ok');
    });

    it('cleans up context even when operation throws', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const handler = getErrorHandler();

      // First call throws
      try {
        handler.wrapSync({ feature: 'syncCleanup' }, () => {
          throw new Error('first');
        });
      } catch {
        // ignore
      }

      // Second call should still work - context was cleaned
      const result = handler.wrapSync({ feature: 'syncCleanup' }, () => 'second');
      expect(result).toBe('second');
    });

    it('uses "unknown" as feature name when context.feature is missing and operation throws', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const log = await import('electron-log');
      const handler = getErrorHandler();

      expect(() => {
        handler.wrapSync({}, () => {
          throw new Error('no-feature sync error');
        });
      }).toThrow('no-feature sync error');

      const errorCalls = log.default.error.mock.calls;
      expect(errorCalls.some((call) => call[0]?.includes("'unknown'"))).toBe(true);
    });
  });

  // ========================================================================
  // Global handlers: unhandledRejection, uncaughtException
  // ========================================================================

  describe('Global handlers', () => {
    it('unhandledRejection handler logs reason', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const log = await import('electron-log');
      const handler = getErrorHandler();
      handler.initialize();

      // Get the unhandledRejection listener
      const listeners = process.listeners('unhandledRejection') as Array<
        (...args: unknown[]) => void
      >;
      const rejectionHandler = listeners[listeners.length - 1];

      const reason = new Error('unhandled rejection error');
      await rejectionHandler(reason, Promise.resolve());

      const errorCalls = log.default.error.mock.calls;
      expect(errorCalls.some((call) => call[0]?.includes('Unhandled Promise Rejection'))).toBe(
        true
      );
    });

    it('unhandledRejection handles string reasons', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const log = await import('electron-log');
      const handler = getErrorHandler();
      handler.initialize();

      const listeners = process.listeners('unhandledRejection') as Array<
        (...args: unknown[]) => void
      >;
      const rejectionHandler = listeners[listeners.length - 1];

      await rejectionHandler('string rejection', Promise.resolve());

      const errorCalls = log.default.error.mock.calls;
      expect(errorCalls.some((call) => call[0]?.includes('Unhandled Promise Rejection'))).toBe(
        true
      );
    });

    it('uncaughtException handler logs error and calls app.quit', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const electron = await import('electron');
      const log = await import('electron-log');
      const handler = getErrorHandler({ gracefulShutdown: true });
      handler.initialize();

      // Get the uncaughtException listener
      const listeners = process.listeners('uncaughtException') as Array<
        (...args: unknown[]) => void
      >;
      const exceptionHandler = listeners[listeners.length - 1];

      const error = new Error('uncaught exception error');
      exceptionHandler(error);

      // Allow setTimeout (1000ms) to fire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const errorCalls = log.default.error.mock.calls;
      expect(errorCalls.some((call) => call[0]?.includes('Uncaught Exception'))).toBe(true);
      expect(electron.app.quit).toHaveBeenCalled();
    });

    it('uncaughtException does not quit when gracefulShutdown is false', async () => {
      const { getErrorHandler } = await import('./errorHandler');
      const electron = await import('electron');
      const handler = getErrorHandler({ gracefulShutdown: false });
      handler.initialize();

      const listeners = process.listeners('uncaughtException') as Array<
        (...args: unknown[]) => void
      >;
      const exceptionHandler = listeners[listeners.length - 1];

      const error = new Error('no shutdown');
      exceptionHandler(error);

      // Allow promise to settle
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(electron.app.quit).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // initializeErrorHandler()
  // ========================================================================

  describe('initializeErrorHandler()', () => {
    it('creates and initializes handler', async () => {
      const { initializeErrorHandler } = await import('./errorHandler');
      const log = await import('electron-log');

      initializeErrorHandler();

      const infoCalls = log.default.info.mock.calls;
      expect(infoCalls.some((call) => call[0]?.includes('Initializing'))).toBe(true);
    });

    it('accepts config option', async () => {
      const { initializeErrorHandler } = await import('./errorHandler');
      const electron = await import('electron');

      initializeErrorHandler({ gracefulShutdown: false });

      // Trigger uncaughtException to verify no quit
      const listeners = process.listeners('uncaughtException') as Array<
        (...args: unknown[]) => void
      >;
      const exceptionHandler = listeners[listeners.length - 1];
      exceptionHandler(new Error('test'));

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(electron.app.quit).not.toHaveBeenCalled();
    });
  });
});

describe('destroyErrorHandler', () => {
  it('resets the singleton', async () => {
    const { initializeErrorHandler, destroyErrorHandler, getErrorHandler } =
      await import('./errorHandler.js');
    initializeErrorHandler({ gracefulShutdown: false });
    expect(() => {
      destroyErrorHandler();
      destroyErrorHandler();
    }).not.toThrow();
    expect(getErrorHandler()).toBeTruthy();
  });
});

describe('ErrorHandler — log redaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  async function installHandlers(gracefulShutdown: boolean) {
    const { getErrorHandler } = await import('./errorHandler');
    const spies = spiesOf((await import('electron-log')).default);
    const handler = getErrorHandler({ gracefulShutdown });
    const push = handler.pushContext({
      feature: 'externalLinks',
      phase: 'ui',
      operation: 'navigate',
      metadata: { url: SECRET_AUTH_URL },
    });
    handler.initialize();
    spies.error.mockClear();
    const rejection = (
      process.listeners('unhandledRejection') as Array<(...a: unknown[]) => void>
    ).at(-1)!;
    const exception = (
      process.listeners('uncaughtException') as Array<(...a: unknown[]) => void>
    ).at(-1)!;
    process.off('unhandledRejection', rejection);
    process.off('uncaughtException', exception);
    return { spies, rejection, exception, push };
  }

  it.each([
    ['an Error with URLs in message, stack and cause', makeSecretError()],
    ['a string reason carrying a URL', `rejected ${SECRET_AUTH_URL}`],
    ['an object reason carrying a URL', { url: SECRET_AUTH_URL }],
  ])('logs an unhandled rejection with %s as a fixed Error', async (_label, reason) => {
    const { spies, rejection, push } = await installHandlers(false);

    rejection(reason, Promise.resolve());

    expect(spies.error).toHaveBeenCalledTimes(1);
    const [message, logged] = spies.error.mock.calls[0] as [string, Error];
    expect(message).toBe('[ErrorHandler] Unhandled Promise Rejection:');
    expect(logged).toBeInstanceOf(Error);
    expect(logged.message).toBe('[redacted]');
    expect(logged.stack).toBe('[redacted]');
    expect(logged.cause).toBeUndefined();
    expectNoSentinels(spies);
    push();
  });

  it('logs an uncaught exception as a fixed Error and still schedules the graceful quit', async () => {
    vi.useFakeTimers();
    try {
      const { spies, exception, push } = await installHandlers(true);
      const electron = await import('electron');

      exception(makeSecretError());

      const calls = spies.error.mock.calls as Array<[string, Error?]>;
      expect(calls.map(([message]) => message)).toEqual([
        '[ErrorHandler] Uncaught Exception:',
        '[ErrorHandler] Critical error, initiating graceful shutdown',
      ]);
      expect(calls[0]?.[1]?.message).toBe('[redacted]');
      expect(calls[0]?.[1]?.stack).toBe('[redacted]');
      expectNoSentinels(spies, 2);
      expect(electron.app.quit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(electron.app.quit).toHaveBeenCalledTimes(1);
      push();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not quit on an uncaught exception when graceful shutdown is off', async () => {
    const { spies, exception, push } = await installHandlers(false);
    const electron = await import('electron');

    exception(makeSecretError());

    expect(spies.error).toHaveBeenCalledTimes(1);
    expect(electron.app.quit).not.toHaveBeenCalled();
    expectNoSentinels(spies);
    push();
  });
});
