import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
import { Menu, clipboard } from 'electron';
import store, { configGet } from '../config.js';
import environment from '../../environment.js';
import { IPC_CHANNELS } from '../../shared/constants.js';
import { asAccountIndex } from '../../shared/types/branded.js';
import { getMenuAction } from './menuActionRegistry.js';
import { buildHelpSubMenu, relaunchApp } from '../utils/platform/helpMenuBuilder.js';
import { supports } from '../utils/platform/platformDetection.js';
import { showNotificationSettingsDialog } from '../utils/security/notificationAccess.js';
import { promptAccountLabel } from '../utils/platform/accountLabelDialog.js';
import {
  clearStoredAccountLabels,
  getAllStoredAccountLabels,
  getStoredAccountLabel,
  setStoredAccountLabel,
} from '../utils/platform/accountLabelStore.js';
import { getAccountWindowManager } from '../utils/account/accountWindowManager.js';
import { exitAppAfterSavingWindows } from '../utils/account/exitAfterAccountWindows.js';
import {
  getAccountURL,
  loadAccountURL,
  sendToAccount,
} from '../utils/account/accountNavigation.js';
import { formatAccountNotificationLabel } from '../utils/platform/accountNotificationIdentity.js';
import type { AccountIndex } from '../../shared/types/branded.js';

function menuAccountIndex(window: BrowserWindow): AccountIndex {
  try {
    return getAccountWindowManager().getAccountIndex(window) ?? asAccountIndex(0);
  } catch {
    return asAccountIndex(0);
  }
}

function buildAccountLabelsSubmenu(
  parentWindow: BrowserWindow,
  rebuildMenu: (window: BrowserWindow) => void
): MenuItemConstructorOptions {
  // Dense 0..slotCount-1 slots are intentional for Preferences → Account Labels
  // (users may label not-yet-created indices). Live account lifecycle code must
  // use listAccountIndices() instead of getAccountCount() loops.
  let accountCount = 0;
  try {
    accountCount = getAccountWindowManager().getAccountCount();
  } catch {
    // Manager may be unavailable during early menu build in tests.
  }
  const stored = getAllStoredAccountLabels();
  const maxFromLabels = Object.keys(stored)
    .map((k) => Number(k))
    .filter((n) => Number.isInteger(n) && n >= 0)
    .reduce((max, n) => Math.max(max, n), -1);
  const slotCount = Math.max(accountCount, maxFromLabels + 1, 0);

  const items: MenuItemConstructorOptions[] = [];
  if (slotCount === 0) {
    items.push({
      label: 'No accounts yet',
      enabled: false,
    });
  } else {
    for (let i = 0; i < slotCount; i++) {
      const index = asAccountIndex(i);
      const display = formatAccountNotificationLabel(index);
      const isCustom = getStoredAccountLabel(index) !== undefined;
      items.push({
        label: isCustom ? `Account ${i + 1}: ${display}…` : `Account ${i + 1}…`,
        click: () => {
          void (async () => {
            const current = getStoredAccountLabel(index) ?? '';
            const result = await promptAccountLabel(parentWindow, i, current);
            if (result === null) {
              return;
            }
            setStoredAccountLabel(index, result);
            // Rebuild menu so labels refresh (same-module callback — no self-import cycle)
            rebuildMenu(parentWindow);
          })();
        },
      });
    }
  }

  items.push({ type: 'separator' });
  items.push({
    label: 'Clear All Labels',
    enabled: Object.keys(stored).length > 0,
    click: () => {
      clearStoredAccountLabels();
      rebuildMenu(parentWindow);
    },
  });

  return {
    label: 'Account Labels',
    submenu: items,
  };
}

