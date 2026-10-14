/**
 * Unit tests for closeToTray feature.
 *
 * Tests the public API: default export (window handlers) and cleanup.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

// ─── Fake BrowserWindow ───────────────────────────────────────────────────────

function makeFakeWindow() {
  const wc = new EventEmitter() as EventEmitter & {
    getURL: () => string;
  };
  wc.getURL = vi.fn(() => 'https://chat.google.com');

  const win = new EventEmitter() as unknown as Electron.BrowserWindow & {
    webContents: typeof wc;
    isDestroyed: () => boolean;
    hide: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    on: (event: string, handler: (...args: unknown[]) => void) => void;
    removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
    _destroyed: boolean;
  };

  win.webContents = wc;
  win._destroyed = false;
  win.isDestroyed = () => win._destroyed;
  win.hide = vi.fn();
  win.show = vi.fn();
  win.destroy = vi.fn();
  win.on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    win.addListener(event, handler);
  });
  win.removeListener = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    win.removeListener(event, handler);
  });

  return win;
}

// ─── Mock electron ────────────────────────────────────────────────────────────

// Store handlers registered on app for later invocation
const appHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    hide: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!appHandlers[event]) {
        appHandlers[event] = [];
      }
      appHandlers[event].push(handler);
      return { app: { on: vi.fn() } };
    }),
    removeListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (appHandlers[event]) {
        appHandlers[event] = appHandlers[event].filter((h) => h !== handler);
      }
    }),
  },
  BrowserWindow: vi.fn(),
}));

vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock accountWindowManager (tray-close dehydration)
const mockManager = {
  listAccountIndices: vi.fn(() => [] as number[]),
  isDehydrated: vi.fn(() => false),
  dehydrateAccount: vi.fn(),
};
vi.mock('../utils/account/accountWindowManager.js', () => ({
  getAccountWindowManager: vi.fn(() => mockManager),
}));

// Mock platform
const mockPlatform = {
  isMac: true,
};
vi.mock('../utils/platform/platformDetection.js', () => ({
  platform: mockPlatform,
}));

describe('closeToTray feature', () => {
  let win: ReturnType<typeof makeFakeWindow>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Clear registered handlers
    Object.keys(appHandlers).forEach((key) => delete appHandlers[key]);

    // Reset platform
    mockPlatform.isMac = true;

    // Reset dehydration mocks
    mockManager.listAccountIndices.mockReturnValue([]);
    mockManager.isDehydrated.mockReturnValue(false);
    mockManager.dehydrateAccount.mockClear();

    win = makeFakeWindow();
  });

  // Helper to get registered close handler
  function getCloseHandler(): ((event: { preventDefault: () => void }) => void) | undefined {
    const calls = (win.on as ReturnType<typeof vi.fn>).mock.calls;
    const closeCall = calls.find((call: unknown[]) => call[0] === 'close');
    return closeCall?.[1] as ((event: { preventDefault: () => void }) => void) | undefined;
  }

  // Helper to get registered before-quit handler
  function getBeforeQuitHandler(): (() => void) | undefined {
    const handlers = appHandlers['before-quit'];
    return handlers?.[0] as (() => void) | undefined;
  }

  // ── default export / close handler setup ─────────────────────────────────

  describe('default export (window setup)', () => {
    it('registers before-quit listener on app', async () => {
      const feature = await import('./closeToTray.js');
      feature.default(win as unknown as Electron.BrowserWindow);

      const { app: electronApp } = await import('electron');
      expect(electronApp.on).toHaveBeenCalledWith('before-quit', expect.any(Function));
    });

    it('registers close listener on window', async () => {
      const feature = await import('./closeToTray.js');
      feature.default(win as unknown as Electron.BrowserWindow);

      expect(win.on).toHaveBeenCalledWith('close', expect.any(Function));
    });
  });

  // ── close handler behavior ───────────────────────────────────────────────

  describe('close handler', () => {
    it('prevents default close when not quitting', async () => {
      const feature = await import('./closeToTray.js');
      feature.default(win as unknown as Electron.BrowserWindow);

      const closeHandler = getCloseHandler();
      expect(closeHandler).toBeDefined();

      const preventDefault = vi.fn();
      closeHandler!({ preventDefault } as unknown as Electron.Event);

      expect(preventDefault).toHaveBeenCalled();
      expect(win.isDestroyed()).toBe(false);
      expect(win.destroy).not.toHaveBeenCalled();
    });

    it('calls hide on macOS', async () => {
      mockPlatform.isMac = true;

      const feature = await import('./closeToTray.js');
      feature.default(win as unknown as Electron.BrowserWindow);

      const closeHandler = getCloseHandler();
      closeHandler!({ preventDefault: vi.fn() } as unknown as Electron.Event);

      const { app: electronApp } = await import('electron');
      expect(electronApp.hide).toHaveBeenCalled();
    });

    it('calls window.hide() on non-macOS', async () => {
      mockPlatform.isMac = false;

      const feature = await import('./closeToTray.js');
      feature.default(win as unknown as Electron.BrowserWindow);

      const closeHandler = getCloseHandler();
      closeHandler!({ preventDefault: vi.fn() } as unknown as Electron.Event);

      expect(win.hide).toHaveBeenCalled();
    });

    it('does not prevent close when willQuit is true', async () => {
      const feature = await import('./closeToTray.js');
      feature.default(win as unknown as Electron.BrowserWindow);

      // Simulate before-quit was called (willQuit = true)
      const beforeQuitHandler = getBeforeQuitHandler();
      beforeQuitHandler?.();

      // Now trigger close
      const closeHandler = getCloseHandler();
      const preventDefault = vi.fn();
      closeHandler!({ preventDefault } as unknown as Electron.Event);

      // Dock Quit is not cancelled, and the window is allowed to close.
      expect(preventDefault).not.toHaveBeenCalled();
      const { app: electronApp } = await import('electron');
      expect(electronApp.hide).not.toHaveBeenCalled();
    });

    it('dehydrates sparse non-zero accounts (e.g. {0, 2}) without needing index 1', async () => {
      mockManager.listAccountIndices.mockReturnValue([0, 2]);
      mockManager.isDehydrated.mockImplementation((_i: number) => false);

      const feature = await import('./closeToTray.js');
      feature.default(win as unknown as Electron.BrowserWindow);

      const closeHandler = getCloseHandler();
      closeHandler!({ preventDefault: vi.fn() } as unknown as Electron.Event);

      expect(mockManager.dehydrateAccount).toHaveBeenCalledTimes(1);
      expect(mockManager.dehydrateAccount).toHaveBeenCalledWith(2);
      expect(mockManager.dehydrateAccount).not.toHaveBeenCalledWith(0);
      expect(mockManager.dehydrateAccount).not.toHaveBeenCalledWith(1);
    });

    it('skips already-dehydrated accounts', async () => {
      mockManager.listAccountIndices.mockReturnValue([0, 1, 2]);
      mockManager.isDehydrated.mockImplementation((i: number) => i === 1);

      const feature = await import('./closeToTray.js');
      feature.default(win as unknown as Electron.BrowserWindow);
      getCloseHandler()!({ preventDefault: vi.fn() } as unknown as Electron.Event);

      expect(mockManager.dehydrateAccount).toHaveBeenCalledWith(2);
      expect(mockManager.dehydrateAccount).not.toHaveBeenCalledWith(1);
      expect(mockManager.dehydrateAccount).not.toHaveBeenCalledWith(0);
    });
  });

  // ── cleanupCloseToTray ───────────────────────────────────────────────────

  describe('cleanupCloseToTray', () => {
    it('removes before-quit listener', async () => {
      const feature = await import('./closeToTray.js');
      feature.default(win as unknown as Electron.BrowserWindow);

      const beforeQuitHandler = getBeforeQuitHandler();

      feature.cleanupCloseToTray(win as unknown as Electron.BrowserWindow);

      const { app: electronApp } = await import('electron');
      expect(electronApp.removeListener).toHaveBeenCalledWith('before-quit', beforeQuitHandler);
    });

    it('removes close listener', async () => {
      const feature = await import('./closeToTray.js');
      feature.default(win as unknown as Electron.BrowserWindow);

      const closeHandler = getCloseHandler();

      feature.cleanupCloseToTray(win as unknown as Electron.BrowserWindow);

      expect(win.removeListener).toHaveBeenCalledWith('close', closeHandler);
    });

    it('does not throw when window is destroyed', async () => {
      const feature = await import('./closeToTray.js');
      feature.default(win as unknown as Electron.BrowserWindow);

      win._destroyed = true;

      expect(() =>
        feature.cleanupCloseToTray(win as unknown as Electron.BrowserWindow)
      ).not.toThrow();
    });

    it('is idempotent (can be called twice)', async () => {
      const feature = await import('./closeToTray.js');
      feature.default(win as unknown as Electron.BrowserWindow);

      feature.cleanupCloseToTray(win as unknown as Electron.BrowserWindow);

      expect(() =>
        feature.cleanupCloseToTray(win as unknown as Electron.BrowserWindow)
      ).not.toThrow();
    });

    it('removes both handlers on cleanup', async () => {
      const feature = await import('./closeToTray.js');
      feature.default(win as unknown as Electron.BrowserWindow);

      const beforeQuitHandler = getBeforeQuitHandler();
      const closeHandler = getCloseHandler();

      feature.cleanupCloseToTray(win as unknown as Electron.BrowserWindow);

      const { app: electronApp } = await import('electron');
      expect(electronApp.removeListener).toHaveBeenCalledWith('before-quit', beforeQuitHandler);
      expect(win.removeListener).toHaveBeenCalledWith('close', closeHandler);
    });
  });

  // ── tray-close dehydration ──────────────────────────

  describe('tray-close dehydration', () => {
    it('dehydrates non-primary accounts (1+) when closing to tray', async () => {
      mockManager.listAccountIndices.mockReturnValue([0, 1, 2]);
      mockManager.isDehydrated.mockReturnValue(false);

      const feature = await import('./closeToTray.js');
      feature.default(win as unknown as Electron.BrowserWindow);

      const closeHandler = getCloseHandler();
      closeHandler!({ preventDefault: vi.fn() } as unknown as Electron.Event);

      // Account 0 must NEVER be dehydrated.
      expect(mockManager.dehydrateAccount).not.toHaveBeenCalledWith(0);
      expect(mockManager.dehydrateAccount).toHaveBeenCalledWith(1);
      expect(mockManager.dehydrateAccount).toHaveBeenCalledWith(2);
      expect(mockManager.dehydrateAccount).toHaveBeenCalledTimes(2);
    });

    it('does nothing when only account-0 exists', async () => {
      mockManager.listAccountIndices.mockReturnValue([0]);

      const feature = await import('./closeToTray.js');
      feature.default(win as unknown as Electron.BrowserWindow);

      const closeHandler = getCloseHandler();
      closeHandler!({ preventDefault: vi.fn() } as unknown as Electron.Event);

      expect(mockManager.dehydrateAccount).not.toHaveBeenCalled();
    });

    it('still hides the window if dehydration throws', async () => {
      mockManager.listAccountIndices.mockReturnValue([0, 1]);
      mockManager.dehydrateAccount.mockImplementationOnce(() => {
        throw new Error('boom');
      });

      const feature = await import('./closeToTray.js');
      feature.default(win as unknown as Electron.BrowserWindow);

      const closeHandler = getCloseHandler();
      const preventDefault = vi.fn();
      closeHandler!({ preventDefault } as unknown as Electron.Event);

      // Default still prevented and hide still called.
      expect(preventDefault).toHaveBeenCalled();
      const { app: electronApp } = await import('electron');
      expect(electronApp.hide).toHaveBeenCalled();
    });
  });
});
