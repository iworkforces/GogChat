/**
 * Characterization tests for AccountViewManager — the opt-in WebContentsView
 * backend for multi-account session management.
 *
 * Covers:
 *   - createAccountWindow: view creation, partition isolation, webContents wiring
 *   - getAccountWindow / getAccountWebContents / getAccountForWebContents lookups
 *   - getAllWindows / getMostRecentWindow / hasAccount / getAccountCount
 *   - registerWindow / getAccountIndex (host-window contract)
 *   - dehydrateAccount / hydrateAccount / isDehydrated state machine
 *   - unregisterAccount / destroyAll cleanup
 *   - saveAccountWindowState / getAccountWindowState persistence
 *   - Bootstrap delegate methods
 *   - Singleton get/destroy
 *   - Lifecycle edge cases: double-create, unknown index, host destroyed,
 *     destroyed webContents during cleanup, never-created views
 *
 * NOTE: These are pure characterization tests — they do not modify
 * accountViewManager.ts. They lock in current observable behavior.
 */

import { vi } from 'vitest';
import type { Mock } from 'vitest';
import type { EventEmitter as NodeEventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Hoisted mock infrastructure — defined inside vi.hoisted so vi.mock factories
// (which are hoisted to top of file) can safely reference these classes/state.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  // Use require() inside the hoisted closure: top-level imports are hoisted
  // but their bindings are not initialized until module-evaluation time, which
  // is AFTER vi.hoisted runs. require() reads the module synchronously here.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const events = require('events') as { EventEmitter: typeof NodeEventEmitter };
  const EE = events.EventEmitter;
  /** Mock WebContents — minimal surface used by AccountViewManager. */
  class MockWC extends EE {
    static nextId = 1;
    public id: number;
    public url = '';
    public destroyed = false;
    public throttling: boolean | null = null;

    public loadURL: ReturnType<typeof vi.fn>;
    public getURL: ReturnType<typeof vi.fn>;
    public setBackgroundThrottling: ReturnType<typeof vi.fn>;
    public focus: ReturnType<typeof vi.fn>;
    public isDestroyed: ReturnType<typeof vi.fn>;
    public close: ReturnType<typeof vi.fn>;
    public destroy: ReturnType<typeof vi.fn>;

    constructor() {
      super();
      this.id = MockWC.nextId++;
      this.loadURL = vi.fn((url: string): Promise<void> => {
        this.url = url;
        return Promise.resolve();
      });
      this.getURL = vi.fn((): string => this.url);
      this.setBackgroundThrottling = vi.fn((allowed: boolean): void => {
        this.throttling = allowed;
      });
      this.focus = vi.fn();
      this.isDestroyed = vi.fn((): boolean => this.destroyed);
      this.close = vi.fn((): void => {
        this.destroyed = true;
      });
      this.destroy = vi.fn((): void => {
        this.destroyed = true;
      });
    }
  }

  /** Mock WebContentsView — minimal surface used by AccountViewManager. */
  class MockWebContentsView {
    public webContents: MockWC;
    public lastBounds: { x: number; y: number; width: number; height: number } | null = null;
    public ctorOptions: unknown;
    public setBoundsImpl: ((b: unknown) => void) | null = null;
    public setBounds: ReturnType<typeof vi.fn>;

    constructor(options?: unknown) {
      this.ctorOptions = options;
      this.webContents = new MockWC();
      this.setBounds = vi.fn((b: { x: number; y: number; width: number; height: number }): void => {
        if (this.setBoundsImpl) {
          this.setBoundsImpl(b);
          return;
        }
        this.lastBounds = b;
      });
    }
  }

  const createdWindows: MockBW[] = [];

  /** Mock BrowserWindow — richer than tests/mocks/electron.ts (contentView, getContentSize). */
  class MockBW extends EE {
    static nextId = 1;
    public id: number;
    public webContents: MockWC;
    public ctorOptions: unknown;
    public destroyed = false;
    public visible = false;
    public maximized = false;
    public bounds = { x: 10, y: 20, width: 800, height: 600 };
    public addedChildren: MockWebContentsView[] = [];
    public removedChildren: MockWebContentsView[] = [];

    public contentView: {
      addChildView: ReturnType<typeof vi.fn>;
      removeChildView: ReturnType<typeof vi.fn>;
    };

    public show: ReturnType<typeof vi.fn>;
    public hide: ReturnType<typeof vi.fn>;
    public focus: ReturnType<typeof vi.fn>;
    public loadURL: ReturnType<typeof vi.fn>;
    public isVisible: ReturnType<typeof vi.fn>;
    public isMaximized: ReturnType<typeof vi.fn>;
    public isMinimized: ReturnType<typeof vi.fn>;
    public isDestroyed: ReturnType<typeof vi.fn>;
    public getBounds: ReturnType<typeof vi.fn>;
    public getContentSize: ReturnType<typeof vi.fn>;
    public removeListener_spy: Mock<
      (event: string | symbol, listener: (...a: unknown[]) => void) => void
    > = vi.fn();
    public destroy: ReturnType<typeof vi.fn>;

    constructor(options?: unknown) {
      super();
      this.id = MockBW.nextId++;
      this.ctorOptions = options;
      this.webContents = new MockWC();
      createdWindows.push(this);

      this.contentView = {
        addChildView: vi.fn((v: MockWebContentsView): void => {
          this.addedChildren.push(v);
        }),
        removeChildView: vi.fn((v: MockWebContentsView): void => {
          this.removedChildren.push(v);
        }),
      };

      this.show = vi.fn((): void => {
        this.visible = true;
        this.emit('show');
      });
      this.hide = vi.fn((): void => {
        this.visible = false;
      });
      this.focus = vi.fn();
      this.loadURL = vi.fn((url: string): Promise<void> => {
        this.webContents.url = url;
        return Promise.resolve();
      });
      this.isVisible = vi.fn((): boolean => this.visible);
      this.isMaximized = vi.fn((): boolean => this.maximized);
      this.isMinimized = vi.fn((): boolean => false);
      this.isDestroyed = vi.fn((): boolean => this.destroyed);
      this.getBounds = vi.fn(() => ({ ...this.bounds }));
      this.getContentSize = vi.fn((): [number, number] => [this.bounds.width, this.bounds.height]);
      const origRemove = EE.prototype.removeListener.bind(this);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).removeListener = (
        event: string | symbol,
        listener: (...a: unknown[]) => void
      ): MockBW => {
        this.removeListener_spy(event, listener);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        origRemove(event, listener as (...a: any[]) => void);
        return this;
      };
      this.destroy = vi.fn((): void => {
        this.destroyed = true;
        this.emit('closed');
      });
    }
  }

  // Shared state used by mocks
  const mockStore: Record<string, unknown> = {};
  const bootstrapSet = new Set<number>();
  const activityTracker = { recordActivity: vi.fn() };

  return {
    MockWC,
    MockWebContentsView,
    MockBW,
    createdWindows,
    mockStore,
    bootstrapSet,
    activityTracker,
  };
});

type MockWCInstance = InstanceType<typeof h.MockWC>;
type MockBWInstance = InstanceType<typeof h.MockBW>;
type MockViewInstance = InstanceType<typeof h.MockWebContentsView>;

vi.mock('electron', () => {
  return {
    app: {
      getAppPath: vi.fn(() => '/mock/app/path'),
    },
    BrowserWindow: h.MockBW,
    WebContentsView: h.MockWebContentsView,
  };
});

vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
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

vi.mock('../platform/iconCache.js', () => ({
  getIconCache: vi.fn(() => ({
    getIcon: vi.fn(() => '/mock/icon.png'),
  })),
}));

vi.mock('../security/permissionHandler.js', () => ({
  installPermissionHandlers: vi.fn(),
}));

