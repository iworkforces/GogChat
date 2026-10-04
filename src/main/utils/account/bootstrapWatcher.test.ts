/**
 * Unit tests for bootstrapWatcher.ts — bootstrap window auth completion watcher
 *
 * Covers:
 * - watchBootstrapAccount(): navigation listener registration, auth detection
 * - Path A: direct auth in main window → promoteBootstrap
 * - Path B: OAuth popup child window → promoteBootstrap + child cleanup
 * - Noop when account is not bootstrap or window destroyed
 * - Window 'closed' event → listener cleanup
 * - cleanupBootstrapPromotion(): global cleanup of all active watchers
 * - Multiple concurrent bootstrap windows
 * - Idempotent cleanup/detach
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ──── Hoisted mocks ────────────────────────────────────────────────────────
const { mockLog, mockIsAuthenticatedChatUrl, mockGetAccountWindowManager } = vi.hoisted(() => ({
  mockLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  mockIsAuthenticatedChatUrl: vi.fn(),
  mockGetAccountWindowManager: vi.fn(),
}));

// ──── Module mocks ─────────────────────────────────────────────────────────
vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
}));

vi.mock('electron-log', () => ({
  default: mockLog,
}));

vi.mock('../../../shared/urlValidators.js', () => ({
  isAuthenticatedChatUrl: mockIsAuthenticatedChatUrl,
}));

vi.mock('./accountWindowManager.js', () => ({
  getAccountWindowManager: mockGetAccountWindowManager,
}));

// ──── Import under test ────────────────────────────────────────────────────
import { watchBootstrapAccount, cleanupBootstrapPromotion } from './bootstrapWatcher';
import { loadAccountURL } from './accountNavigation.js';
import {
  SECRET_AUTH_URL,
  SECRET_CHAT_URL,
  clearSpies,
  expectNoSentinels,
  makeSecretError,
  messagesAt,
  spiesOf,
} from '../../../../tests/mocks/logCapture';

// ──── Helpers ──────────────────────────────────────────────────────────────

type ListenerMap = Map<string, Array<(...args: unknown[]) => void>>;
type OnceListenerMap = Map<string, Array<(...args: unknown[]) => void>>;

/**
 * Create a mock webContents with event emitter behavior
 */
function createMockWebContents(): {
  on: Mock;
  once: Mock;
  removeListener: Mock;
  getURL: Mock;
  _listeners: ListenerMap;
  _emit: (event: string, ...args: unknown[]) => void;
} {
  const listeners: ListenerMap = new Map();

  const on = vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event)!.push(handler);
  });

  const once = vi.fn();

  const removeListener = vi
    .fn()
    .mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      const arr = listeners.get(event);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      }
    });

  return {
    on,
    once,
    removeListener,
    isDestroyed: vi.fn().mockReturnValue(false),
    getURL: vi.fn().mockReturnValue('https://chat.google.com/u/0/'),
    _listeners: listeners,
    _emit(event: string, ...args: unknown[]) {
      const arr = listeners.get(event);
      if (arr) {
        // Copy to avoid mutation during iteration
        [...arr].forEach((fn) => fn(...args));
      }
    },
  };
}

/**
 * Create a mock BrowserWindow with webContents
 */
function createMockBrowserWindow(): {
  webContents: ReturnType<typeof createMockWebContents>;
  isDestroyed: Mock;
  destroy: Mock;
  loadURL: Mock;
  once: Mock;
  _onceListeners: OnceListenerMap;
  _emitOnce: (event: string, ...args: unknown[]) => void;
} {
  const wc = createMockWebContents();
  const onceListeners: OnceListenerMap = new Map();

  const once = vi
    .fn()
    .mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (!onceListeners.has(event)) onceListeners.set(event, []);
      onceListeners.get(event)!.push(handler);
    });

  return {
    webContents: wc,
    isDestroyed: vi.fn().mockReturnValue(false),
    destroy: vi.fn(),
    loadURL: vi.fn().mockResolvedValue(undefined),
    once,
    _onceListeners: onceListeners,
    _emitOnce(event: string, ...args: unknown[]) {
      const arr = onceListeners.get(event);
      if (arr) {
        [...arr].forEach((fn) => fn(...args));
        onceListeners.delete(event);
      }
    },
  };
}

