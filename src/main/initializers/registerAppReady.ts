/**
 * App Ready Initializer
 *
 * Encapsulates the app.whenReady() body that was previously inline in index.ts.
 * Handles error handler init, global cleanup registration, phased feature initialization,
 * store init, account window manager setup, icon cache warming, and deferred feature loading.
 *
 * The initialization order is security-critical — do not reorder phases.
 */

import { app, session, type BrowserWindow } from 'electron';
import log from 'electron-log';
import { sanitizeLogError } from '../../shared/logSanitizer.js';
import { perfMonitor } from '../utils/lifecycle/performanceMonitor.js';
import { initializeErrorHandler } from '../utils/lifecycle/errorHandler.js';

import {
  getAccountWindowManager,
  createAccountWindow,
  getWindowForAccount,
} from '../utils/account/accountWindowManager.js';
import { registerGlobalCleanups } from './registerGlobalCleanups.js';
import { initializeStore } from '../config.js';
import { prepareAccountWindows } from '../utils/account/accountWindowPersistenceBridge.js';
import { createTrackedInterval } from '../utils/lifecycle/resourceCleanup.js';
import environment from '../../environment.js';
import { runPhase } from '../utils/lifecycle/featureRunner.js';
import { isStartupAdmissionOpen } from '../utils/lifecycle/startupAdmission.js';
import type { FeatureContext, FeatureCallbacks } from '../utils/lifecycle/featureConfigTypes.js';
import { setSharedFeatureContext } from '../utils/lifecycle/featureContextStore.js';
import type { WindowFactory } from '../../shared/types/window.js';
import { asAccountIndex } from '../../shared/types/branded.js';
import {
  armPerformanceFinalizer,
  notifyDocumentLoadComplete,
} from '../utils/lifecycle/performanceFinalizer.js';

/**
 * Options for registerAppReady
 */
interface AppReadyOptions {
  /** Window factory for account window manager */
  windowFactory: WindowFactory;
  /** Callback to set the mainWindow reference in index.ts module scope */
  setMainWindow: (win: BrowserWindow | null) => void;
  /** Callback to get the mainWindow reference from index.ts module scope */
  getMainWindow: () => BrowserWindow | null;
  /** Cleanup-task registrar (delegates to resourceCleanup) */
  registerCleanupTask: (name: string, cleanup: () => void | Promise<void>) => void;
}

/**
 * Register the app.whenReady() handler with all initialization logic.
 *
 * This is the core app lifecycle handler extracted from index.ts.
 * Phases execute in order: security → critical → store → account windows → ui → deferred.
 */