vi.mock('../security/notificationAccess.js', () => ({
  ensureNotificationPermission: vi.fn().mockReturnValue('scheduled'),
}));

vi.mock('../security/cspHeaderHandler.js', () => ({
  installHeaderFix: vi.fn(),
}));

vi.mock('../platform/windowUtils.js', () => ({
  getWindowDefaults: vi.fn(() => ({
    hideMenuBar: false,
    startHidden: false,
  })),
}));

vi.mock('../lifecycle/logger.js', () => ({
  logger: {
    window: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  },
}));

vi.mock('./accountSessionMaintenance.js', () => ({
  startSessionMaintenance: vi.fn(),
  stopSessionMaintenance: vi.fn(),
  getAccountActivityTracker: vi.fn(() => h.activityTracker),
}));

// ---------------------------------------------------------------------------
// Imports under test (after vi.mock declarations are hoisted)
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  AccountViewManager,
  getAccountViewManager,
  destroyAccountViewManager,
} from './accountViewManager.js';
import { asAccountIndex, asWebContentsId } from '../../../shared/types/branded.js';
import log from 'electron-log';
import {
  SECRET_AUTH_URL,
  SECRET_CHAT_URL,
  clearSpies,
  expectNoSentinels,
  makeSecretError,
  messagesAt,
  spiesOf,
} from '../../../../tests/mocks/logCapture';
import * as accountHooks from './accountWebContentsHooks.js';
import { configGet } from '../../config.js';
import { flushAccountWindowsWrites } from './accountWindowsStore.js';
import {
  markAsBootstrap as trackerMark,
  isBootstrap as trackerIsBootstrap,
  promoteBootstrap as trackerPromote,
  clearBootstrap as trackerClear,
  getBootstrapAccounts as trackerList,
} from './bootstrapTracker.js';
import { installPermissionHandlers } from '../security/permissionHandler.js';
import { installHeaderFix } from '../security/cspHeaderHandler.js';
import { ensureNotificationPermission } from '../security/notificationAccess.js';
import { startSessionMaintenance, stopSessionMaintenance } from './accountSessionMaintenance.js';
import {
  attachRoutingProbes,
  runSharedRoutingScenarios,
} from '../../../../tests/helpers/accountRoutingConformance';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lastWindow(): MockBWInstance {
  const w = h.createdWindows[h.createdWindows.length - 1];
  if (!w) throw new Error('No window created');
  return w;
}

function viewOf(manager: AccountViewManager, idx: number): MockViewInstance {
  const wc = manager.getAccountWebContents(asAccountIndex(idx));
  expect(wc).not.toBeNull();
  const win = lastWindow();
  const found = win.addedChildren.find(
    (v: MockViewInstance) => v.webContents === (wc as unknown as MockWCInstance)
  );
  if (!found) throw new Error(`No view found for account ${idx}`);
  return found;
}

beforeEach(() => {
  // Fresh state for each test
  h.createdWindows.length = 0;
  h.bootstrapSet.clear();
  for (const k of Object.keys(h.mockStore)) delete h.mockStore[k];
  h.MockBW.nextId = 1;
  h.MockWC.nextId = 1;
  destroyAccountViewManager();
  vi.clearAllMocks();
});

