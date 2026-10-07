/* global AbortSignal, AbortController */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { registerShutdownHandler as RegisterShutdownHandler } from './registerShutdown.js';
import type * as StartupAdmission from '../utils/lifecycle/startupAdmission.js';

type BeforeQuitEvent = { preventDefault: () => void };
type BeforeQuitListener = (event: BeforeQuitEvent) => void;
type WindowAllClosedListener = () => void;

const mocks = vi.hoisted(() => {
  const beforeQuitListeners: BeforeQuitListener[] = [];
  const windowAllClosedListeners: WindowAllClosedListener[] = [];

  return {
    app: {
      on: vi.fn((event: string, listener: BeforeQuitListener | WindowAllClosedListener): void => {
        if (event === 'before-quit') beforeQuitListeners.push(listener as BeforeQuitListener);
        if (event === 'window-all-closed') {
          windowAllClosedListeners.push(listener as WindowAllClosedListener);
        }
      }),
      exit: vi.fn(),
      quit: vi.fn(),
    },
    beforeQuitListeners,
    windowAllClosedListeners,
    cleanupAll: vi.fn().mockResolvedValue(undefined),
    cleanupResources: vi.fn().mockResolvedValue(undefined),
    getSharedFeatureContext: vi.fn().mockReturnValue({}),
    destroyAccountWindowManager: vi.fn(),
    peekAccountWindowManager: vi.fn(() => ({
      listAccountIndices: () => [0, 1],
      saveAccountWindowState: vi.fn(),
    })),
    flushAccountWindowPersistence: vi.fn(async () => undefined),
    destroyAllSingletons: vi.fn(),
    logShutdownDiagnostics: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('electron', () => ({ app: mocks.app }));
vi.mock('electron-log', () => ({
  default: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('../utils/lifecycle/featureRunner.js', () => ({ cleanupAll: mocks.cleanupAll }));
vi.mock('../utils/lifecycle/featureContextStore.js', () => ({
  getSharedFeatureContext: mocks.getSharedFeatureContext,
}));
vi.mock('../utils/lifecycle/resourceCleanup.js', () => ({
  getCleanupManager: () => ({ cleanup: mocks.cleanupResources }),
}));
vi.mock('../utils/account/accountWindowManager.js', () => ({
  destroyAccountWindowManager: mocks.destroyAccountWindowManager,
  peekAccountWindowManager: mocks.peekAccountWindowManager,
}));
vi.mock('../utils/account/accountWindowPersistenceBridge.js', () => ({
  flushAccountWindowPersistence: mocks.flushAccountWindowPersistence,
}));
vi.mock('./singletonDestroyers.js', () => ({ destroyAllSingletons: mocks.destroyAllSingletons }));
vi.mock('./shutdownDiagnostics.js', () => ({
  logShutdownDiagnostics: mocks.logShutdownDiagnostics,
}));

import {
  SHUTDOWN_OVERALL_TIMEOUT_MS,
  SHUTDOWN_STAGE_TIMEOUT_MS,
  type ShutdownDeadlineFactory,
} from './registerShutdown.js';
let registerShutdownHandler: typeof RegisterShutdownHandler;
let admission: typeof StartupAdmission;

function getBeforeQuitListener(): BeforeQuitListener {
  const listener = mocks.beforeQuitListeners[0];
  if (!listener) throw new Error('before-quit listener was not registered');
  return listener;
}

function getWindowAllClosedListener(): WindowAllClosedListener {
  const listener = mocks.windowAllClosedListeners[0];
  if (!listener) throw new Error('window-all-closed listener was not registered');
  return listener;
}

async function waitForShutdown(): Promise<void> {
  await vi.waitFor(() => expect(mocks.app.exit).toHaveBeenCalledTimes(1));
}

function recordShutdownOrder(order: string[]): void {
  mocks.cleanupAll.mockImplementation(async () => {
    order.push('features');
  });
  mocks.cleanupResources.mockImplementation(async () => {
    order.push('global');
  });
  mocks.destroyAccountWindowManager.mockImplementation(() => {
    order.push('accounts');
  });
  mocks.logShutdownDiagnostics.mockImplementation(async () => {
    order.push('diagnostics');
  });
  mocks.destroyAllSingletons.mockImplementation(() => {
    order.push('singletons');
  });
  mocks.app.exit.mockImplementation(() => {
    order.push('exit');
  });
}

describe('registerShutdownHandler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(async () => {
    vi.resetModules();
    ({ registerShutdownHandler } = await import('./registerShutdown.js'));
    admission = await import('../utils/lifecycle/startupAdmission.js');
    vi.clearAllMocks();
    vi.useRealTimers();
    mocks.beforeQuitListeners.length = 0;
    mocks.windowAllClosedListeners.length = 0;
    mocks.cleanupAll.mockResolvedValue(undefined);
    mocks.cleanupResources.mockResolvedValue(undefined);
    mocks.logShutdownDiagnostics.mockResolvedValue(undefined);
    mocks.app.exit.mockImplementation(() => undefined);
    mocks.app.quit.mockImplementation(() => undefined);
    mocks.flushAccountWindowPersistence.mockReset();
    mocks.flushAccountWindowPersistence.mockResolvedValue(undefined);
    mocks.peekAccountWindowManager.mockImplementation(() => ({
      listAccountIndices: () => [0, 1],
      saveAccountWindowState: vi.fn(),
    }));
  });

  it('runs global cleanup in the ordered shutdown sequence', async () => {
    const order: string[] = [];
    recordShutdownOrder(order);

    registerShutdownHandler();
    const event = { preventDefault: vi.fn() };
    getBeforeQuitListener()(event);

    await waitForShutdown();

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(mocks.cleanupResources).toHaveBeenCalledWith({
      includeGlobalResources: true,
      logDetails: true,
    });
    expect(order).toEqual(['features', 'global', 'accounts', 'diagnostics', 'singletons', 'exit']);
    expect(mocks.peekAccountWindowManager).toHaveBeenCalled();
    expect(mocks.flushAccountWindowPersistence).toHaveBeenCalled();
    expect(mocks.logShutdownDiagnostics).toHaveBeenCalledWith({ accountIndices: [0, 1] });
  });

  it('saves every live and dehydrated account, flushes, then destroys', async () => {
    const steps: string[] = [];
    mocks.peekAccountWindowManager.mockReturnValueOnce({
      listAccountIndices: () => [0, 2],
      saveAccountWindowState: (accountIndex: number) => {
        steps.push(`save:${accountIndex}`);
      },
    });
    mocks.flushAccountWindowPersistence.mockImplementationOnce(async () => {
      steps.push('flush');
    });
    mocks.destroyAccountWindowManager.mockImplementationOnce(() => {
      steps.push('destroy');
    });

    registerShutdownHandler();
    getBeforeQuitListener()({ preventDefault: vi.fn() });
    await waitForShutdown();

    expect(steps).toEqual(['save:0', 'save:2', 'flush', 'destroy']);
    expect(mocks.logShutdownDiagnostics).toHaveBeenCalledWith({ accountIndices: [0, 2] });
  });

  it('closes startup synchronously before scheduling cleanup and shares the stage/overall budget', async () => {
    const stage = new AbortController();
    const overall = new AbortController();
    let featureSignal: AbortSignal | undefined;
    mocks.cleanupAll.mockImplementation(async (_context, signal: AbortSignal) => {
      featureSignal = signal;
    });
    registerShutdownHandler({
      createStageSignal: () => stage.signal,
      createOverallSignal: () => overall.signal,
    });
    expect(admission.isStartupAdmissionOpen()).toBe(true);
    getBeforeQuitListener()({ preventDefault: vi.fn() });
    expect(admission.isStartupAdmissionOpen()).toBe(false);
    expect(mocks.cleanupAll).not.toHaveBeenCalled();
    await waitForShutdown();
    expect(featureSignal?.aborted).toBe(false);
    overall.abort();
    expect(featureSignal?.aborted).toBe(true);
    expect(mocks.app.exit).toHaveBeenCalledTimes(1);
  });

  it('continues through every remaining stage when feature cleanup rejects', async () => {
    const order: string[] = [];
    recordShutdownOrder(order);
    mocks.cleanupAll.mockImplementation(async () => {
      order.push('features');
      throw new Error('feature cleanup failed');
    });

    registerShutdownHandler();
    getBeforeQuitListener()({ preventDefault: vi.fn() });

    await waitForShutdown();

    expect(order).toEqual(['features', 'global', 'accounts', 'diagnostics', 'singletons', 'exit']);
    expect(mocks.app.exit).toHaveBeenCalledOnce();
  });

  it('continues through every remaining stage when global cleanup rejects', async () => {
    const order: string[] = [];
    recordShutdownOrder(order);
    mocks.cleanupResources.mockImplementation(async () => {
      order.push('global');
      throw new Error('global cleanup failed');
    });

    registerShutdownHandler();
    getBeforeQuitListener()({ preventDefault: vi.fn() });

    await waitForShutdown();

    expect(order).toEqual(['features', 'global', 'accounts', 'diagnostics', 'singletons', 'exit']);
    expect(mocks.app.exit).toHaveBeenCalledOnce();
  });

  it('runs cleanup and exits only once when before-quit repeats', async () => {
    registerShutdownHandler();
    const event = { preventDefault: vi.fn() };
    const listener = getBeforeQuitListener();

    listener(event);
    listener(event);

    await waitForShutdown();

    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(mocks.cleanupAll).toHaveBeenCalledOnce();
    expect(mocks.cleanupResources).toHaveBeenCalledOnce();
    expect(mocks.destroyAccountWindowManager).toHaveBeenCalledOnce();
    expect(mocks.logShutdownDiagnostics).toHaveBeenCalledOnce();
    expect(mocks.destroyAllSingletons).toHaveBeenCalledOnce();
    expect(mocks.app.exit).toHaveBeenCalledOnce();
  });

  function timeoutSignal(ms: number): AbortSignal {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, ms);
    return controller.signal;
  }

  const fakeDeadlines: ShutdownDeadlineFactory = {
    createStageSignal: () => timeoutSignal(SHUTDOWN_STAGE_TIMEOUT_MS),
    createOverallSignal: () => timeoutSignal(SHUTDOWN_OVERALL_TIMEOUT_MS),
  };

  it('abandons a pending stage after 2s and continues later stages in order', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    recordShutdownOrder(order);
    mocks.cleanupAll.mockImplementation(() => new Promise(() => undefined));

    registerShutdownHandler(fakeDeadlines);
    getBeforeQuitListener()({ preventDefault: vi.fn() });

    await vi.advanceTimersByTimeAsync(SHUTDOWN_STAGE_TIMEOUT_MS);
    await Promise.resolve();

    expect(order).toEqual(['global', 'accounts', 'diagnostics', 'singletons', 'exit']);
    expect(mocks.app.exit).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('observes a late rejection after the stage deadline without unhandled rejection', async () => {
    vi.useFakeTimers();
    const late = Promise.withResolvers<void>();
    mocks.cleanupAll.mockReturnValue(late.promise);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    registerShutdownHandler(fakeDeadlines);
    getBeforeQuitListener()({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(SHUTDOWN_STAGE_TIMEOUT_MS);
    await Promise.resolve();

    late.reject(new Error('feature cleanup late'));
    await Promise.resolve();
    await Promise.resolve();

    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
    expect(mocks.app.exit).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('exits once when the overall 8s ceiling fires while a stage is still pending', async () => {
    vi.useFakeTimers();
    mocks.cleanupAll.mockImplementation(() => new Promise(() => undefined));
    mocks.cleanupResources.mockImplementation(() => new Promise(() => undefined));
    mocks.destroyAccountWindowManager.mockImplementation(() => new Promise(() => undefined));
    mocks.logShutdownDiagnostics.mockImplementation(() => new Promise(() => undefined));
    mocks.destroyAllSingletons.mockImplementation(() => new Promise(() => undefined));

    const deadlines: ShutdownDeadlineFactory = {
      createStageSignal: () => timeoutSignal(60_000),
      createOverallSignal: () => timeoutSignal(SHUTDOWN_OVERALL_TIMEOUT_MS),
    };

    registerShutdownHandler(deadlines);
    getBeforeQuitListener()({ preventDefault: vi.fn() });

    await vi.advanceTimersByTimeAsync(SHUTDOWN_OVERALL_TIMEOUT_MS);
    await Promise.resolve();

    expect(mocks.app.exit).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('abandons a stage immediately when its deadline is already expired', async () => {
    const order: string[] = [];
    recordShutdownOrder(order);
    const deadlines: ShutdownDeadlineFactory = {
      createStageSignal: () => {
        const controller = new AbortController();
        controller.abort();
        return controller.signal;
      },
      createOverallSignal: () => new AbortController().signal,
    };

    registerShutdownHandler(deadlines);
    getBeforeQuitListener()({ preventDefault: vi.fn() });
    await waitForShutdown();
    await vi.waitFor(() => {
      expect(order).toEqual(
        expect.arrayContaining([
          'features',
          'global',
          'accounts',
          'diagnostics',
          'singletons',
          'exit',
        ])
      );
    });

    expect(order.filter((step) => step === 'exit')).toEqual(['exit']);
    expect(mocks.app.exit).toHaveBeenCalledOnce();
  });

  it('exits immediately when the overall deadline is already expired', async () => {
    mocks.cleanupAll.mockImplementation(() => new Promise(() => undefined));
    const deadlines: ShutdownDeadlineFactory = {
      createStageSignal: () => new AbortController().signal,
      createOverallSignal: () => {
        const controller = new AbortController();
        controller.abort();
        return controller.signal;
      },
    };

    registerShutdownHandler(deadlines);
    getBeforeQuitListener()({ preventDefault: vi.fn() });
    await waitForShutdown();
    expect(mocks.app.exit).toHaveBeenCalledOnce();
  });

  it.each(['feature', 'global', 'accounts', 'diagnostics', 'singletons'] as const)(
    'honors GOGCHAT_TEST_HANG_SHUTDOWN=%s and still exits after the stage deadline',
    async (stage) => {
      vi.useFakeTimers();
      process.env['GOGCHAT_TEST_HANG_SHUTDOWN'] = stage;
      try {
        registerShutdownHandler(fakeDeadlines);
        getBeforeQuitListener()({ preventDefault: vi.fn() });
        await vi.advanceTimersByTimeAsync(SHUTDOWN_STAGE_TIMEOUT_MS * 5);
        await Promise.resolve();
        expect(mocks.app.exit).toHaveBeenCalled();
      } finally {
        delete process.env['GOGCHAT_TEST_HANG_SHUTDOWN'];
        vi.useRealTimers();
      }
    }
  );

  it('routes window-all-closed through orderly shutdown', async () => {
    const order: string[] = [];
    recordShutdownOrder(order);
    mocks.app.quit.mockImplementation(() => {
      getBeforeQuitListener()({ preventDefault: vi.fn() });
    });

    registerShutdownHandler();
    getWindowAllClosedListener()();

    await waitForShutdown();

    expect(mocks.app.quit).toHaveBeenCalledOnce();
    expect(order).toEqual(['features', 'global', 'accounts', 'diagnostics', 'singletons', 'exit']);
    expect(mocks.app.exit).toHaveBeenCalledOnce();
  });
});
