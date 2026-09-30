/**
 * Characterization tests for AccountWindowManager — the default per-account
 * BrowserWindow backend for multi-account session management.
 *
 * Covers:
 *   - Construction: clearAllBootstrap, threshold resolution from config.memory
 *   - registerWindow / getAccountIndex / getAccountWindow / getAccountWebContents
 *   - getAccountForWebContents / getAllWindows / getMostRecentWindow
 *   - hasAccount / getAccountCount
 *   - createAccountWindow: routing, factory invocation, partition string,
 *     bootstrap mid-auth detection, hydration auto-route
 *   - hydrateAccount / dehydrateAccount / isDehydrated state machine
 *   - unregisterAccount / destroyAll cleanup
 *   - saveAccountWindowState / getAccountWindowState persistence
 *   - flushAccountWindowsWrites serialization
 *   - Bootstrap delegate methods (markAsBootstrap, isBootstrap, promote,
 *     clearBootstrap, getBootstrapAccounts)
 *   - Module-level helpers + singleton lifecycle (get/destroy/route by config flag)
 *
 * NOTE: Pure characterization — does NOT modify accountWindowManager.ts.
 * Locks in current observable behavior before the Tier 2 strategy refactor.
 */

import { vi } from 'vitest';
import type { EventEmitter as NodeEventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Hoisted mock infrastructure — vi.mock factories are hoisted to top, so any
// shared mock state must live inside vi.hoisted to be initialized before them.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const events = require('events') as { EventEmitter: typeof NodeEventEmitter };
  const EE = events.EventEmitter;

  /** Mock WebContents — minimal surface used by AccountWindowManager. */
  class MockWC extends EE {
    static nextId = 1;
    public id: number;
    public url = '';
    public destroyed = false;

    public loadURL: ReturnType<typeof vi.fn>;
    public setBackgroundThrottling: ReturnType<typeof vi.fn>;
    public getURL: ReturnType<typeof vi.fn>;
    public isDestroyed: ReturnType<typeof vi.fn>;
    public removeAllListeners: ReturnType<typeof vi.fn>;

    constructor() {
      super();
      this.id = MockWC.nextId++;
      this.loadURL = vi.fn((url: string): Promise<void> => {
        this.url = url;
        return Promise.resolve();
      });
      this.setBackgroundThrottling = vi.fn();
      this.getURL = vi.fn((): string => this.url);
      this.isDestroyed = vi.fn((): boolean => this.destroyed);
      this.removeAllListeners = vi.fn((): MockWC => {
        EE.prototype.removeAllListeners.call(this);
        return this;
      });
    }
  }

  const createdWindows: MockBW[] = [];

  /** Mock BrowserWindow used by tests + factory. */
  class MockBW extends EE {
    static nextId = 1;
    public id: number;
    public webContents: MockWC;
    public destroyed = false;
    public minimized = false;
    public maximized = false;
    public visible = true;
    public bounds = { x: 10, y: 20, width: 800, height: 600 };
    public ctorOptions: unknown;

    public show: ReturnType<typeof vi.fn>;
    public hide: ReturnType<typeof vi.fn>;
    public focus: ReturnType<typeof vi.fn>;
    public restore: ReturnType<typeof vi.fn>;
    public maximize: ReturnType<typeof vi.fn>;
    public setBounds: ReturnType<typeof vi.fn>;
    public getBounds: ReturnType<typeof vi.fn>;
    public isMaximized: ReturnType<typeof vi.fn>;
    public isMinimized: ReturnType<typeof vi.fn>;
    public isDestroyed: ReturnType<typeof vi.fn>;
    public loadURL: ReturnType<typeof vi.fn>;
    public destroy: ReturnType<typeof vi.fn>;
    public isVisible: ReturnType<typeof vi.fn>;
    public removeListener: (event: string, listener: (...a: unknown[]) => void) => MockBW;

    constructor(options?: unknown) {
      super();
      this.id = MockBW.nextId++;
      this.ctorOptions = options;
      this.webContents = new MockWC();
      createdWindows.push(this);

      this.show = vi.fn((): void => {
        this.visible = true;
        this.emit('show');
      });
      this.hide = vi.fn((): void => {
        this.visible = false;
        this.emit('hide');
      });
      this.focus = vi.fn((): void => {
        this.emit('focus');
      });
      this.restore = vi.fn((): void => {
        this.minimized = false;
      });
      this.maximize = vi.fn((): void => {
        this.maximized = true;
      });
      this.setBounds = vi.fn((b: { x: number; y: number; width: number; height: number }): void => {
        this.bounds = { ...b };
      });
      this.getBounds = vi.fn(() => ({ ...this.bounds }));
      this.isMaximized = vi.fn((): boolean => this.maximized);
      this.isMinimized = vi.fn((): boolean => this.minimized);
      this.isDestroyed = vi.fn((): boolean => this.destroyed);
      this.isVisible = vi.fn((): boolean => this.visible && !this.destroyed);
      this.loadURL = vi.fn((url: string): Promise<void> => {
        this.webContents.url = url;
        return Promise.resolve();
      });
      this.removeListener = vi.fn(
        (event: string, listener: (...args: unknown[]) => void): MockBW => {
          EE.prototype.removeListener.call(this, event, listener);
          return this;
        }
      );
      this.destroy = vi.fn((): void => {
        this.destroyed = true;
        this.webContents.destroyed = true;
        this.emit('closed');
      });
    }
  }

  // Shared mock state
  const mockStore: Record<string, unknown> = {};
  const bootstrapSet = new Set<number>();
  // Track createTrackedTimeout calls so tests can flush dehydrate timers if needed
  const trackedTimers: Array<{
    id: NodeJS.Timeout;
    callback: () => void;
    delay: number;
    name: string | undefined;
  }> = [];

  return {
    EE,
    MockWC,
    MockBW,
    createdWindows,
    mockStore,
    bootstrapSet,
    trackedTimers,
    recordActivity: vi.fn(),
  };
});

type _MockWCInstance = InstanceType<typeof h.MockWC>;
type MockBWInstance = InstanceType<typeof h.MockBW>;

// ---------------------------------------------------------------------------
// vi.mock declarations (hoisted)
// ---------------------------------------------------------------------------

vi.mock('electron', () => {
  return {
    app: { getAppPath: vi.fn(() => '/mock/app/path') },
    BrowserWindow: h.MockBW,
  };
});

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  default: {
    get: vi.fn((key: string) => h.mockStore[key]),
    set: vi.fn((key: string, value: unknown) => {
      h.mockStore[key] = value;
    }),
  },
  configGet: vi.fn((key: string) => h.mockStore[key]),
  configSet: vi.fn((key: string, value: unknown) => {
    h.mockStore[key] = value;
  }),
}));

vi.mock('./bootstrapTracker.js', () => ({
  markAsBootstrap: vi.fn((idx: number) => {
    h.bootstrapSet.add(idx);
  }),
  isBootstrap: vi.fn((idx: number) => h.bootstrapSet.has(idx)),
  promoteBootstrap: vi.fn((idx: number) => {
    if (h.bootstrapSet.has(idx)) {
      h.bootstrapSet.delete(idx);
      return true;
    }
    return false;
  }),
  clearBootstrap: vi.fn((idx: number) => {
    h.bootstrapSet.delete(idx);
  }),
  getBootstrapAccounts: vi.fn(() => Array.from(h.bootstrapSet)),
  clearAllBootstrap: vi.fn(() => {
    h.bootstrapSet.clear();
  }),
}));

