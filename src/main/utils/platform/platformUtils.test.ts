/**
 * Unit tests for PlatformUtils — macOS platform utilities
 *
 * Covers: singleton, tray icon creation, dock badge management,
 * keyboard shortcuts, platform capability checks, and utility functions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Store from 'electron-store';
import type { StoreType } from '../../../shared/types/config.js';

// ========================================================================
// Mock electron first — must come before any imports that use electron
// ========================================================================

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: vi.fn().mockReturnValue('/Applications/GogChat.app/Contents/MacOS'),
    getName: vi.fn().mockReturnValue('GogChat'),
    getVersion: vi.fn().mockReturnValue('1.0.0'),
    getLocale: vi.fn().mockReturnValue('en-US'),
    quit: vi.fn(),
    whenReady: vi.fn().mockResolvedValue(undefined),
    dock: {
      setBadge: vi.fn(),
      getBadge: vi.fn().mockReturnValue(''),
    },
  },
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
  nativeImage: {
    createFromPath: vi.fn().mockReturnValue({
      resize: vi.fn().mockReturnThis(),
      isEmpty: vi.fn().mockReturnValue(false),
    }),
  },
  Tray: vi.fn().mockImplementation(function MockTray() {
    return {
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      setIgnoreDoubleClickEvents: vi.fn(),
      destroy: vi.fn(),
    };
  }),
  BrowserWindow: vi.fn().mockImplementation(() => ({
    id: 1,
    webContents: { send: vi.fn() },
    show: vi.fn(),
    hide: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: vi.fn().mockReturnValue(false),
  })),
  dialog: {
    showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
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

vi.mock('../../../shared/urlValidators.js', () => ({
  validateExternalURL: vi.fn((url: string) => url),
}));

// Mock path join
vi.mock('path', () => ({
  join: vi.fn((...args: string[]) => args.join('/')),
  dirname: vi.fn((p: string) => p.replace(/[/][^/]+$/, '')),
}));

// Mock url
vi.mock('url', () => ({
  fileURLToPath: vi.fn((u: string) => u),
}));

// Mock os
vi.mock('os', () => ({
  default: {
    platform: vi.fn().mockReturnValue('darwin'),
    release: vi.fn().mockReturnValue('23.0.0'),
    arch: vi.fn().mockReturnValue('arm64'),
    totalmem: vi.fn().mockReturnValue(16 * 1024 * 1024 * 1024),
    freemem: vi.fn().mockReturnValue(8 * 1024 * 1024 * 1024),
    hostname: vi.fn().mockReturnValue('test-mac.local'),
  },
}));

// Mock electron-store
vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({
    get: vi.fn(),
    set: vi.fn(),
  })),
}));

// Mock process for getSystemVersion
const mockProcess = {
  platform: 'darwin',
  arch: 'arm64',
  version: 'v24.16.0',
  versions: { electron: '41.0.0', chrome: '130.0.0', node: '24.16.0', v8: '12.8.0' },
  getSystemVersion: vi.fn().mockReturnValue('23.0.0'),
};

vi.stubGlobal('process', mockProcess);

describe('PlatformUtils', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  // ========================================================================
  // Singleton
  // ========================================================================

  describe('Singleton', () => {
    it('getPlatformUtils returns the same instance on repeated calls', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const instance1 = getPlatformUtils();
      const instance2 = getPlatformUtils();
      expect(instance1).toBe(instance2);
    });

    it('getPlatformUtils returns different instances after resetModules', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const instance1 = getPlatformUtils();
      vi.resetModules();
      const { getPlatformUtils: getFresh } = await import('./platformUtils');
      const instance2 = getFresh();
      expect(instance1).not.toBe(instance2);
    });
  });

  // ========================================================================
  // PlatformUtils.getAppIconPath()
  // ========================================================================

  describe('getAppIconPath()', () => {
    it('returns path to mac.icns icon', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();
      const iconPath = pu.getAppIconPath();
      expect(iconPath).toContain('mac.icns');
      expect(iconPath).toContain('resources/icons/normal');
    });
  });

  // ========================================================================
  // PlatformUtils.getTrayIconPath()
  // ========================================================================

  describe('getTrayIconPath()', () => {
    it('returns path to tray template icon', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();
      const trayPath = pu.getTrayIconPath();
      expect(trayPath).toContain('iconTemplate.png');
      expect(trayPath).toContain('resources/icons/tray');
    });
  });

  // ========================================================================
  // PlatformUtils.createTrayIcon()
  // ========================================================================

  describe('createTrayIcon()', () => {
    it('creates tray icon from template image', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();

      const tray = pu.createTrayIcon();

      expect(tray).toBeDefined();
      const { nativeImage } = await import('electron');
      expect(nativeImage.createFromPath).toHaveBeenCalled();
      const iconPath = nativeImage.createFromPath.mock.calls[0][0];
      expect(iconPath).toContain('iconTemplate.png');
    });

    it('resizes icon to 16x16 for macOS tray', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();

      pu.createTrayIcon();

      const { nativeImage } = await import('electron');
      const createdImage = nativeImage.createFromPath.mock.results[0].value;
      expect(createdImage.resize).toHaveBeenCalledWith({ width: 16, height: 16 });
    });

    it('creates Tray with resized icon', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();

      pu.createTrayIcon();

      const { Tray } = await import('electron');
      expect(Tray).toHaveBeenCalled();
    });

    it('ignores double-click events on tray', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();

      pu.createTrayIcon();

      const { Tray } = await import('electron');
      const trayInstance = Tray.mock.results[0].value;
      expect(trayInstance.setIgnoreDoubleClickEvents).toHaveBeenCalledWith(true);
    });
  });

  // ========================================================================
  // PlatformUtils.setBadge()
  // ========================================================================

  describe('setBadge()', () => {
    it('sets dock badge with count when count > 0', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();
      const mockWindow = { id: 1 } as unknown as Electron.BrowserWindow;

      pu.setBadge(mockWindow, 5);

      const { app } = await import('electron');
      expect(app.dock!.setBadge).toHaveBeenCalledWith('5');
    });

    it('sets badge to 99+ when count > 99', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();
      const mockWindow = { id: 1 } as unknown as Electron.BrowserWindow;

      pu.setBadge(mockWindow, 150);

      const { app } = await import('electron');
      expect(app.dock!.setBadge).toHaveBeenCalledWith('99+');
    });

    it('clears badge when count is 0', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();
      const mockWindow = { id: 1 } as unknown as Electron.BrowserWindow;

      pu.setBadge(mockWindow, 0);

      const { app } = await import('electron');
      expect(app.dock!.setBadge).toHaveBeenCalledWith('');
    });

    it('handles large but under-99 numbers correctly', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();
      const mockWindow = { id: 1 } as unknown as Electron.BrowserWindow;

      pu.setBadge(mockWindow, 99);

      const { app } = await import('electron');
      expect(app.dock!.setBadge).toHaveBeenCalledWith('99');
    });

    it('handles count of 1 correctly', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();
      const mockWindow = { id: 1 } as unknown as Electron.BrowserWindow;

      pu.setBadge(mockWindow, 1);

      const { app } = await import('electron');
      expect(app.dock!.setBadge).toHaveBeenCalledWith('1');
    });
  });

  // ========================================================================
  // PlatformUtils.clearBadge()
  // ========================================================================

  describe('clearBadge()', () => {
    it('clears dock badge with empty string', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();
      const mockWindow = { id: 1 } as unknown as Electron.BrowserWindow;

      pu.clearBadge(mockWindow);

      const { app } = await import('electron');
      expect(app.dock!.setBadge).toHaveBeenCalledWith('');
    });
  });

  // ========================================================================
  // PlatformUtils.getShortcuts()
  // ========================================================================

  describe('getShortcuts()', () => {
    it('returns macOS-specific keyboard shortcuts', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();

      const shortcuts = pu.getShortcuts();

      expect(shortcuts.quit).toBe('Cmd+Q');
      expect(shortcuts.preferences).toBe('Cmd+,');
      expect(shortcuts.reload).toBe('Cmd+R');
    });

    it('uses Cmd modifier for all shortcuts (macOS)', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();

      const shortcuts = pu.getShortcuts();
      const shortcutValues = Object.values(shortcuts);

      shortcutValues.forEach((shortcut) => {
        expect(shortcut).toMatch(/^Cmd/);
      });
    });

    it('includes all expected shortcut keys', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();

      const shortcuts = pu.getShortcuts();

      expect(shortcuts).toHaveProperty('quit');
      expect(shortcuts).toHaveProperty('preferences');
      expect(shortcuts).toHaveProperty('reload');
      expect(shortcuts).toHaveProperty('forceReload');
      expect(shortcuts).toHaveProperty('toggleDevTools');
      expect(shortcuts).toHaveProperty('zoomIn');
      expect(shortcuts).toHaveProperty('zoomOut');
      expect(shortcuts).toHaveProperty('zoomReset');
      expect(shortcuts).toHaveProperty('find');
      expect(shortcuts).toHaveProperty('selectAll');
      expect(shortcuts).toHaveProperty('copy');
      expect(shortcuts).toHaveProperty('paste');
      expect(shortcuts).toHaveProperty('cut');
      expect(shortcuts).toHaveProperty('undo');
      expect(shortcuts).toHaveProperty('redo');
    });

    it('has correct zoom shortcuts', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();

      const shortcuts = pu.getShortcuts();

      expect(shortcuts.zoomIn).toBe('Cmd+Plus');
      expect(shortcuts.zoomOut).toBe('Cmd+-');
      expect(shortcuts.zoomReset).toBe('Cmd+0');
    });
  });

  // ========================================================================
  // PlatformUtils.applyWindowOptions()
  // ========================================================================

  describe('applyWindowOptions()', () => {
    it('sets hiddenInset title bar style', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();
      const options = {} as Electron.BrowserWindowConstructorOptions;

      pu.applyWindowOptions(options);

      expect(options.titleBarStyle).toBe('hiddenInset');
    });

    it('sets traffic light position to 16,16', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();
      const options = {} as Electron.BrowserWindowConstructorOptions;

      pu.applyWindowOptions(options);

      expect(options.trafficLightPosition).toEqual({ x: 16, y: 16 });
    });

    it('does not override existing options', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();
      const options = { title: 'Test' } as Electron.BrowserWindowConstructorOptions;

      pu.applyWindowOptions(options);

      expect(options.title).toBe('Test');
      expect(options.titleBarStyle).toBe('hiddenInset');
    });
  });

  // ========================================================================
  // PlatformUtils.isFeatureSupported()
  // ========================================================================

  describe('isFeatureSupported()', () => {
    it('returns true for supported features', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();

      expect(pu.isFeatureSupported('supportsDockBadge')).toBe(true);
      expect(pu.isFeatureSupported('supportsTrayIcon')).toBe(true);
      expect(pu.isFeatureSupported('supportsAutoLaunch')).toBe(true);
      expect(pu.isFeatureSupported('supportsSpellChecker')).toBe(true);
    });

    it('returns false for unsupported features', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();

      expect(pu.isFeatureSupported('supportsOverlayIcon')).toBe(false);
      expect(pu.isFeatureSupported('supportsTaskbarBadge')).toBe(false);
    });
  });

  // ========================================================================
  // PlatformUtils.getPlatformInfo()
  // ========================================================================

  describe('getPlatformInfo()', () => {
    it('returns platform information object', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();

      const info = pu.getPlatformInfo();

      expect(info.platform).toBe('darwin');
      expect(info.arch).toBeDefined();
      expect(info.locale).toBe('en-US');
      expect(info.appVersion).toBe('1.0.0');
    });

    it('includes MACOS_CONFIG properties', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();

      const info = pu.getPlatformInfo();

      expect(info).toHaveProperty('supportsOverlayIcon', false);
      expect(info).toHaveProperty('supportsDockBadge', true);
      expect(info).toHaveProperty('supportsTrayIcon', true);
      expect(info).toHaveProperty('defaultIconFormat', 'icns');
      expect(info).toHaveProperty('trayIconSize');
    });

    it('includes version information', async () => {
      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();

      const info = pu.getPlatformInfo();

      expect(info).toHaveProperty('nodeVersion');
      expect(info).toHaveProperty('electronVersion');
      expect(info).toHaveProperty('chromeVersion');
      expect(info).toHaveProperty('v8Version');
    });
  });

  // ========================================================================
  // Standalone: platform export
  // ========================================================================

  describe('platform export', () => {
    it('isMac is true for macOS', async () => {
      const { platform } = await import('./platformDetection');
      expect(platform.isMac).toBe(true);
    });

    it('name is darwin', async () => {
      const { platform } = await import('./platformDetection');
      expect(platform.name).toBe('darwin');
    });

    it('config contains MACOS_CONFIG', async () => {
      const { platform } = await import('./platformDetection');
      expect(platform.config.supportsDockBadge).toBe(true);
      expect(platform.config.supportsTrayIcon).toBe(true);
      expect(platform.config.defaultIconFormat).toBe('icns');
    });
  });

  // ========================================================================
  // Standalone: supports export
  // ========================================================================

  describe('supports export', () => {
    it('dockBadge returns true', async () => {
      const { supports } = await import('./platformDetection');
      expect(supports.dockBadge()).toBe(true);
    });

    it('trayIcon returns true', async () => {
      const { supports } = await import('./platformDetection');
      expect(supports.trayIcon()).toBe(true);
    });

    it('autoLaunch returns true', async () => {
      const { supports } = await import('./platformDetection');
      expect(supports.autoLaunch()).toBe(true);
    });

    it('spellChecker returns true', async () => {
      const { supports } = await import('./platformDetection');
      expect(supports.spellChecker()).toBe(true);
    });

    it('overlayIcon returns false', async () => {
      const { supports } = await import('./platformDetection');
      expect(supports.overlayIcon()).toBe(false);
    });

    it('taskbarBadge returns false', async () => {
      const { supports } = await import('./platformDetection');
      expect(supports.taskbarBadge()).toBe(false);
    });
  });

  // ========================================================================
  // Standalone: getAppPath()
  // ========================================================================

  describe('getAppPath()', () => {
    it('returns app.getAppPath() result', async () => {
      const { getAppPath } = await import('./platformHelpers');
      const result = getAppPath();
      expect(result).toBe('/Applications/GogChat.app/Contents/MacOS');
    });
  });

  // ========================================================================
  // Standalone: isPackaged()
  // ========================================================================

  describe('isPackaged()', () => {
    it('returns app.isPackaged value', async () => {
      const { isPackaged } = await import('./platformHelpers');
      expect(isPackaged()).toBe(false);
    });
  });

  // ========================================================================
  // Standalone: isDevelopment()
  // ========================================================================

  describe('isDevelopment()', () => {
    it('returns true when not packaged', async () => {
      const { isDevelopment } = await import('./platformHelpers');
      expect(isDevelopment()).toBe(true);
    });

    it('returns false when packaged', async () => {
      const { app } = await import('electron');
      Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
      const { isDevelopment } = await import('./platformHelpers');
      expect(isDevelopment()).toBe(false);
      Object.defineProperty(app, 'isPackaged', { value: false, configurable: true });
    });
  });

  // ========================================================================
  // Standalone: debugInfo()
  // ========================================================================

  describe('debugInfo()', () => {
    it('returns string containing app info', async () => {
      const { debugInfo } = await import('./platformHelpers');
      const info = debugInfo();

      expect(info).toContain('GogChat');
      expect(info).toContain('1.0.0');
    });

    it('returns string containing Electron/Chrome/Node versions', async () => {
      const { debugInfo } = await import('./platformHelpers');
      const info = debugInfo();

      expect(info).toContain('Electron:');
      expect(info).toContain('Chrome:');
      expect(info).toContain('Node:');
      expect(info).toContain('V8:');
    });

    it('returns string containing memory info', async () => {
      const { debugInfo } = await import('./platformHelpers');
      const info = debugInfo();

      expect(info).toContain('Memory:');
      expect(info).toContain('GB free');
      expect(info).toContain('GB total');
    });

    it('returns string containing platform info', async () => {
      const { debugInfo } = await import('./platformHelpers');
      const info = debugInfo();

      expect(info).toContain('Platform:');
      expect(info).toContain('Arch:');
    });

    it('returns string containing locale', async () => {
      const { debugInfo } = await import('./platformHelpers');
      const info = debugInfo();

      expect(info).toContain('Locale:');
    });
  });

  // ========================================================================
  // Standalone: enforceMacOSAppLocation()
  // ========================================================================

  describe('enforceMacOSAppLocation()', () => {
    it('returns early when not packaged', async () => {
      const { app } = await import('electron');
      Object.defineProperty(app, 'isPackaged', { value: false, configurable: true });
      const { enforceMacOSAppLocation } = await import('./platformHelpers');

      enforceMacOSAppLocation();

      expect(app.quit).not.toHaveBeenCalled();
    });

    it('returns early when app is in /Applications', async () => {
      const { app } = await import('electron');
      Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
      (app.getAppPath as ReturnType<typeof vi.fn>).mockReturnValue(
        '/Applications/GogChat.app/Contents/MacOS'
      );
      const { enforceMacOSAppLocation } = await import('./platformHelpers');

      enforceMacOSAppLocation();

      expect(app.quit).not.toHaveBeenCalled();
    });

    it('quits app when not in /Applications (packaged)', async () => {
      const { app } = await import('electron');
      Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
      (app.getAppPath as ReturnType<typeof vi.fn>).mockReturnValue(
        '/Users/kenny/Development/GogChat'
      );
      const { enforceMacOSAppLocation } = await import('./platformHelpers');

      enforceMacOSAppLocation();

      // Async dialog import, but quit should be called synchronously
      expect(app.quit).toHaveBeenCalled();
    });
  });

  // ========================================================================
  // Standalone: openNewGitHubIssue()
  // ========================================================================

  describe('openNewGitHubIssue()', () => {
    it('opens external URL with issue params', async () => {
      const { openNewGitHubIssue } = await import('./platformHelpers');

      openNewGitHubIssue({
        repoUrl: 'https://github.com/iworkforces/GogChat',
        title: 'Test Issue',
        body: 'Issue description',
        labels: ['bug'],
      });

      const { shell } = await import('electron');
      expect(shell.openExternal).toHaveBeenCalled();
    });

    it('handles missing optional params', async () => {
      const { openNewGitHubIssue } = await import('./platformHelpers');

      openNewGitHubIssue({
        repoUrl: 'https://github.com/iworkforces/GogChat',
      });

      const { shell } = await import('electron');
      expect(shell.openExternal).toHaveBeenCalled();
    });
  });

  // ========================================================================
  // Standalone: isFirstAppLaunch()
  // ========================================================================

  describe('isFirstAppLaunch()', () => {
    it('returns true when store key is not set', async () => {
      const { isFirstAppLaunch } = await import('./platformHelpers');
      const mockStore = {
        get: vi.fn().mockReturnValue(undefined),
        set: vi.fn(),
      } as unknown as Store<StoreType>;

      const result = isFirstAppLaunch(mockStore);

      expect(result).toBe(true);
      expect(mockStore.set).toHaveBeenCalledWith('firstLaunchComplete', true);
    });

    it('returns false when store key is already set', async () => {
      const { isFirstAppLaunch } = await import('./platformHelpers');
      const mockStore = {
        get: vi.fn().mockReturnValue(true),
        set: vi.fn(),
      } as unknown as Store<StoreType>;

      const result = isFirstAppLaunch(mockStore);

      expect(result).toBe(false);
      expect(mockStore.set).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // setBadge() error path
  // ========================================================================

  describe('setBadge() error path', () => {
    it('catches error when dock.setBadge throws', async () => {
      const { app } = await import('electron');
      (app.dock!.setBadge as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Dock unavailable');
      });

      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();
      const mockWindow = { id: 1 } as unknown as Electron.BrowserWindow;

      // Should not throw
      expect(() => pu.setBadge(mockWindow, 5)).not.toThrow();

      // Restore
      (app.dock!.setBadge as ReturnType<typeof vi.fn>).mockImplementation(vi.fn());
    });
  });

  // ========================================================================
  // clearBadge() error path
  // ========================================================================

  describe('clearBadge() error path', () => {
    it('catches error when dock.setBadge throws during clear', async () => {
      const { app } = await import('electron');
      (app.dock!.setBadge as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Dock unavailable');
      });

      const { getPlatformUtils } = await import('./platformUtils');
      const pu = getPlatformUtils();
      const mockWindow = { id: 1 } as unknown as Electron.BrowserWindow;

      // Should not throw
      expect(() => pu.clearBadge(mockWindow)).not.toThrow();

      // Restore
      (app.dock!.setBadge as ReturnType<typeof vi.fn>).mockImplementation(vi.fn());
    });
  });

  // ========================================================================
  // openNewGitHubIssue() — URL validation error path
  // ========================================================================

  describe('openNewGitHubIssue() error path', () => {
    it('logs error when validateExternalURL throws', async () => {
      const { validateExternalURL } = await import('../../../shared/urlValidators.js');
      (validateExternalURL as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Invalid URL');
      });

      const { openNewGitHubIssue } = await import('./platformHelpers');
      const { shell } = await import('electron');

      // Should not throw — error is caught internally
      expect(() =>
        openNewGitHubIssue({
          repoUrl: 'https://github.com/iworkforces/GogChat',
          title: 'Test',
        })
      ).not.toThrow();

      expect(shell.openExternal).not.toHaveBeenCalled();

      // Restore
      (validateExternalURL as ReturnType<typeof vi.fn>).mockImplementation((url: string) => url);
    });
  });

  // ========================================================================
  // openNewGitHubIssue() — URL construction
  // ========================================================================

  describe('openNewGitHubIssue() URL construction', () => {
    it('constructs URL with all parameters', async () => {
      const { openNewGitHubIssue } = await import('./platformHelpers');
      const { shell } = await import('electron');
      const { validateExternalURL } = await import('../../../shared/urlValidators.js');
      (validateExternalURL as ReturnType<typeof vi.fn>).mockImplementation((url: string) => url);
      (shell.openExternal as ReturnType<typeof vi.fn>).mockClear();

      openNewGitHubIssue({
        repoUrl: 'https://github.com/iworkforces/GogChat',
        title: 'Bug Report',
        body: 'Steps to reproduce',
        labels: ['bug', 'critical'],
      });

      const calls = (validateExternalURL as ReturnType<typeof vi.fn>).mock.calls;
      const calledUrl = calls[calls.length - 1]?.[0] as string;
      expect(calledUrl).toContain('/issues/new?');
      expect(calledUrl).toContain('title=Bug+Report');
      expect(calledUrl).toContain('body=Steps+to+reproduce');
      expect(calledUrl).toContain('labels=bug%2Ccritical');
    });

    it('constructs URL with no optional parameters', async () => {
      const { openNewGitHubIssue } = await import('./platformHelpers');
      const { validateExternalURL } = await import('../../../shared/urlValidators.js');
      (validateExternalURL as ReturnType<typeof vi.fn>).mockImplementation((url: string) => url);

      openNewGitHubIssue({
        repoUrl: 'https://github.com/iworkforces/GogChat',
      });

      const calls = (validateExternalURL as ReturnType<typeof vi.fn>).mock.calls;
      const calledUrl = calls[calls.length - 1]?.[0] as string;
      expect(calledUrl).toContain('/issues/new?');
      // No title/body/labels params
      expect(calledUrl).not.toContain('title=');
      expect(calledUrl).not.toContain('body=');
      expect(calledUrl).not.toContain('labels=');
    });

    it('constructs URL with empty labels array', async () => {
      const { openNewGitHubIssue } = await import('./platformHelpers');
      const { validateExternalURL } = await import('../../../shared/urlValidators.js');
      (validateExternalURL as ReturnType<typeof vi.fn>).mockImplementation((url: string) => url);

      openNewGitHubIssue({
        repoUrl: 'https://github.com/iworkforces/GogChat',
        labels: [],
      });

      const calls = (validateExternalURL as ReturnType<typeof vi.fn>).mock.calls;
      const calledUrl = calls[calls.length - 1]?.[0] as string;
      expect(calledUrl).not.toContain('labels=');
    });
  });

  // ========================================================================
  // debugInfo() — detailed field checks
  // ========================================================================

  describe('debugInfo() detailed', () => {
    it('returns all expected info lines', async () => {
      const { debugInfo } = await import('./platformHelpers');
      const info = debugInfo();
      const lines = info.split('\n');

      // Should have at least 8 lines (app, electron, chrome, node, v8, platform, arch, locale, memory)
      expect(lines.length).toBeGreaterThanOrEqual(8);
    });

    it('includes correct app name and version', async () => {
      const { debugInfo } = await import('./platformHelpers');
      const info = debugInfo();

      expect(info).toContain('App: GogChat 1.0.0');
    });

    it('includes memory info with correct format', async () => {
      const { debugInfo } = await import('./platformHelpers');
      const info = debugInfo();

      // 8GB free / 16GB total based on mock
      expect(info).toContain('8.00GB free');
      expect(info).toContain('16.00GB total');
    });
  });
});
