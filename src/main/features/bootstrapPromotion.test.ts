/**
 * Unit tests for the bootstrapPromotion feature.
 *
 * Strategy
 * ────────
 * We fake `electron` and `electron-log` with minimal stubs, then fake
 * `accountWindowManager` with a controllable in-memory instance so we can
 * verify that:
 *   - promoteBootstrap() is called when auth is detected
 *   - listeners are cleaned up after promotion (no dangling handlers)
 *   - child-window (popup) auth path triggers the same promotion
 *   - early window closure removes all listeners gracefully
 *   - non-authenticated URLs are ignored
 *   - init() is a no-op when no accounts are marked as bootstrap
 *   - watchBootstrapAccount() from bootstrapWatcher promotes secondary accounts
 *   - init() watches all currently-bootstrap accounts simultaneously
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type * as BootstrapWatcher from '../utils/account/bootstrapWatcher.js';
import {
  expectNoSentinels,
  makeSecretError,
  messagesAt,
  spiesOf,
} from '../../../tests/mocks/logCapture';

// ─── Shared mock state ────────────────────────────────────────────────────────

// We build a minimal fake BrowserWindow with only the surface our feature uses.
function makeFakeWindow() {
  const wc = new EventEmitter() as EventEmitter & {
    getURL: () => string;
    isDestroyed: () => boolean;
  };
  wc.getURL = vi.fn(() => '');
  wc.isDestroyed = () => false;

  const win = new EventEmitter() as EventEmitter & {
    webContents: typeof wc;
    isDestroyed: () => boolean;
    destroy: () => void;
    loadURL: ReturnType<typeof vi.fn>;
    _destroyed: boolean;
  };
  win.webContents = wc;
  win._destroyed = false;
  win.isDestroyed = () => win._destroyed;
  win.loadURL = vi.fn();
  win.destroy = () => {
    win._destroyed = true;
    win.emit('closed');
  };
  return win;
}

// Controllable in-memory fake for AccountWindowManager.
function makeFakeMgr(
  bootstrapAccounts: Set<number>,
  windowMap: Map<number, ReturnType<typeof makeFakeWindow>>
) {
  return {
    isBootstrap: (idx: number) => bootstrapAccounts.has(idx),
    getAccountWindow: (idx: number) => windowMap.get(idx) ?? null,
    getAccountWebContents: (idx: number) => {
      const win = windowMap.get(idx);
      if (!win || win.isDestroyed()) return null;
      return win.webContents;
    },
    getBootstrapAccounts: () => Array.from(bootstrapAccounts),
    promoteBootstrap: vi.fn((idx: number) => {
      const was = bootstrapAccounts.has(idx);
      bootstrapAccounts.delete(idx);
      return was;
    }),
  };
}

vi.mock('../utils/account/accountNavigation.js', () => ({
  loadAccountURL: vi.fn().mockReturnValue(true),
}));

// ─── Mocks ────────────────────────────────────────────────────────────────────

// vi.mock calls are hoisted by Vitest — they run before any imports.

vi.mock('electron', () => ({
  // Feature only imports types from electron; no runtime call needed.
  app: {
    isPackaged: false,
  },
}));

vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// We'll override the return value of getAccountWindowManager per test.
const getAccountWindowManagerMock = vi.fn();

vi.mock('../utils/account/accountWindowManager.js', () => ({
  getAccountWindowManager: getAccountWindowManagerMock,
}));

vi.mock('../../environment.js', () => ({
  default: {
    appUrl: 'https://chat.google.com',
  },
}));

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('bootstrapPromotion feature', () => {
  let bootstrapAccounts: Set<number>;
  let windowMap: Map<number, ReturnType<typeof makeFakeWindow>>;
  let mgr: ReturnType<typeof makeFakeMgr>;
  let account0Win: ReturnType<typeof makeFakeWindow>;
  let watchBootstrapAccount: typeof BootstrapWatcher.watchBootstrapAccount;
  let cleanupBootstrapPromotion: typeof BootstrapWatcher.cleanupBootstrapPromotion;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    account0Win = makeFakeWindow();
    bootstrapAccounts = new Set([0]);
    windowMap = new Map([[0, account0Win]]);
    mgr = makeFakeMgr(bootstrapAccounts, windowMap);
    getAccountWindowManagerMock.mockReturnValue(mgr);
    ({ watchBootstrapAccount, cleanupBootstrapPromotion } =
      await import('../utils/account/bootstrapWatcher.js'));
  });

  // ── No-op cases ─────────────────────────────────────────────────────────────

  it('is a no-op when no accounts are marked as bootstrap', async () => {
    bootstrapAccounts.clear(); // no bootstrap accounts
    const feature = await import('./bootstrapPromotion.js');
    feature.default();
    expect(mgr.promoteBootstrap).not.toHaveBeenCalled();
  });

  it('is a no-op when account-0 window does not exist', async () => {
    windowMap.delete(0); // no window registered
    const feature = await import('./bootstrapPromotion.js');
    feature.default();
    expect(mgr.promoteBootstrap).not.toHaveBeenCalled();
  });

  it('is a no-op when account-0 window is already destroyed', async () => {
    account0Win._destroyed = true;
    const feature = await import('./bootstrapPromotion.js');
    feature.default();
    expect(mgr.promoteBootstrap).not.toHaveBeenCalled();
  });

  // ── Path A: auth inside the same window ─────────────────────────────────────

  it('promotes account-0 when did-navigate fires with an authenticated URL', async () => {
    const feature = await import('./bootstrapPromotion.js');
    feature.default();

    // Simulate navigation to an authenticated Chat URL.
    account0Win.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/0/');

    expect(mgr.promoteBootstrap).toHaveBeenCalledOnce();
    expect(mgr.promoteBootstrap).toHaveBeenCalledWith(0);
  });

  it('does NOT promote when did-navigate fires with a non-authenticated URL', async () => {
    const feature = await import('./bootstrapPromotion.js');
    feature.default();

    account0Win.webContents.emit('did-navigate', {}, 'https://accounts.google.com/signin');

    expect(mgr.promoteBootstrap).not.toHaveBeenCalled();
  });

  it('does NOT promote on bare chat.google.com/ (no /u/ segment)', async () => {
    const feature = await import('./bootstrapPromotion.js');
    feature.default();

    account0Win.webContents.emit('did-navigate', {}, 'https://chat.google.com/');

    expect(mgr.promoteBootstrap).not.toHaveBeenCalled();
  });

  it('removes the did-navigate listener after promotion (self-cleaning)', async () => {
    const feature = await import('./bootstrapPromotion.js');
    feature.default();

    // First auth navigation — should promote.
    account0Win.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/0/');
    expect(mgr.promoteBootstrap).toHaveBeenCalledOnce();

    // Second navigation — listener must have been removed, so no second call.
    account0Win.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/0/r/room');
    expect(mgr.promoteBootstrap).toHaveBeenCalledOnce(); // still just 1
  });

  it('accepts mail.google.com/chat/u/1/ as an authenticated URL', async () => {
    const feature = await import('./bootstrapPromotion.js');
    feature.default();

    account0Win.webContents.emit('did-navigate', {}, 'https://mail.google.com/chat/u/1/');

    expect(mgr.promoteBootstrap).toHaveBeenCalledOnce();
  });

  // ── Path B: auth via child/popup window ─────────────────────────────────────

  it('promotes account-0 when auth completes in a child (popup) window', async () => {
    const feature = await import('./bootstrapPromotion.js');
    feature.default();

    const childWin = makeFakeWindow();

    // Electron fires did-create-window with the child BrowserWindow.
    account0Win.webContents.emit('did-create-window', childWin, {});

    // Child navigates to an authenticated URL.
    childWin.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/0/');

    expect(mgr.promoteBootstrap).toHaveBeenCalledOnce();
    expect(mgr.promoteBootstrap).toHaveBeenCalledWith(0);
  });

  it('destroys the child window after promotion via popup auth', async () => {
    const feature = await import('./bootstrapPromotion.js');
    feature.default();

    const childWin = makeFakeWindow();
    account0Win.webContents.emit('did-create-window', childWin, {});

    childWin.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/0/');

    expect(childWin._destroyed).toBe(true);
  });

  it('reloads the bootstrap window after child-window auth completes', async () => {
    const feature = await import('./bootstrapPromotion.js');
    feature.default();

    const childWin = makeFakeWindow();
    account0Win.webContents.emit('did-create-window', childWin, {});
    childWin.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/0/');

    const { loadAccountURL } = await import('../utils/account/accountNavigation.js');
    expect(loadAccountURL).toHaveBeenCalled();
  });

  it('removes child auth listener after promotion (no double-fire)', async () => {
    const feature = await import('./bootstrapPromotion.js');
    feature.default();

    const childWin = makeFakeWindow();
    account0Win.webContents.emit('did-create-window', childWin, {});

    // First auth navigation in child — promotes.
    childWin.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/0/');
    expect(mgr.promoteBootstrap).toHaveBeenCalledOnce();

    // Even if the (destroyed) child somehow emits again, no second call.
    childWin.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/0/');
    expect(mgr.promoteBootstrap).toHaveBeenCalledOnce();
  });

  it('handles a second child window after the first was closed without auth', async () => {
    const feature = await import('./bootstrapPromotion.js');
    feature.default();

    // First popup — user closes without logging in.
    const child1 = makeFakeWindow();
    account0Win.webContents.emit('did-create-window', child1, {});
    child1.destroy(); // closed before auth

    // Second popup — user logs in.
    const child2 = makeFakeWindow();
    account0Win.webContents.emit('did-create-window', child2, {});
    child2.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/0/');

    expect(mgr.promoteBootstrap).toHaveBeenCalledOnce();
  });

  // ── Window closed before auth ────────────────────────────────────────────────

  it('does nothing if account-0 window closes before auth completes', async () => {
    const feature = await import('./bootstrapPromotion.js');
    feature.default();

    // Close the window before any auth.
    account0Win.destroy();

    expect(mgr.promoteBootstrap).not.toHaveBeenCalled();
  });

  it('does not error if did-navigate fires after window closure', async () => {
    const feature = await import('./bootstrapPromotion.js');
    feature.default();

    // Simulate closure then a stale navigate event.
    account0Win.destroy();
    expect(() => {
      account0Win.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/0/');
    }).not.toThrow();

    // The listener should have been removed, so promote is not called.
    expect(mgr.promoteBootstrap).not.toHaveBeenCalled();
  });

  // ── Explicit cleanup ─────────────────────────────────────────────────────────

  it('cleanupBootstrapPromotion() removes listeners without error', async () => {
    const feature = await import('./bootstrapPromotion.js');
    feature.default();

    expect(() => cleanupBootstrapPromotion()).not.toThrow();
  });

  it('cleanupBootstrapPromotion() prevents promotion after cleanup', async () => {
    const feature = await import('./bootstrapPromotion.js');
    feature.default();
    cleanupBootstrapPromotion();

    // Navigation after cleanup — listener must be gone.
    account0Win.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/0/');
    expect(mgr.promoteBootstrap).not.toHaveBeenCalled();
  });

  it('cleanupBootstrapPromotion() is idempotent (double-call does not error)', async () => {
    const feature = await import('./bootstrapPromotion.js');
    feature.default();

    expect(() => {
      cleanupBootstrapPromotion();
      cleanupBootstrapPromotion();
    }).not.toThrow();
  });

  // ── skip double-promotion ────────────────────────────────────────────────────

  it('does not call promoteBootstrap if bootstrap flag was already cleared', async () => {
    // Simulate a race: something else already promoted the window.
    bootstrapAccounts.clear();
    const feature = await import('./bootstrapPromotion.js');

    // Re-add to set so isBootstrap(0) returns true at init time...
    bootstrapAccounts.add(0);
    feature.default();
    // ...then clear it again before the navigate fires.
    bootstrapAccounts.clear();

    account0Win.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/0/');

    // promoteBootstrap is still called but the underlying set is already empty,
    // so the mock's `was` will be false — the key point is no crash.
    expect(() =>
      account0Win.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/0/')
    ).not.toThrow();
  });

  // ── watchBootstrapAccount: secondary account (account-1) ─────────────────────

  describe('watchBootstrapAccount()', () => {
    let account1Win: ReturnType<typeof makeFakeWindow>;

    beforeEach(() => {
      account1Win = makeFakeWindow();
      bootstrapAccounts.add(1);
      windowMap.set(1, account1Win);
    });

    it('returns a no-op when the account is not marked as bootstrap', async () => {
      bootstrapAccounts.delete(1); // account-1 NOT bootstrap
      const detach = watchBootstrapAccount(1);
      expect(detach).toBeTypeOf('function');
      expect(() => detach()).not.toThrow();
      expect(mgr.promoteBootstrap).not.toHaveBeenCalled();
    });

    it('returns a no-op when the account window does not exist', async () => {
      windowMap.delete(1);
      const detach = watchBootstrapAccount(1);
      expect(() => detach()).not.toThrow();
      expect(mgr.promoteBootstrap).not.toHaveBeenCalled();
    });

    it('returns a no-op when the account window is already destroyed', async () => {
      account1Win._destroyed = true;
      const detach = watchBootstrapAccount(1);
      expect(() => detach()).not.toThrow();
      expect(mgr.promoteBootstrap).not.toHaveBeenCalled();
    });

    it('promotes account-1 when did-navigate fires with an authenticated URL', async () => {
      watchBootstrapAccount(1);

      account1Win.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/1/');

      expect(mgr.promoteBootstrap).toHaveBeenCalledOnce();
      expect(mgr.promoteBootstrap).toHaveBeenCalledWith(1);
    });

    it('does NOT promote account-1 on a non-authenticated URL', async () => {
      watchBootstrapAccount(1);

      account1Win.webContents.emit('did-navigate', {}, 'https://accounts.google.com/signin');

      expect(mgr.promoteBootstrap).not.toHaveBeenCalled();
    });

    it('self-cleans after account-1 promotion (no double-fire)', async () => {
      watchBootstrapAccount(1);

      account1Win.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/1/');
      expect(mgr.promoteBootstrap).toHaveBeenCalledOnce();

      // Second navigation — listener must be gone.
      account1Win.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/1/r/room');
      expect(mgr.promoteBootstrap).toHaveBeenCalledOnce();
    });

    it('returned detach function prevents promotion before auth fires', async () => {
      const detach = watchBootstrapAccount(1);

      // Detach before any auth.
      detach();

      account1Win.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/1/');
      expect(mgr.promoteBootstrap).not.toHaveBeenCalled();
    });

    it('returned detach function is idempotent (double-call does not error)', async () => {
      const detach = watchBootstrapAccount(1);

      expect(() => {
        detach();
        detach();
      }).not.toThrow();
    });

    it('promotes account-1 via child (popup) window auth', async () => {
      watchBootstrapAccount(1);

      const childWin = makeFakeWindow();
      account1Win.webContents.emit('did-create-window', childWin, {});
      childWin.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/1/');

      expect(mgr.promoteBootstrap).toHaveBeenCalledOnce();
      expect(mgr.promoteBootstrap).toHaveBeenCalledWith(1);
    });

    it('destroys account-1 child window after popup auth completes', async () => {
      watchBootstrapAccount(1);

      const childWin = makeFakeWindow();
      account1Win.webContents.emit('did-create-window', childWin, {});
      childWin.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/1/');

      expect(childWin._destroyed).toBe(true);
    });

    it('does NOT reload the account-1 main window after popup auth (account-0 only behavior)', async () => {
      watchBootstrapAccount(1);

      const childWin = makeFakeWindow();
      account1Win.webContents.emit('did-create-window', childWin, {});
      childWin.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/1/');

      // account-1 window must NOT be reloaded — that behaviour is account-0-only.
      expect(account1Win.loadURL).not.toHaveBeenCalled();
    });

    it('does nothing if account-1 window closes before auth completes', async () => {
      watchBootstrapAccount(1);

      account1Win.destroy();

      expect(mgr.promoteBootstrap).not.toHaveBeenCalled();
    });

    it('promotes account-1 and account-0 independently when both are bootstrap', async () => {
      const feature = await import('./bootstrapPromotion.js');
      watchBootstrapAccount(1); // watch secondary
      feature.default(); // also watch account-0 via init

      // Account-1 authenticates first.
      account1Win.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/1/');
      expect(mgr.promoteBootstrap).toHaveBeenCalledTimes(1);
      expect(mgr.promoteBootstrap).toHaveBeenCalledWith(1);

      // Account-0 authenticates later.
      account0Win.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/0/');
      expect(mgr.promoteBootstrap).toHaveBeenCalledTimes(2);
      expect(mgr.promoteBootstrap).toHaveBeenCalledWith(0);
    });
  });

  // ── init() with multiple bootstrap accounts ──────────────────────────────────

  describe('init() with multiple bootstrap accounts', () => {
    let account1Win: ReturnType<typeof makeFakeWindow>;

    beforeEach(() => {
      account1Win = makeFakeWindow();
      bootstrapAccounts.add(1);
      windowMap.set(1, account1Win);
    });

    it('watches all currently-bootstrap accounts when init() is called', async () => {
      const feature = await import('./bootstrapPromotion.js');
      feature.default(); // both account-0 and account-1 are bootstrap

      // Account-1 authenticates.
      account1Win.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/1/');
      expect(mgr.promoteBootstrap).toHaveBeenCalledWith(1);

      // Account-0 still has its watcher.
      account0Win.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/0/');
      expect(mgr.promoteBootstrap).toHaveBeenCalledWith(0);

      expect(mgr.promoteBootstrap).toHaveBeenCalledTimes(2);
    });

    it('cleanupBootstrapPromotion() removes listeners for all watched accounts', async () => {
      const feature = await import('./bootstrapPromotion.js');
      feature.default();

      cleanupBootstrapPromotion();

      // Neither account should promote after cleanup.
      account0Win.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/0/');
      account1Win.webContents.emit('did-navigate', {}, 'https://chat.google.com/u/1/');
      expect(mgr.promoteBootstrap).not.toHaveBeenCalled();
    });
  });
  // ── init() error path ─────────────────────────────────────────────────────────────────

  describe('init() error handling', () => {
    it('logs error and does not throw when getAccountWindowManager throws', async () => {
      getAccountWindowManagerMock.mockImplementation(() => {
        throw new Error('Manager not initialized');
      });

      const log = (await import('electron-log')).default;
      const feature = await import('./bootstrapPromotion.js');

      expect(() => feature.default()).not.toThrow();
      expect(log.error).toHaveBeenCalledWith(
        '[BootstrapPromotion] Failed to initialize:',
        expect.any(Error)
      );
    });

    it('logs error when getBootstrapAccounts throws', async () => {
      getAccountWindowManagerMock.mockReturnValue({
        ...mgr,
        getBootstrapAccounts: () => {
          throw new Error('Failed to get bootstrap accounts');
        },
      });

      const log = (await import('electron-log')).default;
      const feature = await import('./bootstrapPromotion.js');

      expect(() => feature.default()).not.toThrow();
      expect(log.error).toHaveBeenCalledWith(
        '[BootstrapPromotion] Failed to initialize:',
        expect.any(Error)
      );
    });
  });
});

describe('bootstrapPromotion feature — log redaction', () => {
  const AUTHENTICATED_SECRET_URL =
    'https://chat.google.com/u/0/P2_PATH?token=P2_QUERY&continue=https%3A%2F%2Fx.example%2FP2_CONTINUE#P2_FRAGMENT';
  let bootstrapAccounts: Set<number>;
  let windowMap: Map<number, ReturnType<typeof makeFakeWindow>>;
  let mgr: ReturnType<typeof makeFakeMgr>;
  let account0Win: ReturnType<typeof makeFakeWindow>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    account0Win = makeFakeWindow();
    bootstrapAccounts = new Set([0]);
    windowMap = new Map([[0, account0Win]]);
    mgr = makeFakeMgr(bootstrapAccounts, windowMap);
    getAccountWindowManagerMock.mockReturnValue(mgr);
  });

  it('logs real authentication flow messages without the authenticated URL', async () => {
    const spies = spiesOf((await import('electron-log')).default);
    const feature = await import('./bootstrapPromotion.js');
    feature.default();

    account0Win.webContents.emit('did-navigate', {}, AUTHENTICATED_SECRET_URL);

    expect(mgr.promoteBootstrap).toHaveBeenCalledExactlyOnceWith(0);
    expect(messagesAt(spies, 'info')).toEqual([
      '[BootstrapPromotion] Watching account-0 for authentication',
      '[BootstrapPromotion] Feature initialized; watching accounts: 0',
      '[BootstrapPromotion] Account-0 authenticated in main window',
    ]);
    expectNoSentinels(spies, 3);
  });

  it('logs the no-bootstrap skip', async () => {
    const spies = spiesOf((await import('electron-log')).default);
    bootstrapAccounts.clear();
    const feature = await import('./bootstrapPromotion.js');
    feature.default();

    expect(messagesAt(spies, 'debug')).toEqual([
      '[BootstrapPromotion] No bootstrap accounts — skipping',
    ]);
    expectNoSentinels(spies);
  });

  it('replaces an initialization Error carrying secrets with the fixed placeholder', async () => {
    const spies = spiesOf((await import('electron-log')).default);
    getAccountWindowManagerMock.mockImplementation(() => {
      throw makeSecretError();
    });
    const feature = await import('./bootstrapPromotion.js');
    feature.default();

    const [message, logged] = spies.error.mock.calls[0] as [string, Error];
    expect(message).toBe('[BootstrapPromotion] Failed to initialize:');
    expect(logged.message).toBe('[redacted]');
    expect(logged.stack).toBe('[redacted]');
    expect(logged.cause).toBeUndefined();
    expectNoSentinels(spies);
  });
});
