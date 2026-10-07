import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { asAccountIndex } from '../../shared/types/branded.js';
import type { registerAppReady as RegisterAppReady } from './registerAppReady.js';
import type { closeStartupAdmission as CloseStartupAdmission } from '../utils/lifecycle/startupAdmission.js';

type ReadyHandler = () => Promise<void> | void;
type WcListener = (...args: unknown[]) => void;

const mocks = vi.hoisted(() => {
  const order: string[] = [];
  const didFinishLoadListeners: WcListener[] = [];
  const didFailLoadListeners: WcListener[] = [];

  const account0Wc = {
    isDestroyed: vi.fn(() => false),
    once: vi.fn((event: string, listener: WcListener) => {
      if (event === 'did-finish-load') didFinishLoadListeners.push(listener);
    }),
    on: vi.fn((event: string, listener: WcListener) => {
      if (event === 'did-fail-load') didFailLoadListeners.push(listener);
    }),
  };

  const hostOnlyWc = {
    isDestroyed: vi.fn(() => false),
    once: vi.fn(),
    on: vi.fn(),
  };

  const preconnect = vi.fn((opts: { url: string; numSockets: number }) => {
    order.push(`preconnect:${opts.url}`);
  });

  const accountWindowManager = {
    markAsBootstrap: vi.fn(),
    getAccountWebContents: vi.fn(() => account0Wc),
    hostWebContents: hostOnlyWc,
  };

  const mainWindow = { id: 1, isDestroyed: () => false };

  return {
    order,
    didFinishLoadListeners,
    didFailLoadListeners,
    account0Wc,
    hostOnlyWc,
    preconnect,
    accountWindowManager,
    mainWindow,
    whenReadyThen: vi.fn((handler: ReadyHandler) => {
      return Promise.resolve()
        .then(handler)
        .then(() => ({ catch: vi.fn() }));
    }),
    app: {
      whenReady: vi.fn(),
      quit: vi.fn(),
      isPackaged: true,
    },
    sessionFromPartition: vi.fn(() => ({ preconnect })),
    initializeErrorHandler: vi.fn(),
    registerGlobalCleanups: vi.fn(async () => {
      order.push('global-cleanups');
    }),
    runPhase: vi.fn(async (phase: string) => {
      order.push(`phase:${phase}`);
    }),
    initializeStore: vi.fn(async () => {
      order.push('store-init');
    }),
    prepareAccountWindows: vi.fn(async () => {
      order.push('prepare-account-windows');
    }),
    getAccountWindowManager: vi.fn(() => accountWindowManager),
    createAccountWindow: vi.fn(() => {
      order.push('create-account-0');
      return mainWindow;
    }),
    getWindowForAccount: vi.fn(() => mainWindow),
    setSharedFeatureContext: vi.fn(),
    armPerformanceFinalizer: vi.fn(),
    notifyDocumentLoadComplete: vi.fn(() => {
      order.push('notify-document-load-complete');
    }),
    notifyDocumentLoadFailed: vi.fn(() => {
      order.push('notify-document-load-failed');
    }),
    warmInitialIcons: vi.fn(() => {
      order.push('warm-initial-icons');
    }),
    warmSoonDeferredIcons: vi.fn(() => {
      order.push('warm-soon-icons');
    }),
    runDeferredPhase: vi.fn(async () => {
      order.push('deferred-phase');
    }),
    createTrackedInterval: vi.fn(),
    perfMark: vi.fn((name: string) => {
      order.push(`mark:${name}`);
    }),
    sampleAllRenderers: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: mocks.app,
  session: { fromPartition: mocks.sessionFromPartition },
}));
vi.mock('electron-log', () => ({
  default: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('../utils/lifecycle/performanceMonitor.js', () => ({
  perfMonitor: {
    mark: mocks.perfMark,
    sampleAllRenderers: mocks.sampleAllRenderers,
  },
}));
vi.mock('../utils/lifecycle/errorHandler.js', () => ({
  initializeErrorHandler: mocks.initializeErrorHandler,
}));
vi.mock('../utils/account/accountWindowManager.js', () => ({
  getAccountWindowManager: mocks.getAccountWindowManager,
  createAccountWindow: mocks.createAccountWindow,
  getWindowForAccount: mocks.getWindowForAccount,
  getMostRecentWindow: vi.fn(),
}));
vi.mock('./registerGlobalCleanups.js', () => ({
  registerGlobalCleanups: mocks.registerGlobalCleanups,
}));
vi.mock('../config.js', () => ({
  initializeStore: mocks.initializeStore,
}));
vi.mock('../utils/account/accountWindowPersistenceBridge.js', () => ({
  prepareAccountWindows: mocks.prepareAccountWindows,
}));
vi.mock('../utils/account/cacheWarmer.js', () => ({
  warmInitialIcons: mocks.warmInitialIcons,
  warmSoonDeferredIcons: mocks.warmSoonDeferredIcons,
  runDeferredPhase: mocks.runDeferredPhase,
}));
vi.mock('../utils/lifecycle/resourceCleanup.js', () => ({
  createTrackedInterval: mocks.createTrackedInterval,
}));
vi.mock('../../environment.js', () => ({
  default: { appUrl: 'https://mail.google.com/chat/u/0', isDev: false },
}));
vi.mock('../utils/lifecycle/featureRunner.js', () => ({
  runPhase: mocks.runPhase,
}));
vi.mock('../utils/lifecycle/featureContextStore.js', () => ({
  setSharedFeatureContext: mocks.setSharedFeatureContext,
}));
vi.mock('../utils/lifecycle/performanceFinalizer.js', () => ({
  armPerformanceFinalizer: mocks.armPerformanceFinalizer,
  notifyDocumentLoadComplete: mocks.notifyDocumentLoadComplete,
}));

import log from 'electron-log';
import {
  SECRET_AUTH_URL,
  expectNoSentinels,
  makeSecretError,
  messagesAt,
  spiesOf,
} from '../../../tests/mocks/logCapture';
let registerAppReady: typeof RegisterAppReady;
let closeStartupAdmission: typeof CloseStartupAdmission;

const scheduledImmediates: Array<(...args: unknown[]) => void> = [];

function flushImmediate(): void {
  const pending = scheduledImmediates.splice(0);
  for (const fn of pending) {
    fn();
  }
}

async function runReady(): Promise<void> {
  let readyHandler: ReadyHandler | undefined;
  mocks.app.whenReady.mockImplementation(() => ({
    then(handler: ReadyHandler) {
      readyHandler = handler;
      return {
        catch(onRejected: (error: unknown) => void) {
          void Promise.resolve()
            .then(() => readyHandler?.())
            .catch(onRejected);
          return undefined;
        },
      };
    },
  }));

  registerAppReady({
    windowFactory: { createWindow: vi.fn() },
    setMainWindow: vi.fn(),
    getMainWindow: vi.fn(() => mocks.mainWindow as never),
    registerCleanupTask: vi.fn(),
  });

  await vi.waitFor(() => {
    expect(readyHandler).toBeTypeOf('function');
  });
}

describe('registerAppReady characterization', () => {
  const originalPreconnect = process.env['GOGCHAT_DISABLE_PRECONNECT'];

  beforeEach(async () => {
    vi.resetModules();
    ({ registerAppReady } = await import('./registerAppReady.js'));
    ({ closeStartupAdmission } = await import('../utils/lifecycle/startupAdmission.js'));
    mocks.order.length = 0;
    mocks.didFinishLoadListeners.length = 0;
    mocks.didFailLoadListeners.length = 0;
    scheduledImmediates.length = 0;
    vi.spyOn(global, 'setImmediate').mockImplementation(((fn: (...args: unknown[]) => void) => {
      scheduledImmediates.push(fn);
      return {
        hasRef: () => false,
        ref: () => undefined,
        unref: () => undefined,
      } as NodeJS.Immediate;
    }) as typeof setImmediate);
    vi.clearAllMocks();
    mocks.runPhase.mockImplementation(async (phase: string) => {
      mocks.order.push(`phase:${phase}`);
    });
    mocks.initializeStore.mockImplementation(async () => {
      mocks.order.push('store-init');
    });
    mocks.prepareAccountWindows.mockImplementation(async () => {
      mocks.order.push('prepare-account-windows');
    });
    mocks.runDeferredPhase.mockImplementation(async () => {
      mocks.order.push('deferred-phase');
    });
    mocks.account0Wc.isDestroyed.mockReturnValue(false);
    mocks.accountWindowManager.getAccountWebContents.mockReturnValue(mocks.account0Wc);
    mocks.app.isPackaged = true;
    delete process.env['GOGCHAT_DISABLE_PRECONNECT'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalPreconnect === undefined) {
      delete process.env['GOGCHAT_DISABLE_PRECONNECT'];
    } else {
      process.env['GOGCHAT_DISABLE_PRECONNECT'] = originalPreconnect;
    }
  });

  it('runs security with global cleanup, then critical with store init, then preconnect before account-0', async () => {
    await runReady();
    await vi.waitFor(() => expect(mocks.createAccountWindow).toHaveBeenCalled());

    const security = mocks.order.indexOf('phase:security');
    const cleanups = mocks.order.indexOf('global-cleanups');
    const critical = mocks.order.indexOf('phase:critical');
    const store = mocks.order.indexOf('store-init');
    const prepare = mocks.order.indexOf('prepare-account-windows');
    const firstPreconnect = mocks.order.findIndex((item) => item.startsWith('preconnect:'));
    const account0 = mocks.order.indexOf('create-account-0');
    const ui = mocks.order.indexOf('phase:ui');

    expect(security).toBeGreaterThanOrEqual(0);
    expect(cleanups).toBeGreaterThanOrEqual(0);
    expect(Math.max(security, cleanups)).toBeLessThan(critical);
    expect(Math.max(security, cleanups)).toBeLessThan(store);
    expect(Math.max(critical, store)).toBeLessThan(prepare);
    expect(prepare).toBeLessThan(firstPreconnect);
    expect(firstPreconnect).toBeLessThan(account0);
    expect(account0).toBeLessThan(ui);

    expect(mocks.sessionFromPartition).toHaveBeenCalledWith('persist:account-0');
    expect(mocks.createAccountWindow).toHaveBeenCalledWith(
      'https://mail.google.com/chat/u/0',
      asAccountIndex(0)
    );
    expect(mocks.accountWindowManager.markAsBootstrap).toHaveBeenCalledWith(asAccountIndex(0));
    expect(mocks.armPerformanceFinalizer).toHaveBeenCalledTimes(1);
  });

  it('attaches load markers to account WebContents, not a WCV host, and treats hard fail-load as non-terminal', async () => {
    await runReady();
    await vi.waitFor(() =>
      expect(mocks.accountWindowManager.getAccountWebContents).toHaveBeenCalledWith(
        asAccountIndex(0)
      )
    );

    expect(mocks.account0Wc.once).toHaveBeenCalledWith('did-finish-load', expect.any(Function));
    expect(mocks.account0Wc.on).toHaveBeenCalledWith('did-fail-load', expect.any(Function));
    expect(mocks.hostOnlyWc.once).not.toHaveBeenCalled();
    expect(mocks.hostOnlyWc.on).not.toHaveBeenCalled();

    const finish = mocks.didFinishLoadListeners[0];
    expect(finish).toBeTypeOf('function');
    finish?.();
    expect(mocks.notifyDocumentLoadComplete).toHaveBeenCalledTimes(1);
    expect(mocks.order).toContain('mark:account-0-content-loaded');
    expect(mocks.order).toContain('notify-document-load-complete');

    const fail = mocks.didFailLoadListeners[0];
    expect(fail).toBeTypeOf('function');
    fail?.(undefined, -2, 'ERR_FAILED', 'https://mail.google.com/chat/u/0', true);
    expect(mocks.notifyDocumentLoadComplete).toHaveBeenCalledTimes(1);
    expect(mocks.order).not.toContain('notify-document-load-failed');
    expect(mocks.app.quit).not.toHaveBeenCalled();
  });

  it('logs a hard main-frame load failure without its description or URL', async () => {
    await runReady();
    await vi.waitFor(() => expect(mocks.didFailLoadListeners).toHaveLength(1));
    const fail = mocks.didFailLoadListeners[0];

    fail?.(
      undefined,
      -102,
      `ERR_CONNECTION_REFUSED loading '${SECRET_AUTH_URL}'`,
      SECRET_AUTH_URL,
      true
    );

    expect(messagesAt(spiesOf(log), 'warn')).toEqual([
      '[Main] Account-0 did-fail-load (non-terminal for metrics): code=-102',
    ]);
    expectNoSentinels(spiesOf(log));
  });

  it('logs an error-handler initialization failure without its Error and keeps starting', async () => {
    mocks.initializeErrorHandler.mockImplementationOnce(() => {
      throw makeSecretError();
    });
    await runReady();
    await vi.waitFor(() => expect(mocks.initializeStore).toHaveBeenCalled());

    expect(messagesAt(spiesOf(log), 'error')).toEqual([
      '[Main] Failed to initialize error handler',
    ]);
    expect(mocks.app.quit).not.toHaveBeenCalled();
    expectNoSentinels(spiesOf(log));
  });

  it('logs a store initialization failure and the fatal startup failure without their Errors', async () => {
    mocks.initializeStore.mockRejectedValueOnce(makeSecretError());
    await runReady();
    await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledTimes(1));

    expect(messagesAt(spiesOf(log), 'error')).toEqual([
      '[Main] Failed to initialize critical phase or store',
      '[Main] Failed to initialize application',
    ]);
    expectNoSentinels(spiesOf(log), 2);
  });

  it('logs a deferred-phase failure carrying secrets as the fixed placeholder Error', async () => {
    mocks.runDeferredPhase.mockRejectedValueOnce(makeSecretError());
    await runReady();
    await vi.waitFor(() => expect(scheduledImmediates).toHaveLength(1));
    flushImmediate();
    await vi.waitFor(() => expect(log.error).toHaveBeenCalled());

    expect(log.error).toHaveBeenCalledWith(
      '[Main] Failed to initialize deferred features:',
      expect.objectContaining({ message: '[redacted]', stack: '[redacted]' })
    );
    expectNoSentinels(spiesOf(log));
  });

  it('schedules deferred work on setImmediate after the UI phase', async () => {
    await runReady();
    await vi.waitFor(() => expect(mocks.runPhase).toHaveBeenCalledWith('ui', expect.anything()));

    expect(mocks.order).toContain('phase:ui');
    expect(mocks.order).not.toContain('deferred-phase');
    expect(mocks.order).not.toContain('warm-initial-icons');
    expect(scheduledImmediates.length).toBe(1);

    flushImmediate();
    await vi.waitFor(() => expect(mocks.runDeferredPhase).toHaveBeenCalled());

    const ui = mocks.order.indexOf('phase:ui');
    const warm = mocks.order.indexOf('warm-initial-icons');
    const deferred = mocks.order.indexOf('deferred-phase');
    expect(ui).toBeGreaterThanOrEqual(0);
    expect(warm).toBeGreaterThan(ui);
    expect(deferred).toBeGreaterThan(warm);
    expect(mocks.warmSoonDeferredIcons).toHaveBeenCalledTimes(1);
  });

  it('does not relabel readiness when deferred phase rejects', async () => {
    const error = new Error('deferred exploded');
    mocks.runDeferredPhase.mockImplementation(() => {
      mocks.order.push('deferred-phase');
      return Promise.reject(error);
    });

    await runReady();
    await vi.waitFor(() => expect(mocks.runPhase).toHaveBeenCalledWith('ui', expect.anything()));
    flushImmediate();
    await vi.waitFor(() => expect(mocks.runDeferredPhase).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(log.error).toHaveBeenCalledWith(
        '[Main] Failed to initialize deferred features:',
        expect.objectContaining({ message: '[redacted]', stack: '[redacted]' })
      )
    );

    expect(mocks.order).toContain('mark:account-0-ready');
    expect(mocks.order).toContain('phase:ui');
    expect(mocks.app.quit).not.toHaveBeenCalled();
    expect(mocks.notifyDocumentLoadComplete).not.toHaveBeenCalled();
  });

  it('does not create account-0, run UI, or schedule deferred when required security fails', async () => {
    mocks.runPhase.mockImplementation(async (phase: string) => {
      mocks.order.push(`phase:${phase}`);
      if (phase === 'security') {
        throw new Error('required security failed');
      }
    });

    await runReady();
    await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledTimes(1));
    flushImmediate();

    expect(mocks.createAccountWindow).not.toHaveBeenCalled();
    expect(mocks.runPhase).not.toHaveBeenCalledWith('critical', expect.anything());
    expect(mocks.runPhase).not.toHaveBeenCalledWith('ui', expect.anything());
    expect(mocks.runDeferredPhase).not.toHaveBeenCalled();
    expect(mocks.preconnect).not.toHaveBeenCalled();
    expect(mocks.armPerformanceFinalizer).not.toHaveBeenCalled();
  });

  it('does no ready work when admission closes before whenReady resumes', async () => {
    closeStartupAdmission();
    await runReady();
    await Promise.resolve();
    expect(mocks.initializeErrorHandler).not.toHaveBeenCalled();
    expect(mocks.runPhase).not.toHaveBeenCalled();
    expect(mocks.getAccountWindowManager).not.toHaveBeenCalled();
  });

  it.each(['security', 'critical', 'ui'])(
    'stops startup when held %s resumes after quit',
    async (phase) => {
      const held = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      mocks.runPhase.mockImplementation(async (current: string) => {
        mocks.order.push(`phase:${current}`);
        if (current === phase) {
          entered.resolve();
          await held.promise;
        }
      });
      await runReady();
      await entered.promise;

      closeStartupAdmission();
      held.resolve();
      for (let microtask = 0; microtask < 12; microtask += 1) await Promise.resolve();

      expect(scheduledImmediates).toHaveLength(0);
      if (phase !== 'ui') {
        expect(mocks.getAccountWindowManager).not.toHaveBeenCalled();
        expect(mocks.createAccountWindow).not.toHaveBeenCalled();
        expect(mocks.runPhase).not.toHaveBeenCalledWith('ui', expect.anything());
      } else {
        expect(mocks.order).not.toContain('mark:features-loaded');
      }
    }
  );

  it('does not construct the manager when held store initialization resumes after quit', async () => {
    const held = Promise.withResolvers<void>();
    mocks.initializeStore.mockImplementation(() => held.promise);
    await runReady();
    await vi.waitFor(() => expect(mocks.initializeStore).toHaveBeenCalled());
    closeStartupAdmission();
    held.resolve();
    for (let microtask = 0; microtask < 12; microtask += 1) await Promise.resolve();
    expect(mocks.getAccountWindowManager).not.toHaveBeenCalled();
    expect(mocks.order).not.toContain('mark:store-init-end');
  });

  it.each([false, true])(
    'guards detached warming across callback/import boundary (started=%s)',
    async (started) => {
      await runReady();
      await vi.waitFor(() => expect(scheduledImmediates).toHaveLength(1));
      if (started) flushImmediate();
      closeStartupAdmission();
      if (!started) flushImmediate();
      for (let microtask = 0; microtask < 12; microtask += 1) await Promise.resolve();
      expect(mocks.warmInitialIcons).not.toHaveBeenCalled();
      expect(mocks.runDeferredPhase).not.toHaveBeenCalled();
      expect(mocks.createTrackedInterval).not.toHaveBeenCalled();
    }
  );

  it('guards document-load and renderer sampling callbacks after quit', async () => {
    mocks.app.isPackaged = false;
    await runReady();
    await vi.waitFor(() => expect(scheduledImmediates).toHaveLength(1));
    flushImmediate();
    await vi.waitFor(() => expect(mocks.createTrackedInterval).toHaveBeenCalled());
    const sample = mocks.createTrackedInterval.mock.calls[0]?.[0];
    closeStartupAdmission();
    mocks.didFinishLoadListeners[0]?.();
    sample();
    expect(mocks.notifyDocumentLoadComplete).not.toHaveBeenCalled();
    expect(mocks.sampleAllRenderers).not.toHaveBeenCalled();
  });

  it('observes deferred rejection even after admission closes', async () => {
    const held = Promise.withResolvers<void>();
    mocks.runDeferredPhase.mockImplementation(() => held.promise);
    await runReady();
    await vi.waitFor(() => expect(scheduledImmediates).toHaveLength(1));
    flushImmediate();
    await vi.waitFor(() => expect(mocks.runDeferredPhase).toHaveBeenCalled());
    closeStartupAdmission();
    const error = new Error('late deferred failure');
    held.reject(error);
    await vi.waitFor(() =>
      expect(log.error).toHaveBeenCalledWith(
        '[Main] Failed to initialize deferred features:',
        expect.objectContaining({ message: '[redacted]', stack: '[redacted]' })
      )
    );
    expect(mocks.app.quit).not.toHaveBeenCalled();
  });
});
