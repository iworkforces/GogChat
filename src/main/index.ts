import type { BrowserWindow } from 'electron';
import { app } from 'electron';
import { perfMonitor } from './utils/lifecycle/performanceMonitor.js';

import { enforceSingleInstance } from './features/singleInstance.js';
import { setupDeepLinkListener } from './features/deepLinkHandler.js';
import { registerCleanupTask } from './utils/lifecycle/resourceCleanup.js';

import windowWrapper from './windowWrapper.js';

import { registerShutdownHandler } from './initializers/registerShutdown.js';
import { registerAppReady } from './initializers/registerAppReady.js';
import { APP_IDENTITY } from '../shared/appIdentity.js';
import { onDockActivate, setDockActivateMainWindowGetter } from './dockActivate.js';

// Cap V8 heap per renderer (default 512MB, conservative for Google Chat SPA).
// Must be set before app.ready per Electron docs. Replaces the previous anti-throttle
// flags (disable-background-timer-throttling / disable-renderer-backgrounding /
// disable-backgrounding-occluded-windows); throttling is now toggled per-window via
// `setBackgroundThrottling` so account-0 stays unthrottled for badge/notification
// reliability while accounts 1+ recover 5–15% renderer CPU when blurred.
//
// Allow override via env var `GOGCHAT_V8_HEAP_CAP_MB` (range 128–4096).
// Config store cannot be used here: it requires SafeStorage → app.ready, but
// `--js-flags` must be set before any chromium process starts.
const v8HeapCapMB = ((): number => {
  const env = process.env['GOGCHAT_V8_HEAP_CAP_MB'];
  if (env !== undefined) {
    const parsed = parseInt(env, 10);
    if (!isNaN(parsed) && parsed >= 128 && parsed <= 4096) {
      return parsed;
    }
  }
  return 512;
})();
app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${v8HeapCapMB}`);

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow: BrowserWindow | null = null;

// Initialize performance monitoring
perfMonitor.mark('app-start', 'App initialization started');

// Feature plan is generated at build time from src/main/initializers/*.spec.ts
// (see scripts/featurePlanPlugin.js). featureRunner walks it at runtime — no
// per-feature registration call lives here anymore.

if (enforceSingleInstance()) {
  // Register deep link listener BEFORE app.ready (macOS fires open-url early)
  setupDeepLinkListener();

  // Delegate app.whenReady() logic to initializer module
  registerAppReady({
    windowFactory: { createWindow: windowWrapper },
    setMainWindow: (win) => {
      mainWindow = win;
    },
    getMainWindow: () => mainWindow,
    registerCleanupTask,
  });
}

// ===== Shutdown Handler =====
registerShutdownHandler();

app.setAppUserModelId(APP_IDENTITY.appId);

// Dock click restores the existing window. The registered function is onDockActivate.
setDockActivateMainWindowGetter(() => mainWindow);
app.on('activate', onDockActivate);
