/**
 * Unit tests for inOnline (connectivity monitoring) feature.
 *
 * Tests the public API: default export (IPC setup), cleanup,
 * and exported functions.
 */
/* global AbortSignal */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { pathToFileURL } from 'node:url';
import { asType } from '../../shared/typeUtils.js';
import type { IAccountWindowManager } from '../../shared/types/window.js';

// ─── Fake BrowserWindow ───────────────────────────────────────────────────────

function makeSender(id: number) {
  const sender = new EventEmitter() as EventEmitter & {
    id: number;
    isDestroyed: () => boolean;
    _destroyed: boolean;
    destroy: () => void;
  };
  sender.id = id;
  sender._destroyed = false;
  sender.isDestroyed = () => sender._destroyed;
  sender.destroy = () => {
    if (sender._destroyed) {
      return;
    }
    sender._destroyed = true;
    sender.emit('destroyed');
  };
  return sender;
}

function makeReplyEvent(id: number) {
  return {
    sender: makeSender(id),
    reply: vi.fn(),
  };
}

type OnlineIpcConfig = {
  handler: (
    data: { attemptId: string },
    event: { reply?: ReturnType<typeof vi.fn>; sender?: ReturnType<typeof makeSender> }
  ) => void;
  validator: (data: unknown) => unknown;
  rateLimit?: number;
};

function getOnlineIpc(): OnlineIpcConfig {
  const cfg = mockDefineIPC.mock.calls[0]?.[0] as OnlineIpcConfig | undefined;
  if (!cfg) {
    throw new Error('defineIPC was not called');
  }
  return cfg;
}

function makeFakeWindow(url = '') {
  const wc = new EventEmitter() as EventEmitter & {
    getURL: () => string;
    send: ReturnType<typeof vi.fn>;
    loadURL: ReturnType<typeof vi.fn>;
    isDestroyed: () => boolean;
  };
  wc.getURL = vi.fn(() => url);
  wc.send = vi.fn();
  wc.loadURL = vi.fn().mockResolvedValue(undefined);
  wc.isDestroyed = () => false;

  const win = new EventEmitter() as unknown as Electron.BrowserWindow & {
    webContents: typeof wc;
    isDestroyed: () => boolean;
    show: () => void;
    _destroyed: boolean;
  };
  win.webContents = wc;
  win._destroyed = false;
  win.isDestroyed = () => win._destroyed;
  win.show = vi.fn();
  win.loadURL = vi.fn().mockResolvedValue(undefined);
  return win;
}

function makeAccountManager(win: ReturnType<typeof makeFakeWindow>) {
  return asType<IAccountWindowManager>({
    getAccountWebContents: vi.fn(() => win.webContents),
    isDehydrated: vi.fn(() => false),
    focusAccount: vi.fn(),
  });
}

