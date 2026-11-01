/**
 * Tests for preload/index.ts — renderer↔main contextBridge API
 * SECURITY CRITICAL: this is the ONLY bridge between renderer and main processes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock('../shared/dataValidators.js', () => ({
  validateUnreadCount: vi.fn((v: number) => v),
  validatePasskeyFailureData: vi.fn((v: string) => ({ errorType: v, timestamp: 12345 })),
  validateOnlineCheckRequest: vi.fn((data: { attemptId: string }) => {
    if (!data || typeof data.attemptId !== 'string' || data.attemptId.trim() === '') {
      throw new Error('bad attempt');
    }
    return data;
  }),
  validateOnlineStatusData: vi.fn((data: { attemptId: string; outcome: string }) => {
    if (
      !data ||
      typeof data.attemptId !== 'string' ||
      !['online', 'http-error', 'network-error', 'timeout'].includes(data.outcome)
    ) {
      throw new Error('bad status');
    }
    return data;
  }),
}));

vi.mock('../shared/urlValidators.js', () => ({
  validateFaviconURL: vi.fn((v: string) => v),
}));

vi.mock('../shared/constants.js', () => ({
  IPC_CHANNELS: {
    UNREAD_COUNT: 'unread-count',
    FAVICON_CHANGED: 'favicon-changed',
    NOTIFICATION_CLICKED: 'notification-clicked',
    CHECK_IF_ONLINE: 'check-if-online',
    PASSKEY_AUTH_FAILED: 'passkey-auth-failed',
    SEARCH_SHORTCUT: 'search-shortcut',
    ONLINE_STATUS: 'online-status',
  },
}));

const installerMocks = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    installDisableWebAuthn: vi.fn(() => {
      order.push('disableWebAuthn');
    }),
    installFaviconChanged: vi.fn(() => {
      order.push('faviconChanged');
    }),
    installOffline: vi.fn(() => {
      order.push('offline');
    }),
    installPasskeyMonitor: vi.fn(() => {
      order.push('passkeyMonitor');
    }),
    installSearchShortcut: vi.fn(() => {
      order.push('searchShortcut');
    }),
    installUnreadCount: vi.fn(() => {
      order.push('unreadCount');
    }),
    installNotificationBridge: vi.fn(() => {
      order.push('notificationBridge');
    }),
  };
});

vi.mock('./disableWebAuthn.js', () => ({
  installDisableWebAuthn: installerMocks.installDisableWebAuthn,
}));
vi.mock('./faviconChanged.js', () => ({
  installFaviconChanged: installerMocks.installFaviconChanged,
}));
vi.mock('./offline.js', () => ({
  installOffline: installerMocks.installOffline,
}));
vi.mock('./passkeyMonitor.js', () => ({
  installPasskeyMonitor: installerMocks.installPasskeyMonitor,
}));
vi.mock('./searchShortcut.js', () => ({
  installSearchShortcut: installerMocks.installSearchShortcut,
}));
vi.mock('./unreadCount.js', () => ({
  installUnreadCount: installerMocks.installUnreadCount,
}));
vi.mock('./notificationBridge.js', () => ({
  installNotificationBridge: installerMocks.installNotificationBridge,
}));

import { contextBridge, ipcRenderer } from 'electron';
import { validateUnreadCount, validatePasskeyFailureData } from '../shared/dataValidators.js';
import { validateFaviconURL } from '../shared/urlValidators.js';
import type { GogChatBridgeAPI } from '../shared/types/bridge.js';

type ExposeMock = ReturnType<typeof vi.fn> & {
  mock: { calls: Array<[string, GogChatBridgeAPI]> };
};

async function loadPreload(): Promise<GogChatBridgeAPI> {
  await import('./index');
  const exposeMock = contextBridge.exposeInMainWorld as unknown as ExposeMock;
  const call = exposeMock.mock.calls[0];
  if (!call) throw new Error('contextBridge.exposeInMainWorld was not called');
  return call[1];
}

describe('preload/index.ts', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installerMocks.order.length = 0;
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('contextBridge.exposeInMainWorld', () => {
    it('is called exactly once with "gogchat" as namespace', async () => {
      await loadPreload();
      expect(contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1);
      expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith('gogchat', expect.any(Object));
    });

    it('installs WebAuthn disable, then exposes the bridge, then remaining features in order', async () => {
      const exposeMock = contextBridge.exposeInMainWorld as unknown as ReturnType<typeof vi.fn>;
      exposeMock.mockImplementation(() => {
        installerMocks.order.push('expose');
      });

      await loadPreload();

      expect(installerMocks.order).toEqual([
        'disableWebAuthn',
        'expose',
        'faviconChanged',
        'offline',
        'passkeyMonitor',
        'searchShortcut',
        'unreadCount',
        'notificationBridge',
      ]);
      expect(installerMocks.installDisableWebAuthn).toHaveBeenCalledTimes(1);
      expect(installerMocks.installNotificationBridge).toHaveBeenCalledTimes(1);
    });

    it('exposes exactly the 7 documented API methods', async () => {
      const api = await loadPreload();
      expect(typeof api.sendUnreadCount).toBe('function');
      expect(typeof api.sendFaviconChanged).toBe('function');
      expect(typeof api.sendNotificationClicked).toBe('function');
      expect(typeof api.checkIfOnline).toBe('function');
      expect(typeof api.reportPasskeyFailure).toBe('function');
      expect(typeof api.onSearchShortcut).toBe('function');
      expect(typeof api.onOnlineStatus).toBe('function');
    });

    it('does NOT leak raw ipcRenderer or other electron internals', async () => {
      const api = await loadPreload();
      const record = api as unknown as Record<string, unknown>;
      expect(record.ipcRenderer).toBeUndefined();
      expect(record.contextBridge).toBeUndefined();
      expect(record.require).toBeUndefined();
      expect(record.process).toBeUndefined();
    });
  });

  describe('sendUnreadCount', () => {
    it('validates and forwards valid count', async () => {
      const api = await loadPreload();
      api.sendUnreadCount(5);
      expect(validateUnreadCount).toHaveBeenCalledWith(5);
      expect(ipcRenderer.send).toHaveBeenCalledWith('unread-count', 5);
    });

    it('does NOT call ipcRenderer.send when validator throws; logs error', async () => {
      vi.mocked(validateUnreadCount).mockImplementationOnce(() => {
        throw new Error('bad count');
      });
      const api = await loadPreload();
      api.sendUnreadCount(-1);
      expect(ipcRenderer.send).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[GogChat API] Invalid unread count:',
        expect.any(Error)
      );
    });
  });

  describe('sendFaviconChanged', () => {
    it('validates and forwards valid href', async () => {
      const api = await loadPreload();
      api.sendFaviconChanged('https://example.com/fav.ico');
      expect(validateFaviconURL).toHaveBeenCalledWith('https://example.com/fav.ico');
      expect(ipcRenderer.send).toHaveBeenCalledWith(
        'favicon-changed',
        'https://example.com/fav.ico'
      );
    });

    it('does NOT send when validator throws', async () => {
      vi.mocked(validateFaviconURL).mockImplementationOnce(() => {
        throw new Error('bad url');
      });
      const api = await loadPreload();
      api.sendFaviconChanged('javascript:alert(1)');
      expect(ipcRenderer.send).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[GogChat API] Invalid favicon URL:',
        expect.any(Error)
      );
    });
  });

  describe('sendNotificationClicked', () => {
    it('sends on NOTIFICATION_CLICKED channel with no payload', async () => {
      const api = await loadPreload();
      api.sendNotificationClicked();
      expect(ipcRenderer.send).toHaveBeenCalledWith('notification-clicked');
    });
  });

  describe('checkIfOnline', () => {
    it('sends on CHECK_IF_ONLINE channel with a validated attemptId', async () => {
      const api = await loadPreload();
      api.checkIfOnline('attempt-1');
      expect(ipcRenderer.send).toHaveBeenCalledWith('check-if-online', { attemptId: 'attempt-1' });
    });

    it('does NOT send when the attemptId is invalid', async () => {
      const api = await loadPreload();
      api.checkIfOnline('   ');
      expect(ipcRenderer.send).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[GogChat API] Invalid online check request:',
        expect.any(Error)
      );
    });
  });

  describe('reportPasskeyFailure', () => {
    it('validates and forwards validated payload', async () => {
      const api = await loadPreload();
      api.reportPasskeyFailure('NotAllowedError');
      expect(validatePasskeyFailureData).toHaveBeenCalledWith('NotAllowedError');
      expect(ipcRenderer.send).toHaveBeenCalledWith('passkey-auth-failed', {
        errorType: 'NotAllowedError',
        timestamp: 12345,
      });
    });

    it('does NOT send when validator throws', async () => {
      vi.mocked(validatePasskeyFailureData).mockImplementationOnce(() => {
        throw new Error('bad passkey data');
      });
      const api = await loadPreload();
      api.reportPasskeyFailure('');
      expect(ipcRenderer.send).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[GogChat API] Invalid passkey failure data:',
        expect.any(Error)
      );
    });
  });

  describe('onSearchShortcut', () => {
    it('registers listener on SEARCH_SHORTCUT channel', async () => {
      const api = await loadPreload();
      const cb = vi.fn();
      api.onSearchShortcut(cb);
      expect(ipcRenderer.on).toHaveBeenCalledWith('search-shortcut', expect.any(Function));
    });

    it('invokes the provided callback when listener fires', async () => {
      const api = await loadPreload();
      const cb = vi.fn();
      api.onSearchShortcut(cb);
      const onMock = vi.mocked(ipcRenderer.on);
      const [, listener] = onMock.mock.calls[0] ?? [];
      expect(listener).toBeDefined();
      (listener as (...args: unknown[]) => void)();
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('returns cleanup fn that calls removeListener with same listener', async () => {
      const api = await loadPreload();
      const cb = vi.fn();
      const cleanup = api.onSearchShortcut(cb);
      const onMock = vi.mocked(ipcRenderer.on);
      const [, listener] = onMock.mock.calls[0] ?? [];
      cleanup();
      expect(ipcRenderer.removeListener).toHaveBeenCalledWith('search-shortcut', listener);
    });
  });

  describe('onOnlineStatus', () => {
    it('registers listener on ONLINE_STATUS channel', async () => {
      const api = await loadPreload();
      const cb = vi.fn();
      api.onOnlineStatus(cb);
      expect(ipcRenderer.on).toHaveBeenCalledWith('online-status', expect.any(Function));
    });

    it('extracts attempt-aware outcomes from event args and invokes callback', async () => {
      const api = await loadPreload();
      const cb = vi.fn();
      api.onOnlineStatus(cb);
      const onMock = vi.mocked(ipcRenderer.on);
      const [, listener] = onMock.mock.calls[0] ?? [];
      expect(listener).toBeDefined();
      const deliver = listener as (event: unknown, data: unknown) => void;
      deliver({}, { attemptId: 'a1', outcome: 'online' });
      expect(cb).toHaveBeenLastCalledWith({ attemptId: 'a1', outcome: 'online' });

      deliver({}, { attemptId: 'a2', outcome: 'http-error', httpStatus: 503 });
      expect(cb).toHaveBeenLastCalledWith({
        attemptId: 'a2',
        outcome: 'http-error',
        httpStatus: 503,
      });
      deliver({}, { attemptId: 'a3', outcome: 'network-error' });
      deliver({}, { attemptId: 'a4', outcome: 'timeout' });
      expect(cb).toHaveBeenCalledTimes(4);
    });

    it.each([
      ['a missing outcome', { attemptId: 'a1' }],
      ['the legacy boolean shape', { attemptId: 'a1', online: true }],
      ['an unknown outcome', { attemptId: 'a1', outcome: 'offline' }],
    ])('does not invoke the callback for %s', async (_name, payload) => {
      const api = await loadPreload();
      const cb = vi.fn();
      api.onOnlineStatus(cb);
      const onMock = vi.mocked(ipcRenderer.on);
      const [, listener] = onMock.mock.calls[0] ?? [];
      (listener as (event: unknown, data: unknown) => void)({}, payload);
      expect(cb).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[GogChat API] Invalid online status:',
        expect.any(Error)
      );
    });

    it('returns cleanup fn that calls removeListener with same listener', async () => {
      const api = await loadPreload();
      const cb = vi.fn();
      const cleanup = api.onOnlineStatus(cb);
      const onMock = vi.mocked(ipcRenderer.on);
      const [, listener] = onMock.mock.calls[0] ?? [];
      cleanup();
      expect(ipcRenderer.removeListener).toHaveBeenCalledWith('online-status', listener);
    });
  });
});
