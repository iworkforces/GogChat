/**
 * Deferred phase feature specs.
 *
 * Consolidates the previous deferredSystem / deferredWindow / deferredNetwork
 * registration modules into one declarative array. Loaded via setImmediate
 * after the main window is ready. Side effects (setTrayIcon, registerCleanupTask,
 * updateContext) are routed through the `callbacks` slot on FeatureContext.
 */

import type { Tray } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants.js';
import type { FeatureSpec } from '../utils/lifecycle/featureConfigTypes.js';
import { SUPPORTED_PLATFORM_NAMES } from '../utils/platform/platformDetection.js';

export const DEFERRED_FEATURES = [
  // Registers About menu action (native aurora window); tray + menu depend on it
  {
    name: 'aboutPanel',
    phase: 'deferred',
    description: 'Native About window menu action',
    init: async () => {
      await import('../features/aboutPanel.js');
    },
  },
  // System: tray icon — other tray-dependent features depend on it
  {
    name: 'trayIcon',
    phase: 'deferred',
    dependencies: ['aboutPanel'],
    description: 'System tray icon',
    init: async ({ mainWindow, callbacks }) => {
      if (!mainWindow) return;
      const module = await import('../features/trayIcon.js');
      const icon = module.default(mainWindow);
      callbacks?.setTrayIcon(icon);
      callbacks?.updateContext({ trayIcon: icon });
    },
  },
  {
    name: 'badgeIcons',
    phase: 'deferred',
    dependencies: ['trayIcon'],
    description: 'Badge/overlay icon for unread count',
    ipcChannels: {
      listen: [IPC_CHANNELS.FAVICON_CHANGED, IPC_CHANNELS.UNREAD_COUNT],
    },
    init: async ({ mainWindow, trayIcon }) => {
      if (!mainWindow || !trayIcon) return;
      const module = await import('../features/badgeIcon.js');
      module.default(mainWindow, trayIcon);
    },
  },
  {
    name: 'bootstrapPromotion',
    phase: 'deferred',
    description: 'Bootstrap window promotion after first login',
    init: async () => {
      const module = await import('../features/bootstrapPromotion.js');
      module.default();
    },
  },
  {
    name: 'windowState',
    phase: 'deferred',
    dependencies: ['singleInstance', 'deepLinkHandler', 'bootstrapPromotion'],
    description: 'Window state persistence',
    init: async ({ accountWindowManager }) => {
      const module = await import('../features/windowState.js');
      module.default(accountWindowManager ? { accountWindowManager } : {});
    },
  },
  {
    name: 'openAtLogin',
    phase: 'deferred',
    platforms: [SUPPORTED_PLATFORM_NAMES.macOS],
    description: 'Auto-launch on system startup',
    init: async (context) => {
      const module = await import('../features/openAtLogin.js');
      module.default(context);
    },
  },
  {
    name: 'appUpdates',
    phase: 'deferred',
    description: 'Update notification system',
    init: async () => {
      const module = await import('../features/appUpdates.js');
      module.default();
    },
  },
  {
    name: 'firstLaunch',
    phase: 'deferred',
    description: 'First launch logging',
    init: async () => {
      const module = await import('../features/firstLaunch.js');
      module.default();
    },
  },
  {
    name: 'enforceMacOSAppLocation',
    phase: 'deferred',
    platforms: [SUPPORTED_PLATFORM_NAMES.macOS],
    description: 'macOS app location enforcement',
    init: async () => {
      const module = await import('../utils/platform/platformHelpers.js');
      module.enforceMacOSAppLocation();
    },
  },
  // Window: features that need a main window
  {
    name: 'appMenu',
    phase: 'deferred',
    dependencies: ['openAtLogin', 'externalLinks', 'appUpdates', 'aboutPanel'],
    description: 'Application menu',
    ipcChannels: {
      emit: [IPC_CHANNELS.SEARCH_SHORTCUT],
    },
    init: async ({ mainWindow }) => {
      if (!mainWindow) return;
      const module = await import('../features/appMenu.js');
      module.default(mainWindow);
    },
  },
  {
    name: 'passkeySupport',
    phase: 'deferred',
    description: 'Passkey/WebAuthn support',
    ipcChannels: {
      listen: [IPC_CHANNELS.PASSKEY_AUTH_FAILED],
    },
    init: async ({ mainWindow }) => {
      if (!mainWindow) return;
      const module = await import('../features/passkeySupport.js');
      module.default(mainWindow);
    },
  },
  {
    name: 'handleNotification',
    phase: 'deferred',
    description: 'Native notification handler',
    ipcChannels: {
      listen: [IPC_CHANNELS.NOTIFICATION_SHOW, IPC_CHANNELS.NOTIFICATION_CLICKED],
    },
    init: async ({ mainWindow }) => {
      if (!mainWindow) return;
      const module = await import('../features/handleNotification.js');
      module.default(mainWindow);
    },
  },
  {
    name: 'externalLinks',
    phase: 'deferred',
    dependencies: ['bootstrapPromotion'],
    description: 'External links handler',
    init: async ({ mainWindow }) => {
      if (!mainWindow) return;
      const module = await import('../features/externalLinks.js');
      module.default(mainWindow);
    },
  },
  {
    name: 'closeToTray',
    phase: 'deferred',
    dependencies: ['trayIcon'],
    description: 'Close to tray behavior',
    init: async ({ mainWindow }) => {
      if (!mainWindow) return;
      const module = await import('../features/closeToTray.js');
      module.default(mainWindow);
    },
  },
  {
    name: 'contextMenu',
    phase: 'deferred',
    description: 'Right-click context menu',
    init: async ({ callbacks }) => {
      const module = await import('../features/contextMenu.js');
      const cleanup = module.default();
      if (typeof cleanup === 'function') {
        callbacks?.registerCleanupTask('contextMenu', cleanup);
      }
    },
  },
  // Network: connectivity monitoring
  {
    name: 'inOnline',
    phase: 'deferred',
    description: 'Internet connectivity monitoring',
    ipcChannels: {
      listen: [IPC_CHANNELS.CHECK_IF_ONLINE],
      emit: [IPC_CHANNELS.ONLINE_STATUS],
    },
    init: async ({ accountWindowManager, callbacks }) => {
      if (!accountWindowManager) return;
      const module = await import('../features/inOnline.js');
      module.default();
      const dispose = module.scheduleInitialConnectivity(accountWindowManager);
      callbacks?.registerCleanupTask('inOnline', dispose);
    },
  },
  // Telemetry: after shell UI batch (appMenu) so CDP does not race first paint path
  {
    name: 'cdpTelemetry',
    phase: 'deferred',
    required: false,
    dependencies: ['appMenu'],
    description: 'Local-only Chrome DevTools Protocol RUM telemetry',
    init: async ({ accountWindowManager, callbacks }) => {
      const module = await import('../features/cdpTelemetry.js');
      const cleanup = await module.default(accountWindowManager);
      if (typeof cleanup === 'function') {
        callbacks?.registerCleanupTask('cdpTelemetry', cleanup);
      }
    },
  },
] as const satisfies readonly FeatureSpec[];

// Re-export for type inference completeness in callsites that import callbacks
export type { Tray };