// ─── Mock electron ────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: vi.fn().mockReturnValue('/Applications/GogChat.app'),
  },
  BrowserWindow: vi.fn(),
  Notification: vi.fn().mockImplementation(function () {
    return Object.assign(new EventEmitter(), {
      show: vi.fn(),
      close: vi.fn(),
    });
  }),
  ipcMain: {
    on: vi.fn(),
    removeListener: vi.fn(),
    handle: vi.fn(),
    removeHandler: vi.fn(),
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

// Mock rateLimiter
const mockRateLimiter = {
  isAllowed: vi.fn().mockReturnValue(true),
};
vi.mock('../utils/ipc/rateLimiter.js', () => ({
  getRateLimiter: () => mockRateLimiter,
}));

// Mock iconCache
const mockGetIcon = vi.fn().mockReturnValue('/fake/icon.png');
vi.mock('../utils/platform/iconCache.js', () => ({
  getIconCache: () => ({ getIcon: mockGetIcon }),
}));

// Mock defineIPC
const mockDefineIPC = vi.fn().mockReturnValue(vi.fn());
vi.mock('../utils/ipc/defineIPC.js', () => ({
  defineIPC: mockDefineIPC,
}));

// Mock path
vi.mock('path', () => ({
  default: { join: vi.fn((...args: string[]) => args.join('/')) },
}));

vi.mock('fs', () => ({
  default: { existsSync: vi.fn(() => true) },
}));

describe('inOnline feature', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockRateLimiter.isAllowed.mockReturnValue(true);
    mockDefineIPC.mockReturnValue(vi.fn());
    mockGetIcon.mockReturnValue('/fake/icon.png');
  });

  // ── IPC handler ───────────────────────────────────────────────────────────

  describe('default export (IPC setup)', () => {
    it('registers CHECK_IF_ONLINE handler', async () => {
      mockDefineIPC.mockReturnValue(vi.fn());
      const win = makeFakeWindow() as unknown as Electron.BrowserWindow;

      const feature = await import('./inOnline.js');
      feature.default(win);

      expect(mockDefineIPC).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'checkIfOnline' })
      );
    });

    it('returns undefined (no cleanup from default export)', async () => {
      const win = makeFakeWindow() as unknown as Electron.BrowserWindow;

      const feature = await import('./inOnline.js');
      const result = feature.default(win);

      expect(result).toBeUndefined();
    });
  });

  // ── cleanupConnectivityHandler ────────────────────────────────────────────

  describe('cleanupConnectivityHandler', () => {
    it('does not throw when called with no handlers', async () => {
      const feature = await import('./inOnline.js');
      expect(() => feature.cleanupConnectivityHandler()).not.toThrow();
    });

    it('calls cleanup function if registered', async () => {
      const cleanupFn = vi.fn();
      mockDefineIPC.mockReturnValue(cleanupFn);

      const win = makeFakeWindow() as unknown as Electron.BrowserWindow;

      const feature = await import('./inOnline.js');
      feature.default(win);
      feature.cleanupConnectivityHandler();

      expect(cleanupFn).toHaveBeenCalled();
    });

    it('is idempotent (can be called twice)', async () => {
      const cleanupFn = vi.fn();
      mockDefineIPC.mockReturnValue(cleanupFn);

      const win = makeFakeWindow() as unknown as Electron.BrowserWindow;

      const feature = await import('./inOnline.js');
      feature.default(win);
      feature.cleanupConnectivityHandler();

      expect(() => feature.cleanupConnectivityHandler()).not.toThrow();
    });
  });

  // ── checkForInternet ──────────────────────────────────────────────────────

  describe('checkForInternet', () => {
    it('is exported and callable', async () => {
      const mod = await import('./inOnline.js');
      expect(mod.checkForInternet).toBeDefined();
      expect(typeof mod.checkForInternet).toBe('function');
    });

    it('does not load the offline page when fetch reports online', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      const win = makeFakeWindow('https://mail.google.com/chat/u/0');
      const mod = await import('./inOnline.js');
      await mod.checkForInternet(makeAccountManager(win));
      expect(win.webContents.loadURL).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('loads the offline page after a confirmed offline probe', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
      const win = makeFakeWindow('https://mail.google.com/chat/u/0');
      const mod = await import('./inOnline.js');
      await mod.checkForInternet(makeAccountManager(win));
      expect(win.webContents.loadURL).toHaveBeenCalledWith(
        'file:///Applications/GogChat.app/lib/offline/index.html'
      );
      expect(win.loadURL).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(2);
      vi.unstubAllGlobals();
    });

    it('stays on the current page when the confirmation probe succeeds', async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
      const win = makeFakeWindow('https://mail.google.com/chat/u/0');
      const mod = await import('./inOnline.js');
      await mod.checkForInternet(makeAccountManager(win));
      expect(win.loadURL).not.toHaveBeenCalled();
      const { Notification } = await import('electron');
      expect(Notification).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('notifies without navigating when the offline page is missing', async () => {
      const fs = await import('fs');
      vi.mocked(fs.default.existsSync).mockReturnValueOnce(false);
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
      const win = makeFakeWindow('https://mail.google.com/chat/u/0');
      const mod = await import('./inOnline.js');
      await mod.checkForInternet(makeAccountManager(win));
      expect(win.loadURL).not.toHaveBeenCalled();
      expect(win.webContents.loadURL).not.toHaveBeenCalled();
      const { Notification } = await import('electron');
      expect(Notification).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    });
  });

  describe('initial document ownership', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('makes a same-URL navigation during the startup delay permanently inert', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn().mockResolvedValue({ ok: false });
      vi.stubGlobal('fetch', fetchMock);
      const win = makeFakeWindow('https://chat.google.com/u/0');
      const mod = await import('./inOnline.js');
      const dispose = mod.scheduleInitialConnectivity(makeAccountManager(win));
      win.webContents.emit('did-start-navigation', {
        isMainFrame: true,
        url: win.webContents.getURL(),
      });
      await vi.advanceTimersByTimeAsync(3000);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(win.webContents.loadURL).not.toHaveBeenCalled();
      dispose();
    });

    it.each(['destroy', 'replacement', 'dehydrate', 'shutdown'])(
      'never rearms when %s invalidates the pre-delay account',
      async (race) => {
        vi.useFakeTimers();
        const fetchMock = vi.fn().mockResolvedValue({ ok: false });
        vi.stubGlobal('fetch', fetchMock);
        const win = makeFakeWindow('https://chat.google.com/u/0');
        const manager = makeAccountManager(win);
        const mod = await import('./inOnline.js');
        const dispose = mod.scheduleInitialConnectivity(manager);
        if (race === 'destroy') win.webContents.emit('destroyed');
        if (race === 'replacement')
          vi.mocked(manager.getAccountWebContents).mockReturnValue(makeFakeWindow().webContents);
        if (race === 'dehydrate') vi.mocked(manager.isDehydrated).mockReturnValue(true);
        if (race === 'shutdown') dispose();
        await vi.advanceTimersByTimeAsync(3000);
        vi.mocked(manager.getAccountWebContents).mockReturnValue(win.webContents);
        vi.mocked(manager.isDehydrated).mockReturnValue(false);
        await vi.advanceTimersByTimeAsync(3000);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(win.webContents.loadURL).not.toHaveBeenCalled();
        dispose();
      }
    );

    it('discards a pending fallback load when a competing same-URL navigation begins', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
      const win = makeFakeWindow('https://chat.google.com/u/0');
      let finishLoad = () => {};
      vi.mocked(win.webContents.loadURL).mockImplementation((url: string) => {
        win.webContents.emit('did-start-navigation', { isMainFrame: true, url });
        return new Promise<void>((resolve) => {
          finishLoad = resolve;
        });
      });
      const mod = await import('./inOnline.js');
      const dispose = mod.scheduleInitialConnectivity(makeAccountManager(win));
      await vi.advanceTimersByTimeAsync(3000);
      win.webContents.emit('did-start-navigation', {
        isMainFrame: true,
        url: 'file:///Applications/GogChat.app/lib/offline/index.html',
      });
      finishLoad();
      await vi.advanceTimersByTimeAsync(0);
      const { Notification } = await import('electron');
      expect(Notification).not.toHaveBeenCalled();
      expect(win.webContents.loadURL).toHaveBeenCalledTimes(1);
      dispose();
    });

    it('ignores subframe navigation while preserving initial account document ownership', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
      const win = makeFakeWindow('https://chat.google.com/u/0');
      const mod = await import('./inOnline.js');
      const dispose = mod.scheduleInitialConnectivity(makeAccountManager(win));
      win.webContents.emit('did-start-navigation', { isMainFrame: false, url: 'about:blank' });
      await vi.advanceTimersByTimeAsync(3000);
      expect(win.webContents.loadURL).toHaveBeenCalledTimes(1);
      dispose();
    });

    it.each(['navigation', 'same-url', 'destroy', 'replacement', 'dehydrate', 'shutdown'])(
      'discards a pending probe on %s',
      async (race) => {
        vi.useFakeTimers();
        let resolveProbe: (value: { ok: boolean }) => void = () => {};
        let signal: AbortSignal | undefined;
        const fetchMock = vi.fn((_url: string, options: { signal: AbortSignal }) => {
          signal = options.signal;
          return new Promise<{ ok: boolean }>((resolve) => {
            resolveProbe = resolve;
          });
        });
        vi.stubGlobal('fetch', fetchMock);
        const win = makeFakeWindow('https://chat.google.com/u/0');
        const manager = makeAccountManager(win);
        const mod = await import('./inOnline.js');
        const dispose = mod.scheduleInitialConnectivity(manager);
        await vi.advanceTimersByTimeAsync(3000);
        if (race === 'navigation' || race === 'same-url') {
          win.webContents.emit('did-start-navigation', {
            isMainFrame: true,
            url:
              race === 'same-url' ? win.webContents.getURL() : 'https://accounts.google.com/signin',
          });
        } else if (race === 'destroy') {
          win.webContents.emit('destroyed');
        } else if (race === 'replacement') {
          vi.mocked(manager.getAccountWebContents).mockReturnValue(makeFakeWindow().webContents);
        } else if (race === 'dehydrate') {
          vi.mocked(manager.isDehydrated).mockReturnValue(true);
        } else {
          dispose();
        }
        resolveProbe({ ok: false });
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(win.webContents.loadURL).not.toHaveBeenCalled();
        if (race !== 'replacement' && race !== 'dehydrate') expect(signal?.aborted).toBe(true);
        dispose();
      }
    );

    it('aborts a navigation during the confirmation probe without routing or notifying', async () => {
      vi.useFakeTimers();
      let resolveProbe: (value: { ok: boolean }) => void = () => {};
      let signal: AbortSignal | undefined;
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false })
        .mockImplementationOnce((_url: string, options: { signal: AbortSignal }) => {
          signal = options.signal;
          return new Promise<{ ok: boolean }>((resolve) => {
            resolveProbe = resolve;
          });
        });
      vi.stubGlobal('fetch', fetchMock);
      const win = makeFakeWindow('https://chat.google.com/u/0');
      const mod = await import('./inOnline.js');
      const dispose = mod.scheduleInitialConnectivity(makeAccountManager(win));
      await vi.advanceTimersByTimeAsync(3000);
      win.webContents.emit('did-start-navigation', {
        isMainFrame: true,
        url: win.webContents.getURL(),
      });
      resolveProbe({ ok: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(signal?.aborted).toBe(true);
      expect(win.webContents.loadURL).not.toHaveBeenCalled();
      const { Notification } = await import('electron');
      expect(Notification).not.toHaveBeenCalled();
      dispose();
    });

    it.each(['replacement', 'dehydrate', 'shutdown', 'destroy', 'navigation'])(
      'disposes owned notification and makes captured clicks inert after %s',
      async (race) => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
        const win = makeFakeWindow('https://chat.google.com/u/0');
        const manager = makeAccountManager(win);
        const mod = await import('./inOnline.js');
        const dispose = mod.scheduleInitialConnectivity(manager);
        await vi.advanceTimersByTimeAsync(3000);
        const { Notification } = await import('electron');
        const banner = vi.mocked(Notification).mock.results.at(-1)?.value;
        const oldClick = banner.listeners('click')[0];
        if (race === 'replacement')
          vi.mocked(manager.getAccountWebContents).mockReturnValue(makeFakeWindow().webContents);
        if (race === 'dehydrate') vi.mocked(manager.isDehydrated).mockReturnValue(true);
        if (race === 'shutdown') dispose();
        if (race === 'destroy') win.webContents.emit('destroyed');
        if (race === 'navigation')
          win.webContents.emit('did-start-navigation', {
            isMainFrame: true,
            url: 'https://chat.google.com/u/0',
          });
        oldClick();
        expect(manager.focusAccount).not.toHaveBeenCalled();
        expect(banner.close).toHaveBeenCalledTimes(1);
        expect(banner.listenerCount('click')).toBe(0);
        expect(win.webContents.listenerCount('did-start-navigation')).toBe(0);
        dispose();
      }
    );

    it.each(['missing', 'dehydrated', 'destroyed'])(
      'never probes unavailable %s content',
      async (state) => {
        vi.useFakeTimers();
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const win = makeFakeWindow();
        const manager = makeAccountManager(win);
        if (state === 'missing') vi.mocked(manager.getAccountWebContents).mockReturnValue(null);
        if (state === 'dehydrated') vi.mocked(manager.isDehydrated).mockReturnValue(true);
        if (state === 'destroyed') win.webContents.isDestroyed = () => true;
        const mod = await import('./inOnline.js');
        const dispose = mod.scheduleInitialConnectivity(manager);
        await vi.advanceTimersByTimeAsync(3000);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(manager.focusAccount).not.toHaveBeenCalled();
        dispose();
      }
    );

    it.each(['/Applications/Gog Chat.app', '/Applications/Gog Chat #?%.app'])(
      'retains one notification when its own file navigation is normalized under %s',
      async (appPath) => {
        vi.useFakeTimers();
        const { app, Notification } = await import('electron');
        vi.spyOn(app, 'getAppPath').mockReturnValue(appPath);
        const fetchMock = vi.fn().mockResolvedValue({ ok: false });
        vi.stubGlobal('fetch', fetchMock);
        const canonicalTarget = pathToFileURL(`${appPath}/lib/offline/index.html`).href;
        const win = makeFakeWindow('https://chat.google.com/u/0');
        vi.mocked(win.webContents.loadURL).mockImplementation(async () => {
          win.webContents.emit('did-start-navigation', {
            isMainFrame: true,
            url: canonicalTarget,
          });
        });
        const mod = await import('./inOnline.js');
        const dispose = mod.scheduleInitialConnectivity(makeAccountManager(win));
        try {
          await vi.advanceTimersByTimeAsync(3000);

          expect(Notification).toHaveBeenCalledTimes(1);
          const banner = asType<Electron.Notification>(
            vi.mocked(Notification).mock.results[0]?.value
          );
          expect(banner.show).toHaveBeenCalledTimes(1);
          expect(win.webContents.loadURL).toHaveBeenCalledWith(canonicalTarget);
          expect(win.loadURL).not.toHaveBeenCalled();
          expect(fetchMock).toHaveBeenCalledTimes(2);
        } finally {
          dispose();
        }
      }
    );

    it('invalidates normalized file ownership when a same-URL competitor starts', async () => {
      vi.useFakeTimers();
      const { app, Notification } = await import('electron');
      const appPath = '/Applications/Gog Chat #?%.app';
      vi.spyOn(app, 'getAppPath').mockReturnValue(appPath);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
      const canonicalTarget = pathToFileURL(`${appPath}/lib/offline/index.html`).href;
      const win = makeFakeWindow('https://chat.google.com/u/0');
      const manager = makeAccountManager(win);
      vi.mocked(win.webContents.loadURL).mockImplementation(async () => {
        win.webContents.emit('did-start-navigation', {
          isMainFrame: true,
          url: canonicalTarget,
        });
      });
      const mod = await import('./inOnline.js');
      const dispose = mod.scheduleInitialConnectivity(manager);
      try {
        await vi.advanceTimersByTimeAsync(3000);
        expect(Notification).toHaveBeenCalledTimes(1);
        const banner = asType<Electron.Notification>(
          vi.mocked(Notification).mock.results[0]?.value
        );
        const capturedClicks = banner.listeners('click');
        expect(capturedClicks).toHaveLength(1);

        win.webContents.emit('did-start-navigation', {
          isMainFrame: true,
          url: canonicalTarget,
        });
        for (const click of capturedClicks) click();

        expect(manager.focusAccount).not.toHaveBeenCalled();
        expect(banner.close).toHaveBeenCalledTimes(1);
        expect(banner.listenerCount('click')).toBe(0);
        expect(win.webContents.listenerCount('did-start-navigation')).toBe(0);
      } finally {
        dispose();
      }
    });

    it('transfers ownership to its own navigation then closes the banner on a same-URL competitor', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
      const win = makeFakeWindow('https://chat.google.com/u/0');
      const manager = makeAccountManager(win);
      vi.mocked(win.webContents.loadURL).mockImplementation(async (url: string) => {
        win.webContents.emit('did-start-navigation', { isMainFrame: true, url });
      });
      const mod = await import('./inOnline.js');
      const dispose = mod.scheduleInitialConnectivity(manager);
      await vi.advanceTimersByTimeAsync(3000);
      const { Notification } = await import('electron');
      const banner = vi.mocked(Notification).mock.results.at(-1)?.value;
      expect(banner.show).toHaveBeenCalledTimes(1);
      const oldClick = banner.listeners('click')[0];
      oldClick();
      expect(manager.focusAccount).toHaveBeenCalledWith(0);
      win.webContents.emit('did-start-navigation', {
        isMainFrame: true,
        url: 'file:///Applications/GogChat.app/lib/offline/index.html',
      });
      oldClick();
      expect(manager.focusAccount).toHaveBeenCalledTimes(1);
      expect(banner.close).toHaveBeenCalled();
      expect(banner.listenerCount('click')).toBe(0);
      dispose();
    });

    it.each(['auth', 'reject', 'throw'])(
      'does not notify after a %s routing refusal',
      async (state) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
        const win = makeFakeWindow(
          state === 'auth' ? 'https://accounts.google.com/signin' : 'https://chat.google.com/u/0'
        );
        if (state === 'reject')
          vi.mocked(win.webContents.loadURL).mockRejectedValue(new Error('ERR_ABORTED'));
        if (state === 'throw')
          vi.mocked(win.webContents.loadURL).mockImplementation(() => {
            throw new Error('gone');
          });
        const mod = await import('./inOnline.js');
        await mod.checkForInternet(makeAccountManager(win));
        const { Notification } = await import('electron');
        expect(Notification).not.toHaveBeenCalled();
      }
    );
  });

  describe('IPC handler replies', () => {
    it('replies true when fetch succeeds and skips events without reply', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      const win = makeFakeWindow() as unknown as Electron.BrowserWindow;
      const feature = await import('./inOnline.js');
      feature.default(win);
      const cfg = getOnlineIpc();
      expect(cfg.validator({ attemptId: 'ok-1' })).toEqual({ attemptId: 'ok-1' });
      expect(() => cfg.validator(undefined)).toThrow();
      cfg.handler({ attemptId: 'skip' }, {});
      const event = makeReplyEvent(1);
      cfg.handler({ attemptId: 'ok-1' }, event);
      await vi.waitFor(() =>
        expect(event.reply).toHaveBeenCalledWith('onlineStatus', {
          attemptId: 'ok-1',
          online: true,
        })
      );
      vi.unstubAllGlobals();
    });

    it('replies false when the probe rejects', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue('down'));
      const win = makeFakeWindow() as unknown as Electron.BrowserWindow;
      const feature = await import('./inOnline.js');
      feature.default(win);
      const event = makeReplyEvent(2);
      getOnlineIpc().handler({ attemptId: 'down-1' }, event);
      await vi.waitFor(() =>
        expect(event.reply).toHaveBeenCalledWith('onlineStatus', {
          attemptId: 'down-1',
          online: false,
        })
      );
      vi.unstubAllGlobals();
    });
  });

  // ── IPC handler configuration ─────────────────────────────────────────────

  describe('IPC handler configuration', () => {
    it('handler includes validator', async () => {
      mockDefineIPC.mockReturnValue(vi.fn());
      const win = makeFakeWindow() as unknown as Electron.BrowserWindow;

      const feature = await import('./inOnline.js');
      feature.default(win);

      expect(mockDefineIPC).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'checkIfOnline',
          validator: expect.any(Function),
        })
      );
    });

    it('does not rate-limit a replacement before supersession', async () => {
      mockDefineIPC.mockReturnValue(vi.fn());
      const win = makeFakeWindow() as unknown as Electron.BrowserWindow;

      const feature = await import('./inOnline.js');
      feature.default(win);

      expect(mockDefineIPC.mock.calls[0]?.[0]).not.toHaveProperty('rateLimit');
      expect(mockDefineIPC.mock.calls[0]?.[0]).not.toHaveProperty('deduplicate', true);
    });
  });

  describe('attempt-aware probes', () => {
    function stubPendingFetch() {
      const pending: Array<{
        resolve: (value: { ok: boolean }) => void;
        reject: (reason?: unknown) => void;
        signal?: AbortSignal;
        aborted: boolean;
      }> = [];
      const fetchMock = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
        return new Promise<{ ok: boolean }>((resolve, reject) => {
          const signal = init?.signal;
          const entry = {
            resolve,
            reject,
            signal,
            aborted: Boolean(signal?.aborted),
          };
          const onAbort = (): void => {
            entry.aborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          };
          if (signal?.aborted) {
            onAbort();
            pending.push(entry);
            return;
          }
          signal?.addEventListener('abort', onAbort, { once: true });
          pending.push(entry);
        });
      });
      vi.stubGlobal('fetch', fetchMock);
      return { fetchMock, pending };
    }

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('lets a fast second probe reply and drops the slow first result', async () => {
      vi.useFakeTimers();
      const { pending, fetchMock } = stubPendingFetch();
      const win = makeFakeWindow() as unknown as Electron.BrowserWindow;
      const feature = await import('./inOnline.js');
      feature.default(win);
      const event = makeReplyEvent(10);
      const cfg = getOnlineIpc();

      cfg.handler({ attemptId: 'slow' }, event);
      cfg.handler({ attemptId: 'fast' }, event);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(pending[0]?.aborted).toBe(true);

      await vi.advanceTimersByTimeAsync(feature.ONLINE_FETCH_MIN_INTERVAL_MS);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      pending[1]?.resolve({ ok: true });
      await vi.waitFor(() =>
        expect(event.reply).toHaveBeenCalledWith('onlineStatus', {
          attemptId: 'fast',
          online: true,
        })
      );
      expect(event.reply).toHaveBeenCalledTimes(1);
      feature.cleanupConnectivityHandler();
    });

    it('replaces a same-sender probe immediately and coalesces the fetch', async () => {
      vi.useFakeTimers();
      const { pending, fetchMock } = stubPendingFetch();
      const win = makeFakeWindow() as unknown as Electron.BrowserWindow;
      const feature = await import('./inOnline.js');
      feature.default(win);
      const event = makeReplyEvent(11);
      const cfg = getOnlineIpc();

      cfg.handler({ attemptId: 'first' }, event);
      cfg.handler({ attemptId: 'second' }, event);
      cfg.handler({ attemptId: 'third' }, event);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(pending[0]?.aborted).toBe(true);

      await vi.advanceTimersByTimeAsync(feature.ONLINE_FETCH_MIN_INTERVAL_MS);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      pending[1]?.resolve({ ok: true });
      await vi.waitFor(() =>
        expect(event.reply).toHaveBeenCalledWith('onlineStatus', {
          attemptId: 'third',
          online: true,
        })
      );
      expect(event.reply).toHaveBeenCalledTimes(1);
      feature.cleanupConnectivityHandler();
    });

    it('does not let a reused attemptId abort the replacement', async () => {
      vi.useFakeTimers();
      const { pending, fetchMock } = stubPendingFetch();
      const win = makeFakeWindow() as unknown as Electron.BrowserWindow;
      const feature = await import('./inOnline.js');
      feature.default(win);
      const event = makeReplyEvent(12);
      const cfg = getOnlineIpc();

      cfg.handler({ attemptId: 'reused' }, event);
      cfg.handler({ attemptId: 'reused' }, event);
      expect(pending[0]?.aborted).toBe(true);

      await vi.advanceTimersByTimeAsync(feature.ONLINE_FETCH_MIN_INTERVAL_MS);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      pending[1]?.resolve({ ok: true });
      await vi.waitFor(() =>
        expect(event.reply).toHaveBeenCalledWith('onlineStatus', {
          attemptId: 'reused',
          online: true,
        })
      );
      expect(event.reply).toHaveBeenCalledTimes(1);
      feature.cleanupConnectivityHandler();
    });

    it('keeps different senders independent', async () => {
      const { pending } = stubPendingFetch();
      const win = makeFakeWindow() as unknown as Electron.BrowserWindow;
      const feature = await import('./inOnline.js');
      feature.default(win);
      const first = makeReplyEvent(21);
      const second = makeReplyEvent(22);
      const cfg = getOnlineIpc();

      cfg.handler({ attemptId: 'sender-a' }, first);
      cfg.handler({ attemptId: 'sender-b' }, second);
      await vi.waitFor(() => expect(pending.length).toBe(2));

      pending[0]?.resolve({ ok: true });
      pending[1]?.resolve({ ok: false });
      await vi.waitFor(() =>
        expect(first.reply).toHaveBeenCalledWith('onlineStatus', {
          attemptId: 'sender-a',
          online: true,
        })
      );
      await vi.waitFor(() =>
        expect(second.reply).toHaveBeenCalledWith('onlineStatus', {
          attemptId: 'sender-b',
          online: false,
        })
      );
    });

    it('aborts and does not reply when the sender is destroyed', async () => {
      const { pending } = stubPendingFetch();
      const win = makeFakeWindow() as unknown as Electron.BrowserWindow;
      const feature = await import('./inOnline.js');
      feature.default(win);
      const event = makeReplyEvent(31);
      getOnlineIpc().handler({ attemptId: 'dying' }, event);
      await vi.waitFor(() => expect(pending.length).toBe(1));

      event.sender.destroy();
      expect(pending[0]?.aborted).toBe(true);
      pending[0]?.resolve({ ok: true });
      await Promise.resolve();
      await Promise.resolve();
      expect(event.reply).not.toHaveBeenCalled();
    });

    it('does not start a probe for an already-destroyed sender', async () => {
      const { fetchMock } = stubPendingFetch();
      const win = makeFakeWindow() as unknown as Electron.BrowserWindow;
      const feature = await import('./inOnline.js');
      feature.default(win);
      const event = makeReplyEvent(32);
      event.sender._destroyed = true;
      getOnlineIpc().handler({ attemptId: 'gone' }, event);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(event.reply).not.toHaveBeenCalled();
    });

    it('uses a final liveness check when destroy races the reply', async () => {
      const { pending } = stubPendingFetch();
      const win = makeFakeWindow() as unknown as Electron.BrowserWindow;
      const feature = await import('./inOnline.js');
      feature.default(win);
      const event = makeReplyEvent(33);
      getOnlineIpc().handler({ attemptId: 'race' }, event);
      await vi.waitFor(() => expect(pending.length).toBe(1));

      event.sender._destroyed = true;
      pending[0]?.resolve({ ok: true });
      await Promise.resolve();
      await Promise.resolve();
      expect(event.reply).not.toHaveBeenCalled();
    });

    it('swallows a reply throw after the liveness check', async () => {
      const { pending } = stubPendingFetch();
      const win = makeFakeWindow() as unknown as Electron.BrowserWindow;
      const feature = await import('./inOnline.js');
      feature.default(win);
      const event = makeReplyEvent(34);
      event.reply.mockImplementation(() => {
        throw new Error('sender gone during send');
      });
      getOnlineIpc().handler({ attemptId: 'send-race' }, event);
      await vi.waitFor(() => expect(pending.length).toBe(1));
      pending[0]?.resolve({ ok: true });
      await Promise.resolve();
      await Promise.resolve();
      expect(event.reply).toHaveBeenCalledTimes(1);
    });

    it('aborts in-flight work on feature cleanup and emits no reply', async () => {
      const { pending } = stubPendingFetch();
      const win = makeFakeWindow() as unknown as Electron.BrowserWindow;
      const feature = await import('./inOnline.js');
      feature.default(win);
      const event = makeReplyEvent(41);
      getOnlineIpc().handler({ attemptId: 'cleanup' }, event);
      await vi.waitFor(() => expect(pending.length).toBe(1));

      feature.cleanupConnectivityHandler();
      expect(pending[0]?.aborted).toBe(true);
      pending[0]?.resolve({ ok: true });
      await Promise.resolve();
      await Promise.resolve();
      expect(event.reply).not.toHaveBeenCalled();
    });

    it('settles an aborted probe during cleanup without throwing', async () => {
      const settled = vi.fn();
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
          return new Promise((_resolve, reject) => {
            const signal = init?.signal;
            const finish = (): void => {
              settled();
              reject(new DOMException('Aborted', 'AbortError'));
            };
            if (signal?.aborted) {
              finish();
              return;
            }
            signal?.addEventListener('abort', finish, { once: true });
          });
        })
      );
      const win = makeFakeWindow() as unknown as Electron.BrowserWindow;
      const feature = await import('./inOnline.js');
      feature.default(win);
      const event = makeReplyEvent(42);
      getOnlineIpc().handler({ attemptId: 'shutdown' }, event);

      expect(() => feature.cleanupConnectivityHandler()).not.toThrow();
      await vi.waitFor(() => expect(settled).toHaveBeenCalled());
      expect(event.reply).not.toHaveBeenCalled();
    });
  });
});