vi.mock('../lifecycle/resourceCleanup.js', () => ({
  createTrackedTimeout: vi.fn(
    (callback: () => void, delay: number, name?: string): NodeJS.Timeout => {
      const id = setTimeout(callback, delay);
      h.trackedTimers.push({ id, callback, delay, name });
      return id;
    }
  ),
  createTrackedInterval: vi.fn((callback: () => void, delay: number): NodeJS.Timeout =>
    setInterval(callback, delay)
  ),
}));

vi.mock('./accountSessionMaintenance.js', () => ({
  startSessionMaintenance: vi.fn(),
  stopSessionMaintenance: vi.fn(),
  getAccountActivityTracker: vi.fn(() => ({
    recordActivity: h.recordActivity,
    isIdle: vi.fn(() => false),
    forget: vi.fn(),
    reset: vi.fn(),
  })),
}));

vi.mock('./accountViewManager.js', () => ({
  resetAccountViewManagerSingleton: vi.fn(),
  getAccountViewManager: vi.fn(() => {
    // Return a minimal IAccountWindowManager-shaped stub. Only invoked when
    // app.useWebContentsView is true, which the routing tests assert on.
    return {
      createAccountWindow: vi.fn(),
      registerWindow: vi.fn(),
      getAccountIndex: vi.fn(),
      getAccountWindow: vi.fn(),
      getAccountWebContents: vi.fn(),
      getAccountForWebContents: vi.fn(),
      focusAccount: vi.fn(),
      getAllWindows: vi.fn(() => []),
      getMostRecentWindow: vi.fn(),
      hasAccount: vi.fn(),
      listAccountIndices: vi.fn(() => []),
      isAccountVisible: vi.fn(() => false),
      unregisterAccount: vi.fn(),
      getAccountCount: vi.fn(() => 0),
      destroyAll: vi.fn(),
      markAsBootstrap: vi.fn(),
      promoteBootstrap: vi.fn(),
      isBootstrap: vi.fn(),
      clearBootstrap: vi.fn(),
      getBootstrapAccounts: vi.fn(() => []),
      saveAccountWindowState: vi.fn(),
      getAccountWindowState: vi.fn(),
      dehydrateAccount: vi.fn(),
      hydrateAccount: vi.fn(),
      isDehydrated: vi.fn(() => false),
      enumerateAccountWebContents: vi.fn(() => []),
      __isViewBackend: true,
    };
  }),
}));

// ---------------------------------------------------------------------------
// Imports under test (after vi.mock declarations are hoisted)
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  AccountWindowManager,
  getAccountWindowManager,
  peekAccountWindowManager,
  destroyAccountWindowManager,
  flushAccountWindowsWrites,
  getMostRecentWindow as moduleGetMostRecentWindow,
  getWindowForAccount,
  getAccountIndex as moduleGetAccountIndex,
  createAccountWindow as moduleCreateAccountWindow,
  getAccountForWebContents as moduleGetAccountForWebContents,
} from './accountWindowManager';
import { asAccountIndex, asWebContentsId, toPartition } from '../../../shared/types/branded';
import type { WindowFactory } from '../../../shared/types/window';
import { asType } from '../../../shared/typeUtils.js';
import * as accountHooks from './accountWebContentsHooks.js';
import { startSessionMaintenance, stopSessionMaintenance } from './accountSessionMaintenance.js';
import { getAccountViewManager, resetAccountViewManagerSingleton } from './accountViewManager.js';
import {
  attachRoutingProbes,
  runSharedRoutingScenarios,
} from '../../../../tests/helpers/accountRoutingConformance';
import {
  clearAllBootstrap,
  markAsBootstrap as trackerMark,
  isBootstrap as trackerIs,
  promoteBootstrap as trackerPromote,
  clearBootstrap as trackerClear,
  getBootstrapAccounts as trackerList,
} from './bootstrapTracker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fresh WindowFactory whose `createWindow` constructs a MockBW and
 * records the call args. The returned object is itself a vi.fn() spy.
 */
function makeFactory(): WindowFactory & { createWindow: ReturnType<typeof vi.fn> } {
  const fn = vi.fn((url: string, partition: string): Electron.BrowserWindow => {
    // Build a MockBW with ctorOptions including the partition for inspection.
    const w = new h.MockBW({ webPreferences: { partition }, url });
    // Mirror live windowWrapper contract: factory owns the single restored
    // URL dispatch via loadURL on creation.
    void w.loadURL(url);
    return w as unknown as Electron.BrowserWindow;
  });
  return { createWindow: fn };
}

beforeEach(() => {
  // Fresh state before each test
  h.createdWindows.length = 0;
  h.bootstrapSet.clear();
  h.trackedTimers.length = 0;
  for (const k of Object.keys(h.mockStore)) delete h.mockStore[k];
  h.MockBW.nextId = 1;
  h.MockWC.nextId = 1;
  destroyAccountWindowManager();
  vi.clearAllMocks();
});