/**
 * Create a mock AccountWindowManager
 */
function createMockManager(
  overrides: {
    isBootstrap?: (idx: number) => boolean;
    getAccountWindow?: (idx: number) => ReturnType<typeof createMockBrowserWindow> | null;
    promoteBootstrap?: Mock;
  } = {}
): {
  isBootstrap: Mock;
  getAccountWindow: Mock;
  getAccountWebContents: Mock;
  promoteBootstrap: Mock;
} {
  const getAccountWindow = vi.fn().mockImplementation(overrides.getAccountWindow ?? (() => null));
  return {
    isBootstrap: vi.fn().mockImplementation(overrides.isBootstrap ?? (() => true)),
    getAccountWindow,
    getAccountWebContents: vi.fn().mockImplementation((idx: number) => {
      const win = getAccountWindow(idx) as ReturnType<typeof createMockBrowserWindow> | null;
      if (!win || win.isDestroyed()) return null;
      return win.webContents;
    }),
    promoteBootstrap: overrides.promoteBootstrap ?? vi.fn(),
  };
}

vi.mock('./accountNavigation.js', () => ({
  loadAccountURL: vi.fn().mockReturnValue(true),
}));

// ──── Tests ────────────────────────────────────────────────────────────────

describe('bootstrapWatcher', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Clean up internal module state between tests
    cleanupBootstrapPromotion();
    vi.resetAllMocks(); // Reset after cleanup to clear log calls
  });

  describe('watchBootstrapAccount', () => {
    // ─── Registration ──────────────────────────────────────────────────

    it('should register did-navigate listener on webContents', () => {
      const win = createMockBrowserWindow();
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: () => win,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      watchBootstrapAccount(0);

      expect(win.webContents.on).toHaveBeenCalledWith('did-navigate', expect.any(Function));
    });

    it('should register did-create-window listener on webContents', () => {
      const win = createMockBrowserWindow();
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: () => win,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      watchBootstrapAccount(0);

      expect(win.webContents.on).toHaveBeenCalledWith('did-create-window', expect.any(Function));
    });

    it('should register closed listener on window', () => {
      const win = createMockBrowserWindow();
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: () => win,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      watchBootstrapAccount(0);

      expect(win.once).toHaveBeenCalledWith('closed', expect.any(Function));
    });

    // ─── Noop cases ────────────────────────────────────────────────────

    it('should return noop when account is not bootstrap', () => {
      const mgr = createMockManager({ isBootstrap: () => false });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      const cleanup = watchBootstrapAccount(5);

      cleanup(); // should not throw
      expect(mockLog.debug).toHaveBeenCalledWith(
        '[BootstrapPromotion] Account-5 is not a bootstrap window — skipping'
      );
    });

    it('should return noop when window is null', () => {
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: () => null,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      const cleanup = watchBootstrapAccount(0);

      cleanup(); // should not throw
      expect(mockLog.warn).toHaveBeenCalledWith(
        '[BootstrapPromotion] Account-0 WebContents not found — skipping'
      );
    });

    it('should return noop when window is destroyed', () => {
      const win = createMockBrowserWindow();
      win.isDestroyed.mockReturnValue(true);
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: () => win,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      const cleanup = watchBootstrapAccount(0);

      cleanup(); // should not throw
      expect(mockLog.warn).toHaveBeenCalledWith(
        '[BootstrapPromotion] Account-0 WebContents not found — skipping'
      );
    });

    // ─── Path A: Auth detected in main window ──────────────────────────

    it('should detect auth completion via did-navigate (Path A)', () => {
      const win = createMockBrowserWindow();
      const promoteBootstrap = vi.fn();
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: () => win,
        promoteBootstrap,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      mockIsAuthenticatedChatUrl.mockImplementation(
        (url: unknown) => url === 'https://chat.google.com/u/0/'
      );

      watchBootstrapAccount(0);

      // Simulate navigation to authenticated URL
      const mockEvent = {};
      win.webContents._emit('did-navigate', mockEvent, 'https://chat.google.com/u/0/');

      expect(promoteBootstrap).toHaveBeenCalledWith(0);
    });

    it('should not fire on non-auth URLs', () => {
      const win = createMockBrowserWindow();
      const promoteBootstrap = vi.fn();
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: () => win,
        promoteBootstrap,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      mockIsAuthenticatedChatUrl.mockReturnValue(false);

      watchBootstrapAccount(0);

      win.webContents._emit('did-navigate', {}, 'https://accounts.google.com/signin');

      expect(promoteBootstrap).not.toHaveBeenCalled();
    });

    it('should self-remove listener after first auth detection (Path A)', () => {
      const win = createMockBrowserWindow();
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: () => win,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      mockIsAuthenticatedChatUrl.mockReturnValue(true);

      watchBootstrapAccount(0);

      // First auth triggers removal
      win.webContents._emit('did-navigate', {}, 'https://chat.google.com/u/0/');

      // Listener should have been removed
      expect(win.webContents.removeListener).toHaveBeenCalledWith(
        'did-navigate',
        expect.any(Function)
      );
    });

    it('should also remove did-create-window listener on Path A auth', () => {
      const win = createMockBrowserWindow();
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: () => win,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      mockIsAuthenticatedChatUrl.mockReturnValue(true);

      watchBootstrapAccount(0);

      win.webContents._emit('did-navigate', {}, 'https://chat.google.com/u/0/');

      expect(win.webContents.removeListener).toHaveBeenCalledWith(
        'did-create-window',
        expect.any(Function)
      );
    });

    // ─── Path B: Auth via child window (OAuth popup) ───────────────────

    it('should watch child window for auth when did-create-window fires (Path B)', () => {
      const win = createMockBrowserWindow();
      const childWin = createMockBrowserWindow();
      const promoteBootstrap = vi.fn();
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: () => win,
        promoteBootstrap,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      mockIsAuthenticatedChatUrl.mockImplementation(
        (url: unknown) => url === 'https://chat.google.com/u/0/'
      );

      watchBootstrapAccount(0);

      // Simulate child window creation
      win.webContents._emit('did-create-window', childWin, {});

      // Verify child webContents gets a listener
      expect(childWin.webContents.on).toHaveBeenCalledWith('did-navigate', expect.any(Function));

      // Simulate auth in child window
      childWin.webContents._emit('did-navigate', {}, 'https://chat.google.com/u/0/');

      expect(promoteBootstrap).toHaveBeenCalledWith(0);
    });

    it('should destroy child window after auth via Path B', () => {
      const win = createMockBrowserWindow();
      const childWin = createMockBrowserWindow();
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: () => win,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      mockIsAuthenticatedChatUrl.mockReturnValue(true);

      watchBootstrapAccount(0);

      // Simulate child creation and auth
      win.webContents._emit('did-create-window', childWin, {});
      childWin.webContents._emit('did-navigate', {}, 'https://chat.google.com/u/0/');

      expect(childWin.destroy).toHaveBeenCalledTimes(1);
    });

    it('should not destroy child window if already destroyed (Path B)', () => {
      const win = createMockBrowserWindow();
      const childWin = createMockBrowserWindow();
      childWin.isDestroyed.mockReturnValue(true);
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: () => win,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      mockIsAuthenticatedChatUrl.mockReturnValue(true);

      watchBootstrapAccount(0);

      win.webContents._emit('did-create-window', childWin, {});
      childWin.webContents._emit('did-navigate', {}, 'https://chat.google.com/u/0/');

      expect(childWin.destroy).not.toHaveBeenCalled();
    });

    it('should remove main window listeners on Path B auth', () => {
      const win = createMockBrowserWindow();
      const childWin = createMockBrowserWindow();
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: () => win,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      mockIsAuthenticatedChatUrl.mockReturnValue(true);

      watchBootstrapAccount(0);

      win.webContents._emit('did-create-window', childWin, {});
      childWin.webContents._emit('did-navigate', {}, 'https://chat.google.com/u/0/');

      // Main window listeners should be cleaned up
      expect(win.webContents.removeListener).toHaveBeenCalledWith(
        'did-navigate',
        expect.any(Function)
      );
      expect(win.webContents.removeListener).toHaveBeenCalledWith(
        'did-create-window',
        expect.any(Function)
      );
    });

    it('should load auth URL on account-0 via loadAccountURL (Path B)', async () => {
      const { loadAccountURL } = await import('./accountNavigation.js');
      vi.mocked(loadAccountURL).mockClear();

      const win = createMockBrowserWindow();
      win.webContents.getURL.mockReturnValue('https://accounts.google.com/signin');

      const childWin = createMockBrowserWindow();
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: (idx: number) => (idx === 0 ? win : null),
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      mockIsAuthenticatedChatUrl.mockReturnValue(true);

      watchBootstrapAccount(0);

      win.webContents._emit('did-create-window', childWin, {});
      childWin.webContents._emit('did-navigate', {}, 'https://chat.google.com/u/0/');

      expect(loadAccountURL).toHaveBeenCalled();
    });

    it('should not load URL on non-zero account (Path B)', async () => {
      const { loadAccountURL } = await import('./accountNavigation.js');
      vi.mocked(loadAccountURL).mockClear();

      const win = createMockBrowserWindow();
      const childWin = createMockBrowserWindow();
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: () => win,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      mockIsAuthenticatedChatUrl.mockReturnValue(true);

      watchBootstrapAccount(2);

      win.webContents._emit('did-create-window', childWin, {});
      childWin.webContents._emit('did-navigate', {}, 'https://chat.google.com/u/2/');

      expect(loadAccountURL).not.toHaveBeenCalled();
    });

    // ─── Window closed during watch ────────────────────────────────────

    it('should clean up all listeners when window closes before auth', () => {
      const win = createMockBrowserWindow();
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: () => win,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      watchBootstrapAccount(0);

      // Simulate window close
      win._emitOnce('closed');

      // All listeners should be removed
      expect(win.webContents.removeListener).toHaveBeenCalledWith(
        'did-navigate',
        expect.any(Function)
      );
      expect(win.webContents.removeListener).toHaveBeenCalledWith(
        'did-create-window',
        expect.any(Function)
      );

      expect(mockLog.debug).toHaveBeenCalledWith(
        '[BootstrapPromotion] Account-0 window closed — listeners removed'
      );
    });

    // ─── Cleanup return function ───────────────────────────────────────

    it('should return a cleanup function that removes all listeners', () => {
      const win = createMockBrowserWindow();
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: () => win,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      const cleanup = watchBootstrapAccount(0);
      cleanup();

      expect(win.webContents.removeListener).toHaveBeenCalledWith(
        'did-navigate',
        expect.any(Function)
      );
      expect(win.webContents.removeListener).toHaveBeenCalledWith(
        'did-create-window',
        expect.any(Function)
      );
      expect(mockLog.debug).toHaveBeenCalledWith(
        '[BootstrapPromotion] Cleaned up bootstrap promotion listeners for account-0'
      );
    });

    it('should be safe to call cleanup multiple times', () => {
      const win = createMockBrowserWindow();
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: () => win,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      const cleanup = watchBootstrapAccount(0);
      cleanup();
      cleanup(); // should not throw
    });

    // ─── Previous child watcher cleanup ────────────────────────────────

    it('should detach previous child watcher when new child window created', () => {
      const win = createMockBrowserWindow();
      const childWin1 = createMockBrowserWindow();
      const childWin2 = createMockBrowserWindow();
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: () => win,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      mockIsAuthenticatedChatUrl.mockReturnValue(false);

      watchBootstrapAccount(0);

      // First child
      win.webContents._emit('did-create-window', childWin1, {});
      expect(childWin1.webContents.on).toHaveBeenCalledWith('did-navigate', expect.any(Function));

      // Second child should detach first child
      win.webContents._emit('did-create-window', childWin2, {});
      expect(childWin1.webContents.removeListener).toHaveBeenCalledWith(
        'did-navigate',
        expect.any(Function)
      );
      expect(childWin2.webContents.on).toHaveBeenCalledWith('did-navigate', expect.any(Function));
    });

    // ─── Child closed before auth ──────────────────────────────────────

    it('should handle child window closing before auth completes', () => {
      const win = createMockBrowserWindow();
      const childWin = createMockBrowserWindow();
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: () => win,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      mockIsAuthenticatedChatUrl.mockReturnValue(false);

      watchBootstrapAccount(0);

      // Create child and register listener
      win.webContents._emit('did-create-window', childWin, {});
      expect(childWin.webContents.on).toHaveBeenCalledWith('did-navigate', expect.any(Function));

      // Child closes before auth
      childWin._emitOnce('closed');

      // Should not crash, and main watchers should still be active
      // (the main window did-navigate is still watching)
    });

    // ─── webContents already garbage-collected ─────────────────────────

    it('should handle webContents.removeListener throwing during detach', () => {
      const win = createMockBrowserWindow();
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: () => win,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      // Make removeListener throw on first call
      win.webContents.removeListener.mockImplementation(() => {
        throw new Error('webContents already GC-ed');
      });

      mockIsAuthenticatedChatUrl.mockReturnValue(true);

      watchBootstrapAccount(0);

      // Should not throw despite removeListener failure
      win.webContents._emit('did-navigate', {}, 'https://chat.google.com/u/0/');
    });

    // ─── Bootstrap already promoted ────────────────────────────────────

    it('should not call promoteBootstrap if account is no longer bootstrap', () => {
      const win = createMockBrowserWindow();
      let isBootstrapVal = true;
      const promoteBootstrap = vi.fn();
      const mgr = createMockManager({
        isBootstrap: () => isBootstrapVal,
        getAccountWindow: () => win,
        promoteBootstrap,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      mockIsAuthenticatedChatUrl.mockReturnValue(true);

      watchBootstrapAccount(0);

      // Mark as no longer bootstrap before auth fires
      isBootstrapVal = false;

      win.webContents._emit('did-navigate', {}, 'https://chat.google.com/u/0/');

      expect(promoteBootstrap).not.toHaveBeenCalled();
    });

    // ─── Multiple concurrent bootstrap windows ─────────────────────────

    it('should handle multiple concurrent bootstrap windows independently', () => {
      const win0 = createMockBrowserWindow();
      const win1 = createMockBrowserWindow();
      const promoteBootstrap = vi.fn();
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: (idx: number) => (idx === 0 ? win0 : win1),
        promoteBootstrap,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      mockIsAuthenticatedChatUrl.mockReturnValue(true);

      watchBootstrapAccount(0);
      watchBootstrapAccount(1);

      // Auth on account-0 only
      win0.webContents._emit('did-navigate', {}, 'https://chat.google.com/u/0/');

      expect(promoteBootstrap).toHaveBeenCalledWith(0);
      expect(promoteBootstrap).toHaveBeenCalledTimes(1);

      // Account-1 watchers should still be active
      // (did not trigger yet, so no removal calls for win1)
    });

    it('should not interfere when cleaning up one account while another is watched', () => {
      const win0 = createMockBrowserWindow();
      const win1 = createMockBrowserWindow();
      const promoteBootstrap = vi.fn();
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: (idx: number) => (idx === 0 ? win0 : win1),
        promoteBootstrap,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      mockIsAuthenticatedChatUrl.mockReturnValue(true);

      const cleanup0 = watchBootstrapAccount(0);
      watchBootstrapAccount(1);

      // Manually clean up account-0
      cleanup0();

      // Account-1 should still work
      win1.webContents._emit('did-navigate', {}, 'https://chat.google.com/u/1/');

      expect(promoteBootstrap).toHaveBeenCalledWith(1);
    });
  });

  // ─── cleanupBootstrapPromotion ─────────────────────────────────────────

  describe('cleanupBootstrapPromotion', () => {
    it('should clean up all active watchers', () => {
      const win0 = createMockBrowserWindow();
      const win1 = createMockBrowserWindow();
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: (idx: number) => (idx === 0 ? win0 : win1),
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      watchBootstrapAccount(0);
      watchBootstrapAccount(1);

      cleanupBootstrapPromotion();

      // Both windows should have their listeners removed
      expect(win0.webContents.removeListener).toHaveBeenCalled();
      expect(win1.webContents.removeListener).toHaveBeenCalled();

      expect(mockLog.debug).toHaveBeenCalledWith('[BootstrapPromotion] Cleanup complete');
    });

    it('should be safe to call when no watchers are active', () => {
      cleanupBootstrapPromotion();

      expect(mockLog.debug).toHaveBeenCalledWith('[BootstrapPromotion] Cleanup complete');
    });

    it('should handle errors during cleanup gracefully', () => {
      const win = createMockBrowserWindow();
      const mgr = createMockManager({
        isBootstrap: () => true,
        getAccountWindow: () => win,
      });
      mockGetAccountWindowManager.mockReturnValue(mgr);

      watchBootstrapAccount(0);

      // Make log.debug throw AFTER the watcher is set up.
      // fullCleanup() calls log.debug() after detaching listeners,
      // which propagates to cleanupBootstrapPromotion's outer catch.
      mockLog.debug.mockImplementation(() => {
        throw new Error('log failure during cleanup');
      });

      // Should not throw
      cleanupBootstrapPromotion();

      expect(mockLog.error).toHaveBeenCalledWith(
        '[BootstrapPromotion] Failed to cleanup:',
        expect.any(Error)
      );
    });
  });
});