export function registerAppReady(options: AppReadyOptions): void {
  const { windowFactory, setMainWindow, getMainWindow, registerCleanupTask } = options;

  // The runtime feature context is shared between phases (each phase mutates
  // it via callbacks.updateContext, e.g., trayIcon → badgeIcons).
  const context: FeatureContext = {};
  const callbacks: FeatureCallbacks = {
    setTrayIcon: () => {
      // Tray icon registration is purely contextual now (consumed via context.trayIcon).
    },
    registerCleanupTask,
    updateContext: (patch) => Object.assign(context, patch),
  };
  context.callbacks = callbacks;
  setSharedFeatureContext(context);

  app
    .whenReady()
    .then(async () => {
      if (!isStartupAdmissionOpen()) return;
      perfMonitor.mark('app-ready');

      // ===== INITIALIZE ERROR HANDLER =====
      try {
        initializeErrorHandler({
          gracefulShutdown: true,
        });
      } catch {
        log.error('[Main] Failed to initialize error handler');
      }

      // Register global cleanups + security phase in parallel:
      if (!isStartupAdmissionOpen()) return;
      // - registerGlobalCleanups: pure registration (no app.on, no network, no SafeStorage)
      // - security phase (cert pinning + permissions): independent of the cleanup registry
      await Promise.all([registerGlobalCleanups(), runPhase('security', context)]);
      if (!isStartupAdmissionOpen()) return;

      // ===== CRITICAL PHASE + STORE INIT (parallel) =====
      // initializeStore requires app.ready + SafeStorage but NOT cert pinning or userAgent.
      // The critical phase (userAgent override) is sync and independent of store init.
      try {
        await Promise.all([
          runPhase('critical', context),
          (async () => {
            if (!isStartupAdmissionOpen()) return;
            perfMonitor.mark('store-init-start');
            try {
              await initializeStore();
            } finally {
              if (isStartupAdmissionOpen()) {
                perfMonitor.mark('store-init-end');
              }
            }
          })(),
        ]);
        if (!isStartupAdmissionOpen()) return;
      } catch (error: unknown) {
        log.error('[Main] Failed to initialize critical phase or store');
        throw error;
      }

      // Copy legacy `window` into account 0 before any account window exists.
      // Repeat calls are idempotent and do not run from a getter.
      if (!isStartupAdmissionOpen()) return;
      await prepareAccountWindows();
      if (!isStartupAdmissionOpen()) return;

      // ===== ACCOUNT WINDOW MANAGER INITIALIZATION =====
      const accountWindowManager = getAccountWindowManager(windowFactory);
      if (!isStartupAdmissionOpen()) return;
      perfMonitor.mark('account-manager-init');

      // Preconnect on the network thread before BrowserWindow construction so
      // DNS + TCP + TLS handshake starts in parallel with renderer startup (~50-200 ms on cold).
      // Expanded set covers: chat app shell (mail.google.com), auth flow (accounts.google.com),
      // and static asset/font CDNs (ssl.gstatic.com for icons/scripts, fonts.gstatic.com for font binaries).
      // All preconnects are session-scoped and must use the same partition as the account-0 window.
      //
      // Kill switch: GOGCHAT_DISABLE_PRECONNECT=1 disables all preconnects so the CI perf harness
      // (and local benchmarking) can A/B-measure the cold-start contribution of preconnect warmup.
      // Defaults to enabled — leave the env var unset to preserve current behavior.
      const preconnectDisabled = process.env['GOGCHAT_DISABLE_PRECONNECT'] === '1';
      const account0Session = session.fromPartition('persist:account-0');
      if (!preconnectDisabled) {
        account0Session.preconnect({ url: 'https://mail.google.com', numSockets: 2 });
        account0Session.preconnect({ url: 'https://accounts.google.com', numSockets: 2 });
        account0Session.preconnect({ url: 'https://ssl.gstatic.com', numSockets: 1 });
        account0Session.preconnect({ url: 'https://fonts.gstatic.com', numSockets: 1 });
        // Preconnect Google Chat domains for parallel TLS handshake on cold start
        account0Session.preconnect({ url: 'https://chat.google.com', numSockets: 2 });
        account0Session.preconnect({ url: 'https://hangouts.google.com', numSockets: 1 });
        perfMonitor.mark('chat-preconnect');
      } else {
        perfMonitor.mark('chat-preconnect-skipped');
      }

      // Create account-0 window (primary window)
      if (!isStartupAdmissionOpen()) return;
      createAccountWindow(environment.appUrl, asAccountIndex(0));
      if (!isStartupAdmissionOpen()) return;
      accountWindowManager.markAsBootstrap(asAccountIndex(0));
      perfMonitor.mark('window-created');

      // Get the created window and use it as mainWindow for features
      // This preserves single-window behavior for account-0 while preparing for multi-account
      const mainWindow = getWindowForAccount(asAccountIndex(0));
      setMainWindow(mainWindow);

      // Update feature context with mainWindow and account manager
      context.mainWindow = mainWindow;
      context.accountWindowManager = accountWindowManager;
      perfMonitor.mark('account-0-ready');

      // Arm one-shot metrics finalization: export runs only after deferred
      // phase + document-load marker + immediate renderer sample. Document
      // load / account-0-ready are NOT first paint or first interaction.
      armPerformanceFinalizer({
        getAccountManager: () => accountWindowManager,
      });

      // Account-0 content-loaded marker — must listen on the **account**
      // WebContents (not host-only under WebContentsView). account-0-ready only
      // reflects window construction. One-shot so navigations don't re-mark.
      const account0Wc = accountWindowManager.getAccountWebContents(asAccountIndex(0));
      if (account0Wc && !account0Wc.isDestroyed()) {
        account0Wc.once('did-finish-load', () => {
          if (!isStartupAdmissionOpen()) return;
          perfMonitor.mark('account-0-content-loaded');
          notifyDocumentLoadComplete();
        });
        // do not force-fail the capture on did-fail-load: Google auth and
        // error pages still emit did-finish-load for the final document, and
        // intermediate redirects often surface as fail-load events. Hard
        // timeouts still mark the run invalid via the finalizer.
        account0Wc.on(
          'did-fail-load',
          (_event, errorCode, _errorDescription, _validatedURL, isMainFrame) => {
            if (!isStartupAdmissionOpen()) return;
            if (!isMainFrame) return;
            if (errorCode === -3 /* ERR_ABORTED */) return;
            log.warn(
              `[Main] Account-0 did-fail-load (non-terminal for metrics): code=${errorCode}`
            );
          }
        );
      } else {
        log.warn('[Main] No account-0 WebContents');
      }

      // ===== UI PHASE =====
      await runPhase('ui', context);
      if (!isStartupAdmissionOpen()) return;

      perfMonitor.mark('features-loaded');

      // ===== DEFERRED PHASE =====
      // Defer non-critical features using setImmediate.
      // warmInitialIcons is moved here (off the critical path) — the window icon (256.png)
      // is already loaded on-demand in windowWrapper via getIconCache().getIcon().
      // All other warmed icons are consumed by deferred-only features (tray, badges, inOnline).
      // Dynamic import keeps cacheWarmer + configProfiler out of lib/main/index.js
      // (mainBundleSize budget).
      setImmediate(() => {
        if (!isStartupAdmissionOpen()) return;
        void (async () => {
          const { warmInitialIcons, warmSoonDeferredIcons, runDeferredPhase } =
            await import('../utils/account/cacheWarmer.js');
          if (!isStartupAdmissionOpen()) return;
          warmInitialIcons();
          warmSoonDeferredIcons();

          // visibility: sample per-renderer memory every 60s so later
          // optimization phases (B/C) can be measured. Tracked via resourceCleanup
          // so it is torn down on app shutdown.
          if (!app.isPackaged) {
            createTrackedInterval(
              () => {
                if (!isStartupAdmissionOpen()) return;
                perfMonitor.sampleAllRenderers(accountWindowManager);
              },
              60 * 1000,
              'renderer-memory-sampling'
            );
          }

          await runDeferredPhase({
            context,
            getMainWindow,
            isDev: environment.isDev,
          });
        })().catch((error: unknown) => {
          log.error('[Main] Failed to initialize deferred features:', sanitizeLogError(error));
        });
      });
    })
    .catch(() => {
      log.error('[Main] Failed to initialize application');
      app.quit();
    });
}
