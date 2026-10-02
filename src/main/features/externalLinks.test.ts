/**
 * Unit tests for externalLinks feature.
 *
 * Tests the public API: default export (window handlers) and cleanup.
 * Helper functions are tested indirectly through the behavior they influence.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

// ─── Fake Window helpers ──────────────────────────────────────────────────────

function makeFakeWindow(url = '') {
  const wc = new EventEmitter() as EventEmitter & {
    getURL: () => string;
    setWindowOpenHandler: (h: unknown) => void;
    on: (event: string, handler: (...args: unknown[]) => void) => void;
  };
  wc.getURL = vi.fn(() => url);
  wc.setWindowOpenHandler = vi.fn();
  wc.on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    wc.addListener(event, handler);
  });

  const win = new EventEmitter() as unknown as Electron.BrowserWindow & {
    webContents: typeof wc;
    isDestroyed: () => boolean;
    loadURL: ReturnType<typeof vi.fn>;
    minimize: () => void;
    restore: () => void;
    show: () => void;
    focus: () => void;
    hide: () => void;
    on: (event: string, handler: (...args: unknown[]) => void) => void;
    _destroyed: boolean;
  };
  win.webContents = wc;
  win._destroyed = false;
  win.isDestroyed = () => win._destroyed;
  win.loadURL = vi.fn().mockResolvedValue(undefined);
  win.minimize = vi.fn();
  win.restore = vi.fn();
  win.show = vi.fn();
  win.focus = vi.fn();
  win.hide = vi.fn();
  win.on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    win.addListener(event, handler);
  });
  return win;
}

// ─── Mock electron ────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: vi.fn(),
  dialog: {
    showMessageBox: vi.fn().mockResolvedValue({ response: 1 }),
  },
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined),
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

// Mock validators
vi.mock('../../shared/urlValidators.js', () => ({
  validateExternalURL: vi.fn((url: string) => url),
  isWhitelistedHost: vi.fn().mockReturnValue(true),
  isGoogleAuthUrl: vi.fn().mockReturnValue(false),
}));

const mockFocusAccount = vi.fn();
const mockHasAccount = vi.fn().mockReturnValue(false);
const mockIsBootstrap = vi.fn().mockReturnValue(false);
const mockMarkAsBootstrap = vi.fn();
const mockLoadAccountURL = vi.fn().mockReturnValue(true);
const mockGetAccountURL = vi.fn().mockReturnValue(null);

// Mock accountWindowManager
vi.mock('../utils/account/accountWindowManager.js', () => ({
  getAccountWindowManager: () => ({
    isBootstrap: (...args: unknown[]) => mockIsBootstrap(...args),
    markAsBootstrap: (...args: unknown[]) => mockMarkAsBootstrap(...args),
    getAccountIndex: vi.fn().mockReturnValue(0),
    getAccountWindow: vi.fn().mockReturnValue(null),
    hasAccount: (...args: unknown[]) => mockHasAccount(...args),
    focusAccount: (...args: unknown[]) => mockFocusAccount(...args),
    enumerateAccountWebContents: vi.fn(() => []),
  }),
  createAccountWindow: vi.fn().mockReturnValue({
    webContents: { getURL: () => '' },
    isMinimized: () => false,
    minimize: vi.fn(),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    loadURL: vi.fn().mockResolvedValue(undefined),
  }),
  getWindowForAccount: vi.fn().mockReturnValue(null),
  getAccountIndex: vi.fn().mockReturnValue(0),
}));

vi.mock('../utils/account/accountNavigation.js', () => ({
  loadAccountURL: (...args: unknown[]) => mockLoadAccountURL(...args),
  getAccountURL: (...args: unknown[]) => mockGetAccountURL(...args),
}));

vi.mock('../utils/account/accountWebContentsHooks.js', () => ({
  setAccountWebContentsHooksManager: vi.fn(),
  onAccountWebContentsCreated: vi.fn(() => () => {}),
}));

// Mock bootstrapPromotion
vi.mock('./bootstrapPromotion.js', () => ({
  watchBootstrapAccount: vi.fn(),
}));

// Mock resourceCleanup for createTrackedInterval
vi.mock('../utils/lifecycle/resourceCleanup.js', () => ({
  cancelTrackedInterval: (handle: NodeJS.Timeout) => clearInterval(handle),
  createTrackedInterval: vi.fn().mockReturnValue({} as NodeJS.Timeout),
}));

vi.mock('../utils/security/shellWrapper.js', () => ({
  openExternal: vi.fn().mockResolvedValue(undefined),
}));

describe('externalLinks feature', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  // ── default export / window.open handler ───────────────────────────────────

  describe('default export (window setup)', () => {
    it('installExternalLinkGuards registers handlers on the account WebContents', async () => {
      const win = makeFakeWindow('https://chat.google.com');
      const feature = await import('./externalLinks.js');
      feature.installExternalLinkGuards(
        win.webContents as unknown as Electron.WebContents,
        win as unknown as Electron.BrowserWindow
      );
      expect(win.webContents.setWindowOpenHandler).toHaveBeenCalled();
      expect(win.webContents.on).toHaveBeenCalledWith('will-navigate', expect.any(Function));
    });

    it('handler denies non-HTTP URLs', async () => {
      const win = makeFakeWindow('https://chat.google.com');
      const feature = await import('./externalLinks.js');
      feature.installExternalLinkGuards(
        win.webContents as unknown as Electron.WebContents,
        win as unknown as Electron.BrowserWindow
      );

      const handler = win.webContents.setWindowOpenHandler.mock.calls[0][0];
      const result = handler({ url: 'javascript:alert(1)' } as Electron.HandlerDetails);

      expect(result).toEqual({ action: 'deny' });
    });

    it('handler allows whitelisted navigation', async () => {
      const win = makeFakeWindow('https://chat.google.com');
      const feature = await import('./externalLinks.js');
      feature.installExternalLinkGuards(
        win.webContents as unknown as Electron.WebContents,
        win as unknown as Electron.BrowserWindow
      );

      const handler = win.webContents.setWindowOpenHandler.mock.calls[0][0];
      const result = handler({ url: 'https://accounts.google.com' } as Electron.HandlerDetails);

      expect(result).toEqual({ action: 'allow' });
    });

    it('will-navigate prevents default for Chat account routing', async () => {
      const win = makeFakeWindow('https://chat.google.com');
      const feature = await import('./externalLinks.js');
      feature.installExternalLinkGuards(
        win.webContents as unknown as Electron.WebContents,
        win as unknown as Electron.BrowserWindow
      );

      const navCall = (win.webContents.on as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => call[0] === 'will-navigate'
      );
      const navHandler = navCall?.[1] as (
        event: { preventDefault: ReturnType<typeof vi.fn> },
        url: string
      ) => void;

      const preventDefault = vi.fn();
      navHandler({ preventDefault } as unknown as Electron.Event, 'https://chat.google.com/u/1/');

      expect(preventDefault).toHaveBeenCalled();
      expect(mockFocusAccount).toHaveBeenCalledWith(1);
    });

    it('routes existing secondary accounts via loadAccountURL (not host loadURL)', async () => {
      mockHasAccount.mockReturnValue(true);
      mockGetAccountURL.mockReturnValue('https://chat.google.com/u/1/');
      const order: string[] = [];
      mockFocusAccount.mockImplementation(() => {
        order.push('focus');
      });
      mockLoadAccountURL.mockImplementation(() => {
        order.push('load');
        return true;
      });
      const win = makeFakeWindow('https://chat.google.com/u/0/');
      const feature = await import('./externalLinks.js');
      feature.installExternalLinkGuards(
        win.webContents as unknown as Electron.WebContents,
        win as unknown as Electron.BrowserWindow
      );

      const handler = win.webContents.setWindowOpenHandler.mock.calls[0][0];
      const result = handler({
        url: 'https://chat.google.com/u/1/room/abc',
      } as Electron.HandlerDetails);

      expect(result).toEqual({ action: 'deny' });
      expect(mockLoadAccountURL).toHaveBeenCalledWith(
        expect.anything(),
        1,
        'https://chat.google.com/u/1/room/abc'
      );
      expect(mockFocusAccount).toHaveBeenCalledWith(1);
      expect(order[0]).toBe('focus');
      expect(order).toContain('load');
      expect(win.loadURL).not.toHaveBeenCalled();
    });

    it('hydrates a known dehydrated account before loadAccountURL', async () => {
      mockHasAccount.mockReturnValue(true);
      const order: string[] = [];
      mockFocusAccount.mockImplementation(() => {
        order.push('focus');
      });
      mockGetAccountURL.mockImplementation(() =>
        order.includes('focus') ? 'https://chat.google.com/u/2/' : null
      );
      mockLoadAccountURL.mockImplementation(() => {
        order.push('load');
        return true;
      });
      const win = makeFakeWindow('https://chat.google.com/u/0/');
      const feature = await import('./externalLinks.js');
      feature.installExternalLinkGuards(
        win.webContents as unknown as Electron.WebContents,
        win as unknown as Electron.BrowserWindow
      );

      const handler = win.webContents.setWindowOpenHandler.mock.calls[0][0];
      expect(
        handler({ url: 'https://chat.google.com/u/2/room/restored' } as Electron.HandlerDetails)
      ).toEqual({ action: 'deny' });

      expect(order[0]).toBe('focus');
      expect(order).toContain('load');
      expect(mockLoadAccountURL).toHaveBeenCalledWith(
        expect.anything(),
        2,
        'https://chat.google.com/u/2/room/restored'
      );
    });

    it('records two focus-then-load sequences when a second Chat link is issued immediately', async () => {
      mockHasAccount.mockReturnValue(true);
      mockGetAccountURL.mockReturnValue('https://chat.google.com/u/2/');
      const order: string[] = [];
      mockFocusAccount.mockImplementation(() => {
        order.push('focus');
      });
      mockLoadAccountURL.mockImplementation((_manager, accountIndex, url: string) => {
        order.push(`load:${String(accountIndex)}:${url}`);
        return true;
      });
      const win = makeFakeWindow('https://chat.google.com/u/0/');
      const feature = await import('./externalLinks.js');
      feature.installExternalLinkGuards(
        win.webContents as unknown as Electron.WebContents,
        win as unknown as Electron.BrowserWindow
      );

      const handler = win.webContents.setWindowOpenHandler.mock.calls[0][0];
      const first = 'https://chat.google.com/u/2/room/first';
      const second = 'https://chat.google.com/u/2/room/second';
      expect(handler({ url: first } as Electron.HandlerDetails)).toEqual({ action: 'deny' });
      expect(handler({ url: second } as Electron.HandlerDetails)).toEqual({ action: 'deny' });

      expect(order).toEqual([
        'focus',
        `load:2:${first}`,
        'focus',
        'focus',
        `load:2:${second}`,
        'focus',
      ]);
      expect(win.loadURL).not.toHaveBeenCalled();
    });

    it('creates a missing account instead of navigating the source host', async () => {
      mockHasAccount.mockReturnValue(false);
      const win = makeFakeWindow('https://chat.google.com/u/0/');
      const { createAccountWindow } = await import('../utils/account/accountWindowManager.js');
      const feature = await import('./externalLinks.js');
      feature.installExternalLinkGuards(
        win.webContents as unknown as Electron.WebContents,
        win as unknown as Electron.BrowserWindow
      );

      const handler = win.webContents.setWindowOpenHandler.mock.calls[0][0];
      const result = handler({
        url: 'https://chat.google.com/u/4/room/new',
      } as Electron.HandlerDetails);

      expect(result).toEqual({ action: 'deny' });
      expect(createAccountWindow).toHaveBeenCalledWith('https://chat.google.com/u/4/room/new', 4);
      expect(mockMarkAsBootstrap).toHaveBeenCalledWith(4);
      expect(win.loadURL).not.toHaveBeenCalled();
    });

    it('will-navigate prevents non-HTTP schemes (parity with window-open handler)', async () => {
      const win = makeFakeWindow('https://chat.google.com');
      const feature = await import('./externalLinks.js');
      feature.installExternalLinkGuards(
        win.webContents as unknown as Electron.WebContents,
        win as unknown as Electron.BrowserWindow
      );

      const navCall = (win.webContents.on as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => call[0] === 'will-navigate'
      );
      const navHandler = navCall?.[1] as (
        event: { preventDefault: ReturnType<typeof vi.fn> },
        url: string
      ) => void;

      for (const bad of [
        'javascript:alert(1)',
        'file:///etc/passwd',
        'data:text/html,hi',
        'ftp://example.com/x',
      ]) {
        const preventDefault = vi.fn();
        navHandler({ preventDefault }, bad);
        expect(preventDefault).toHaveBeenCalled();
      }

      const { openExternal } = await import('../utils/security/shellWrapper.js');
      expect(openExternal).not.toHaveBeenCalled();
    });

    it('will-navigate allows same-host http(s) without preventDefault when guard on', async () => {
      const win = makeFakeWindow('https://mail.google.com/chat/u/0');
      const feature = await import('./externalLinks.js');
      feature.installExternalLinkGuards(
        win.webContents as unknown as Electron.WebContents,
        win as unknown as Electron.BrowserWindow
      );

      const navCall = (win.webContents.on as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => call[0] === 'will-navigate'
      );
      const navHandler = navCall?.[1] as (
        event: { preventDefault: ReturnType<typeof vi.fn> },
        url: string
      ) => void;

      const preventDefault = vi.fn();
      navHandler({ preventDefault }, 'https://mail.google.com/chat/u/0/room/abc');
      expect(preventDefault).not.toHaveBeenCalled();
    });
  });

  // ── cleanupExternalLinks ────────────────────────────────────────────────────

  describe('cleanupExternalLinks', () => {
    it('does not throw when called', async () => {
      const feature = await import('./externalLinks.js');
      expect(() => feature.cleanupExternalLinks()).not.toThrow();
    });

    it('is idempotent (can be called twice)', async () => {
      const feature = await import('./externalLinks.js');
      feature.cleanupExternalLinks();
      expect(() => feature.cleanupExternalLinks()).not.toThrow();
    });
  });

  // ── toggleExternalLinksGuard ────────────────────────────────────────────────

  describe('toggleExternalLinksGuard', () => {
    it('shows confirmation dialog', async () => {
      const { dialog } = await import('electron');
      const feature = await import('./externalLinks.js');
      const win = makeFakeWindow('https://chat.google.com');
      feature.toggleExternalLinksGuard(win as unknown as Electron.BrowserWindow);
      expect(dialog.showMessageBox).toHaveBeenCalled();
    });
  });
});