describe('bootstrapWatcher — log redaction', () => {
  const spies = spiesOf(mockLog);

  beforeEach(() => {
    vi.resetAllMocks();
    cleanupBootstrapPromotion();
    vi.resetAllMocks();
    clearSpies(spies);
    mockIsAuthenticatedChatUrl.mockImplementation(
      (url: unknown) =>
        typeof url === 'string' && url.startsWith('https://P2_USERINFO:P2_USERINFO@chat.')
    );
  });

  function watch(accountIndex: number) {
    const win = createMockBrowserWindow();
    const promoteBootstrap = vi.fn();
    const mgr = createMockManager({
      isBootstrap: () => true,
      getAccountWindow: () => win,
      promoteBootstrap,
    });
    mockGetAccountWindowManager.mockReturnValue(mgr);
    const cleanup = watchBootstrapAccount(accountIndex);
    return { win, mgr, promoteBootstrap, cleanup };
  }

  it('logs main-window authentication without the URL; the validator and promotion get the original', () => {
    const { win, promoteBootstrap } = watch(2);

    win.webContents._emit('did-navigate', {}, SECRET_AUTH_URL);
    expect(mockIsAuthenticatedChatUrl).toHaveBeenLastCalledWith(SECRET_AUTH_URL);
    expect(promoteBootstrap).not.toHaveBeenCalled();

    win.webContents._emit('did-navigate', {}, SECRET_CHAT_URL);

    expect(mockIsAuthenticatedChatUrl).toHaveBeenLastCalledWith(SECRET_CHAT_URL);
    expect(promoteBootstrap).toHaveBeenCalledExactlyOnceWith(2);
    expect(messagesAt(spies, 'info')).toEqual([
      '[BootstrapPromotion] Watching account-2 for authentication',
      '[BootstrapPromotion] Account-2 authenticated in main window',
    ]);
    expectNoSentinels(spies, 2);
  });

  it('logs popup authentication on account 0 without the URL; loadAccountURL gets the original', () => {
    const { win, mgr, promoteBootstrap } = watch(0);
    const child = createMockBrowserWindow();

    win.webContents._emit('did-create-window', child, {});
    child.webContents._emit('did-navigate', {}, SECRET_AUTH_URL);
    child.webContents._emit('did-navigate', {}, SECRET_CHAT_URL);

    expect(mockIsAuthenticatedChatUrl).toHaveBeenLastCalledWith(SECRET_CHAT_URL);
    expect(loadAccountURL).toHaveBeenCalledExactlyOnceWith(mgr, 0, SECRET_CHAT_URL);
    expect(promoteBootstrap).toHaveBeenCalledExactlyOnceWith(0);
    expect(child.destroy).toHaveBeenCalledTimes(1);
    expect(messagesAt(spies, 'info')).toEqual([
      '[BootstrapPromotion] Watching account-0 for authentication',
      '[BootstrapPromotion] Account-0 authenticated via child window',
    ]);
    expect(messagesAt(spies, 'debug')).toEqual([
      '[BootstrapPromotion] Account-0 child window created — watching for auth redirect',
      '[BootstrapPromotion] Closing account-0 child auth window after promotion',
    ]);
    expectNoSentinels(spies, 4);
  });

  it('logs popup authentication on another account without loading the URL', () => {
    const { win, promoteBootstrap } = watch(3);
    const child = createMockBrowserWindow();

    win.webContents._emit('did-create-window', child, {});
    child.webContents._emit('did-navigate', {}, SECRET_CHAT_URL);

    expect(loadAccountURL).not.toHaveBeenCalled();
    expect(promoteBootstrap).toHaveBeenCalledExactlyOnceWith(3);
    expect(messagesAt(spies, 'info')).toContain(
      '[BootstrapPromotion] Account-3 authenticated via child window'
    );
    expectNoSentinels(spies, 3);
  });

  it('keeps listener attach and detach behavior while logging window close and cleanup', () => {
    const { win, cleanup } = watch(1);
    expect(win.webContents.on.mock.calls.map(([event]) => event)).toEqual([
      'did-navigate',
      'did-create-window',
    ]);

    win._emitOnce('closed');
    cleanup();

    expect(win.webContents.removeListener.mock.calls.map(([event]) => event).sort()).toEqual([
      'did-create-window',
      'did-create-window',
      'did-navigate',
      'did-navigate',
    ]);
    expect(messagesAt(spies, 'debug')).toEqual([
      '[BootstrapPromotion] Account-1 window closed — listeners removed',
      '[BootstrapPromotion] Cleaned up bootstrap promotion listeners for account-1',
    ]);
    expectNoSentinels(spies, 3);
  });

  it('logs the skip paths for a non-bootstrap account and a missing WebContents', () => {
    mockGetAccountWindowManager.mockReturnValue(
      createMockManager({ isBootstrap: () => false, getAccountWindow: () => null })
    );
    watchBootstrapAccount(4);
    mockGetAccountWindowManager.mockReturnValue(
      createMockManager({ isBootstrap: () => true, getAccountWindow: () => null })
    );
    watchBootstrapAccount(5);

    expect(messagesAt(spies, 'debug')).toEqual([
      '[BootstrapPromotion] Account-4 is not a bootstrap window — skipping',
    ]);
    expect(messagesAt(spies, 'warn')).toEqual([
      '[BootstrapPromotion] Account-5 WebContents not found — skipping',
    ]);
    expectNoSentinels(spies, 2);
  });

  it('logs the global cleanup and replaces a failing cleanup Error with the fixed placeholder', () => {
    watch(1);
    cleanupBootstrapPromotion();
    expect(messagesAt(spies, 'debug')).toContain('[BootstrapPromotion] Cleanup complete');

    watch(1);
    mockLog.debug.mockImplementation(() => {
      throw makeSecretError();
    });
    cleanupBootstrapPromotion();

    const [message, logged] = mockLog.error.mock.calls[0] as [string, Error];
    expect(message).toBe('[BootstrapPromotion] Failed to cleanup:');
    expect(logged).toBeInstanceOf(Error);
    expect(logged.message).toBe('[redacted]');
    expect(logged.stack).toBe('[redacted]');
    expect(logged.cause).toBeUndefined();
    expectNoSentinels(spies, 2);
  });
});
