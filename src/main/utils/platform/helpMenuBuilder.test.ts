/**
 * Unit tests for helpMenuBuilder.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';

vi.mock('electron', () => ({
  app: {
    relaunch: vi.fn(),
    exit: vi.fn(),
    setBadgeCount: vi.fn(),
    getVersion: vi.fn().mockReturnValue('1.0.0'),
    getPath: vi.fn().mockReturnValue('/mock/logs'),
  },
  shell: {
    showItemInFolder: vi.fn(),
  },
  dialog: {
    showMessageBox: vi.fn().mockResolvedValue({ response: 1 }),
  },
}));

vi.mock('electron-log', () => ({
  default: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { mockAboutHandler, mockToggleGuardHandler, mockCheckUpdatesHandler } = vi.hoisted(() => ({
  mockAboutHandler: vi.fn(),
  mockToggleGuardHandler: vi.fn(),
  mockCheckUpdatesHandler: vi.fn(),
}));

vi.mock('../../features/menuActionRegistry.js', () => ({
  getMenuAction: vi.fn((id: string) => {
    if (id === 'aboutPanel') return { label: 'Show About Panel', handler: mockAboutHandler };
    if (id === 'checkForUpdates')
      return { label: 'Check For Updates', handler: mockCheckUpdatesHandler };
    if (id === 'toggleExternalLinksGuard')
      return { label: 'Toggle Guard', handler: mockToggleGuardHandler };
    return undefined;
  }),
}));

vi.mock('../../config.js', () => ({
  default: {
    get: vi.fn(),
    set: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock('../../../environment.js', () => ({
  default: {
    isDev: false,
  },
}));

vi.mock('./platformHelpers.js', () => ({
  openNewGitHubIssue: vi.fn(),
  debugInfo: vi.fn().mockReturnValue('platform: darwin'),
  getPackageInfo: vi.fn().mockReturnValue({
    productName: 'GogChat',
    version: '1.0.0',
    author: 'Test Author',
    repository: 'https://github.com/test/repo',
  }),
}));

vi.mock('./packageInfo.js', () => ({
  getPackageInfo: vi.fn().mockReturnValue({
    productName: 'GogChat',
    version: '1.0.0',
    author: 'Test Author',
    repository: 'https://github.com/test/repo',
  }),
}));

vi.mock('../account/exitAfterAccountWindows.js', () => ({
  persistAccountWindowsBeforeExit: vi.fn(async () => undefined),
  exitAppAfterSavingWindows: vi.fn(async () => undefined),
}));

import { buildHelpSubMenu, relaunchApp, resetAppAndRestart } from './helpMenuBuilder';
import { persistAccountWindowsBeforeExit } from '../account/exitAfterAccountWindows.js';
import { app, dialog, shell } from 'electron';
import store from '../../config';
import { openNewGitHubIssue } from './platformHelpers';
import { getMenuAction } from '../../features/menuActionRegistry.js';
import environment from '../../../environment.js';
import path from 'path';

interface FakeWindow {
  webContents: {
    session: {
      clearStorageData: ReturnType<typeof vi.fn>;
      clearCache: ReturnType<typeof vi.fn>;
    };
  };
}

function makeFakeWindow(): FakeWindow {
  return {
    webContents: {
      session: {
        clearStorageData: vi.fn().mockResolvedValue(undefined),
        clearCache: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
}

describe('helpMenuBuilder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('relaunchApp', () => {
    it('relaunches without --hidden flag and exits', async () => {
      const order: string[] = [];
      vi.mocked(persistAccountWindowsBeforeExit).mockImplementationOnce(async () => {
        order.push('persist');
      });
      vi.mocked(app.relaunch).mockImplementationOnce(() => {
        order.push('relaunch');
      });
      vi.mocked(app.exit).mockImplementationOnce(() => {
        order.push('exit');
      });
      const originalArgv = process.argv;
      process.argv = ['node', 'app.js', '--hidden', '--other-flag'];

      await relaunchApp();

      expect(order).toEqual(['persist', 'relaunch', 'exit']);
      expect(app.relaunch).toHaveBeenCalledWith({
        args: ['node', 'app.js', '--other-flag'],
      });
      expect(app.exit).toHaveBeenCalled();

      process.argv = originalArgv;
    });
  });

  describe('resetAppAndRestart', () => {
    it('clears store, storage, cache, then relaunches', async () => {
      const window = makeFakeWindow();
      await resetAppAndRestart(window as unknown as BrowserWindow);

      expect(store.clear).toHaveBeenCalled();
      expect(window.webContents.session.clearStorageData).toHaveBeenCalled();
      expect(window.webContents.session.clearCache).toHaveBeenCalled();
      expect(app.relaunch).toHaveBeenCalled();
      expect(app.exit).toHaveBeenCalled();
    });
  });

  describe('buildHelpSubMenu', () => {
    it('returns Help menu with expected structure', () => {
      const window = makeFakeWindow();
      const menu = buildHelpSubMenu(window as unknown as BrowserWindow);

      expect(menu.label).toBe('Help');
      expect(Array.isArray(menu.submenu)).toBe(true);
    });

    it('Check For Updates triggers registered checkForUpdates handler', () => {
      const window = makeFakeWindow();
      const menu = buildHelpSubMenu(window as unknown as BrowserWindow);
      const items = menu.submenu as MenuItemConstructorOptions[];
      const checkUpdates = items.find((i) => i.label === 'Check For Updates');

      checkUpdates?.click?.({} as never, undefined as never, {} as never);
      expect(mockCheckUpdatesHandler).toHaveBeenCalled();
    });

    it('Report issue triggers openNewGitHubIssue with repo URL', () => {
      const window = makeFakeWindow();
      const menu = buildHelpSubMenu(window as unknown as BrowserWindow);
      const items = menu.submenu as MenuItemConstructorOptions[];
      const troubleshooting = items.find((i) => i.label === 'Troubleshooting');
      const sub = troubleshooting?.submenu as MenuItemConstructorOptions[];
      const reportIssue = sub.find((i) => i.label === 'Report issue...');

      reportIssue?.click?.({} as never, undefined as never, {} as never);
      expect(openNewGitHubIssue).toHaveBeenCalledWith(
        expect.objectContaining({ repoUrl: 'https://github.com/test/repo' })
      );
    });

    it('Toggle External Links Guard invokes registered handler with window', () => {
      const window = makeFakeWindow();
      const menu = buildHelpSubMenu(window as unknown as BrowserWindow);
      const items = menu.submenu as MenuItemConstructorOptions[];
      const troubleshooting = items.find((i) => i.label === 'Troubleshooting');
      const sub = troubleshooting?.submenu as MenuItemConstructorOptions[];
      const toggle = sub.find((i) => i.label === 'Toggle External Links Guard');

      toggle?.click?.({} as never, undefined as never, {} as never);
      expect(mockToggleGuardHandler).toHaveBeenCalledWith(window);
    });

    it('Demo Badge Count sets a random badge count', () => {
      const window = makeFakeWindow();
      const menu = buildHelpSubMenu(window as unknown as BrowserWindow);
      const items = menu.submenu as MenuItemConstructorOptions[];
      const troubleshooting = items.find((i) => i.label === 'Troubleshooting');
      const sub = troubleshooting?.submenu as MenuItemConstructorOptions[];
      const demo = sub.find((i) => i.label === 'Demo Badge Count');

      demo?.click?.({} as never, undefined as never, {} as never);
      expect(app.setBadgeCount).toHaveBeenCalled();
    });

    it('Show Logs in File Manager opens logs path', () => {
      const window = makeFakeWindow();
      const menu = buildHelpSubMenu(window as unknown as BrowserWindow);
      const items = menu.submenu as MenuItemConstructorOptions[];
      const troubleshooting = items.find((i) => i.label === 'Troubleshooting');
      const sub = troubleshooting?.submenu as MenuItemConstructorOptions[];
      const showLogs = sub.find((i) => i.label === 'Show Logs in File Manager');

      showLogs?.click?.({} as never, undefined as never, {} as never);
      expect(shell.showItemInFolder).toHaveBeenCalled();
    });

    it('About invokes registered aboutPanel handler with window', () => {
      const window = makeFakeWindow();
      const menu = buildHelpSubMenu(window as unknown as BrowserWindow);
      const items = menu.submenu as MenuItemConstructorOptions[];
      const about = items.find((i) => i.label === 'About');

      about?.click?.({} as never, undefined as never, {} as never);
      expect(mockAboutHandler).toHaveBeenCalledWith(window);
    });

    it('Version item is disabled and shows version string', () => {
      const window = makeFakeWindow();
      const menu = buildHelpSubMenu(window as unknown as BrowserWindow);
      const items = menu.submenu as MenuItemConstructorOptions[];
      const version = items.find((i) => typeof i.label === 'string' && i.label.includes('Version'));

      expect(version).toBeDefined();
      expect(version?.enabled).toBe(false);
      expect(version?.label).toContain('1.0.0');
    });

    it('appends a dev suffix when running in development', () => {
      const env = environment as { isDev: boolean };
      const previous = env.isDev;
      env.isDev = true;
      const menu = buildHelpSubMenu(makeFakeWindow() as unknown as BrowserWindow);
      const items = menu.submenu as MenuItemConstructorOptions[];
      const version = items.find((i) => typeof i.label === 'string' && i.label.includes('Version'));
      expect(version?.label).toBe('Version 1.0.0-(dev)');
      env.isDev = previous;
    });

    it('skips unregistered Help actions without throwing', () => {
      vi.mocked(getMenuAction)
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(undefined);
      const window = makeFakeWindow();
      const menu = buildHelpSubMenu(window as unknown as BrowserWindow);
      const items = menu.submenu as MenuItemConstructorOptions[];
      const troubleshooting = items.find((i) => i.label === 'Troubleshooting');
      const sub = troubleshooting?.submenu as MenuItemConstructorOptions[];

      expect(() => {
        items
          .find((i) => i.label === 'Check For Updates')
          ?.click?.({} as never, undefined as never, {} as never);
        sub
          .find((i) => i.label === 'Toggle External Links Guard')
          ?.click?.({} as never, undefined as never, {} as never);
        items
          .find((i) => i.label === 'About')
          ?.click?.({} as never, undefined as never, {} as never);
      }).not.toThrow();
      expect(mockCheckUpdatesHandler).not.toHaveBeenCalled();
      expect(mockToggleGuardHandler).not.toHaveBeenCalled();
      expect(mockAboutHandler).not.toHaveBeenCalled();
    });

    it('Show Logs uses userData/logs off darwin', () => {
      const original = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const menu = buildHelpSubMenu(makeFakeWindow() as unknown as BrowserWindow);
      const items = menu.submenu as MenuItemConstructorOptions[];
      const troubleshooting = items.find((i) => i.label === 'Troubleshooting');
      const sub = troubleshooting?.submenu as MenuItemConstructorOptions[];
      sub
        .find((i) => i.label === 'Show Logs in File Manager')
        ?.click?.({} as never, undefined as never, {} as never);
      expect(shell.showItemInFolder).toHaveBeenCalledWith(path.join('/mock/logs', 'logs'));
      Object.defineProperty(process, 'platform', { value: original });
    });

    it('Reset and Relaunch only clears data when the user confirms', async () => {
      const window = makeFakeWindow();
      const menu = buildHelpSubMenu(window as unknown as BrowserWindow);
      const items = menu.submenu as MenuItemConstructorOptions[];
      const troubleshooting = items.find((i) => i.label === 'Troubleshooting');
      const sub = troubleshooting?.submenu as MenuItemConstructorOptions[];
      const reset = sub.find((i) => i.label === 'Reset and Relaunch App');

      vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({
        response: 1,
      } as Electron.MessageBoxReturnValue);
      reset?.click?.({} as never, undefined as never, {} as never);
      await Promise.resolve();
      expect(store.clear).not.toHaveBeenCalled();

      vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({
        response: 0,
      } as Electron.MessageBoxReturnValue);
      reset?.click?.({} as never, undefined as never, {} as never);
      await vi.waitFor(() => {
        expect(store.clear).toHaveBeenCalled();
        expect(app.relaunch).toHaveBeenCalled();
      });
    });
  });
});
