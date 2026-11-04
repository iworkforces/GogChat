/**
 * Unit tests for appMenu feature.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: vi.fn().mockReturnValue({ getMenuItemById: vi.fn().mockReturnValue(null) }),
    setApplicationMenu: vi.fn(),
  },
  app: {
    relaunch: vi.fn(),
    exit: vi.fn(),
    setBadgeCount: vi.fn(),
    getVersion: vi.fn().mockReturnValue('1.0.0'),
    getPath: vi.fn().mockReturnValue('/mock/logs'),
    showAboutPanel: vi.fn(),
  },
  shell: {
    showItemInFolder: vi.fn(),
  },
  clipboard: {
    writeText: vi.fn(),
  },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null) },
  dialog: {
    showMessageBox: vi.fn().mockResolvedValue({ response: 1 }),
  },
}));

vi.mock('electron-log', () => ({
  default: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/account/exitAfterAccountWindows.js', () => ({
  exitAppAfterSavingWindows: vi.fn(async () => {
    const { app } = await import('electron');
    app.exit();
  }),
  persistAccountWindowsBeforeExit: vi.fn(async () => undefined),
}));

const {
  mockAboutHandler,
  mockAutoLaunchInstance,
  mockAutoLaunchSupport,
  mockToggleGuardHandler,
  mockSnoozeHandler,
  mockResumeHandler,
  mockCheckForUpdatesHandler,
  mockConfigSet,
  registeredActions,
  configValues,
  mockAccountIndex,
  mockIsBootstrap,
  mockForgetAccount,
  retained,
  cleanupTasks,
} = vi.hoisted(() => ({
  mockAboutHandler: vi.fn(),
  mockAutoLaunchInstance: {
    enable: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
  },
  mockAutoLaunchSupport: vi.fn(() => true),
  mockToggleGuardHandler: vi.fn(),
  mockSnoozeHandler: vi.fn(() => true),
  mockResumeHandler: vi.fn(() => true),
  mockCheckForUpdatesHandler: vi.fn(),
  mockConfigSet: vi.fn(),
  mockAccountIndex: vi.fn(() => 0 as number | null),
  mockIsBootstrap: vi.fn((_index: number) => false),
  mockForgetAccount: vi.fn(async (_index: number) => {}),
  retained: { indices: [0, 2, 7] },
  cleanupTasks: new Map<string, () => void>(),
  registeredActions: {} as Record<string, { label: string; handler: () => void }>,
  configValues: {
    'app.autoCheckForUpdates': true,
    'app.autoLaunchAtLogin': false,
    'app.startHidden': false,
    'app.hideMenuBar': false,
    'app.disableSpellChecker': false,
    'app.unreadDeltaNotifications': false,
  } as Record<string, unknown>,
}));

vi.mock('./menuActionRegistry', () => ({
  registerMenuAction: vi.fn((id: string, action: { label: string; handler: () => void }) => {
    registeredActions[id] = action;
  }),
  getMenuAction: vi.fn((id: string) => {
    if (id === 'aboutPanel') return { label: 'Show About Panel', handler: mockAboutHandler };
    if (id === 'autoLaunch')
      return { label: 'Get AutoLaunch', handler: () => mockAutoLaunchInstance };
    if (id === 'toggleExternalLinksGuard')
      return { label: 'Toggle Guard', handler: mockToggleGuardHandler };
    if (id === 'snoozeUpdatePrompts') return { label: 'Snooze', handler: mockSnoozeHandler };
    if (id === 'resumeUpdatePrompts') return { label: 'Resume', handler: mockResumeHandler };
    if (id === 'checkForUpdates')
      return { label: 'Check For Updates', handler: mockCheckForUpdatesHandler };
    return undefined;
  }),
}));

vi.mock('../config', () => ({
  default: {
    get: vi.fn((key: string) => configValues[key]),
    set: vi.fn(),
    clear: vi.fn(),
  },
  configGet: vi.fn((key: string) => configValues[key]),
  configSet: mockConfigSet,
}));

vi.mock('../../environment', () => ({
  default: {
    isDev: false,
    appUrl: 'https://chat.google.com',
    logoutUrl: 'https://accounts.google.com/logout',
  },
}));

vi.mock('../../shared/constants', () => ({
  IPC_CHANNELS: { SEARCH_SHORTCUT: 'searchShortcut' },
}));

vi.mock('../utils/platform/platformHelpers', () => ({
  openNewGitHubIssue: vi.fn(),
  debugInfo: vi.fn().mockReturnValue('platform: darwin'),
  getPackageInfo: vi.fn().mockReturnValue({
    productName: 'GogChat',
    version: '1.0.0',
    author: 'Test Author',
    repository: 'https://github.com/test/repo',
  }),
}));

vi.mock('../utils/platform/packageInfo', () => ({
  getPackageInfo: vi.fn().mockReturnValue({
    productName: 'GogChat',
    version: '1.0.0',
    author: 'Test Author',
    repository: 'https://github.com/test/repo',
  }),
}));

vi.mock('../utils/platform/platformDetection', () => ({
  supports: {
    autoLaunch: mockAutoLaunchSupport,
  },
}));

vi.mock('../utils/security/notificationAccess', () => ({
  showNotificationSettingsDialog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/account/accountWindowManager.js', () => ({
  getAccountWindowManager: vi.fn(() => ({
    getAccountCount: vi.fn(() => 2),
    getAccountIndex: mockAccountIndex,
    isBootstrap: mockIsBootstrap,
    forgetAccount: mockForgetAccount,
    getAccountWebContents: vi.fn(() => ({
      isDestroyed: () => false,
      goBack: vi.fn(),
      goForward: vi.fn(),
      send: vi.fn(),
      getURL: () => 'https://chat.google.com/u/0/',
    })),
  })),
}));

vi.mock('../utils/account/retainedAccounts.js', () => ({
  listRetainedAccountIndices: () => retained.indices,
}));

vi.mock('../utils/lifecycle/resourceCleanup.js', () => ({
  registerCleanupTask: (name: string, cleanup: () => void) => cleanupTasks.set(name, cleanup),
}));

vi.mock('../utils/account/accountNavigation.js', () => ({
  loadAccountURL: vi.fn().mockReturnValue(true),
  getAccountURL: vi.fn().mockReturnValue('https://chat.google.com/u/0/'),
  sendToAccount: vi.fn().mockReturnValue(true),
}));

vi.mock('../utils/platform/accountLabelStore.js', () => ({
  getAllStoredAccountLabels: vi.fn(() => ({ '0': 'Work' })),
  getStoredAccountLabel: vi.fn((idx: number) => (idx === 0 ? 'Work' : undefined)),
  setStoredAccountLabel: vi.fn(),
  clearStoredAccountLabels: vi.fn(),
}));

vi.mock('../utils/platform/accountLabelDialog.js', () => ({
  promptAccountLabel: vi.fn().mockResolvedValue(null),
}));

vi.mock('../utils/platform/accountNotificationIdentity.js', () => ({
  formatAccountNotificationLabel: vi.fn((idx: number | null) =>
    idx === 0 ? 'Work' : idx === null ? 'GogChat' : `Account ${(idx as number) + 1}`
  ),
}));

import appMenu from './appMenu';
import {
  exitAppAfterSavingWindows,
  persistAccountWindowsBeforeExit,
} from '../utils/account/exitAfterAccountWindows.js';
import { _getMenuAction } from './menuActionRegistry';
import { Menu, app, dialog, clipboard, BrowserWindow as ElectronBrowserWindow } from 'electron';
import log from 'electron-log';
import store from '../config';
import { IPC_CHANNELS } from '../../shared/constants';
import { openNewGitHubIssue } from '../utils/platform/platformHelpers';
import { showNotificationSettingsDialog } from '../utils/security/notificationAccess';
import { asAccountIndex } from '../../shared/types/branded.js';
import { asType } from '../../shared/typeUtils.js';
import {
  clearAllBootstrap,
  clearBootstrap,
  isBootstrap,
  markAsBootstrap,
  promoteBootstrap,
} from '../utils/account/bootstrapTracker.js';
import {
  clearAccountWebContentsHooksForTests,
  notifyAccountWebContentsCreated,
} from '../utils/account/accountWebContentsHooks.js';

interface FakeWindow {
  isDestroyed: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  webContents: {
    send: ReturnType<typeof vi.fn>;
    getURL: ReturnType<typeof vi.fn>;
    goBack: ReturnType<typeof vi.fn>;
    goForward: ReturnType<typeof vi.fn>;
    session: {
      clearStorageData: ReturnType<typeof vi.fn>;
      clearCache: ReturnType<typeof vi.fn>;
      setSpellCheckerEnabled: ReturnType<typeof vi.fn>;
    };
  };
  setMenuBarVisibility: ReturnType<typeof vi.fn>;
  setAutoHideMenuBar: ReturnType<typeof vi.fn>;
}

function makeFakeWindow(): FakeWindow {
  return {
    isDestroyed: vi.fn().mockReturnValue(false),
    hide: vi.fn(),
    loadURL: vi.fn().mockResolvedValue(undefined),
    webContents: {
      send: vi.fn(),
      getURL: vi.fn().mockReturnValue('https://chat.google.com'),
      goBack: vi.fn(),
      goForward: vi.fn(),
      session: {
        clearStorageData: vi.fn().mockResolvedValue(undefined),
        clearCache: vi.fn().mockResolvedValue(undefined),
        setSpellCheckerEnabled: vi.fn(),
      },
    },
    setMenuBarVisibility: vi.fn(),
    setAutoHideMenuBar: vi.fn(),
  };
}

describe('appMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAutoLaunchSupport.mockReturnValue(true);
    mockSnoozeHandler.mockReturnValue(true);
    mockResumeHandler.mockReturnValue(true);
    mockConfigSet.mockReset();
    mockAccountIndex.mockReset().mockReturnValue(0);
    mockIsBootstrap.mockReset().mockReturnValue(false);
    mockForgetAccount.mockReset().mockResolvedValue(undefined);
    retained.indices = [0, 2, 7];
    configValues['app.accountNotificationMuteUntil'] = {};
    vi.mocked(dialog.showMessageBox)
      .mockReset()
      .mockResolvedValue({ response: 0, checkboxChecked: false });
    delete configValues['app.updateSnoozedUntil'];
    delete configValues['app.sessionMaintenanceMode'];
    clearAllBootstrap();
    clearAccountWebContentsHooksForTests();
  });

  afterEach(() => {
    for (const cleanup of cleanupTasks.values()) cleanup();
    cleanupTasks.clear();
  });

  it('builds and sets the application menu', () => {
    const window = makeFakeWindow();
    appMenu(window as BrowserWindow);
    expect(Menu.buildFromTemplate).toHaveBeenCalled();
    expect(Menu.setApplicationMenu).toHaveBeenCalled();
  });

  it('includes File menu with Hide Window action', () => {
    const window = makeFakeWindow();
    appMenu(window as BrowserWindow);

    const template = Menu.buildFromTemplate.mock.calls[0][0] as MenuItemConstructorOptions[];
    const fileMenu = template.find((item: MenuItemConstructorOptions) => item.label === 'File');
    expect(fileMenu).toBeDefined();

    const hideWindow = fileMenu.submenu.find(
      (item: MenuItemConstructorOptions) => item.label === 'Hide Window'
    );
    expect(hideWindow).toBeDefined();
    expect(hideWindow.accelerator).toBe('CommandOrControl+W');

    hideWindow.click();
    expect(window.hide).toHaveBeenCalled();
  });

  it('keeps Quit and About and does not label any item as a tray', () => {
    const window = makeFakeWindow();
    appMenu(window as BrowserWindow);

    const template = Menu.buildFromTemplate.mock.calls[0][0] as MenuItemConstructorOptions[];
    const labels: string[] = [];
    const visit = (items: readonly MenuItemConstructorOptions[]): void => {
      for (const item of items) {
        if (typeof item.label === 'string') labels.push(item.label);
        if (Array.isArray(item.submenu)) visit(item.submenu);
      }
    };
    visit(template);

    expect(labels).toContain('Quit');
    expect(labels).toContain('About');
    expect(labels.some((label) => /tray/i.test(label))).toBe(false);
  });

  it('includes File menu with Quit action', async () => {
    const window = makeFakeWindow();
    appMenu(window as BrowserWindow);

    const template = Menu.buildFromTemplate.mock.calls[0][0] as MenuItemConstructorOptions[];
    const fileMenu = template.find((item: MenuItemConstructorOptions) => item.label === 'File');
    const quit = fileMenu.submenu.find((item: MenuItemConstructorOptions) => item.label === 'Quit');

    quit.click();
    await vi.mocked(exitAppAfterSavingWindows).mock.results.at(-1)?.value;
    expect(exitAppAfterSavingWindows).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalled();
  });

  it('includes File menu with Sign Out action', async () => {
    const window = makeFakeWindow();
    appMenu(window as BrowserWindow);

    const template = Menu.buildFromTemplate.mock.calls[0][0] as MenuItemConstructorOptions[];
    const fileMenu = template.find((item: MenuItemConstructorOptions) => item.label === 'File');
    const signOut = fileMenu.submenu.find(
      (item: MenuItemConstructorOptions) => item.label === 'Sign Out'
    );

    signOut.click();
    const { loadAccountURL } = await import('../utils/account/accountNavigation.js');
    expect(loadAccountURL).toHaveBeenCalled();
  });

  it('includes View menu with Search action', async () => {
    const window = makeFakeWindow();
    appMenu(window as BrowserWindow);

    const template = Menu.buildFromTemplate.mock.calls[0][0] as MenuItemConstructorOptions[];
    const viewMenu = template.find((item: MenuItemConstructorOptions) => item.label === 'View');
    const search = viewMenu.submenu.find(
      (item: MenuItemConstructorOptions) => item.label === 'Search'
    );

    search.click();
    const { sendToAccount } = await import('../utils/account/accountNavigation.js');
    expect(sendToAccount).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      IPC_CHANNELS.SEARCH_SHORTCUT
    );
  });

  it('includes View menu with Copy Current URL action', async () => {
    const window = makeFakeWindow();
    appMenu(window as BrowserWindow);

    const template = Menu.buildFromTemplate.mock.calls[0][0] as MenuItemConstructorOptions[];
    const viewMenu = template.find((item: MenuItemConstructorOptions) => item.label === 'View');
    const copyUrl = viewMenu.submenu.find(
      (item: MenuItemConstructorOptions) => item.label === 'Copy Current URL'
    );

    copyUrl.click();
    expect(clipboard.writeText).toHaveBeenCalledWith('https://chat.google.com/u/0/');
  });

  it('includes Preferences menu with checkbox items', () => {
    const window = makeFakeWindow();
    appMenu(window as BrowserWindow);

    const template = Menu.buildFromTemplate.mock.calls[0][0] as MenuItemConstructorOptions[];
    const prefsMenu = template.find(
      (item: MenuItemConstructorOptions) => item.label === 'Preferences'
    );

    const autoUpdates = prefsMenu.submenu.find(
      (item: MenuItemConstructorOptions) => item.label === 'Auto check for Updates'
    );
    expect(autoUpdates).toBeDefined();
    expect(autoUpdates.checked).toBe(true);

    const startHidden = prefsMenu.submenu.find(
      (item: MenuItemConstructorOptions) => item.label === 'Start Hidden'
    );
    expect(startHidden).toBeDefined();
    expect(startHidden.checked).toBe(false);
  });

  it('Preferences includes Notification Settings item that opens the settings dialog', () => {
    const window = makeFakeWindow();
    appMenu(window as BrowserWindow);

    const template = Menu.buildFromTemplate.mock.calls[0][0] as MenuItemConstructorOptions[];
    const prefsMenu = template.find(
      (item: MenuItemConstructorOptions) => item.label === 'Preferences'
    );
    const notificationSettings = prefsMenu.submenu.find(
      (item: MenuItemConstructorOptions) => item.label === 'Notification Settings…'
    );

    expect(notificationSettings).toBeDefined();
    notificationSettings.click();
    expect(showNotificationSettingsDialog).toHaveBeenCalledWith(window);
  });

  it('Preferences includes unread-delta notification checkbox', () => {
    const window = makeFakeWindow();
    appMenu(window as BrowserWindow);

    const template = Menu.buildFromTemplate.mock.calls[0][0] as MenuItemConstructorOptions[];
    const prefsMenu = template.find(
      (item: MenuItemConstructorOptions) => item.label === 'Preferences'
    );
    const unreadDelta = prefsMenu.submenu.find(
      (item: MenuItemConstructorOptions) => item.label === 'Notify on Unread Badge Increase'
    );

    expect(unreadDelta).toBeDefined();
    expect(unreadDelta.type).toBe('checkbox');
    expect(unreadDelta.checked).toBe(false);
    unreadDelta.click({ checked: true });
    expect(store.set).toHaveBeenCalledWith('app.unreadDeltaNotifications', true);
  });

  it('Preferences includes Account Labels submenu with custom label display', () => {
    const window = makeFakeWindow();
    appMenu(window as BrowserWindow);

    const template = Menu.buildFromTemplate.mock.calls[0][0] as MenuItemConstructorOptions[];
    const prefsMenu = template.find(
      (item: MenuItemConstructorOptions) => item.label === 'Preferences'
    );
    const accountLabels = prefsMenu.submenu.find(
      (item: MenuItemConstructorOptions) => item.label === 'Account Labels'
    );

    expect(accountLabels).toBeDefined();
    expect(accountLabels.submenu).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Account 1: Work…' }),
        expect.objectContaining({ label: 'Account 2…' }),
        expect.objectContaining({ label: 'Clear All Labels' }),
      ])
    );
  });

  it('disables Auto Launch at Login when the platform does not support auto launch', () => {
    mockAutoLaunchSupport.mockReturnValue(false);
    const window = makeFakeWindow();
    appMenu(window as BrowserWindow);

    const template = Menu.buildFromTemplate.mock.calls[0][0] as MenuItemConstructorOptions[];
    const prefsMenu = template.find(
      (item: MenuItemConstructorOptions) => item.label === 'Preferences'
    );
    const autoLaunch = prefsMenu.submenu.find(
      (item: MenuItemConstructorOptions) => item.label === 'Auto Launch at Login'
    );

    expect(autoLaunch.enabled).toBe(false);
    expect(autoLaunch.checked).toBe(false);
    autoLaunch.click({ checked: true });
    expect(mockAutoLaunchInstance.enable).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalledWith('app.autoLaunchAtLogin', true);
  });

  it('Preferences checkbox updates store on click', () => {
    const window = makeFakeWindow();
    appMenu(window as BrowserWindow);

    const template = Menu.buildFromTemplate.mock.calls[0][0] as MenuItemConstructorOptions[];
    const prefsMenu = template.find(
      (item: MenuItemConstructorOptions) => item.label === 'Preferences'
    );
    const startHidden = prefsMenu.submenu.find(
      (item: MenuItemConstructorOptions) => item.label === 'Start Hidden'
    );

    startHidden.click({ checked: true });
    expect(store.set).toHaveBeenCalledWith('app.startHidden', true);
  });

  it('includes Help menu with About action', () => {
    const window = makeFakeWindow();
    appMenu(window as BrowserWindow);

    const template = Menu.buildFromTemplate.mock.calls[0][0] as MenuItemConstructorOptions[];
    const helpMenu = template.find((item: MenuItemConstructorOptions) => item.label === 'Help');
    const about = helpMenu.submenu.find(
      (item: MenuItemConstructorOptions) => item.label === 'About'
    );

    about.click();
    expect(mockAboutHandler).toHaveBeenCalledWith(window);
  });

  it('includes Help menu with Report issue action', () => {
    const window = makeFakeWindow();
    appMenu(window as BrowserWindow);

    const template = Menu.buildFromTemplate.mock.calls[0][0] as MenuItemConstructorOptions[];
    const helpMenu = template.find((item: MenuItemConstructorOptions) => item.label === 'Help');
    const troubleshooting = helpMenu.submenu.find(
      (item: MenuItemConstructorOptions) => item.label === 'Troubleshooting'
    );
    const reportIssue = troubleshooting.submenu.find(
      (item: MenuItemConstructorOptions) => item.label === 'Report issue...'
    );

    reportIssue.click();
    expect(openNewGitHubIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUrl: 'https://github.com/test/repo',
      })
    );
  });

  it('shows version info in Help menu', () => {
    const window = makeFakeWindow();
    appMenu(window as BrowserWindow);

    const template = Menu.buildFromTemplate.mock.calls[0][0] as MenuItemConstructorOptions[];
    const helpMenu = template.find((item: MenuItemConstructorOptions) => item.label === 'Help');
    const versionItem = helpMenu.submenu.find(
      (item: MenuItemConstructorOptions) => item.label && item.label.includes('Version')
    );

    expect(versionItem).toBeDefined();
    expect(versionItem.enabled).toBe(false);
  });

  it('Relaunch action saves windows before relaunching', async () => {
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
    const window = makeFakeWindow();
    appMenu(window as BrowserWindow);

    const template = Menu.buildFromTemplate.mock.calls[0][0] as MenuItemConstructorOptions[];
    const fileMenu = template.find((item: MenuItemConstructorOptions) => item.label === 'File');
    const relaunch = fileMenu.submenu.find(
      (item: MenuItemConstructorOptions) => item.label === 'Relaunch'
    );

    relaunch.click();
    await vi.mocked(persistAccountWindowsBeforeExit).mock.results.at(-1)?.value;
    expect(order).toEqual(['persist', 'relaunch', 'exit']);
  });

  describe('account controls', () => {
    function items(menu: string): MenuItemConstructorOptions[] {
      const template = vi
        .mocked(Menu.buildFromTemplate)
        .mock.calls.at(-1)?.[0] as MenuItemConstructorOptions[];
      return template.find((item) => item.label === menu)?.submenu as MenuItemConstructorOptions[];
    }
    function item(menu: string, label: string): MenuItemConstructorOptions {
      const found = items(menu).find((entry) => entry.label === label);
      if (!found) throw new Error(`Missing ${label}`);
      return found;
    }
    function click(entry: MenuItemConstructorOptions): void {
      (entry.click as () => void)();
    }

    it('mutes the account selected at invocation and preserves other deadlines', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      configValues['app.accountNotificationMuteUntil'] = { '0': 5000, '7': 9000 };
      mockConfigSet.mockImplementation((key: string, value: unknown) => {
        configValues[key] = value;
      });
      appMenu(makeFakeWindow() as BrowserWindow);
      mockAccountIndex.mockReturnValue(2);
      click(item('Preferences', 'Mute Chat Notifications for One Hour'));
      expect(mockConfigSet).toHaveBeenCalledWith('app.accountNotificationMuteUntil', {
        '0': 5000,
        '2': 3601000,
        '7': 9000,
      });
      expect(item('Preferences', 'Resume Chat Notifications').enabled).toBe(true);
      click(item('Preferences', 'Resume Chat Notifications'));
      expect(configValues['app.accountNotificationMuteUntil']).toEqual({ '0': 5000, '7': 9000 });
      vi.useRealTimers();
    });

    it('keeps saved menu state when the mute write fails', () => {
      configValues['app.accountNotificationMuteUntil'] = { '7': 9000 };
      mockConfigSet.mockImplementation(() => {
        throw new Error('https://secret.example');
      });
      appMenu(makeFakeWindow() as BrowserWindow);
      const count = vi.mocked(Menu.setApplicationMenu).mock.calls.length;
      click(item('Preferences', 'Mute Chat Notifications for One Hour'));
      expect(configValues['app.accountNotificationMuteUntil']).toEqual({ '7': 9000 });
      expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(count);
      expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain('secret.example');
    });

    it('uses the focused account window for account zero and WCV host resolution', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      const focused = makeFakeWindow();
      vi.mocked(ElectronBrowserWindow.getFocusedWindow).mockReturnValue(focused as BrowserWindow);
      appMenu(makeFakeWindow() as BrowserWindow);
      click(item('Preferences', 'Mute Chat Notifications for One Hour'));
      expect(mockAccountIndex).toHaveBeenLastCalledWith(focused);
      expect(mockConfigSet).toHaveBeenCalledWith('app.accountNotificationMuteUntil', {
        '0': 3601000,
      });
      vi.mocked(ElectronBrowserWindow.getFocusedWindow).mockReturnValue(null);
      vi.useRealTimers();
    });

    it('updates mute availability on menu opening after expiry or account switching', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      configValues['app.accountNotificationMuteUntil'] = { '2': 1001 };
      mockAccountIndex.mockReturnValue(2);
      const mute = { enabled: true };
      const resume = { enabled: false };
      let open: (() => void) | undefined;
      vi.mocked(Menu.buildFromTemplate).mockReturnValueOnce({
        getMenuItemById: (id: string) =>
          id === 'preferences'
            ? {
                submenu: {
                  on: (_event: string, handler: () => void) => {
                    open = handler;
                  },
                },
              }
            : id === 'mute-account-notifications'
              ? mute
              : resume,
      } as never);
      appMenu(makeFakeWindow() as BrowserWindow);
      open?.();
      expect([mute.enabled, resume.enabled]).toEqual([false, true]);
      vi.setSystemTime(1001);
      open?.();
      expect([mute.enabled, resume.enabled]).toEqual([true, false]);
      mockAccountIndex.mockReturnValue(null);
      open?.();
      expect([mute.enabled, resume.enabled]).toEqual([false, false]);
      vi.useRealTimers();
    });

    it('offers retained sparse secondary accounts but disables bootstrap accounts', () => {
      mockIsBootstrap.mockImplementation((index) => index === 7);
      appMenu(makeFakeWindow() as BrowserWindow);
      const entries = item('File', 'Forget Account').submenu as MenuItemConstructorOptions[];
      expect(entries.map(({ label, enabled }) => [label, enabled])).toEqual([
        ['Account 3', true],
        ['Account 8', false],
      ]);
      click(entries[1] as MenuItemConstructorOptions);
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    });

    it.each(['browser-window', 'web-contents-view'] as const)(
      'offers newly retained accounts in the same session on %s creation',
      (backend) => {
        retained.indices = [0, 2];
        appMenu(asType<BrowserWindow>(makeFakeWindow()));

        retained.indices.push(7);
        notifyAccountWebContentsCreated({
          accountIndex: asAccountIndex(7),
          webContents: asType<Electron.WebContents>(makeFakeWindow().webContents),
          backend,
        });

        const entries = item('File', 'Forget Account').submenu as MenuItemConstructorOptions[];
        expect(entries.map(({ label, enabled }) => [label, enabled])).toEqual([
          ['Account 3', true],
          ['Account 8', true],
        ]);
      }
    );

    it.each([
      ['promotion', promoteBootstrap],
      ['clear', clearBootstrap],
    ] as const)(
      'enables Forget in the same session after %s clears bootstrap state',
      (_label, finishBootstrap) => {
        mockIsBootstrap.mockImplementation(isBootstrap);
        markAsBootstrap(asAccountIndex(7));
        appMenu(asType<BrowserWindow>(makeFakeWindow()));
        const before = item('File', 'Forget Account').submenu as MenuItemConstructorOptions[];
        expect(before[1]?.enabled).toBe(false);

        finishBootstrap(asAccountIndex(7));

        const after = item('File', 'Forget Account').submenu as MenuItemConstructorOptions[];
        expect(after[1]?.enabled).toBe(true);
      }
    );

    it('disables Forget when an existing account is marked as bootstrap', () => {
      mockIsBootstrap.mockImplementation(isBootstrap);
      appMenu(asType<BrowserWindow>(makeFakeWindow()));

      markAsBootstrap(asAccountIndex(7));

      const entries = item('File', 'Forget Account').submenu as MenuItemConstructorOptions[];
      expect(entries[1]?.enabled).toBe(false);
    });

    it('unsubscribes lifecycle refreshes on cleanup and resubscribes on initialization', () => {
      const window = asType<BrowserWindow>(makeFakeWindow());
      appMenu(window);
      appMenu(window);
      for (const cleanup of cleanupTasks.values()) cleanup();
      vi.mocked(Menu.setApplicationMenu).mockClear();

      markAsBootstrap(asAccountIndex(7));
      const created = {
        accountIndex: asAccountIndex(7),
        webContents: asType<Electron.WebContents>(makeFakeWindow().webContents),
        backend: 'browser-window' as const,
      };
      notifyAccountWebContentsCreated(created);
      expect(Menu.setApplicationMenu).not.toHaveBeenCalled();

      appMenu(window);
      vi.mocked(Menu.setApplicationMenu).mockClear();
      notifyAccountWebContentsCreated(created);
      expect(Menu.setApplicationMenu).toHaveBeenCalledOnce();
    });

    it('cancels without forgetting and serializes duplicate confirmation requests', async () => {
      const confirmation = Promise.withResolvers<{ response: number; checkboxChecked: boolean }>();
      vi.mocked(dialog.showMessageBox).mockReturnValueOnce(confirmation.promise);
      appMenu(makeFakeWindow() as BrowserWindow);
      const entry = (item('File', 'Forget Account').submenu as MenuItemConstructorOptions[])[0];
      click(entry as MenuItemConstructorOptions);
      click(entry as MenuItemConstructorOptions);
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
      confirmation.resolve({ response: 0, checkboxChecked: false });
      await confirmation.promise;
      expect(mockForgetAccount).not.toHaveBeenCalled();
    });

    it('rebuilds only after confirmed durable forget completes', async () => {
      const operation = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const rebuilt = Promise.withResolvers<void>();
      vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({
        response: 1,
        checkboxChecked: false,
      });
      mockForgetAccount.mockImplementation(() => {
        started.resolve();
        return operation.promise;
      });
      appMenu(makeFakeWindow() as BrowserWindow);
      vi.mocked(Menu.setApplicationMenu).mockImplementationOnce(() => {
        rebuilt.resolve();
      });
      click(
        (
          item('File', 'Forget Account').submenu as MenuItemConstructorOptions[]
        )[1] as MenuItemConstructorOptions
      );
      await started.promise;
      expect(mockForgetAccount).toHaveBeenCalledWith(7);
      expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(1);
      operation.resolve();
      await rebuilt.promise;
      expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(2);
    });

    it('reports forget failure without rebuilding as successful', async () => {
      const reported = Promise.withResolvers<void>();
      vi.mocked(dialog.showMessageBox)
        .mockResolvedValueOnce({ response: 1, checkboxChecked: false })
        .mockImplementationOnce(async () => {
          reported.resolve();
          return { response: 0, checkboxChecked: false };
        });
      mockForgetAccount.mockRejectedValueOnce(new Error('https://secret.example'));
      appMenu(makeFakeWindow() as BrowserWindow);
      click(
        (
          item('File', 'Forget Account').submenu as MenuItemConstructorOptions[]
        )[0] as MenuItemConstructorOptions
      );
      await reported.promise;
      expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(1);
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain('secret.example');
    });
  });

  describe('update snooze and session maintenance preferences', () => {
    const NOW = Date.parse('2026-03-01T12:00:00Z');

    type Item = MenuItemConstructorOptions;

    function preferences(call = 0): Item[] {
      const template = vi.mocked(Menu.buildFromTemplate).mock.calls.at(call)?.[0] as Item[];
      const prefs = template.find((item) => item.label === 'Preferences');
      return prefs?.submenu as Item[];
    }

    function pick(items: Item[], label: string): Item {
      const found = items.find((item) => item.label === label);
      if (!found) throw new Error(`missing menu item ${label}`);
      return found;
    }

    function click(item: Item, menuItem: object = {}): void {
      (item.click as (menuItem: object) => void)(menuItem);
    }

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it.each([
      ['a fresh or older store without the key', undefined],
      ['an inactive deadline', 0],
      ['an expired deadline', NOW - 1],
      ['a deadline that is exactly now', NOW],
    ])('offers Snooze and disables Resume for %s', (_label, deadline) => {
      configValues['app.updateSnoozedUntil'] = deadline;
      appMenu(makeFakeWindow() as BrowserWindow);

      const items = preferences();
      expect(pick(items, 'Snooze Update Prompts for 24 Hours').enabled).toBe(true);
      expect(pick(items, 'Resume Update Prompts').enabled).toBe(false);
    });

    it('disables Snooze and offers Resume while a future deadline is persisted', () => {
      configValues['app.updateSnoozedUntil'] = NOW + 1;
      appMenu(makeFakeWindow() as BrowserWindow);

      const items = preferences();
      expect(pick(items, 'Snooze Update Prompts for 24 Hours').enabled).toBe(false);
      expect(pick(items, 'Resume Update Prompts').enabled).toBe(true);
    });

    it('keeps auto-check independent of the snooze items', () => {
      configValues['app.updateSnoozedUntil'] = NOW + 1000;
      appMenu(makeFakeWindow() as BrowserWindow);

      const autoCheck = pick(preferences(), 'Auto check for Updates');
      expect(autoCheck.checked).toBe(true);
      expect(autoCheck.enabled).toBe(true);
    });

    it('routes Snooze and Resume through their dedicated actions and rebuilds the menu', () => {
      const window = makeFakeWindow();
      appMenu(window as BrowserWindow);
      const builds = vi.mocked(Menu.setApplicationMenu).mock.calls.length;

      click(pick(preferences(), 'Snooze Update Prompts for 24 Hours'));
      expect(mockSnoozeHandler).toHaveBeenCalledTimes(1);
      expect(vi.mocked(Menu.setApplicationMenu)).toHaveBeenCalledTimes(builds + 1);

      click(pick(preferences(), 'Resume Update Prompts'));
      expect(mockResumeHandler).toHaveBeenCalledTimes(1);
      expect(vi.mocked(Menu.setApplicationMenu)).toHaveBeenCalledTimes(builds + 2);

      expect(mockCheckForUpdatesHandler).not.toHaveBeenCalled();
      expect(store.set).not.toHaveBeenCalledWith('app.autoCheckForUpdates', expect.anything());
    });

    it('does not rebuild the menu when the snooze write fails', () => {
      mockSnoozeHandler.mockReturnValue(false);
      mockResumeHandler.mockReturnValue(false);
      appMenu(makeFakeWindow() as BrowserWindow);
      const builds = vi.mocked(Menu.setApplicationMenu).mock.calls.length;

      click(pick(preferences(), 'Snooze Update Prompts for 24 Hours'));
      click(pick(preferences(), 'Resume Update Prompts'));

      expect(vi.mocked(Menu.setApplicationMenu)).toHaveBeenCalledTimes(builds);
    });

    it('presents the saved session maintenance mode as radio choices', () => {
      appMenu(makeFakeWindow() as BrowserWindow);
      let modes = pick(preferences(), 'Session Maintenance').submenu as Item[];
      expect(modes.map((item) => item.type)).toEqual(['radio', 'radio']);
      expect(modes.map((item) => item.checked)).toEqual([true, false]);

      configValues['app.sessionMaintenanceMode'] = 'conservative';
      appMenu(makeFakeWindow() as BrowserWindow);
      modes = pick(preferences(1), 'Session Maintenance').submenu as Item[];
      expect(modes.map((item) => item.checked)).toEqual([false, true]);
    });

    it('persists the chosen mode through the typed accessor without rebuilding', () => {
      appMenu(makeFakeWindow() as BrowserWindow);
      const builds = vi.mocked(Menu.setApplicationMenu).mock.calls.length;
      const [standard, conservative] = pick(preferences(), 'Session Maintenance').submenu as Item[];

      click(conservative as Item);
      expect(mockConfigSet).toHaveBeenLastCalledWith('app.sessionMaintenanceMode', 'conservative');
      click(standard as Item);
      expect(mockConfigSet).toHaveBeenLastCalledWith('app.sessionMaintenanceMode', 'default');

      expect(vi.mocked(Menu.setApplicationMenu)).toHaveBeenCalledTimes(builds);
      expect(log.error).not.toHaveBeenCalled();
    });

    it('rebuilds from the saved selection when the mode write fails', () => {
      configValues['app.sessionMaintenanceMode'] = 'default';
      mockConfigSet.mockImplementation(() => {
        throw new Error('https://user:pass@evil.example/secret');
      });
      appMenu(makeFakeWindow() as BrowserWindow);
      const builds = vi.mocked(Menu.setApplicationMenu).mock.calls.length;
      const conservative = (pick(preferences(), 'Session Maintenance').submenu as Item[])[1];

      click(conservative as Item, { checked: true });

      expect(vi.mocked(Menu.setApplicationMenu)).toHaveBeenCalledTimes(builds + 1);
      const rebuilt = pick(preferences(builds), 'Session Maintenance').submenu as Item[];
      expect(rebuilt.map((item) => item.checked)).toEqual([true, false]);
      expect(log.error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain('evil.example');
    });

    it('registers a refresh action that rebuilds only for a live menu window', () => {
      const refresh = registeredActions['refreshApplicationMenu']?.handler;
      expect(refresh).toEqual(expect.any(Function));

      const window = makeFakeWindow();
      appMenu(window as BrowserWindow);
      const builds = vi.mocked(Menu.setApplicationMenu).mock.calls.length;

      refresh?.();
      expect(vi.mocked(Menu.setApplicationMenu)).toHaveBeenCalledTimes(builds + 1);

      window.isDestroyed.mockReturnValue(true);
      refresh?.();
      expect(vi.mocked(Menu.setApplicationMenu)).toHaveBeenCalledTimes(builds + 1);
    });
  });
});