afterEach(() => {
  destroyAccountViewManager();
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('AccountViewManager — construction', () => {
  it('clears the shared bootstrap tracker on construction', () => {
    h.bootstrapSet.add(99);
    new AccountViewManager();
    expect(h.bootstrapSet.size).toBe(0);
  });

  it('accepts an optional WindowFactory parameter (ignored by view backend)', () => {
    const factory = { createWindow: vi.fn() };
    const m = new AccountViewManager(factory);
    expect(m).toBeInstanceOf(AccountViewManager);
    // Factory should NEVER be called by the view-based path
    expect(factory.createWindow).not.toHaveBeenCalled();
  });

  it('starts session maintenance with the view manager', () => {
    const manager = new AccountViewManager();

    expect(startSessionMaintenance).toHaveBeenCalledWith(h.activityTracker, manager);
  });

  it('isolated constructors skip bootstrap reset and process-wide maintenance', () => {
    h.bootstrapSet.add(7);
    vi.mocked(startSessionMaintenance).mockClear();
    vi.mocked(stopSessionMaintenance).mockClear();
    const manager = new AccountViewManager(undefined, { isolated: true });
    expect(h.bootstrapSet.has(7)).toBe(true);
    expect(startSessionMaintenance).not.toHaveBeenCalled();
    manager.destroyAll();
    expect(stopSessionMaintenance).not.toHaveBeenCalled();
  });

  it('isolated create skips shared session permission handlers', () => {
    vi.mocked(startSessionMaintenance).mockClear();
    const manager = new AccountViewManager(undefined, { isolated: true });
    manager.createAccountWindow('https://chat.google.com/u/1/', asAccountIndex(1));
    expect(startSessionMaintenance).not.toHaveBeenCalled();
    expect(installPermissionHandlers).not.toHaveBeenCalled();
    expect(installHeaderFix).not.toHaveBeenCalled();
    manager.destroyAll();
    expect(stopSessionMaintenance).not.toHaveBeenCalled();
  });

  it('isolated create does not notify WC hooks or stamp host activity', async () => {
    const hooks = await import('./accountWebContentsHooks.js');
    hooks.clearAccountWebContentsHooksForTests();
    const created = vi.fn();
    hooks.onAccountWebContentsCreated(created);
    h.activityTracker.recordActivity.mockClear();
    vi.mocked(ensureNotificationPermission).mockClear();

    const manager = new AccountViewManager(undefined, { isolated: true });
    manager.createAccountWindow('https://chat.google.com/u/1/', asAccountIndex(1));
    expect(created).not.toHaveBeenCalled();
    const host = lastWindow();
    host.emit('focus');
    host.emit('ready-to-show');
    expect(h.activityTracker.recordActivity).not.toHaveBeenCalled();
    expect(ensureNotificationPermission).not.toHaveBeenCalled();
    manager.destroyAll();
    hooks.clearAccountWebContentsHooksForTests();
  });
});

// ---------------------------------------------------------------------------
// createAccountWindow
// ---------------------------------------------------------------------------

describe('AccountViewManager — createAccountWindow', () => {
  it('lazily creates a single host BrowserWindow on first call', () => {
    const m = new AccountViewManager();
    expect(h.createdWindows.length).toBe(0);
    m.createAccountWindow('https://mail.google.com/chat/u/0', asAccountIndex(0));
    expect(h.createdWindows.length).toBe(1);
  });

  it('reuses the same host BrowserWindow across multiple accounts', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://a.example/', asAccountIndex(0));
    m.createAccountWindow('https://b.example/', asAccountIndex(1));
    expect(h.createdWindows.length).toBe(1);
  });

  it('returns the host BrowserWindow (contract: returns BrowserWindow)', () => {
    const m = new AccountViewManager();
    const result = m.createAccountWindow('https://x/', asAccountIndex(0));
    expect(result).toBe(lastWindow());
  });

  it('requests notification permission on host ready-to-show with parentWindow', async () => {
    const { ensureNotificationPermission } = await import('../security/notificationAccess.js');
    vi.mocked(ensureNotificationPermission).mockClear();
    const m = new AccountViewManager();
    m.createAccountWindow('https://x/', asAccountIndex(0));
    // Deferred until the host is ready-to-show (same as BrowserWindow path)
    expect(ensureNotificationPermission).not.toHaveBeenCalled();
    const host = lastWindow();
    host.emit('ready-to-show');
    expect(ensureNotificationPermission).toHaveBeenCalledTimes(1);
    expect(ensureNotificationPermission).toHaveBeenCalledWith({ parentWindow: host });
    m.createAccountWindow('https://y/', asAccountIndex(1));
    // Host reused — ready-to-show already fired; no second ensure
    expect(ensureNotificationPermission).toHaveBeenCalledTimes(1);
  });

  it('attaches a WebContentsView per account to host.contentView', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://a/', asAccountIndex(0));
    m.createAccountWindow('https://b/', asAccountIndex(1));
    const host = lastWindow();
    expect(host.contentView.addChildView).toHaveBeenCalledTimes(2);
    expect(host.addedChildren).toHaveLength(2);
  });

  it('binds the per-account WebContentsView to the persist:account-N partition', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://x/', asAccountIndex(2));
    const view = viewOf(m, 2);
    const opts = view.ctorOptions as {
      webPreferences: { partition: string; sandbox: boolean; contextIsolation: boolean };
    };
    expect(opts.webPreferences.partition).toBe('persist:account-2');
    expect(opts.webPreferences.sandbox).toBe(true);
    expect(opts.webPreferences.contextIsolation).toBe(true);
  });

  it('disables backgroundThrottling for account 0 and enables for others', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.createAccountWindow('https://1/', asAccountIndex(1));
    const v0 = viewOf(m, 0);
    const v1 = viewOf(m, 1);
    const o0 = v0.ctorOptions as { webPreferences: { backgroundThrottling: boolean } };
    const o1 = v1.ctorOptions as { webPreferences: { backgroundThrottling: boolean } };
    // Source: backgroundThrottling: accountIndex > 0
    expect(o0.webPreferences.backgroundThrottling).toBe(false);
    expect(o1.webPreferences.backgroundThrottling).toBe(true);
  });

  it('installs permission handlers and header fix on the new view', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://x/', asAccountIndex(0));
    expect(installPermissionHandlers).toHaveBeenCalledTimes(1);
    expect(installHeaderFix).toHaveBeenCalledTimes(1);
  });

  it('loads the URL in the view webContents', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://hello/', asAccountIndex(0));
    const view = viewOf(m, 0);
    expect(view.webContents.loadURL).toHaveBeenCalledWith('https://hello/');
  });

  it('marks newly created account as the most-recent and visible', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://a/', asAccountIndex(0));
    m.createAccountWindow('https://b/', asAccountIndex(1));
    // Most recent is account 1; after layout, view 1 should have full bounds, view 0 zero.
    const v0 = viewOf(m, 0);
    const v1 = viewOf(m, 1);
    expect(v1.lastBounds).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(v0.lastBounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('on duplicate create for an existing account: navigates and brings to front (no second view)', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://first/', asAccountIndex(0));
    m.createAccountWindow('https://second/', asAccountIndex(0));
    const host = lastWindow();
    expect(host.addedChildren).toHaveLength(1);
    const view = viewOf(m, 0);
    // Both initial + re-navigation calls land on the same webContents
    expect(view.webContents.loadURL).toHaveBeenCalledWith('https://first/');
    expect(view.webContents.loadURL).toHaveBeenCalledWith('https://second/');
  });

  it('does not reload an existing bootstrap view during Google authentication', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://accounts.google.com/signin', asAccountIndex(1));
    m.markAsBootstrap(asAccountIndex(1));
    const view = viewOf(m, 1);
    view.webContents.url = 'https://accounts.google.com/signin/v2/challenge';
    view.webContents.loadURL.mockClear();

    m.createAccountWindow('https://mail.google.com/chat', asAccountIndex(1));

    expect(view.webContents.loadURL).not.toHaveBeenCalled();
  });

  it('navigates an existing view when it is not on a Google authentication URL', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://mail.google.com/chat/u/1', asAccountIndex(1));
    const view = viewOf(m, 1);
    view.webContents.loadURL.mockClear();

    m.createAccountWindow('https://mail.google.com/chat/u/1?refresh=1', asAccountIndex(1));

    expect(view.webContents.loadURL).toHaveBeenCalledWith(
      'https://mail.google.com/chat/u/1?refresh=1'
    );
  });

  it('records activity for view creation and host lifecycle events', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://mail.google.com/chat/u/1', asAccountIndex(1));
    expect(h.activityTracker.recordActivity).toHaveBeenCalledWith(1);

    h.activityTracker.recordActivity.mockClear();
    lastWindow().emit('focus');

    expect(h.activityTracker.recordActivity).toHaveBeenCalledWith(1);
  });

  it('survives setBounds errors during layout (logs warn, does not throw)', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://a/', asAccountIndex(0));
    const v0 = viewOf(m, 0);
    v0.setBoundsImpl = () => {
      throw new Error('boom');
    };
    expect(() => m.createAccountWindow('https://b/', asAccountIndex(1))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Lookup methods
// ---------------------------------------------------------------------------

describe('AccountViewManager — lookups', () => {
  it('hasAccount returns true after create, false otherwise', () => {
    const m = new AccountViewManager();
    expect(m.hasAccount(asAccountIndex(0))).toBe(false);
    m.createAccountWindow('https://x/', asAccountIndex(0));
    expect(m.hasAccount(asAccountIndex(0))).toBe(true);
    expect(m.hasAccount(asAccountIndex(1))).toBe(false);
  });

  it('getAccountCount reflects the number of created accounts', () => {
    const m = new AccountViewManager();
    expect(m.getAccountCount()).toBe(0);
    m.createAccountWindow('https://a/', asAccountIndex(0));
    expect(m.getAccountCount()).toBe(1);
    m.createAccountWindow('https://b/', asAccountIndex(1));
    expect(m.getAccountCount()).toBe(2);
  });

  it('getAccountWindow returns host for known account, null for unknown', () => {
    const m = new AccountViewManager();
    expect(m.getAccountWindow(asAccountIndex(0))).toBeNull();
    m.createAccountWindow('https://x/', asAccountIndex(0));
    expect(m.getAccountWindow(asAccountIndex(0))).toBe(lastWindow());
    expect(m.getAccountWindow(asAccountIndex(99))).toBeNull();
  });

  it('getAccountWebContents returns the view webContents, null when absent', () => {
    const m = new AccountViewManager();
    expect(m.getAccountWebContents(asAccountIndex(0))).toBeNull();
    m.createAccountWindow('https://x/', asAccountIndex(0));
    const wc = m.getAccountWebContents(asAccountIndex(0));
    expect(wc).not.toBeNull();
    expect((wc as unknown as MockWCInstance).id).toBeGreaterThan(0);
  });

  it('getAccountForWebContents returns the registered AccountIndex', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://x/', asAccountIndex(3));
    const wc = m.getAccountWebContents(asAccountIndex(3)) as unknown as MockWCInstance;
    expect(m.getAccountForWebContents(asWebContentsId(wc.id))).toBe(3);
  });

  it('getAccountForWebContents returns null for an unknown id', () => {
    const m = new AccountViewManager();
    expect(m.getAccountForWebContents(asWebContentsId(9999))).toBeNull();
  });

  it('getAllWindows returns [host] when accounts exist, [] otherwise', () => {
    const m = new AccountViewManager();
    expect(m.getAllWindows()).toEqual([]);
    m.createAccountWindow('https://x/', asAccountIndex(0));
    expect(m.getAllWindows()).toEqual([lastWindow()]);
  });

  it('enumerateAccountWebContents returns every live child view, not host-only', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://a/', asAccountIndex(0));
    m.createAccountWindow('https://b/', asAccountIndex(1));
    const listed = m.enumerateAccountWebContents();
    expect(listed).toHaveLength(2);
    expect(listed.map((e) => e.accountIndex).sort()).toEqual([0, 1]);
    expect(listed.every((e) => e.backend === 'web-contents-view')).toBe(true);
    // Each entry is a child view webContents, not an invented host-only sample.
    expect(listed[0]?.webContents).not.toBe(listed[1]?.webContents);
  });

  it('getMostRecentWindow returns null before host exists, host after', () => {
    const m = new AccountViewManager();
    expect(m.getMostRecentWindow()).toBeNull();
    m.createAccountWindow('https://x/', asAccountIndex(0));
    expect(m.getMostRecentWindow()).toBe(lastWindow());
  });

  it('getAccountIndex(host) returns the most-recent account index', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://a/', asAccountIndex(0));
    m.createAccountWindow('https://b/', asAccountIndex(1));
    const host = lastWindow();
    expect(m.getAccountIndex(host as unknown as Electron.BrowserWindow)).toBe(1);
  });

  it('getAccountIndex returns null for a non-host window', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://x/', asAccountIndex(0));
    const otherWindow = new h.MockBW();
    expect(m.getAccountIndex(otherWindow as unknown as Electron.BrowserWindow)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// registerWindow contract no-op
// ---------------------------------------------------------------------------

describe('AccountViewManager — registerWindow', () => {
  it('is a no-op (view-based path creates registrations via createAccountWindow)', () => {
    const m = new AccountViewManager();
    const w = new h.MockBW();
    expect(() =>
      m.registerWindow(w as unknown as Electron.BrowserWindow, asAccountIndex(0))
    ).not.toThrow();
    expect(m.getAccountCount()).toBe(0);
    expect(m.hasAccount(asAccountIndex(0))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bootstrap delegates
// ---------------------------------------------------------------------------

describe('AccountViewManager — bootstrap delegates', () => {
  it('markAsBootstrap ignores unknown account indices (parity with BW)', () => {
    const m = new AccountViewManager();
    m.markAsBootstrap(asAccountIndex(2));
    expect(trackerMark).not.toHaveBeenCalled();
  });

  it('markAsBootstrap delegates to bootstrapTracker for registered accounts', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://2/', asAccountIndex(2));
    m.markAsBootstrap(asAccountIndex(2));
    expect(trackerMark).toHaveBeenCalledWith(2);
  });

  it('isBootstrap reads through the tracker', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.markAsBootstrap(asAccountIndex(0));
    expect(m.isBootstrap(asAccountIndex(0))).toBe(true);
    expect(trackerIsBootstrap).toHaveBeenCalledWith(0);
  });

  it('promoteBootstrap delegates and returns underlying boolean', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://1/', asAccountIndex(1));
    m.markAsBootstrap(asAccountIndex(1));
    expect(m.promoteBootstrap(asAccountIndex(1))).toBe(true);
    expect(m.promoteBootstrap(asAccountIndex(1))).toBe(false);
    expect(trackerPromote).toHaveBeenCalled();
  });

  it('clearBootstrap delegates to tracker', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://1/', asAccountIndex(1));
    m.markAsBootstrap(asAccountIndex(1));
    m.clearBootstrap(asAccountIndex(1));
    expect(trackerClear).toHaveBeenCalledWith(1);
    expect(m.isBootstrap(asAccountIndex(1))).toBe(false);
  });

  it('getBootstrapAccounts delegates to tracker', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.createAccountWindow('https://2/', asAccountIndex(2));
    m.markAsBootstrap(asAccountIndex(0));
    m.markAsBootstrap(asAccountIndex(2));
    const result = m.getBootstrapAccounts();
    expect(trackerList).toHaveBeenCalled();
    expect(result.slice().sort()).toEqual([0, 2]);
  });
});

// ---------------------------------------------------------------------------
// Window state save/load
// ---------------------------------------------------------------------------

describe('AccountViewManager — saveAccountWindowState / getAccountWindowState', () => {
  it('saves bounds + maximized for account 0 only', async () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://x/', asAccountIndex(0));
    const host = lastWindow();
    host.bounds = { x: 50, y: 60, width: 1024, height: 768 };
    host.maximized = true;
    m.saveAccountWindowState(asAccountIndex(0));
    await flushAccountWindowsWrites();

    const stored = configGet('accountWindows') as Record<number, unknown>;
    expect(stored[0]).toEqual({
      bounds: { x: 50, y: 60, width: 1024, height: 768 },
      isMaximized: true,
    });
  });

  it('does NOT save state for account indices other than 0', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://x/', asAccountIndex(1));
    m.saveAccountWindowState(asAccountIndex(1));
    expect(configGet('accountWindows')).toBeUndefined();
  });

  it('does nothing when host window is missing or destroyed', () => {
    const m = new AccountViewManager();
    // No host window has been created yet
    m.saveAccountWindowState(asAccountIndex(0));
    expect(configGet('accountWindows')).toBeUndefined();
  });

  it('getAccountWindowState returns null when no state saved', () => {
    const m = new AccountViewManager();
    expect(m.getAccountWindowState(asAccountIndex(0))).toBeNull();
  });

  it('getAccountWindowState returns the saved state for account 0', async () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://x/', asAccountIndex(0));
    const host = lastWindow();
    host.bounds = { x: 1, y: 2, width: 100, height: 200 };
    m.saveAccountWindowState(asAccountIndex(0));
    await flushAccountWindowsWrites();
    const state = m.getAccountWindowState(asAccountIndex(0));
    expect(state).toEqual({
      bounds: { x: 1, y: 2, width: 100, height: 200 },
      isMaximized: false,
    });
  });

  it('getAccountWindowState returns null for unknown index even when store is populated', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://x/', asAccountIndex(0));
    m.saveAccountWindowState(asAccountIndex(0));
    expect(m.getAccountWindowState(asAccountIndex(99))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Hydrate / dehydrate (view show/hide rather than create/destroy)
// ---------------------------------------------------------------------------

describe('AccountViewManager — dehydrateAccount', () => {
  it('hides the view and throttles its renderer for non-bootstrap, non-zero accounts', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.createAccountWindow('https://1/', asAccountIndex(1));
    const v1 = viewOf(m, 1);
    m.dehydrateAccount(asAccountIndex(1));
    expect(m.isDehydrated(asAccountIndex(1))).toBe(true);
    expect(v1.webContents.setBackgroundThrottling).toHaveBeenCalledWith(true);
    // Hidden view positioned at zero bounds
    expect(v1.lastBounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('refuses to dehydrate account 0 (primary)', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.dehydrateAccount(asAccountIndex(0));
    expect(m.isDehydrated(asAccountIndex(0))).toBe(false);
  });

  it('refuses to dehydrate a bootstrap account', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://1/', asAccountIndex(1));
    m.markAsBootstrap(asAccountIndex(1));
    m.dehydrateAccount(asAccountIndex(1));
    expect(m.isDehydrated(asAccountIndex(1))).toBe(false);
  });

  it('is a no-op for an unknown account index', () => {
    const m = new AccountViewManager();
    expect(() => m.dehydrateAccount(asAccountIndex(42))).not.toThrow();
    expect(m.isDehydrated(asAccountIndex(42))).toBe(false);
  });

  it('is a no-op when already dehydrated-parked', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.createAccountWindow('https://1/', asAccountIndex(1));
    const v1 = viewOf(m, 1);
    m.dehydrateAccount(asAccountIndex(1));
    v1.webContents.setBackgroundThrottling.mockClear();
    m.dehydrateAccount(asAccountIndex(1));
    expect(v1.webContents.setBackgroundThrottling).not.toHaveBeenCalled();
  });

  it('can park a switched-away (hidden-live) account', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.createAccountWindow('https://1/', asAccountIndex(1));
    // 1 is front; 0 is hidden-live — not dehydrated
    expect(m.isDehydrated(asAccountIndex(0))).toBe(false);
    expect(m.isAccountVisible(asAccountIndex(0))).toBe(false);
    m.focusAccount(asAccountIndex(0));
    // 1 is now hidden-live
    expect(m.isDehydrated(asAccountIndex(1))).toBe(false);
    m.dehydrateAccount(asAccountIndex(1));
    expect(m.isDehydrated(asAccountIndex(1))).toBe(true);
    expect(m.isAccountVisible(asAccountIndex(1))).toBe(false);
  });
});

describe('AccountViewManager — hydrateAccount', () => {
  it('returns null for an unknown account', () => {
    const m = new AccountViewManager();
    expect(m.hydrateAccount(asAccountIndex(99))).toBeNull();
  });

  it('returns the host window when account is already visible (no toggle)', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    expect(m.hydrateAccount(asAccountIndex(0))).toBe(lastWindow());
  });

  it('shows a previously-parked view and returns the host window', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.createAccountWindow('https://1/', asAccountIndex(1));
    m.dehydrateAccount(asAccountIndex(1));
    expect(m.isDehydrated(asAccountIndex(1))).toBe(true);
    const result = m.hydrateAccount(asAccountIndex(1));
    expect(result).toBe(lastWindow());
    expect(m.isDehydrated(asAccountIndex(1))).toBe(false);
    expect(m.isAccountVisible(asAccountIndex(1))).toBe(true);
  });

  it('focusAccount unthrottles a parked secondary account (visible ⇒ unthrottled)', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.createAccountWindow('https://1/', asAccountIndex(1));
    const v1 = viewOf(m, 1);
    m.dehydrateAccount(asAccountIndex(1));
    v1.webContents.setBackgroundThrottling.mockClear();
    m.focusAccount(asAccountIndex(1));
    expect(m.isAccountVisible(asAccountIndex(1))).toBe(true);
    expect(m.isDehydrated(asAccountIndex(1))).toBe(false);
    expect(v1.webContents.setBackgroundThrottling).toHaveBeenCalledWith(false);
  });
});

