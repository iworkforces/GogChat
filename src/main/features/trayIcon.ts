import type { BrowserWindow, Tray } from 'electron';
import { Menu } from 'electron';
import log from 'electron-log';
import { setTrayInstance } from '../utils/platform/trayIconState.js';
import { getPlatformUtils } from '../utils/platform/platformUtils.js';
import { exitAppAfterSavingWindows } from '../utils/account/exitAfterAccountWindows.js';
import { getMenuAction } from './menuActionRegistry.js';

// Store tray icon reference for cleanup
let trayIconInstance: Tray | null = null;

export default (window: BrowserWindow) => {
  trayIconInstance = getPlatformUtils().createTrayIcon();

  const handleOpenClick = () => {
    if (window.isMinimized()) {
      window.restore();
    } else {
      window.show();
    }
    window.focus();
  };

  const handleAboutClick = () => {
    const showAbout = getMenuAction('aboutPanel');
    if (showAbout) {
      showAbout.handler(window);
    }
  };

  const handleQuitClick = (): void => {
    // The running webpage can prevent the app from quitting via window.onbeforeunload handler
    // So let's use exit() instead of quit(), after the open windows are saved.
    void exitAppAfterSavingWindows();
  };

  trayIconInstance.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Open GogChat',
        click: handleOpenClick,
      },
      {
        type: 'separator',
      },
      {
        label: 'About',
        click: handleAboutClick,
      },
      {
        type: 'separator',
      },
      {
        label: 'Quit',
        click: handleQuitClick,
      },
    ])
  );

  trayIconInstance.setToolTip('GogChat');

  // macOS: Click on tray icon shows the window
  trayIconInstance.on('click', handleOpenClick);

  // Publish the instance so utils/platform/trayIconState.ts (consumed by badge
  // helpers) can toggle the tray unread dot without a feature→feature import.
  setTrayInstance(trayIconInstance);

  return trayIconInstance;
};

/**
 * Cleanup function for tray icon
 */
export function cleanupTrayIcon(): void {
  try {
    log.debug('[TrayIcon] Cleaning up tray icon');

    if (trayIconInstance && !trayIconInstance.isDestroyed()) {
      trayIconInstance.destroy();
      trayIconInstance = null;
    }

    // Clear shared tray-state reference so badge helpers no-op until next init.
    setTrayInstance(null);

    log.info('[TrayIcon] Tray icon cleaned up');
  } catch (error: unknown) {
    log.error('[TrayIcon] Failed to cleanup tray icon:', error);
  }
}