function setAppMenu(window: BrowserWindow): void {
  const autoLaunchSupported = supports.autoLaunch();
  const menuItems = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: 'Hide Window',
          accelerator: 'CommandOrControl+W',
          click: () => {
            window.hide();
          },
        },
        {
          label: 'Relaunch',
          click: () => {
            void relaunchApp();
          },
        },
        {
          role: 'minimize',
        },
        {
          label: 'Sign Out',
          click: () => {
            const manager = getAccountWindowManager();
            loadAccountURL(manager, menuAccountIndex(window), environment.logoutUrl);
          },
        },
        {
          type: 'separator',
        },
        {
          label: 'Quit',
          accelerator: 'CommandOrControl+Q',
          click: () => {
            void exitAppAfterSavingWindows();
          },
        },
      ],
    },
    {
      role: 'editMenu',
    },
    {
      label: 'View',
      submenu: [
        {
          role: 'reload',
        },
        {
          role: 'forceReload',
        },
        {
          label: 'Search',
          accelerator: 'CommandOrControl+F',
          click: () => {
            const manager = getAccountWindowManager();
            sendToAccount(manager, menuAccountIndex(window), IPC_CHANNELS.SEARCH_SHORTCUT);
          },
        },
        {
          label: 'Copy Current URL',
          click: () => {
            const manager = getAccountWindowManager();
            const url = getAccountURL(manager, menuAccountIndex(window));
            if (url) {
              void clipboard.writeText(url);
            }
          },
        },
        {
          role: 'toggleDevTools',
          visible: environment.isDev,
        },
        {
          type: 'separator',
        },
        {
          role: 'togglefullscreen',
        },
        {
          role: 'resetZoom',
        },
        {
          role: 'zoomIn',
        },
        {
          role: 'zoomOut',
        },
      ],
    },
    {
      label: 'History',
      submenu: [
        {
          label: 'Back',
          accelerator: 'Alt+Left',
          click: () => {
            const manager = getAccountWindowManager();
            const wc = manager.getAccountWebContents(menuAccountIndex(window));
            if (wc && !wc.isDestroyed()) {
              wc.goBack();
            }
          },
        },
        {
          label: 'Forward',
          accelerator: 'Alt+Right',
          click: () => {
            const manager = getAccountWindowManager();
            const wc = manager.getAccountWebContents(menuAccountIndex(window));
            if (wc && !wc.isDestroyed()) {
              wc.goForward();
            }
          },
        },
        {
          type: 'separator',
        },
        {
          label: 'Navigate to Home',
          accelerator: 'Alt+Home',
          click: () => {
            const manager = getAccountWindowManager();
            loadAccountURL(manager, menuAccountIndex(window), environment.appUrl);
          },
        },
      ],
    },
    {
      label: 'Preferences',
      submenu: [
        {
          label: 'Auto check for Updates',
          type: 'checkbox',
          enabled: true,
          checked: configGet('app.autoCheckForUpdates') ?? false,
          click: (menuItem: Electron.MenuItem) => {
            store.set('app.autoCheckForUpdates', menuItem.checked);
          },
        },
        {
          label: 'Auto Launch at Login',
          type: 'checkbox',
          enabled: autoLaunchSupported,
          checked: autoLaunchSupported && (configGet('app.autoLaunchAtLogin') ?? false),
          click: (menuItem: Electron.MenuItem) => {
            void (async () => {
              if (!autoLaunchSupported) return;
              const autoLaunchAction = getMenuAction('autoLaunch');
              if (!autoLaunchAction) return;
              const instance = autoLaunchAction.handler();
              if (menuItem.checked) {
                await instance.enable();
              } else {
                await instance.disable();
              }

              store.set('app.autoLaunchAtLogin', menuItem.checked);
            })();
          },
        },
        {
          label: 'Start Hidden',
          type: 'checkbox',
          checked: configGet('app.startHidden') ?? false,
          click: (menuItem: Electron.MenuItem) => {
            store.set('app.startHidden', menuItem.checked);
          },
        },
        {
          label: 'Hide Menu Bar',
          type: 'checkbox',
          enabled: process.platform !== 'darwin',
          checked: configGet('app.hideMenuBar') ?? false,
          click: (menuItem: Electron.MenuItem) => {
            window.setMenuBarVisibility(!menuItem.checked);
            window.setAutoHideMenuBar(menuItem.checked);
            store.set('app.hideMenuBar', menuItem.checked);
          },
        },
        {
          label: 'Disable Spell Checker',
          type: 'checkbox',
          checked: configGet('app.disableSpellChecker') ?? false,
          click: (menuItem: Electron.MenuItem) => {
            window.webContents.session.setSpellCheckerEnabled(!menuItem.checked);
            store.set('app.disableSpellChecker', menuItem.checked);
          },
        },
        {
          type: 'separator',
        },
        {
          label: 'Notify on Unread Badge Increase',
          type: 'checkbox',
          checked: configGet('app.unreadDeltaNotifications') ?? false,
          click: (menuItem: Electron.MenuItem) => {
            store.set('app.unreadDeltaNotifications', menuItem.checked);
          },
        },
        buildAccountLabelsSubmenu(window, setAppMenu),
        {
          label: 'Notification Settings…',
          click: () => {
            void showNotificationSettingsDialog(window);
          },
        },
      ],
    },
    buildHelpSubMenu(window),
  ]);

  Menu.setApplicationMenu(menuItems);
}

export default setAppMenu;
