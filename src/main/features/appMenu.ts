import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
import { BrowserWindow as ElectronBrowserWindow, Menu, clipboard, dialog } from 'electron';
import log from 'electron-log';
import store, { configGet, configSet } from '../config.js';
import environment from '../../environment.js';
import { IPC_CHANNELS } from '../../shared/constants.js';
import { sanitizeLogError } from '../../shared/logSanitizer.js';
import { asAccountIndex } from '../../shared/types/branded.js';
import type { SessionMaintenanceMode } from '../../shared/types/config.js';
import { getMenuAction, registerMenuAction } from './menuActionRegistry.js';
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
import { listRetainedAccountIndices } from '../utils/account/retainedAccounts.js';
import { isAccountNotificationMuted } from '../utils/platform/accountNotificationMute.js';
import { onAccountWebContentsCreated } from '../utils/account/accountWebContentsHooks.js';
import { onBootstrapStateChanged } from '../utils/account/bootstrapTracker.js';
import { registerCleanupTask } from '../utils/lifecycle/resourceCleanup.js';

const forgettingAccounts = new Set<AccountIndex>();

function selectedAccount(window: BrowserWindow): AccountIndex | null {
  const manager = getAccountWindowManager();
  return manager.getAccountIndex(ElectronBrowserWindow.getFocusedWindow() ?? window);
}

function setAccountMute(window: BrowserWindow, muted: boolean): void {
  try {
    const index = selectedAccount(window);
    if (index === null) return;
    const deadlines = { ...configGet('app.accountNotificationMuteUntil') };
    if (muted) deadlines[String(index)] = Date.now() + 60 * 60 * 1000;
    else delete deadlines[String(index)];
    configSet('app.accountNotificationMuteUntil', deadlines);
    setAppMenu(window);
  } catch (error: unknown) {
    log.error('[AppMenu] Failed to update account notification mute:', sanitizeLogError(error));
  }
}

async function forgetAccount(window: BrowserWindow, index: AccountIndex): Promise<void> {
  const manager = getAccountWindowManager();
  if (
    index === 0 ||
    manager.isBootstrap(index) ||
    !listRetainedAccountIndices().includes(index) ||
    forgettingAccounts.has(index)
  )
    return;
  forgettingAccounts.add(index);
  try {
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning',
      buttons: ['Cancel', 'Forget Account'],
      defaultId: 0,
      cancelId: 0,
      message: `Forget ${formatAccountNotificationLabel(index)}?`,
      detail: 'Local account storage will be removed. This cannot be undone.',
    });
    if (response !== 1) return;
    await manager.forgetAccount(index);
    setAppMenu(window);
  } catch (error: unknown) {
    log.error('[AppMenu] Failed to forget account:', sanitizeLogError(error));
    await dialog.showMessageBox(window, {
      type: 'error',
      message: 'Could not forget account',
      detail: 'Some local data may already have been cleared. You can try again.',
    });
  } finally {
    forgettingAccounts.delete(index);
  }
}

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

let menuWindow: BrowserWindow | null = null;

function refreshApplicationMenu(): void {
  if (menuWindow && !menuWindow.isDestroyed()) {
    setAppMenu(menuWindow);
  }
}

function runUpdateSnoozeAction(
  id: 'snoozeUpdatePrompts' | 'resumeUpdatePrompts',
  window: BrowserWindow
): void {
  if (getMenuAction(id)?.handler()) {
    setAppMenu(window);
  }
}

function selectSessionMaintenanceMode(mode: SessionMaintenanceMode, window: BrowserWindow): void {
  try {
    configSet('app.sessionMaintenanceMode', mode);
  } catch (err: unknown) {
    log.error('[AppMenu] Failed to persist session maintenance mode:', sanitizeLogError(err));
    setAppMenu(window);
  }
}

function setAppMenu(window: BrowserWindow): void {
  if (!menuWindow) {
    // Subscribe before assigning the window: creation-hook backfill needs no refresh.
    // Rebuild on lifecycle changes, before opening; native menus cannot add items live.
    const offCreated = onAccountWebContentsCreated(refreshApplicationMenu);
    const offBootstrap = onBootstrapStateChanged(refreshApplicationMenu);
    registerCleanupTask('appMenu-account-lifecycle', () => {
      offCreated();
      offBootstrap();
      menuWindow = null;
    });
  }
  menuWindow = window;
  const autoLaunchSupported = supports.autoLaunch();
  const updatesSnoozed = (configGet('app.updateSnoozedUntil') ?? 0) > Date.now();
  const maintenanceMode = configGet('app.sessionMaintenanceMode') ?? 'default';
  const selected = selectedAccount(window);
  const muted = selected !== null && isAccountNotificationMuted(selected);
  const manager = getAccountWindowManager();
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
          label: 'Forget Account',
          submenu: listRetainedAccountIndices()
            .filter((index) => index !== 0)
            .map((index) => ({
              label: formatAccountNotificationLabel(index),
              enabled: !manager.isBootstrap(index) && !forgettingAccounts.has(index),
              click: () => {
                void forgetAccount(window, index);
              },
            })),
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
      id: 'preferences',
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
          label: 'Snooze Update Prompts for 24 Hours',
          enabled: !updatesSnoozed,
          click: () => {
            runUpdateSnoozeAction('snoozeUpdatePrompts', window);
          },
        },
        {
          label: 'Resume Update Prompts',
          enabled: updatesSnoozed,
          click: () => {
            runUpdateSnoozeAction('resumeUpdatePrompts', window);
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
        {
          id: 'mute-account-notifications',
          label: 'Mute Chat Notifications for One Hour',
          enabled: selected !== null && !muted,
          click: () => setAccountMute(window, true),
        },
        {
          id: 'resume-account-notifications',
          label: 'Resume Chat Notifications',
          enabled: selected !== null && muted,
          click: () => setAccountMute(window, false),
        },
        {
          label: 'Session Maintenance',
          submenu: [
            {
              label: 'Default',
              type: 'radio',
              checked: maintenanceMode === 'default',
              click: () => {
                selectSessionMaintenanceMode('default', window);
              },
            },
            {
              label: 'Conservative (keep idle HTTP caches and service workers)',
              type: 'radio',
              checked: maintenanceMode === 'conservative',
              click: () => {
                selectSessionMaintenanceMode('conservative', window);
              },
            },
          ],
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

  const preferences = menuItems.getMenuItemById('preferences')?.submenu;
  preferences?.on('menu-will-show', () => {
    const index = selectedAccount(window);
    const isMuted = index !== null && isAccountNotificationMuted(index);
    const mute = menuItems.getMenuItemById('mute-account-notifications');
    const resume = menuItems.getMenuItemById('resume-account-notifications');
    if (mute) mute.enabled = index !== null && !isMuted;
    if (resume) resume.enabled = index !== null && isMuted;
  });
  Menu.setApplicationMenu(menuItems);
}

registerMenuAction('refreshApplicationMenu', {
  label: 'Refresh Application Menu',
  handler: refreshApplicationMenu,
});

export default setAppMenu;
