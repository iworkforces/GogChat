/**
 * Unit tests for trayIcon feature.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAboutHandler } = vi.hoisted(() => ({
  mockAboutHandler: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    exit: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  Menu: {
    buildFromTemplate: vi.fn().mockReturnValue({}),
  },
  Tray: vi.fn().mockImplementation(function (_icon: unknown) {
    return {
      setIgnoreDoubleClickEvents: vi.fn(),
      setContextMenu: vi.fn(),
      setToolTip: vi.fn(),
      on: vi.fn(),
      isDestroyed: vi.fn().mockReturnValue(false),
      destroy: vi.fn(),
    };
  }),
  NativeImage: {},
}));

vi.mock('./menuActionRegistry', () => ({
  getMenuAction: vi.fn((id: string) => {
    if (id === 'aboutPanel') return { label: 'Show About Panel', handler: mockAboutHandler };
    return undefined;
  }),
}));

const mockTrayInstance = {
  setIgnoreDoubleClickEvents: vi.fn(),
  setContextMenu: vi.fn(),
  setToolTip: vi.fn(),
  on: vi.fn(),
  isDestroyed: vi.fn().mockReturnValue(false),
  destroy: vi.fn(),
};
const mockCreateTrayIcon = vi.fn(() => mockTrayInstance);

vi.mock('../utils/platform/platformUtils', () => ({
  getPlatformUtils: () => ({
    createTrayIcon: mockCreateTrayIcon,
  }),
}));

vi.mock('electron-log', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const exitMocks = vi.hoisted(() => ({
  exitAppAfterSavingWindows: vi.fn(async () => {
    const { app } = await import('electron');
    app.exit();
  }),
}));

vi.mock('../utils/account/exitAfterAccountWindows.js', () => ({
  exitAppAfterSavingWindows: (...args: unknown[]) => exitMocks.exitAppAfterSavingWindows(...args),
}));

import createTrayIcon, { cleanupTrayIcon } from './trayIcon';
import type { BrowserWindow } from 'electron';
import { Menu, app } from 'electron';

/**
 * Minimal window interface required by createTrayIcon
 * Uses Pick to extract only the methods actually used by createTrayIcon
 */
type TrayWindow = Pick<BrowserWindow, 'isMinimized' | 'restore' | 'show' | 'focus'>;

describe('trayIcon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeFakeWindow(): TrayWindow {
    return {
      isMinimized: vi.fn().mockReturnValue(false),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
  }

  function getLastTrayInstance() {
    return mockTrayInstance;
  }

  it('creates a tray icon', () => {
    const window = makeFakeWindow();
    const tray = createTrayIcon(window as BrowserWindow);
    expect(tray).toBeDefined();
  });

  it('creates the native tray through platform utilities', () => {
    const window = makeFakeWindow();
    createTrayIcon(window as BrowserWindow);

    expect(mockCreateTrayIcon).toHaveBeenCalledTimes(1);
  });

  it('sets tooltip', () => {
    const window = makeFakeWindow();
    createTrayIcon(window as BrowserWindow);
    const tray = getLastTrayInstance()!;
    expect(tray.setToolTip).toHaveBeenCalledWith('GogChat');
  });

  it('registers click handler for open action', () => {
    const window = makeFakeWindow();
    createTrayIcon(window as BrowserWindow);
    const tray = getLastTrayInstance()!;
    expect(tray.on).toHaveBeenCalledWith('click', expect.any(Function));
  });

  it('sets context menu with menu template', () => {
    const window = makeFakeWindow();
    createTrayIcon(window as BrowserWindow);
    const tray = getLastTrayInstance()!;
    expect(Menu.buildFromTemplate).toHaveBeenCalled();
    expect(tray.setContextMenu).toHaveBeenCalled();
  });

  it('Quit saves open windows and then exits', async () => {
    const window = makeFakeWindow();
    createTrayIcon(window as BrowserWindow);

    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0]?.[0] as Array<{
      label?: string;
      click?: () => void | Promise<void>;
    }>;
    const quit = template?.find((item) => item.label === 'Quit');
    quit?.click?.();
    await exitMocks.exitAppAfterSavingWindows.mock.results[0]?.value;
    expect(exitMocks.exitAppAfterSavingWindows).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledOnce();
  });

  it('About menu item invokes registered aboutPanel handler', () => {
    const window = makeFakeWindow();
    createTrayIcon(window as BrowserWindow);

    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0]?.[0] as Array<{
      label?: string;
      click?: () => void;
    }>;
    const about = template?.find((item) => item.label === 'About');
    expect(about).toBeDefined();
    about?.click?.();
    expect(mockAboutHandler).toHaveBeenCalledWith(window);
  });

  it('shows and focuses window on open click', () => {
    const window = makeFakeWindow();
    createTrayIcon(window as BrowserWindow);
    const tray = getLastTrayInstance()!;

    const clickHandler = tray.on.mock.calls.find((c: [string]) => c[0] === 'click')?.[1];
    expect(clickHandler).toBeDefined();

    clickHandler!();
    expect(window.show).toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalled();
  });

  it('restores window if minimized on open click', () => {
    const window = makeFakeWindow();
    vi.mocked(window.isMinimized).mockReturnValue(true);
    createTrayIcon(window as BrowserWindow);
    const tray = getLastTrayInstance()!;

    const clickHandler = tray.on.mock.calls.find((c: [string]) => c[0] === 'click')?.[1];
    clickHandler!();

    expect(window.restore).toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalled();
  });

  it('cleanup destroys tray icon', () => {
    const window = makeFakeWindow();
    createTrayIcon(window as BrowserWindow);
    const tray = getLastTrayInstance()!;

    cleanupTrayIcon();
    expect(tray.destroy).toHaveBeenCalled();
  });
});
