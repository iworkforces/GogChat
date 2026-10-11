/**
 * Deferred startup must not construct a menu-bar tray.
 * Drives the shipped spec init functions for badge and hide-on-close.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../shared/constants.js';
import type { BrowserWindow } from 'electron';
import type { FeatureContext } from '../utils/lifecycle/featureConfigTypes.js';

const trayConstructor = vi.hoisted(() => vi.fn());
const createTrayIcon = vi.hoisted(() => vi.fn());
const ipcOn = vi.hoisted(() => vi.fn());
const appOn = vi.hoisted(() => vi.fn());
const dockHide = vi.hoisted(() => vi.fn());
const setActivationPolicy = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  app: {
    setBadgeCount: vi.fn(),
    on: appOn,
    hide: vi.fn(),
    removeListener: vi.fn(),
    dock: { hide: dockHide, setBadge: vi.fn() },
    setActivationPolicy,
    isPackaged: false,
    getPath: vi.fn(() => '/tmp'),
    getAppPath: vi.fn(() => '/app'),
  },
  Tray: trayConstructor,
  ipcMain: {
    on: ipcOn,
    removeListener: vi.fn(),
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  Notification: vi.fn(),
  nativeImage: {
    createFromPath: vi.fn(() => ({ resize: vi.fn() })),
  },
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

vi.mock('../utils/platform/platformUtils.js', () => ({
  getPlatformUtils: () => ({ createTrayIcon }),
}));

function fakeWindow(): BrowserWindow {
  return {
    on: vi.fn(),
    isDestroyed: () => false,
  } as unknown as BrowserWindow;
}

describe('deferred startup without a tray', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not schedule a tray feature', async () => {
    const { DEFERRED_FEATURES } = await import('./deferred.spec.js');
    expect(DEFERRED_FEATURES.map((feature) => feature.name)).not.toContain('trayIcon');
    expect(DEFERRED_FEATURES.map((feature) => feature.name)).toEqual(
      expect.arrayContaining(['badgeIcons', 'closeToTray'])
    );
  });

  it('registers unread handling and hide-on-close with no tray in context', async () => {
    const { DEFERRED_FEATURES } = await import('./deferred.spec.js');
    const window = fakeWindow();
    const context: FeatureContext = { mainWindow: window };

    const badge = DEFERRED_FEATURES.find((feature) => feature.name === 'badgeIcons');
    const close = DEFERRED_FEATURES.find((feature) => feature.name === 'closeToTray');
    expect(badge).toBeDefined();
    expect(close).toBeDefined();

    await badge?.init(context);
    await close?.init(context);

    expect(trayConstructor).not.toHaveBeenCalled();
    expect(createTrayIcon).not.toHaveBeenCalled();
    expect(dockHide).not.toHaveBeenCalled();
    expect(setActivationPolicy).not.toHaveBeenCalled();
    expect(ipcOn).toHaveBeenCalledWith(IPC_CHANNELS.UNREAD_COUNT, expect.any(Function));
    expect(window.on).toHaveBeenCalledWith('close', expect.any(Function));
  });
});
