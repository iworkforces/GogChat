import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
import { app, shell, dialog } from 'electron';
import path from 'path';
import log from 'electron-log';
import store from '../../config.js';
import environment from '../../../environment.js';
import { openNewGitHubIssue, debugInfo } from './platformHelpers.js';
import { getPackageInfo } from './packageInfo.js';
import { getMenuAction } from '../../features/menuActionRegistry.js';
import { persistAccountWindowsBeforeExit } from '../account/exitAfterAccountWindows.js';

/**
 * Relaunch the application without the --hidden flag (filters out auto-launch hidden start).
 */
export const relaunchApp = async (): Promise<void> => {
  await persistAccountWindowsBeforeExit();
  app.relaunch({
    // auto-launch adds the --hidden flag to the command during OS start
    // This will launch the app without hidden flag
    args: process.argv.filter((flag) => flag !== '--hidden'),
  });
  app.exit();
};

/**
 * Clear all app data (storage, cache, config) and relaunch the app.
 */
export const resetAppAndRestart = async (window: BrowserWindow): Promise<void> => {
  log.log('clearing app data');
  store.clear();
  const { session } = window.webContents;
  await session.clearStorageData();
  await session.clearCache();
  log.log('cleared app data');
  await relaunchApp();
};

/**
 * Build the Help submenu definition.
 */
export const buildHelpSubMenu = (window: BrowserWindow): MenuItemConstructorOptions => {
  const pkg = getPackageInfo();

  return {
    label: 'Help',
    submenu: [
      {
        label: 'Check For Updates',
        enabled: true,
        click: () => {
          const checkUpdates = getMenuAction('checkForUpdates');
          if (checkUpdates) {
            checkUpdates.handler();
          }
        },
      },
      {
        label: 'Troubleshooting',
        submenu: [
          {
            label: 'Report issue...',
            click: () => {
              openNewGitHubIssue({
                repoUrl: pkg.repository,
                body: `### Platform\n\n${debugInfo()}`,
              });
            },
          },
          {
            label: 'Toggle External Links Guard',
            click: () => {
              const toggleGuard = getMenuAction('toggleExternalLinksGuard');
              if (toggleGuard) {
                toggleGuard.handler(window);
              }
            },
          },
          {
            label: 'Demo Badge Count',
            click: () => {
              app.setBadgeCount(Math.floor(Math.random() * 99));
            },
          },
          {
            type: 'separator',
          },
          {
            label: 'Show Logs in File Manager',
            click: () => {
              if (process.platform === 'darwin') {
                shell.showItemInFolder(app.getPath('logs'));
              } else {
                shell.showItemInFolder(path.join(app.getPath('userData'), 'logs'));
              }
            },
          },
          {
            label: 'Reset and Relaunch App',
            click: () => {
              void dialog
                .showMessageBox(window, {
                  type: 'warning',
                  title: 'Confirm',
                  message: 'Reset app data?',
                  detail: `You will be logged out from application.\nAll settings will reset to default.\nPress 'Yes' to proceed.`,
                  buttons: ['Yes', 'No'],
                  cancelId: 1,
                  defaultId: 1,
                })
                .then(({ response }) => {
                  if (response === 0) {
                    void resetAppAndRestart(window);
                  }
                });
            },
          },
        ],
      },
      {
        label: 'About',
        click: () => {
          const showAbout = getMenuAction('aboutPanel');
          if (showAbout) {
            showAbout.handler(window);
          }
        },
      },
      {
        type: 'separator',
      },
      {
        label: `Version ${app.getVersion()}${environment.isDev ? '-(dev)' : ''}`,
        enabled: false,
      },
    ],
  };
};
