/**
 * Dock badge presentation with no Tray instance.
 * Drives the unread IPC listener registered by setupBadgeHandlers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainEvent } from 'electron';
import { asType } from '../../../shared/typeUtils.js';
import { asAccountIndex } from '../../../shared/types/branded.js';
import { BADGE, IPC_CHANNELS } from '../../../shared/constants.js';
import type { IAccountWindowManager } from '../../../shared/types/window.js';

const mockSetBadgeCount = vi.fn();
const Tray = vi.fn();

vi.mock('electron', () => ({
  app: {
    setBadgeCount: (...args: unknown[]) => mockSetBadgeCount(...args),
    dock: { hide: vi.fn(), setBadge: vi.fn() },
    setActivationPolicy: vi.fn(),
  },
  ipcMain: {
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  Tray,
  Notification: vi.fn(),
  nativeImage: { createFromPath: vi.fn() },
}));

vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
  },
}));

vi.mock('../../config.js', () => ({
  configGet: () => false,
}));

vi.mock('../account/accountWindowManager.js', () => ({
  getAccountWindowManager: () => ({
    isAccountVisible: () => false,
  }),
}));

vi.mock('../security/notificationAccess.js', () => ({
  ensureNotificationPermission: vi.fn(),
}));

vi.mock('./notificationFocus.js', () => ({
  resolveNotificationFocusWindow: (_event: unknown, fallback: unknown) => fallback,
}));

vi.mock('./platformDetection.js', () => ({
  platform: {
    isMac: true,
    config: { supportsDockBadge: true },
  },
}));

function sender(id: number): Electron.WebContents {
  return asType<Electron.WebContents>({
    id,
    isDestroyed: () => false,
  });
}

describe('dock badge presentation without a tray', () => {
  const account0 = sender(11);
  const account2 = sender(13);

  beforeEach(async () => {
    vi.clearAllMocks();
    const hooks = await import('../account/accountWebContentsHooks.js');
    hooks.clearAccountWebContentsHooksForTests();
    const { setSharedFeatureContext } = await import('../lifecycle/featureContextStore.js');
    const manager = asType<IAccountWindowManager>({
      getAccountForWebContents: (id: number) => {
        if (id === account0.id) return asAccountIndex(0);
        if (id === account2.id) return asAccountIndex(2);
        return null;
      },
      isAccountVisible: () => false,
      enumerateAccountWebContents: () => [
        { accountIndex: asAccountIndex(0), webContents: account0, backend: 'browser-window' },
        { accountIndex: asAccountIndex(2), webContents: account2, backend: 'browser-window' },
      ],
    });
    setSharedFeatureContext({ accountWindowManager: manager });
    hooks.setAccountWebContentsHooksManager(manager);
    const { getRateLimiter } = await import('../ipc/rateLimiter.js');
    getRateLimiter().resetAll();
  });

  async function unreadListener(): Promise<(event: IpcMainEvent, count: number) => void> {
    const { ipcMain } = await import('electron');
    const { setupBadgeHandlers } = await import('./badgeHelpers.js');
    setupBadgeHandlers(
      asType<Electron.BrowserWindow>({ isDestroyed: () => false, isFocused: () => false })
    );
    const onMock = ipcMain.on as unknown as ReturnType<typeof vi.fn>;
    const call = onMock.mock.calls.find(([channel]) => channel === IPC_CHANNELS.UNREAD_COUNT);
    expect(call).toBeDefined();
    return call![1] as (event: IpcMainEvent, count: number) => void;
  }

  it('caps a positive unread total and clears zero without a tray image', async () => {
    const listener = await unreadListener();

    listener(asType<IpcMainEvent>({ sender: account0 }), BADGE.DISPLAY_MAX + 51);
    expect(mockSetBadgeCount).toHaveBeenLastCalledWith(BADGE.DISPLAY_MAX);
    expect(Tray).not.toHaveBeenCalled();

    listener(asType<IpcMainEvent>({ sender: account0 }), 0);
    expect(mockSetBadgeCount).toHaveBeenLastCalledWith(0);
    expect(Tray).not.toHaveBeenCalled();
  });

  it('caps the sum of per-account unread totals', async () => {
    const listener = await unreadListener();
    const half = Math.floor(BADGE.DISPLAY_MAX / 2) + 1;

    listener(asType<IpcMainEvent>({ sender: account0 }), half);
    listener(asType<IpcMainEvent>({ sender: account2 }), half);

    expect(mockSetBadgeCount).toHaveBeenLastCalledWith(BADGE.DISPLAY_MAX);
    expect(half + half).toBeGreaterThan(BADGE.DISPLAY_MAX);
    expect(Tray).not.toHaveBeenCalled();
  });
});