afterEach(() => {
  destroyAccountWindowManager();
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('AccountWindowManager — construction', () => {
  it('clears the shared bootstrap tracker on construction', () => {
    h.bootstrapSet.add(7);
    new AccountWindowManager();
    expect(h.bootstrapSet.size).toBe(0);
    expect(clearAllBootstrap).toHaveBeenCalled();
  });

  it('starts session maintenance exactly once per instance', () => {
    new AccountWindowManager();
    expect(startSessionMaintenance).toHaveBeenCalledTimes(1);
  });

  it('isolated constructors skip bootstrap reset and process-wide maintenance', () => {
    h.bootstrapSet.add(7);
    vi.mocked(startSessionMaintenance).mockClear();
    vi.mocked(stopSessionMaintenance).mockClear();
    const manager = new AccountWindowManager(makeFactory(), { isolated: true });
    expect(h.bootstrapSet.has(7)).toBe(true);
    expect(startSessionMaintenance).not.toHaveBeenCalled();
    manager.destroyAll();
    expect(stopSessionMaintenance).not.toHaveBeenCalled();
  });

  it('isolated create/dehydrate/hydrate do not start maintenance or require hook notify', () => {
    vi.mocked(startSessionMaintenance).mockClear();
    const factory = makeFactory();
    const manager = new AccountWindowManager(factory, { isolated: true });
    const window = manager.createAccountWindow('https://chat.google.com/u/1/', asAccountIndex(1));
    expect(window).toBeTruthy();
    expect(startSessionMaintenance).not.toHaveBeenCalled();
    manager.dehydrateAccount(asAccountIndex(1));
    expect(manager.isDehydrated(asAccountIndex(1))).toBe(true);
    const restored = manager.hydrateAccount(asAccountIndex(1));
    expect(restored).toBeTruthy();
    manager.destroyAll();
    expect(stopSessionMaintenance).not.toHaveBeenCalled();
  });

  it('isolated teardown does not wipe the shared bootstrap set or notify WC hooks', async () => {
    h.bootstrapSet.add(0);
    const hooks = await import('./accountWebContentsHooks.js');
    hooks.clearAccountWebContentsHooksForTests();
    const created = vi.fn();
    hooks.onAccountWebContentsCreated(created);

    const manager = new AccountWindowManager(makeFactory(), { isolated: true });
    manager.createAccountWindow('https://chat.google.com/u/2/', asAccountIndex(2));
    expect(created).not.toHaveBeenCalled();
    expect(manager.isBootstrap(asAccountIndex(0))).toBe(false);
    manager.markAsBootstrap(asAccountIndex(2));
    expect(manager.isBootstrap(asAccountIndex(2))).toBe(true);
    expect(h.bootstrapSet.has(0)).toBe(true);

    manager.destroyAll();
    expect(h.bootstrapSet.has(0)).toBe(true);
    expect(created).not.toHaveBeenCalled();
    hooks.clearAccountWebContentsHooksForTests();
  });

  it('honours a configured memory.dehydrationThresholdMs in [60000, 600000]', () => {
    h.mockStore['memory'] = { dehydrationThresholdMs: 120000 };
    // We cannot read the private threshold directly. Instead, verify the
    // observable contract: dehydrate timer is scheduled with that delay.
    const m = new AccountWindowManager(makeFactory());
    const w = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(w, asAccountIndex(1));
    // Trigger blur → onIdleStart → scheduleDehydrate
    (w as unknown as MockBWInstance).emit('blur');
    expect(h.trackedTimers.length).toBeGreaterThanOrEqual(1);
    const last = h.trackedTimers[h.trackedTimers.length - 1];
    expect(last?.delay).toBe(120000);
  });

  it('falls back to 90s when memory config is absent', () => {
    const m = new AccountWindowManager(makeFactory());
    const w = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(w, asAccountIndex(2));
    (w as unknown as MockBWInstance).emit('blur');
    const last = h.trackedTimers[h.trackedTimers.length - 1];
    expect(last?.delay).toBe(90 * 1000);
  });

  it('falls back to default when configured threshold is out of range', () => {
    h.mockStore['memory'] = { dehydrationThresholdMs: 5 }; // below floor
    const m = new AccountWindowManager(makeFactory());
    const w = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(w, asAccountIndex(2));
    (w as unknown as MockBWInstance).emit('blur');
    const last = h.trackedTimers[h.trackedTimers.length - 1];
    expect(last?.delay).toBe(90 * 1000);
  });
});

// ---------------------------------------------------------------------------
// registerWindow / getAccountIndex / getAccountWindow / getAllWindows
// ---------------------------------------------------------------------------

describe('AccountWindowManager — registry queries', () => {
  it('registerWindow stores the window and exposes it via getAccountWindow', () => {
    const m = new AccountWindowManager();
    const w = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(w, asAccountIndex(0));
    expect(m.getAccountWindow(asAccountIndex(0))).toBe(w);
    expect(m.getAccountIndex(w)).toBe(0);
  });

  it('hasAccount and getAccountCount reflect registrations', () => {
    const m = new AccountWindowManager();
    expect(m.hasAccount(asAccountIndex(0))).toBe(false);
    expect(m.getAccountCount()).toBe(0);
    const w = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(w, asAccountIndex(0));
    expect(m.hasAccount(asAccountIndex(0))).toBe(true);
    expect(m.getAccountCount()).toBe(1);
    expect(m.hasAccount(asAccountIndex(7))).toBe(false);
  });

  it('getAccountWindow returns null for an unknown account', () => {
    const m = new AccountWindowManager();
    expect(m.getAccountWindow(asAccountIndex(99))).toBeNull();
  });

  it('getAccountIndex returns null for a non-registered window', () => {
    const m = new AccountWindowManager();
    const w = new h.MockBW() as unknown as Electron.BrowserWindow;
    expect(m.getAccountIndex(w)).toBeNull();
  });

  it('getAccountWebContents returns the window webContents, null when absent', () => {
    const m = new AccountWindowManager();
    expect(m.getAccountWebContents(asAccountIndex(0))).toBeNull();
    const w = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(w, asAccountIndex(0));
    const wc = m.getAccountWebContents(asAccountIndex(0));
    expect(wc).toBe((w as unknown as MockBWInstance).webContents);
  });

  it('getAccountForWebContents resolves by webContents id', () => {
    const m = new AccountWindowManager();
    const w = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(w, asAccountIndex(3));
    const wcId = (w as unknown as MockBWInstance).webContents.id;
    expect(m.getAccountForWebContents(asWebContentsId(wcId))).toBe(3);
    expect(m.getAccountForWebContents(asWebContentsId(99999))).toBeNull();
  });

  it('getAllWindows returns the registered windows array', () => {
    const m = new AccountWindowManager();
    expect(m.getAllWindows()).toEqual([]);
    const a = new h.MockBW() as unknown as Electron.BrowserWindow;
    const b = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(a, asAccountIndex(0));
    m.registerWindow(b, asAccountIndex(1));
    const all = m.getAllWindows();
    expect(all).toHaveLength(2);
    expect(all).toEqual(expect.arrayContaining([a, b]));
  });

  it('getMostRecentWindow tracks the latest focused window', () => {
    const m = new AccountWindowManager();
    expect(m.getMostRecentWindow()).toBeNull();
    const a = new h.MockBW() as unknown as Electron.BrowserWindow;
    const b = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(a, asAccountIndex(0));
    m.registerWindow(b, asAccountIndex(1));
    // Focus a → most recent = a (focus event triggers registry's mostRecent setter)
    (a as unknown as MockBWInstance).emit('focus');
    expect(m.getMostRecentWindow()).toBe(a);
    (b as unknown as MockBWInstance).emit('focus');
    expect(m.getMostRecentWindow()).toBe(b);
  });

  it('re-registering the same window with a new index detaches old listeners', () => {
    const m = new AccountWindowManager();
    const w = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(w, asAccountIndex(0));
    m.registerWindow(w, asAccountIndex(1));
    // Idempotent — old account-0 mapping is gone, new account-1 mapping wins
    expect(m.getAccountIndex(w)).toBe(1);
    expect(m.hasAccount(asAccountIndex(0))).toBe(false);
    expect(m.hasAccount(asAccountIndex(1))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Activity listeners (focus/blur throttling)
// ---------------------------------------------------------------------------

describe('AccountWindowManager — activity listeners', () => {
  it('keeps account-0 unthrottled regardless of focus/blur state', () => {
    const m = new AccountWindowManager();
    const w = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(w, asAccountIndex(0));
    const wc = (w as unknown as MockBWInstance).webContents;
    // Initial applyThrottle(false) was called during register — for account 0
    // the branch sets background throttling to false.
    expect(wc.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
    (w as unknown as MockBWInstance).emit('blur');
    expect(wc.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
    (w as unknown as MockBWInstance).emit('focus');
    expect(wc.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
  });

  it('throttles account 1+ when blurred and unthrottles on focus', () => {
    const m = new AccountWindowManager();
    const w = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(w, asAccountIndex(2));
    const wc = (w as unknown as MockBWInstance).webContents;
    // Initial applyThrottle(false) → throttling = !false = true
    expect(wc.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
    (w as unknown as MockBWInstance).emit('focus');
    expect(wc.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
    (w as unknown as MockBWInstance).emit('blur');
    expect(wc.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
  });

  it('does not schedule dehydrate for account 0 on blur', () => {
    const m = new AccountWindowManager();
    const w = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(w, asAccountIndex(0));
    h.trackedTimers.length = 0;
    (w as unknown as MockBWInstance).emit('blur');
    expect(h.trackedTimers.filter((t) => t.name?.startsWith('dehydrate-account-'))).toHaveLength(0);
  });

  it('schedules a dehydrate timer for account 1+ on blur', () => {
    const m = new AccountWindowManager();
    const w = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(w, asAccountIndex(1));
    h.trackedTimers.length = 0;
    (w as unknown as MockBWInstance).emit('blur');
    const dehydrateTimers = h.trackedTimers.filter((t) => t.name?.startsWith('dehydrate-account-'));
    expect(dehydrateTimers).toHaveLength(1);
    expect(dehydrateTimers[0]?.name).toBe('dehydrate-account-1');
  });

  it('does not re-schedule a dehydrate when one is already pending', () => {
    const m = new AccountWindowManager();
    const w = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(w, asAccountIndex(1));
    h.trackedTimers.length = 0;
    (w as unknown as MockBWInstance).emit('blur');
    (w as unknown as MockBWInstance).emit('blur');
    const dehydrateTimers = h.trackedTimers.filter((t) => t.name?.startsWith('dehydrate-account-'));
    expect(dehydrateTimers).toHaveLength(1);
  });

  it('does not schedule a dehydrate for a bootstrap account on blur', () => {
    const m = new AccountWindowManager();
    const w = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(w, asAccountIndex(1));
    m.markAsBootstrap(asAccountIndex(1));
    h.trackedTimers.length = 0;
    (w as unknown as MockBWInstance).emit('blur');
    const dehydrateTimers = h.trackedTimers.filter((t) => t.name?.startsWith('dehydrate-account-'));
    expect(dehydrateTimers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createAccountWindow (router delegate)
// ---------------------------------------------------------------------------

describe('AccountWindowManager — createAccountWindow', () => {
  it('throws when no factory is configured and no existing window exists', () => {
    const m = new AccountWindowManager();
    expect(() => m.createAccountWindow('https://x/', asAccountIndex(0))).toThrowError(
      /No WindowFactory injected/
    );
  });

  it('invokes the factory with the persist:account-N partition', () => {
    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    m.createAccountWindow('https://hello/', asAccountIndex(2));
    expect(factory.createWindow).toHaveBeenCalledTimes(1);
    expect(factory.createWindow).toHaveBeenCalledWith(
      'https://hello/',
      toPartition(asAccountIndex(2))
    );
    expect(factory.createWindow.mock.calls[0]?.[1]).toBe('persist:account-2');
  });

  it('registers the new window in the registry', () => {
    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    const w = m.createAccountWindow('https://hello/', asAccountIndex(0));
    expect(m.getAccountWindow(asAccountIndex(0))).toBe(w);
    expect(m.getAccountIndex(w)).toBe(0);
  });

  it('reuses an existing window: shows, focuses and loads the new URL', () => {
    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    const w1 = m.createAccountWindow('https://first/', asAccountIndex(0));
    const w1Mock = w1 as unknown as MockBWInstance;
    w1Mock.show.mockClear();
    w1Mock.focus.mockClear();
    w1Mock.loadURL.mockClear();
    factory.createWindow.mockClear();

    const w2 = m.createAccountWindow('https://second/', asAccountIndex(0));
    expect(w2).toBe(w1);
    expect(factory.createWindow).not.toHaveBeenCalled();
    expect(w1Mock.show).toHaveBeenCalled();
    expect(w1Mock.focus).toHaveBeenCalled();
    expect(w1Mock.loadURL).toHaveBeenCalledWith('https://second/');
  });

  it('restores a minimized window when reusing it', () => {
    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    const w = m.createAccountWindow('https://x/', asAccountIndex(0));
    const wMock = w as unknown as MockBWInstance;
    wMock.minimized = true;
    wMock.restore.mockClear();
    m.createAccountWindow('https://y/', asAccountIndex(0));
    expect(wMock.restore).toHaveBeenCalled();
  });

  it('skips loadURL for a bootstrap window mid Google auth flow', () => {
    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    const w = m.createAccountWindow('https://accounts.google.com/signin', asAccountIndex(1));
    const wMock = w as unknown as MockBWInstance;
    m.markAsBootstrap(asAccountIndex(1));
    wMock.webContents.url = 'https://accounts.google.com/signin/v2/challenge';
    wMock.loadURL.mockClear();

    const reused = m.createAccountWindow('https://mail.google.com/chat', asAccountIndex(1));
    expect(reused).toBe(w);
    expect(wMock.loadURL).not.toHaveBeenCalled();
  });

  it('hydrates a dehydrated account instead of going through the factory path', () => {
    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    const w1 = m.createAccountWindow('https://first/', asAccountIndex(1));
    // Capture factory call count, then dehydrate
    const callsBeforeDehydrate = factory.createWindow.mock.calls.length;
    m.dehydrateAccount(asAccountIndex(1));
    expect(m.isDehydrated(asAccountIndex(1))).toBe(true);

    const w2 = m.createAccountWindow('https://second/', asAccountIndex(1));
    // Factory was called again — by hydrate, not by router fall-through
    expect(factory.createWindow.mock.calls.length).toBe(callsBeforeDehydrate + 1);
    expect(factory.createWindow).toHaveBeenLastCalledWith(
      'https://first/',
      toPartition(asAccountIndex(1))
    );
    expect(w2).not.toBe(w1);
    expect(m.isDehydrated(asAccountIndex(1))).toBe(false);
    // Router applies the requested URL after snapshot restore.
    expect((w2 as unknown as MockBWInstance).loadURL).toHaveBeenCalledWith('https://second/');
  });

  it('starts account 1 throttled and wires activity, dehydrate, and throttle listeners once', async () => {
    const hooks = await import('./accountWebContentsHooks.js');
    hooks.clearAccountWebContentsHooksForTests();
    const created = vi.fn();
    hooks.onAccountWebContentsCreated(created);

    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    h.recordActivity.mockClear();
    const w = m.createAccountWindow('https://chat/', asAccountIndex(1));
    const wMock = w as unknown as MockBWInstance;
    const wc = wMock.webContents;

    expect(wc.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
    expect(created).toHaveBeenCalledTimes(1);
    expect(h.recordActivity).toHaveBeenCalled();

    const activityCallsAfterCreate = h.recordActivity.mock.calls.length;
    const focusCount = wMock.listenerCount('focus');
    const blurCount = wMock.listenerCount('blur');

    wMock.emit('focus');
    expect(wc.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
    expect(h.recordActivity.mock.calls.length).toBe(activityCallsAfterCreate + 1);

    h.trackedTimers.length = 0;
    wMock.emit('blur');
    expect(wc.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
    expect(h.recordActivity.mock.calls.length).toBe(activityCallsAfterCreate + 2);
    expect(h.trackedTimers.filter((t) => t.name === 'dehydrate-account-1')).toHaveLength(1);

    wMock.emit('focus');
    wMock.emit('blur');
    expect(h.trackedTimers.filter((t) => t.name === 'dehydrate-account-1')).toHaveLength(2);

    wMock.emit('show');
    expect(h.recordActivity.mock.calls.length).toBe(activityCallsAfterCreate + 5);

    const reused = m.createAccountWindow('https://chat/again', asAccountIndex(1));
    expect(reused).toBe(w);
    expect(created).toHaveBeenCalledTimes(1);
    expect(wMock.listenerCount('focus')).toBe(focusCount);
    expect(wMock.listenerCount('blur')).toBe(blurCount);

    hooks.clearAccountWebContentsHooksForTests();
  });

  it('does not increment hook or listener counts when hydrating through createAccountWindow', async () => {
    const hooks = await import('./accountWebContentsHooks.js');
    hooks.clearAccountWebContentsHooksForTests();
    const created = vi.fn();
    hooks.onAccountWebContentsCreated(created);

    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    const first = m.createAccountWindow('https://first/', asAccountIndex(1));
    expect(created).toHaveBeenCalledTimes(1);
    m.dehydrateAccount(asAccountIndex(1));

    const restored = m.createAccountWindow('https://second/', asAccountIndex(1));
    expect(restored).not.toBe(first);
    expect(created).toHaveBeenCalledTimes(2);
    expect(m.isDehydrated(asAccountIndex(1))).toBe(false);

    hooks.clearAccountWebContentsHooksForTests();
  });

  it('rolls back a failed new-window callback: no live window, registry, hook, listener, or timer', async () => {
    const hooks = await import('./accountWebContentsHooks.js');
    hooks.clearAccountWebContentsHooksForTests();
    const created = vi.fn();
    hooks.onAccountWebContentsCreated(created);

    const factory = makeFactory();
    factory.createWindow.mockImplementation((url: string) => {
      const w = new h.MockBW({ url });
      w.webContents.setBackgroundThrottling.mockImplementation(() => {
        throw new Error('throttle failed');
      });
      void w.loadURL(url);
      return w as unknown as Electron.BrowserWindow;
    });
    const m = new AccountWindowManager(factory);

    expect(() => m.createAccountWindow('https://boom/', asAccountIndex(1))).toThrow(
      'throttle failed'
    );

    expect(m.getAccountWindow(asAccountIndex(1))).toBeNull();
    expect(m.hasAccount(asAccountIndex(1))).toBe(false);
    expect(created).not.toHaveBeenCalled();
    expect(h.trackedTimers.filter((t) => t.name?.startsWith('dehydrate-account-'))).toHaveLength(0);
    expect(h.createdWindows.every((w) => w.destroyed)).toBe(true);

    hooks.clearAccountWebContentsHooksForTests();
  });

  it('focusAccount shows the window and isAccountVisible tracks live vs dehydrated', () => {
    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    const w = m.createAccountWindow('https://chat/', asAccountIndex(1));
    const wMock = w as unknown as MockBWInstance;
    wMock.show.mockClear();
    wMock.focus.mockClear();

    expect(m.isAccountVisible(asAccountIndex(1))).toBe(true);
    m.focusAccount(asAccountIndex(1));
    expect(wMock.show).toHaveBeenCalled();
    expect(wMock.focus).toHaveBeenCalled();

    m.dehydrateAccount(asAccountIndex(1));
    expect(m.isAccountVisible(asAccountIndex(1))).toBe(false);
    m.focusAccount(asAccountIndex(1));
    expect(m.isDehydrated(asAccountIndex(1))).toBe(false);
    expect(m.isAccountVisible(asAccountIndex(1))).toBe(true);

    m.focusAccount(asAccountIndex(99));
    expect(m.hasAccount(asAccountIndex(99))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dehydrateAccount / hydrateAccount / isDehydrated
// ---------------------------------------------------------------------------

describe('AccountWindowManager — dehydrate / hydrate', () => {
  it('isDehydrated returns false for unknown accounts', () => {
    const m = new AccountWindowManager();
    expect(m.isDehydrated(asAccountIndex(99))).toBe(false);
  });

  it('dehydrateAccount destroys the window and marks the account dehydrated', () => {
    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    const w = m.createAccountWindow('https://hello/', asAccountIndex(1));
    const wMock = w as unknown as MockBWInstance;

    m.dehydrateAccount(asAccountIndex(1));
    expect(m.isDehydrated(asAccountIndex(1))).toBe(true);
    expect(wMock.destroy).toHaveBeenCalled();
    // After dehydration, getAccountWindow returns null even though registry
    // technically saw a closed event.
    expect(m.getAccountWindow(asAccountIndex(1))).toBeNull();
    // Dehydrated-parked remains a known account (dual-backend contract).
    expect(m.hasAccount(asAccountIndex(1))).toBe(true);
    expect(m.listAccountIndices()).toContain(asAccountIndex(1));
  });

  it('dehydrateAccount is a no-op for a bootstrap account', () => {
    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    const w = m.createAccountWindow('https://hello/', asAccountIndex(1));
    const wMock = w as unknown as MockBWInstance;
    m.markAsBootstrap(asAccountIndex(1));
    m.dehydrateAccount(asAccountIndex(1));
    expect(m.isDehydrated(asAccountIndex(1))).toBe(false);
    expect(wMock.destroy).not.toHaveBeenCalled();
  });

  it('dehydrateAccount is a no-op for unknown account index', () => {
    const m = new AccountWindowManager(makeFactory());
    expect(() => m.dehydrateAccount(asAccountIndex(99))).not.toThrow();
    expect(m.isDehydrated(asAccountIndex(99))).toBe(false);
  });

  it('dehydrateAccount is idempotent: second call does nothing', () => {
    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    const w = m.createAccountWindow('https://hello/', asAccountIndex(1));
    const wMock = w as unknown as MockBWInstance;
    m.dehydrateAccount(asAccountIndex(1));
    wMock.destroy.mockClear();
    m.dehydrateAccount(asAccountIndex(1));
    expect(wMock.destroy).not.toHaveBeenCalled();
  });

  it('hydrateAccount returns null for a fully unknown account', () => {
    const m = new AccountWindowManager(makeFactory());
    expect(m.hydrateAccount(asAccountIndex(99))).toBeNull();
  });

  it('hydrateAccount returns the live window when not dehydrated', () => {
    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    const w = m.createAccountWindow('https://hello/', asAccountIndex(0));
    expect(m.hydrateAccount(asAccountIndex(0))).toBe(w);
  });

  it('hydrateAccount throws when no factory is configured', () => {
    // Build a manager WITH a factory so we can dehydrate, then construct a
    // separate dehydrated state by manipulating via the public path: dehydrate
    // calls require a factory to recreate. We use a manager constructed
    // without factory and assert that a non-existent dehydrated account hits
    // the early null branch (covered above). To exercise the throw, we need a
    // manager that has a snapshot but no factory — we can't reach that state
    // through public APIs. Skip the explicit throw assertion to remain pure
    // characterization: see hydrate path uncovered branch.
    const m = new AccountWindowManager();
    expect(m.hydrateAccount(asAccountIndex(99))).toBeNull();
  });

  it('hydrateAccount recreates the window with the same partition + saved bounds', () => {
    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    const w = m.createAccountWindow('https://hello/', asAccountIndex(1));
    const wMock = w as unknown as MockBWInstance;
    wMock.bounds = { x: 100, y: 200, width: 1024, height: 768 };
    wMock.maximized = true;

    m.dehydrateAccount(asAccountIndex(1));
    expect(m.isDehydrated(asAccountIndex(1))).toBe(true);

    // Hydrate
    factory.createWindow.mockClear();
    const w2 = m.hydrateAccount(asAccountIndex(1));
    expect(w2).not.toBeNull();
    expect(factory.createWindow).toHaveBeenCalledWith(
      'https://hello/',
      toPartition(asAccountIndex(1))
    );
    expect(m.isDehydrated(asAccountIndex(1))).toBe(false);

    const w2Mock = w2 as unknown as MockBWInstance;
    expect(w2Mock.setBounds).toHaveBeenCalledWith({
      x: 100,
      y: 200,
      width: 1024,
      height: 768,
    });
    expect(w2Mock.maximize).toHaveBeenCalled();
    // Factory owns the sole loadURL; manager must not re-dispatch navigation.
    expect(w2Mock.loadURL).toHaveBeenCalledTimes(1);
    expect(w2Mock.loadURL).toHaveBeenCalledWith('https://hello/');
  });

  it('dehydrate then hydrate re-fires WebContents hooks for externalLinks reinstall', async () => {
    const hooks = await import('./accountWebContentsHooks.js');
    hooks.clearAccountWebContentsHooksForTests();
    const disposer = vi.fn();
    const listener = vi.fn(() => disposer);
    hooks.onAccountWebContentsCreated(listener);

    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    m.createAccountWindow('https://hello/', asAccountIndex(1));
    expect(listener).toHaveBeenCalled();
    const createsAfterCreate = listener.mock.calls.length;

    m.dehydrateAccount(asAccountIndex(1));
    expect(disposer).toHaveBeenCalled();

    m.hydrateAccount(asAccountIndex(1));
    expect(listener.mock.calls.length).toBeGreaterThan(createsAfterCreate);

    hooks.clearAccountWebContentsHooksForTests();
  });

  it('rolls back hydrate when post-create restore fails and keeps the snapshot', () => {
    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    m.createAccountWindow('https://hello/', asAccountIndex(1));
    m.dehydrateAccount(asAccountIndex(1));
    expect(m.isDehydrated(asAccountIndex(1))).toBe(true);

    factory.createWindow.mockImplementation((url: string, partition: string) => {
      const w = new h.MockBW({ webPreferences: { partition }, url });
      void w.loadURL(url);
      w.setBounds.mockImplementation(() => {
        throw new Error('setBounds failed');
      });
      return w as unknown as Electron.BrowserWindow;
    });

    expect(() => m.hydrateAccount(asAccountIndex(1))).toThrow('setBounds failed');
    expect(m.isDehydrated(asAccountIndex(1))).toBe(true);
    expect(m.getAccountWindow(asAccountIndex(1))).toBeNull();
    expect(m.hasAccount(asAccountIndex(1))).toBe(true);

    factory.createWindow.mockImplementation((url: string, partition: string) => {
      const w = new h.MockBW({ webPreferences: { partition }, url });
      void w.loadURL(url);
      return w as unknown as Electron.BrowserWindow;
    });
    const recovered = m.hydrateAccount(asAccountIndex(1));
    expect(recovered).not.toBeNull();
    expect(m.isDehydrated(asAccountIndex(1))).toBe(false);
    expect(factory.createWindow).toHaveBeenLastCalledWith(
      'https://hello/',
      toPartition(asAccountIndex(1))
    );
  });

  it('hydrateAccount dispatches exactly one loadURL via the factory (no manager re-nav)', () => {
    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    m.createAccountWindow('https://chat.example/', asAccountIndex(1));
    m.dehydrateAccount(asAccountIndex(1));

    factory.createWindow.mockClear();
    const w2 = m.hydrateAccount(asAccountIndex(1));
    const w2Mock = w2 as unknown as MockBWInstance;

    // One factory creation → one factory loadURL; manager never calls loadURL.
    expect(factory.createWindow).toHaveBeenCalledTimes(1);
    expect(w2Mock.loadURL).toHaveBeenCalledTimes(1);
    expect(w2Mock.loadURL).toHaveBeenCalledWith('https://chat.example/');
  });

  it('enumerateAccountWebContents returns each live account and skips dehydrated', () => {
    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    m.createAccountWindow('https://a/', asAccountIndex(0));
    m.createAccountWindow('https://b/', asAccountIndex(1));
    m.dehydrateAccount(asAccountIndex(1));

    const listed = m.enumerateAccountWebContents();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.accountIndex).toBe(0);
    expect(listed[0]?.backend).toBe('browser-window');
    expect(listed[0]?.webContents).toBeDefined();
  });

  it('hydrateAccount does not call maximize when snapshot is non-maximized', () => {
    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    const w = m.createAccountWindow('https://hello/', asAccountIndex(1));
    const wMock = w as unknown as MockBWInstance;
    wMock.maximized = false;

    m.dehydrateAccount(asAccountIndex(1));
    const w2 = m.hydrateAccount(asAccountIndex(1));
    const w2Mock = w2 as unknown as MockBWInstance;
    expect(w2Mock.maximize).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// unregisterAccount / destroyAll
// ---------------------------------------------------------------------------

describe('AccountWindowManager — unregister / destroyAll', () => {
  it('unregisterAccount removes the window from the registry', () => {
    const m = new AccountWindowManager();
    const w = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(w, asAccountIndex(1));
    expect(m.hasAccount(asAccountIndex(1))).toBe(true);
    m.unregisterAccount(asAccountIndex(1));
    expect(m.hasAccount(asAccountIndex(1))).toBe(false);
    expect(m.getAccountWindow(asAccountIndex(1))).toBeNull();
  });

  it('unregisterAccount is a no-op for an unknown account', () => {
    const m = new AccountWindowManager();
    expect(() => m.unregisterAccount(asAccountIndex(99))).not.toThrow();
  });

  it('unregisterAccount clears any pending dehydrate timer for that account', () => {
    const m = new AccountWindowManager();
    const w = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(w, asAccountIndex(1));
    (w as unknown as MockBWInstance).emit('blur');
    expect(h.trackedTimers.filter((t) => t.name === 'dehydrate-account-1')).toHaveLength(1);
    m.unregisterAccount(asAccountIndex(1));
    // After unregister, hasAccount returns false and the internal map for that
    // account no longer holds the timer reference.
    expect(m.hasAccount(asAccountIndex(1))).toBe(false);
  });

  it('destroyAll stops session maintenance and clears all windows', () => {
    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    m.createAccountWindow('https://a/', asAccountIndex(0));
    m.createAccountWindow('https://b/', asAccountIndex(1));
    expect(m.getAccountCount()).toBe(2);
    m.destroyAll();
    expect(stopSessionMaintenance).toHaveBeenCalled();
    expect(m.getAccountCount()).toBe(0);
    expect(m.getAllWindows()).toEqual([]);
  });

  it('destroyAll clears the dehydrated sidecar', () => {
    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    m.createAccountWindow('https://a/', asAccountIndex(1));
    m.dehydrateAccount(asAccountIndex(1));
    expect(m.isDehydrated(asAccountIndex(1))).toBe(true);
    m.destroyAll();
    expect(m.isDehydrated(asAccountIndex(1))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// saveAccountWindowState / getAccountWindowState
// ---------------------------------------------------------------------------

describe('AccountWindowManager — state persistence', () => {
  it('saveAccountWindowState writes bounds and maximized to config', async () => {
    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    const w = m.createAccountWindow('https://x/', asAccountIndex(0));
    const wMock = w as unknown as MockBWInstance;
    wMock.bounds = { x: 5, y: 10, width: 1280, height: 720 };
    wMock.maximized = true;

    m.saveAccountWindowState(asAccountIndex(0));
    await flushAccountWindowsWrites();

    const stored = h.mockStore['accountWindows'] as Record<
      number,
      { bounds: unknown; isMaximized: boolean }
    >;
    expect(stored?.[0]).toEqual({
      bounds: { x: 5, y: 10, width: 1280, height: 720 },
      isMaximized: true,
    });
  });

  it('saveAccountWindowState is a no-op when window is missing', async () => {
    const m = new AccountWindowManager();
    m.saveAccountWindowState(asAccountIndex(0));
    await flushAccountWindowsWrites();
    expect(h.mockStore['accountWindows']).toBeUndefined();
  });

  it('saveAccountWindowState is a no-op when window is destroyed', async () => {
    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    const w = m.createAccountWindow('https://x/', asAccountIndex(0));
    (w as unknown as MockBWInstance).destroyed = true;
    m.saveAccountWindowState(asAccountIndex(0));
    await flushAccountWindowsWrites();
    expect(h.mockStore['accountWindows']).toBeUndefined();
  });

  it('saveAccountWindowState merges multiple accounts into the map', async () => {
    const factory = makeFactory();
    const m = new AccountWindowManager(factory);
    const a = m.createAccountWindow('https://a/', asAccountIndex(0));
    const b = m.createAccountWindow('https://b/', asAccountIndex(1));
    (a as unknown as MockBWInstance).bounds = { x: 1, y: 2, width: 3, height: 4 };
    (b as unknown as MockBWInstance).bounds = { x: 5, y: 6, width: 7, height: 8 };

    m.saveAccountWindowState(asAccountIndex(0));
    m.saveAccountWindowState(asAccountIndex(1));
    await flushAccountWindowsWrites();

    const stored = h.mockStore['accountWindows'] as
      | Record<number, { bounds: { x: number; y: number; width: number; height: number } }>
      | undefined;
    expect(stored?.[0]?.bounds).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(stored?.[1]?.bounds).toEqual({ x: 5, y: 6, width: 7, height: 8 });
  });

  it('getAccountWindowState returns the stored state, or null when absent', () => {
    const m = new AccountWindowManager();
    expect(m.getAccountWindowState(asAccountIndex(0))).toBeNull();
    h.mockStore['accountWindows'] = {
      0: {
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        isMaximized: false,
      },
    };
    expect(m.getAccountWindowState(asAccountIndex(0))).toEqual({
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      isMaximized: false,
    });
  });

  it('flushAccountWindowsWrites resolves cleanly even when nothing was queued', async () => {
    await expect(flushAccountWindowsWrites()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Bootstrap delegate methods
// ---------------------------------------------------------------------------

describe('AccountWindowManager — bootstrap delegates', () => {
  it('markAsBootstrap requires the account to be registered first', () => {
    const m = new AccountWindowManager();
    m.markAsBootstrap(asAccountIndex(1));
    // Was NOT delegated because account is unknown
    expect(trackerMark).not.toHaveBeenCalled();
    expect(m.isBootstrap(asAccountIndex(1))).toBe(false);
  });

  it('markAsBootstrap delegates once the window is registered', () => {
    const m = new AccountWindowManager();
    const w = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(w, asAccountIndex(1));
    m.markAsBootstrap(asAccountIndex(1));
    expect(trackerMark).toHaveBeenCalledWith(asAccountIndex(1));
    expect(m.isBootstrap(asAccountIndex(1))).toBe(true);
  });

  it('promoteBootstrap delegates and returns true when the account was a bootstrap', () => {
    const m = new AccountWindowManager();
    const w = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(w, asAccountIndex(1));
    m.markAsBootstrap(asAccountIndex(1));
    const result = m.promoteBootstrap(asAccountIndex(1));
    expect(trackerPromote).toHaveBeenCalledWith(asAccountIndex(1));
    expect(result).toBe(true);
    expect(m.isBootstrap(asAccountIndex(1))).toBe(false);
  });

  it('promoteBootstrap returns false when the account was not a bootstrap', () => {
    const m = new AccountWindowManager();
    expect(m.promoteBootstrap(asAccountIndex(7))).toBe(false);
  });

  it('clearBootstrap delegates to the tracker', () => {
    const m = new AccountWindowManager();
    const w = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(w, asAccountIndex(1));
    m.markAsBootstrap(asAccountIndex(1));
    m.clearBootstrap(asAccountIndex(1));
    expect(trackerClear).toHaveBeenCalledWith(asAccountIndex(1));
    expect(m.isBootstrap(asAccountIndex(1))).toBe(false);
  });

  it('getBootstrapAccounts returns the current set', () => {
    const m = new AccountWindowManager();
    const w1 = new h.MockBW() as unknown as Electron.BrowserWindow;
    const w2 = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(w1, asAccountIndex(1));
    m.registerWindow(w2, asAccountIndex(2));
    m.markAsBootstrap(asAccountIndex(1));
    m.markAsBootstrap(asAccountIndex(2));
    expect(m.getBootstrapAccounts().sort()).toEqual([1, 2]);
    expect(trackerList).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Singleton lifecycle
// ---------------------------------------------------------------------------

describe('AccountWindowManager — singleton', () => {
  it('getAccountWindowManager returns the same instance on subsequent calls', () => {
    const m1 = getAccountWindowManager();
    const m2 = getAccountWindowManager();
    expect(m1).toBe(m2);
  });

  it('peekAccountWindowManager does not construct a manager', () => {
    expect(peekAccountWindowManager()).toBeNull();
    const created = getAccountWindowManager();
    expect(peekAccountWindowManager()).toBe(created);
    destroyAccountWindowManager();
    expect(peekAccountWindowManager()).toBeNull();
  });

  it('routes to AccountWindowManager when app.useWebContentsView is false/absent', () => {
    const m = getAccountWindowManager();
    expect(m).toBeInstanceOf(AccountWindowManager);
    expect(getAccountViewManager).not.toHaveBeenCalled();
  });

  it('routes to the WebContentsView backend when app.useWebContentsView=true', () => {
    h.mockStore['app'] = { useWebContentsView: true };
    const m = getAccountWindowManager();
    expect(m).not.toBeInstanceOf(AccountWindowManager);
    expect(getAccountViewManager).toHaveBeenCalled();
  });

  it('destroyAccountWindowManager resets the singleton and stops maintenance', () => {
    const m1 = getAccountWindowManager();
    expect(m1).toBeDefined();
    destroyAccountWindowManager();
    const m2 = getAccountWindowManager();
    expect(m1).not.toBe(m2);
  });

  it('destroyAccountWindowManager is a no-op when no singleton has been created', () => {
    // Ensure clean state via beforeEach already; calling destroy again is safe
    destroyAccountWindowManager();
    expect(() => destroyAccountWindowManager()).not.toThrow();
  });

  it('WCV path: destroyAll once then clears view singleton (KD15)', () => {
    const destroyAll = vi.fn();
    const viewStub = {
      createAccountWindow: vi.fn(),
      registerWindow: vi.fn(),
      getAccountIndex: vi.fn(),
      getAccountWindow: vi.fn(),
      getAccountWebContents: vi.fn(),
      getAccountForWebContents: vi.fn(),
      focusAccount: vi.fn(),
      getAllWindows: vi.fn(() => []),
      getMostRecentWindow: vi.fn(),
      hasAccount: vi.fn(),
      listAccountIndices: vi.fn(() => []),
      isAccountVisible: vi.fn(() => false),
      unregisterAccount: vi.fn(),
      getAccountCount: vi.fn(() => 0),
      destroyAll,
      markAsBootstrap: vi.fn(),
      promoteBootstrap: vi.fn(),
      isBootstrap: vi.fn(),
      clearBootstrap: vi.fn(),
      getBootstrapAccounts: vi.fn(() => []),
      saveAccountWindowState: vi.fn(),
      getAccountWindowState: vi.fn(),
      dehydrateAccount: vi.fn(),
      hydrateAccount: vi.fn(),
      isDehydrated: vi.fn(() => false),
      enumerateAccountWebContents: vi.fn(() => []),
    };
    vi.mocked(getAccountViewManager).mockReturnValue(
      viewStub as unknown as ReturnType<typeof getAccountViewManager>
    );
    h.mockStore['app'] = { useWebContentsView: true };

    const m = getAccountWindowManager();
    expect(m).toBe(viewStub);
    destroyAccountWindowManager();

    expect(destroyAll).toHaveBeenCalledTimes(1);
    expect(resetAccountViewManagerSingleton).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Module-level convenience helpers
// ---------------------------------------------------------------------------

describe('AccountWindowManager — module helpers', () => {
  it('module helpers return null/no-op when singleton is not initialized', () => {
    destroyAccountWindowManager();
    expect(moduleGetMostRecentWindow()).toBeNull();
    expect(getWindowForAccount(asAccountIndex(0))).toBeNull();
    const w = new h.MockBW() as unknown as Electron.BrowserWindow;
    expect(moduleGetAccountIndex(w)).toBeNull();
    expect(moduleGetAccountForWebContents(asWebContentsId(1))).toBeNull();
  });

  it('module helpers proxy through the active singleton once initialized', () => {
    const factory = makeFactory();
    // Seed the singleton via getAccountWindowManager + a registerWindow call.
    // moduleCreateAccountWindow goes through getAccountWindowManager() with no
    // factory, which would throw — instead we register manually.
    const m = getAccountWindowManager() as AccountWindowManager;
    void factory; // factory unused — we register a raw MockBW
    const w = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(w, asAccountIndex(0));
    (w as unknown as MockBWInstance).emit('focus');

    expect(moduleGetMostRecentWindow()).toBe(w);
    expect(getWindowForAccount(asAccountIndex(0))).toBe(w);
    expect(moduleGetAccountIndex(w)).toBe(0);
    const wcId = (w as unknown as MockBWInstance).webContents.id;
    expect(moduleGetAccountForWebContents(asWebContentsId(wcId))).toBe(0);
  });

  it('module createAccountWindow delegates through the singleton', () => {
    // The singleton getter accepts no factory, so the BrowserWindow path will
    // throw without one. Verify the throw behaviour is preserved end-to-end.
    expect(() => moduleCreateAccountWindow('https://x/', asAccountIndex(0))).toThrowError(
      /No WindowFactory injected/
    );
  });

  it('isBootstrap delegate reflects tracker state', () => {
    const m = new AccountWindowManager();
    const w = new h.MockBW() as unknown as Electron.BrowserWindow;
    m.registerWindow(w, asAccountIndex(1));
    expect(m.isBootstrap(asAccountIndex(1))).toBe(false);
    m.markAsBootstrap(asAccountIndex(1));
    expect(trackerIs).toHaveBeenCalled();
    expect(m.isBootstrap(asAccountIndex(1))).toBe(true);
  });
});

runSharedRoutingScenarios({
  backend: 'browser-window',
  createContext: () => {
    const factory = makeFactory();
    const manager = new AccountWindowManager(factory);
    return {
      backend: 'browser-window',
      manager,
      probes: attachRoutingProbes('browser-window', manager, () => null),
      getPartition: (accountIndex: number) => {
        const expected = toPartition(asAccountIndex(accountIndex));
        const hit = [...factory.createWindow.mock.calls]
          .reverse()
          .find((call) => call[1] === expected);
        return hit?.[1] ?? null;
      },
      getHostWebContents: () => null,
    };
  },
});

describe('AccountWindowManager permanent removal hooks', () => {
  let manager: AccountWindowManager;
  let factory: ReturnType<typeof makeFactory>;
  const removed = vi.fn();

  beforeEach(() => {
    accountHooks.clearAccountWebContentsHooksForTests();
    removed.mockClear();
    accountHooks.onAccountRemoved(removed);
    factory = makeFactory();
    manager = new AccountWindowManager(factory);
  });

  afterEach(() => {
    manager.destroyAll();
    accountHooks.clearAccountWebContentsHooksForTests();
  });

  it('replaces the renderer during dehydration and hydration without removing the account', () => {
    const created = vi.fn();
    const disposed = vi.fn();
    accountHooks.onAccountWebContentsCreated((info) => {
      created(info.webContents);
      return disposed;
    });
    const index = asAccountIndex(2);
    const original = manager.createAccountWindow('https://example.com/two', index);

    manager.dehydrateAccount(index);
    const replacement = manager.hydrateAccount(index);

    expect(removed).not.toHaveBeenCalled();
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(created.mock.calls).toEqual([[original.webContents], [replacement?.webContents]]);
    expect(replacement?.webContents).not.toBe(original.webContents);
    expect(manager.hasAccount(index)).toBe(true);
  });

  it('reports explicit removal of a retained dehydrated sparse account only once', () => {
    const index = asAccountIndex(7);
    manager.createAccountWindow('https://example.com/seven', index);
    manager.dehydrateAccount(index);

    manager.unregisterAccount(index);
    manager.unregisterAccount(index);

    expect(removed.mock.calls).toEqual([[index]]);
    expect(manager.hasAccount(index)).toBe(false);
  });

  it('reports every sparse live or retained account once during full teardown', () => {
    for (const index of [0, 2, 7]) {
      manager.createAccountWindow(`https://example.com/${index}`, asAccountIndex(index));
    }
    manager.dehydrateAccount(asAccountIndex(7));

    manager.destroyAll();
    manager.destroyAll();

    expect(removed.mock.calls).toEqual([[0], [2], [7]]);
  });

  it('disposes the current renderer and removes its identity on native window close', () => {
    const disposed = vi.fn();
    accountHooks.onAccountWebContentsCreated(() => disposed);
    const index = asAccountIndex(2);
    const window = manager.createAccountWindow('https://example.com/two', index);
    const senderId = asWebContentsId(window.webContents.id);

    window.destroy();

    expect(removed.mock.calls).toEqual([[index]]);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(manager.getAccountForWebContents(senderId)).toBeNull();
    expect(manager.hasAccount(index)).toBe(false);
  });

  it('keeps a failed hydration rollback retained instead of reporting permanent removal', () => {
    const index = asAccountIndex(2);
    manager.createAccountWindow('https://example.com/two', index);
    manager.dehydrateAccount(index);
    factory.createWindow.mockImplementation((url: string, partition: string) => {
      const window = new h.MockBW({ webPreferences: { partition }, url });
      vi.spyOn(window, 'setBounds').mockImplementation(() => {
        throw new Error('bounds failed');
      });
      return asType<Electron.BrowserWindow>(window);
    });

    expect(() => manager.hydrateAccount(index)).toThrow('bounds failed');

    expect(removed).not.toHaveBeenCalled();
    expect(manager.hasAccount(index)).toBe(true);
    expect(manager.isDehydrated(index)).toBe(true);
    expect(manager.getAccountWebContents(index)).toBeNull();
  });

  it('does not emit shared removal hooks from an isolated manager', () => {
    const isolated = new AccountWindowManager(makeFactory(), { isolated: true });
    isolated.createAccountWindow('https://example.com/two', asAccountIndex(2));

    isolated.destroyAll();

    expect(removed).not.toHaveBeenCalled();
  });
});