describe('AccountViewManager — dehydrate visible fallback', () => {
  it('promotes account-0 when parking the frontmost non-zero account', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.createAccountWindow('https://1/', asAccountIndex(1));
    expect(m.isAccountVisible(asAccountIndex(1))).toBe(true);
    m.dehydrateAccount(asAccountIndex(1));
    expect(m.isDehydrated(asAccountIndex(1))).toBe(true);
    expect(m.isAccountVisible(asAccountIndex(0))).toBe(true);
    expect(m.isAccountVisible(asAccountIndex(1))).toBe(false);
  });

  it('listAccountIndices includes parked accounts', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.createAccountWindow('https://1/', asAccountIndex(1));
    m.dehydrateAccount(asAccountIndex(1));
    expect(m.listAccountIndices()).toEqual([asAccountIndex(0), asAccountIndex(1)]);
    expect(m.hasAccount(asAccountIndex(1))).toBe(true);
  });
});

describe('AccountViewManager — isDehydrated / three-state', () => {
  it('returns false for an unknown account', () => {
    const m = new AccountViewManager();
    expect(m.isDehydrated(asAccountIndex(99))).toBe(false);
  });

  it('does not treat switch-away as dehydrated', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.createAccountWindow('https://1/', asAccountIndex(1));
    // 1 frontmost; 0 hidden-live
    expect(m.isAccountVisible(asAccountIndex(1))).toBe(true);
    expect(m.isAccountVisible(asAccountIndex(0))).toBe(false);
    expect(m.isDehydrated(asAccountIndex(0))).toBe(false);
    expect(m.isDehydrated(asAccountIndex(1))).toBe(false);

    m.focusAccount(asAccountIndex(0));
    expect(m.isAccountVisible(asAccountIndex(0))).toBe(true);
    expect(m.isDehydrated(asAccountIndex(1))).toBe(false);
  });

  it('isDehydrated only after explicit dehydrateAccount park', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.createAccountWindow('https://1/', asAccountIndex(1));
    expect(m.isDehydrated(asAccountIndex(1))).toBe(false);
    m.dehydrateAccount(asAccountIndex(1));
    expect(m.isDehydrated(asAccountIndex(1))).toBe(true);
  });

  it('keeps other parked accounts parked when switching among live accounts', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.createAccountWindow('https://1/', asAccountIndex(1));
    m.createAccountWindow('https://2/', asAccountIndex(2));
    m.dehydrateAccount(asAccountIndex(1));
    expect(m.isDehydrated(asAccountIndex(1))).toBe(true);
    m.focusAccount(asAccountIndex(0));
    expect(m.isDehydrated(asAccountIndex(1))).toBe(true);
    expect(m.isAccountVisible(asAccountIndex(0))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// unregisterAccount
// ---------------------------------------------------------------------------

describe('AccountViewManager — unregisterAccount', () => {
  it('removes the account from views/lookup tables and child views', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://x/', asAccountIndex(0));
    const wc = m.getAccountWebContents(asAccountIndex(0)) as unknown as MockWCInstance;
    const wcId = wc.id;
    m.unregisterAccount(asAccountIndex(0));
    expect(m.hasAccount(asAccountIndex(0))).toBe(false);
    expect(m.getAccountWebContents(asAccountIndex(0))).toBeNull();
    expect(m.getAccountForWebContents(asWebContentsId(wcId))).toBeNull();
    expect(lastWindow().contentView.removeChildView).toHaveBeenCalled();
  });

  it('clears bootstrap state for the account', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://x/', asAccountIndex(1));
    m.markAsBootstrap(asAccountIndex(1));
    m.unregisterAccount(asAccountIndex(1));
    expect(m.isBootstrap(asAccountIndex(1))).toBe(false);
  });

  it('closes the view webContents to release the renderer', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://x/', asAccountIndex(0));
    const view = viewOf(m, 0);
    m.unregisterAccount(asAccountIndex(0));
    expect(view.webContents.close).toHaveBeenCalled();
  });

  it('updates mostRecentAccountIndex when removing the active account', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.createAccountWindow('https://1/', asAccountIndex(1));
    // mostRecent is 1
    m.unregisterAccount(asAccountIndex(1));
    // Now most-recent should fall back to remaining account (0).
    const host = lastWindow();
    expect(m.getAccountIndex(host as unknown as Electron.BrowserWindow)).toBe(0);
  });

  it('is a no-op for an unknown account', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://x/', asAccountIndex(0));
    expect(() => m.unregisterAccount(asAccountIndex(99))).not.toThrow();
    expect(m.getAccountCount()).toBe(1);
  });

  it('survives a destroyed webContents during cleanup', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://x/', asAccountIndex(0));
    const view = viewOf(m, 0);
    view.webContents.destroyed = true;
    view.webContents.close = vi.fn(() => {
      throw new Error('already destroyed');
    });
    expect(() => m.unregisterAccount(asAccountIndex(0))).not.toThrow();
    expect(m.hasAccount(asAccountIndex(0))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// destroyAll
// ---------------------------------------------------------------------------

describe('AccountViewManager — destroyAll', () => {
  it('unregisters every account and destroys the host window', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.createAccountWindow('https://1/', asAccountIndex(1));
    const host = lastWindow();
    m.destroyAll();
    expect(m.getAccountCount()).toBe(0);
    expect(host.destroy).toHaveBeenCalled();
    expect(host.destroyed).toBe(true);
  });

  it('stops session maintenance during cleanup', () => {
    const m = new AccountViewManager();

    m.destroyAll();

    expect(stopSessionMaintenance).toHaveBeenCalled();
  });

  it('restarts session maintenance when a manager creates a view after cleanup', () => {
    const m = new AccountViewManager();
    m.destroyAll();
    vi.clearAllMocks();

    m.createAccountWindow('https://mail.google.com/chat/u/1', asAccountIndex(1));

    expect(startSessionMaintenance).toHaveBeenCalledWith(h.activityTracker, m);
  });

  it('clears bootstrap tracker state', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.markAsBootstrap(asAccountIndex(0));
    m.destroyAll();
    expect(h.bootstrapSet.size).toBe(0);
  });

  it('is safe to call when no host window has been created', () => {
    const m = new AccountViewManager();
    expect(() => m.destroyAll()).not.toThrow();
  });

  it('removes resize/full-screen listeners from the host window', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://x/', asAccountIndex(0));
    const host = lastWindow();
    m.destroyAll();
    // Should remove three listeners (resize, enter-full-screen, leave-full-screen)
    expect(host.removeListener_spy).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(host.removeListener_spy).toHaveBeenCalledWith('enter-full-screen', expect.any(Function));
    expect(host.removeListener_spy).toHaveBeenCalledWith('leave-full-screen', expect.any(Function));
  });

  it('resets internal state so subsequent createAccountWindow builds a fresh host', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://x/', asAccountIndex(0));
    const firstHost = lastWindow();
    m.destroyAll();
    m.createAccountWindow('https://y/', asAccountIndex(0));
    const secondHost = lastWindow();
    expect(secondHost).not.toBe(firstHost);
    expect(m.hasAccount(asAccountIndex(0))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// View switching via duplicate createAccountWindow
// ---------------------------------------------------------------------------

describe('AccountViewManager — switching active account via re-create', () => {
  it('shows host window when switching if it was hidden', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    const host = lastWindow();
    host.visible = false;
    host.show.mockClear();
    // Re-create existing account: should switchToAccount which shows host.
    m.createAccountWindow('https://0-again/', asAccountIndex(0));
    expect(host.show).toHaveBeenCalled();
  });

  it('focuses the host window and the active view webContents', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    const host = lastWindow();
    host.focus.mockClear();
    const view = viewOf(m, 0);
    view.webContents.focus.mockClear();
    m.createAccountWindow('https://0-again/', asAccountIndex(0));
    expect(host.focus).toHaveBeenCalled();
    expect(view.webContents.focus).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Singleton get/destroy
// ---------------------------------------------------------------------------

describe('getAccountViewManager / destroyAccountViewManager singleton', () => {
  it('returns the same instance across calls', () => {
    const a = getAccountViewManager();
    const b = getAccountViewManager();
    expect(a).toBe(b);
  });

  it('destroyAccountViewManager allows a new instance afterward', () => {
    const a = getAccountViewManager();
    destroyAccountViewManager();
    const b = getAccountViewManager();
    expect(b).not.toBe(a);
  });

  it('destroyAccountViewManager is safe when no instance exists', () => {
    destroyAccountViewManager();
    expect(() => destroyAccountViewManager()).not.toThrow();
  });

  it('destroyAccountViewManager calls destroyAll on the live instance', () => {
    const m = getAccountViewManager();
    m.createAccountWindow('https://x/', asAccountIndex(0));
    const host = lastWindow();
    destroyAccountViewManager();
    expect(host.destroy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Host window lifecycle integration
// ---------------------------------------------------------------------------

describe('AccountViewManager — host window lifecycle integration', () => {
  it('host "closed" event tears down all accounts via destroyAll', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://x/', asAccountIndex(0));
    const host = lastWindow();
    expect(m.getAccountCount()).toBe(1);
    host.emit('closed');
    expect(m.getAccountCount()).toBe(0);
  });

  it('host "resize" event triggers a re-layout of the visible view', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://x/', asAccountIndex(0));
    const host = lastWindow();
    const view = viewOf(m, 0);
    view.setBounds.mockClear();
    host.bounds = { x: 0, y: 0, width: 1200, height: 900 };
    host.emit('resize');
    expect(view.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1200, height: 900 });
  });

  it('host "ready-to-show" causes show() when startHidden=false', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://x/', asAccountIndex(0));
    const host = lastWindow();
    host.show.mockClear();
    host.emit('ready-to-show');
    expect(host.show).toHaveBeenCalled();
  });

  it('host ready-to-show does not show when startHidden is true', async () => {
    const { getWindowDefaults } = await import('../platform/windowUtils.js');
    vi.mocked(getWindowDefaults).mockReturnValueOnce({
      hideMenuBar: false,
      startHidden: true,
    });
    const m = new AccountViewManager();
    m.createAccountWindow('https://x/', asAccountIndex(0));
    const host = lastWindow();
    host.show.mockClear();
    host.emit('ready-to-show');
    expect(host.show).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Todo 13 — WCV resource-state / throttle transition matrix
// ---------------------------------------------------------------------------

interface ResourceCell {
  visible: boolean;
  dehydrated: boolean;
  throttling: boolean;
}

function expectResourceCell(
  manager: AccountViewManager,
  idx: number,
  expected: ResourceCell
): void {
  const view = viewOf(manager, idx);
  expect(manager.isAccountVisible(asAccountIndex(idx)), `account ${idx} visibility`).toBe(
    expected.visible
  );
  expect(manager.isDehydrated(asAccountIndex(idx)), `account ${idx} dehydrated`).toBe(
    expected.dehydrated
  );
  expect(view.webContents.throttling, `account ${idx} setBackgroundThrottling`).toBe(
    expected.throttling
  );
  expect(view.webContents.setBackgroundThrottling).toHaveBeenLastCalledWith(expected.throttling);
}

const UNTHROTTLED_VISIBLE: ResourceCell = {
  visible: true,
  dehydrated: false,
  throttling: false,
};
const ACCOUNT0_HIDDEN_LIVE: ResourceCell = {
  visible: false,
  dehydrated: false,
  throttling: false,
};
const SECONDARY_HIDDEN_LIVE: ResourceCell = {
  visible: false,
  dehydrated: false,
  throttling: true,
};
const SECONDARY_PARKED: ResourceCell = {
  visible: false,
  dehydrated: true,
  throttling: true,
};

describe('AccountViewManager — resource-state throttle matrix (Todo 13)', () => {
  it('walks 0 -> 1 -> 2 -> 0 and asserts state, visibility, and exact throttle', () => {
    const m = new AccountViewManager();

    m.createAccountWindow('https://0/', asAccountIndex(0));
    expectResourceCell(m, 0, UNTHROTTLED_VISIBLE);

    m.createAccountWindow('https://1/', asAccountIndex(1));
    expectResourceCell(m, 0, ACCOUNT0_HIDDEN_LIVE);
    expectResourceCell(m, 1, UNTHROTTLED_VISIBLE);

    m.createAccountWindow('https://2/', asAccountIndex(2));
    expectResourceCell(m, 0, ACCOUNT0_HIDDEN_LIVE);
    expectResourceCell(m, 1, SECONDARY_HIDDEN_LIVE);
    expectResourceCell(m, 2, UNTHROTTLED_VISIBLE);

    m.focusAccount(asAccountIndex(0));
    expectResourceCell(m, 0, UNTHROTTLED_VISIBLE);
    expectResourceCell(m, 1, SECONDARY_HIDDEN_LIVE);
    expectResourceCell(m, 2, SECONDARY_HIDDEN_LIVE);

    // Host WebContents is not an account renderer — never throttle it.
    expect(lastWindow().webContents.setBackgroundThrottling).not.toHaveBeenCalled();
  });

  it('switching away from account 1/2 sets true; returning sets false; account 0 stays false', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.createAccountWindow('https://1/', asAccountIndex(1));
    m.createAccountWindow('https://2/', asAccountIndex(2));

    m.focusAccount(asAccountIndex(1));
    expectResourceCell(m, 0, ACCOUNT0_HIDDEN_LIVE);
    expectResourceCell(m, 1, UNTHROTTLED_VISIBLE);
    expectResourceCell(m, 2, SECONDARY_HIDDEN_LIVE);

    m.focusAccount(asAccountIndex(2));
    expectResourceCell(m, 0, ACCOUNT0_HIDDEN_LIVE);
    expectResourceCell(m, 1, SECONDARY_HIDDEN_LIVE);
    expectResourceCell(m, 2, UNTHROTTLED_VISIBLE);

    m.focusAccount(asAccountIndex(0));
    expectResourceCell(m, 0, UNTHROTTLED_VISIBLE);
    expectResourceCell(m, 1, SECONDARY_HIDDEN_LIVE);
    expectResourceCell(m, 2, SECONDARY_HIDDEN_LIVE);
  });

  it('create of a secondary account unthrottles it and leaves account 0 unthrottled', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.createAccountWindow('https://1/', asAccountIndex(1));
    expect(m.isAccountVisible(asAccountIndex(1))).toBe(true);
    expect(m.isDehydrated(asAccountIndex(0))).toBe(false);
    expectResourceCell(m, 0, ACCOUNT0_HIDDEN_LIVE);
    expectResourceCell(m, 1, UNTHROTTLED_VISIBLE);
  });

  it('parking the frontmost secondary promotes account 0 and throttles the parked view', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.createAccountWindow('https://1/', asAccountIndex(1));
    m.createAccountWindow('https://2/', asAccountIndex(2));
    expect(m.isAccountVisible(asAccountIndex(2))).toBe(true);

    m.dehydrateAccount(asAccountIndex(2));

    expectResourceCell(m, 0, UNTHROTTLED_VISIBLE);
    expectResourceCell(m, 1, SECONDARY_HIDDEN_LIVE);
    expectResourceCell(m, 2, SECONDARY_PARKED);
  });

  it('parking a hidden-live secondary does not mark it visible or dehydrate account 0', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.createAccountWindow('https://1/', asAccountIndex(1));
    m.focusAccount(asAccountIndex(0));
    expect(m.isDehydrated(asAccountIndex(1))).toBe(false);

    m.dehydrateAccount(asAccountIndex(1));

    expectResourceCell(m, 0, UNTHROTTLED_VISIBLE);
    expectResourceCell(m, 1, SECONDARY_PARKED);
    expect(m.isAccountVisible(asAccountIndex(0))).toBe(true);
  });

  it('hydrateAccount and focusAccount restore a parked secondary as visible + unthrottled', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.createAccountWindow('https://1/', asAccountIndex(1));
    m.dehydrateAccount(asAccountIndex(1));
    expectResourceCell(m, 1, SECONDARY_PARKED);

    expect(m.hydrateAccount(asAccountIndex(1))).toBe(lastWindow());
    expectResourceCell(m, 0, ACCOUNT0_HIDDEN_LIVE);
    expectResourceCell(m, 1, UNTHROTTLED_VISIBLE);

    m.dehydrateAccount(asAccountIndex(1));
    m.focusAccount(asAccountIndex(1));
    expectResourceCell(m, 0, ACCOUNT0_HIDDEN_LIVE);
    expectResourceCell(m, 1, UNTHROTTLED_VISIBLE);
  });

  it('unregister of the visible secondary promotes account 0 and keeps it unthrottled', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.createAccountWindow('https://1/', asAccountIndex(1));
    m.createAccountWindow('https://2/', asAccountIndex(2));
    expect(m.isAccountVisible(asAccountIndex(2))).toBe(true);

    m.unregisterAccount(asAccountIndex(2));

    expect(m.hasAccount(asAccountIndex(2))).toBe(false);
    expectResourceCell(m, 0, UNTHROTTLED_VISIBLE);
    expectResourceCell(m, 1, SECONDARY_HIDDEN_LIVE);
    expect(lastWindow().webContents.setBackgroundThrottling).not.toHaveBeenCalled();
  });

  it('unregister of a hidden-live secondary leaves the visible account in place', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.createAccountWindow('https://1/', asAccountIndex(1));
    m.focusAccount(asAccountIndex(0));

    m.unregisterAccount(asAccountIndex(1));

    expect(m.hasAccount(asAccountIndex(1))).toBe(false);
    expectResourceCell(m, 0, UNTHROTTLED_VISIBLE);
  });

  it('refuses to park the last visible account when no fallback exists', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://1/', asAccountIndex(1));
    expect(m.isAccountVisible(asAccountIndex(1))).toBe(true);

    m.dehydrateAccount(asAccountIndex(1));

    expect(m.isDehydrated(asAccountIndex(1))).toBe(false);
    expectResourceCell(m, 1, UNTHROTTLED_VISIBLE);
  });

  it('does not park account 0 or a bootstrap secondary, and never marks hidden-live dehydrated', () => {
    const m = new AccountViewManager();
    m.createAccountWindow('https://0/', asAccountIndex(0));
    m.createAccountWindow('https://1/', asAccountIndex(1));
    m.markAsBootstrap(asAccountIndex(1));

    m.dehydrateAccount(asAccountIndex(0));
    m.dehydrateAccount(asAccountIndex(1));
    m.focusAccount(asAccountIndex(0));

    expect(m.isDehydrated(asAccountIndex(0))).toBe(false);
    expect(m.isDehydrated(asAccountIndex(1))).toBe(false);
    expectResourceCell(m, 0, UNTHROTTLED_VISIBLE);
    expectResourceCell(m, 1, SECONDARY_HIDDEN_LIVE);
  });
});

function partitionForView(manager: AccountViewManager, accountIndex: number): string | null {
  const wc = manager.getAccountWebContents(asAccountIndex(accountIndex));
  if (!wc) return null;
  const win = lastWindow();
  const found = win.addedChildren.find(
    (view: MockViewInstance) => view.webContents === (wc as unknown as MockWCInstance)
  );
  const options = found?.ctorOptions as { webPreferences?: { partition?: string } } | undefined;
  return options?.webPreferences?.partition ?? null;
}

runSharedRoutingScenarios({
  backend: 'web-contents-view',
  createContext: () => {
    const manager = new AccountViewManager();
    return {
      backend: 'web-contents-view',
      manager,
      probes: attachRoutingProbes('web-contents-view', manager, () => {
        return manager.getMostRecentWindow()?.webContents ?? null;
      }),
      getPartition: (accountIndex: number) => partitionForView(manager, accountIndex),
      getHostWebContents: () => manager.getMostRecentWindow()?.webContents ?? null,
    };
  },
});

describe('AccountViewManager permanent removal hooks', () => {
  let manager: AccountViewManager;
  const removed = vi.fn();

  beforeEach(() => {
    accountHooks.clearAccountWebContentsHooksForTests();
    removed.mockClear();
    accountHooks.onAccountRemoved(removed);
    manager = new AccountViewManager();
  });

  afterEach(() => {
    manager.destroyAll();
    accountHooks.clearAccountWebContentsHooksForTests();
  });

  it('keeps the same live renderer and hook disposer when parking and hydrating', () => {
    const created = vi.fn();
    const disposed = vi.fn();
    accountHooks.onAccountWebContentsCreated((info) => {
      created(info.webContents);
      return disposed;
    });
    manager.createAccountWindow('https://example.com/zero', asAccountIndex(0));
    manager.createAccountWindow('https://example.com/two', asAccountIndex(2));
    const original = manager.getAccountWebContents(asAccountIndex(2));

    manager.dehydrateAccount(asAccountIndex(2));
    manager.hydrateAccount(asAccountIndex(2));

    expect(removed).not.toHaveBeenCalled();
    expect(disposed).not.toHaveBeenCalled();
    expect(created).toHaveBeenCalledTimes(2);
    expect(manager.getAccountWebContents(asAccountIndex(2))).toBe(original);
    expect(original?.isDestroyed()).toBe(false);
  });

  it('reports explicit removal of a parked sparse account only once', () => {
    manager.createAccountWindow('https://example.com/zero', asAccountIndex(0));
    const index = asAccountIndex(7);
    manager.createAccountWindow('https://example.com/seven', index);
    manager.dehydrateAccount(index);
    const senderId = asWebContentsId(manager.getAccountWebContents(index)?.id ?? 0);

    manager.unregisterAccount(index);
    manager.unregisterAccount(index);

    expect(removed.mock.calls).toEqual([[index]]);
    expect(manager.getAccountForWebContents(senderId)).toBeNull();
    expect(manager.hasAccount(index)).toBe(false);
  });

  it('reports sparse parked and live accounts once on native host close', () => {
    for (const index of [0, 2, 7]) {
      manager.createAccountWindow(`https://example.com/${index}`, asAccountIndex(index));
    }
    manager.dehydrateAccount(asAccountIndex(7));

    lastWindow().destroy();

    expect(removed.mock.calls).toEqual([[0], [2], [7]]);
    expect(manager.listAccountIndices()).toEqual([]);
  });

  it('reports sparse parked and live accounts once during repeated full teardown', () => {
    for (const index of [0, 2, 7]) {
      manager.createAccountWindow(`https://example.com/${index}`, asAccountIndex(index));
    }
    manager.dehydrateAccount(asAccountIndex(7));

    manager.destroyAll();
    manager.destroyAll();

    expect(removed.mock.calls).toEqual([[0], [2], [7]]);
  });

  it('does not emit shared removal hooks from an isolated manager', () => {
    const isolated = new AccountViewManager(undefined, { isolated: true });
    isolated.createAccountWindow('https://example.com/two', asAccountIndex(2));

    isolated.destroyAll();

    expect(removed).not.toHaveBeenCalled();
  });
});

describe('AccountViewManager — log redaction', () => {
  const spies = spiesOf(log);
  const PREFIX = '[AccountViewManager]';

  beforeEach(() => {
    clearSpies(spies);
  });

  /** Make the NEXT view added to the host throw a secret-bearing Error from its first loadURL. */
  function failNextInitialLoad(m: AccountViewManager): void {
    const host = lastWindow();
    const addChildView = host.contentView.addChildView;
    const original = addChildView.getMockImplementation();
    addChildView.mockImplementationOnce((view: MockViewInstance) => {
      view.webContents.loadURL = vi.fn(() => {
        throw makeSecretError();
      });
      original?.(view);
    });
    expect(m.getAccountCount()).toBeGreaterThan(0);
  }

  it('logs view creation without the URL while the view still loads the original URL', () => {
    const m = new AccountViewManager();
    m.createAccountWindow(SECRET_AUTH_URL, asAccountIndex(0));

    expect(viewOf(m, 0).webContents.loadURL).toHaveBeenCalledExactlyOnceWith(SECRET_AUTH_URL);
    expect(messagesAt(spies, 'info', PREFIX)).toEqual([
      '[AccountViewManager] Host window created',
      '[AccountViewManager] Created view for account 0 (partition=persist:account-0)',
    ]);
    expectNoSentinels(spies, 2);
  });

  it('logs a failed initial load without its Error', () => {
    const m = new AccountViewManager();
    m.createAccountWindow(SECRET_CHAT_URL, asAccountIndex(0));
    failNextInitialLoad(m);
    clearSpies(spies);

    expect(() => m.createAccountWindow(SECRET_AUTH_URL, asAccountIndex(1))).not.toThrow();

    expect(viewOf(m, 1).webContents.loadURL).toHaveBeenCalledExactlyOnceWith(SECRET_AUTH_URL);
    expect(messagesAt(spies, 'warn', PREFIX)).toEqual([
      '[AccountViewManager] Initial loadURL failed for account 1',
    ]);
    expectNoSentinels(spies);
  });

  it('logs a failed security-handler install without its Error', () => {
    vi.mocked(installPermissionHandlers).mockImplementationOnce(() => {
      throw makeSecretError();
    });
    const m = new AccountViewManager();
    expect(() => m.createAccountWindow(SECRET_CHAT_URL, asAccountIndex(1))).not.toThrow();
    expect(messagesAt(spies, 'warn', PREFIX)).toEqual([
      '[AccountViewManager] Failed to install security handlers for account 1',
    ]);
    expectNoSentinels(spies);
  });

  it('reuses an existing view with the original URL and logs a failed reload without its Error', () => {
    const m = new AccountViewManager();
    m.createAccountWindow(SECRET_CHAT_URL, asAccountIndex(0));
    const wc = viewOf(m, 0).webContents;
    wc.loadURL.mockClear();
    wc.loadURL.mockImplementationOnce(() => {
      throw makeSecretError();
    });

    m.createAccountWindow(SECRET_AUTH_URL, asAccountIndex(0));

    expect(wc.loadURL).toHaveBeenCalledExactlyOnceWith(SECRET_AUTH_URL);
    expect(messagesAt(spies, 'warn', PREFIX)).toEqual([
      '[AccountViewManager] loadURL on existing view failed for account 0',
    ]);
    expectNoSentinels(spies);
  });

  it('logs a visible-view setBounds failure without its Error', () => {
    const m = new AccountViewManager();
    m.createAccountWindow(SECRET_CHAT_URL, asAccountIndex(0));
    viewOf(m, 0).setBoundsImpl = () => {
      throw makeSecretError();
    };
    lastWindow().emit('resize');

    expect(messagesAt(spies, 'warn', PREFIX)).toContain(
      '[AccountViewManager] setBounds(visible) failed for account 0'
    );
    expectNoSentinels(spies);
  });

  it('logs unregister teardown failures without their Errors', () => {
    const m = new AccountViewManager();
    m.createAccountWindow(SECRET_CHAT_URL, asAccountIndex(0));
    m.createAccountWindow(SECRET_CHAT_URL, asAccountIndex(1));
    const view = viewOf(m, 1);
    lastWindow().contentView.removeChildView.mockImplementationOnce(() => {
      throw makeSecretError();
    });
    view.webContents.close = vi.fn(() => {
      throw makeSecretError();
    });

    m.unregisterAccount(asAccountIndex(1));

    expect(messagesAt(spies, 'warn', PREFIX)).toEqual([
      '[AccountViewManager] removeChildView failed for account 1',
      '[AccountViewManager] Closing webContents failed for account 1',
    ]);
    expect(messagesAt(spies, 'info', PREFIX)).toContain(
      '[AccountViewManager] Unregistered account 1'
    );
    expectNoSentinels(spies);
  });

  it('keeps URL-free park, unpark, bootstrap and destroy messages', () => {
    const m = new AccountViewManager();
    m.createAccountWindow(SECRET_AUTH_URL, asAccountIndex(0));
    m.createAccountWindow(SECRET_AUTH_URL, asAccountIndex(1));
    m.createAccountWindow(SECRET_AUTH_URL, asAccountIndex(2));
    clearSpies(spies);

    m.dehydrateAccount(asAccountIndex(2));
    m.hydrateAccount(asAccountIndex(2));
    m.dehydrateAccount(asAccountIndex(1));
    m.markAsBootstrap(asAccountIndex(99));
    m.destroyAll();
    getAccountViewManager();
    destroyAccountViewManager();

    expect(messagesAt(spies, 'info', PREFIX)).toEqual([
      '[AccountViewManager] Dehydrated (parked) account 2; promoted 0',
      '[AccountViewManager] Hydrated (shown) account 2',
      '[AccountViewManager] Dehydrated (parked) account 1',
      '[AccountViewManager] Unregistered account 0',
      '[AccountViewManager] Unregistered account 1',
      '[AccountViewManager] Unregistered account 2',
      '[AccountViewManager] Host window created'.replace(
        'Host window created',
        'Manager destroyed'
      ),
    ]);
    expect(messagesAt(spies, 'warn', PREFIX)).toEqual([
      '[AccountViewManager] markAsBootstrap: account 99 not registered — ignored',
    ]);
    expectNoSentinels(spies, 5);
  });
});
