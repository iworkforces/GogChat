import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainEvent, Tray, WebContents } from 'electron';
import { electronMock } from '../../../tests/mocks/electron';
import { IPC_CHANNELS } from '../../shared/constants.js';
import { asType } from '../../shared/typeUtils.js';
import { asAccountIndex } from '../../shared/types/branded.js';
import type { IAccountWindowManager } from '../../shared/types/window.js';
import * as accountHooks from '../utils/account/accountWebContentsHooks.js';
import { setSharedFeatureContext } from '../utils/lifecycle/featureContextStore.js';

const isAllowedMock = vi.fn<(...args: unknown[]) => boolean>();

vi.mock('electron', () => electronMock);

vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../utils/ipc/rateLimiter.js', () => ({
  getRateLimiter: () => ({
    isAllowed: isAllowedMock,
  }),
}));

vi.mock('../utils/platform/iconCache.js', () => ({
  getIconCache: () => ({
    getIcon: vi.fn(() => ({})),
  }),
}));

vi.mock('../utils/ipc/ipcDeduplicator.js', () => ({
  getDeduplicator: () => ({
    deduplicate: async (_key: string, fn: () => Promise<void>) => {
      await fn();
    },
  }),
}));

describe('feature IPC cleanup ownership', () => {
  beforeEach(() => {
    electronMock.reset();
    vi.clearAllMocks();
    isAllowedMock.mockReturnValue(true);
    accountHooks.clearAccountWebContentsHooksForTests();
    setSharedFeatureContext({});
  });

  afterEach(() => {
    accountHooks.clearAccountWebContentsHooksForTests();
    setSharedFeatureContext({});
    vi.restoreAllMocks();
  });

  it('cleanupBadgeIcon removes only feature-owned listeners', async () => {
    const mod = await import('./badgeIcon.js');

    const tray = { setImage: vi.fn() };
    mod.default(asType<BrowserWindow>({}), asType<Tray>(tray));

    const externalFaviconListener = vi.fn();
    const externalUnreadListener = vi.fn();

    electronMock.ipcMain.on(IPC_CHANNELS.FAVICON_CHANGED, externalFaviconListener);
    electronMock.ipcMain.on(IPC_CHANNELS.UNREAD_COUNT, externalUnreadListener);

    expect(electronMock.ipcMain.listenerCount(IPC_CHANNELS.FAVICON_CHANGED)).toBe(2);
    expect(electronMock.ipcMain.listenerCount(IPC_CHANNELS.UNREAD_COUNT)).toBe(2);

    mod.cleanupBadgeIcon();

    expect(electronMock.ipcMain.listenerCount(IPC_CHANNELS.FAVICON_CHANGED)).toBe(1);
    expect(electronMock.ipcMain.listenerCount(IPC_CHANNELS.UNREAD_COUNT)).toBe(1);

    electronMock.ipcMain.emit(
      IPC_CHANNELS.FAVICON_CHANGED,
      asType<IpcMainEvent>({ sender: { id: 203, isDestroyed: () => false } }),
      'https://chat.google.com/favicon.ico'
    );
    electronMock.ipcMain.emit(
      IPC_CHANNELS.UNREAD_COUNT,
      asType<IpcMainEvent>({ sender: { id: 203, isDestroyed: () => false } }),
      4
    );

    expect(externalFaviconListener).toHaveBeenCalled();
    expect(externalUnreadListener).toHaveBeenCalled();
  });

  it('attempts every disposer and invalidates a lingering IPC callback after cleanup failure', async () => {
    const mod = await import('./badgeIcon.js');
    const index = asAccountIndex(2);
    const sender = asType<WebContents>({ id: 203, isDestroyed: () => false });
    const manager = asType<IAccountWindowManager>({
      enumerateAccountWebContents: () => [
        { accountIndex: index, webContents: sender, backend: 'browser-window' },
      ],
      getAccountForWebContents: (id: number) => (id === sender.id ? index : null),
    });
    accountHooks.setAccountWebContentsHooksManager(manager);
    setSharedFeatureContext({ accountWindowManager: manager });
    const externalCreated = vi.fn();
    const externalRemoved = vi.fn();
    accountHooks.onAccountWebContentsCreated(externalCreated);
    accountHooks.onAccountRemoved(externalRemoved);
    const window = asType<BrowserWindow>({ isDestroyed: () => false, isFocused: () => false });
    const tray = asType<Tray>({ setImage: vi.fn() });
    mod.default(window, tray);
    const event = asType<IpcMainEvent>({ sender });
    electronMock.ipcMain.emit(IPC_CHANNELS.UNREAD_COUNT, event, 8);
    const badge = vi.spyOn(electronMock.app, 'setBadgeCount');
    const remove = vi.spyOn(electronMock.ipcMain, 'removeListener').mockImplementationOnce(() => {
      throw new Error('favicon cleanup failed');
    });

    expect(() => mod.cleanupBadgeIcon()).not.toThrow();
    mod.cleanupBadgeIcon();
    accountHooks.notifyAccountWebContentsCreated({
      accountIndex: index,
      webContents: sender,
      backend: 'browser-window',
    });
    accountHooks.notifyAccountRemoved(index);
    electronMock.ipcMain.emit(
      IPC_CHANNELS.FAVICON_CHANGED,
      event,
      'https://mail.google.com/favicon_chat_new_notif_r2.ico'
    );
    electronMock.ipcMain.emit(IPC_CHANNELS.UNREAD_COUNT, event, 20);

    expect(remove).toHaveBeenCalledTimes(2);
    expect(electronMock.ipcMain.listenerCount(IPC_CHANNELS.UNREAD_COUNT)).toBe(0);
    expect(badge).not.toHaveBeenCalled();
    expect(externalCreated).toHaveBeenCalledTimes(2);
    expect(externalRemoved).toHaveBeenCalledWith(index);
  });

  it('cleanupNotificationHandler removes only feature-owned listeners', async () => {
    const mod = await import('./handleNotification.js');

    const windowMock = {
      isVisible: vi.fn(() => true),
      isFocused: vi.fn(() => true),
      show: vi.fn(),
    };

    mod.default(windowMock as never);

    const externalShowListener = vi.fn();
    const externalClickedListener = vi.fn();

    electronMock.ipcMain.on(IPC_CHANNELS.NOTIFICATION_SHOW, externalShowListener);
    electronMock.ipcMain.on(IPC_CHANNELS.NOTIFICATION_CLICKED, externalClickedListener);

    expect(electronMock.ipcMain.listenerCount(IPC_CHANNELS.NOTIFICATION_SHOW)).toBe(2);
    expect(electronMock.ipcMain.listenerCount(IPC_CHANNELS.NOTIFICATION_CLICKED)).toBe(2);

    mod.cleanupNotificationHandler();

    expect(electronMock.ipcMain.listenerCount(IPC_CHANNELS.NOTIFICATION_SHOW)).toBe(1);
    expect(electronMock.ipcMain.listenerCount(IPC_CHANNELS.NOTIFICATION_CLICKED)).toBe(1);

    electronMock.ipcMain.emit(IPC_CHANNELS.NOTIFICATION_SHOW, {}, { title: 'X' });
    electronMock.ipcMain.emit(IPC_CHANNELS.NOTIFICATION_CLICKED, {});

    expect(externalShowListener).toHaveBeenCalled();
    expect(externalClickedListener).toHaveBeenCalled();
  });

  it('cleanupConnectivityHandler removes only feature-owned listeners', async () => {
    const mod = await import('./inOnline.js');
    mod.default({} as never);

    const externalListener = vi.fn();
    electronMock.ipcMain.on(IPC_CHANNELS.CHECK_IF_ONLINE, externalListener);

    expect(electronMock.ipcMain.listenerCount(IPC_CHANNELS.CHECK_IF_ONLINE)).toBe(2);

    mod.cleanupConnectivityHandler();

    expect(electronMock.ipcMain.listenerCount(IPC_CHANNELS.CHECK_IF_ONLINE)).toBe(1);

    electronMock.ipcMain.emit(IPC_CHANNELS.CHECK_IF_ONLINE, {});
    expect(externalListener).toHaveBeenCalled();
  });
});
