/**
 * Window utilities — merged module for windowWrapper.ts consumers.
 *
 * Combines three tightly-coupled window helpers:
 *   - Window defaults (store-backed boolean config)
 *   - Window event logging (visibility/focus lifecycle)
 *   - Window health monitoring (renderer/navigation/crash logging)
 */
import type { BrowserWindow, Event, WebContentsConsoleMessageEventParams } from 'electron';
import store from '../../config.js';
import { logger } from '../lifecycle/logger.js';
import {
  isBenignRendererConsoleMessage,
  isBenignSubframeLoadFailure,
} from '../ipc/benignLogFilter.js';
import { sanitizeLogUrl } from '../../../shared/logSanitizer.js';
import { asType } from '../../../shared/typeUtils.js';

const windowLogger = logger.window;

// ---------------------------------------------------------------------------
// Window defaults
// ---------------------------------------------------------------------------

export interface WindowDefaults {
  hideMenuBar: boolean;
  startHidden: boolean;
  disableSpellChecker: boolean;
}

/**
 * Read window-related defaults from the store.
 * Leaf utility — keeps windowWrapper.ts decoupled from the full config chain.
 */
export function getWindowDefaults(): WindowDefaults {
  return {
    hideMenuBar: asType<boolean>(store.get('app.hideMenuBar')),
    startHidden: asType<boolean>(store.get('app.startHidden')),
    disableSpellChecker: asType<boolean>(store.get('app.disableSpellChecker')),
  };
}

// ---------------------------------------------------------------------------
// Window event logging
// ---------------------------------------------------------------------------

function logState(event: string, window: BrowserWindow): void {
  windowLogger.debug(`${event} visible=${window.isVisible()} focused=${window.isFocused()}`);
}

/**
 * Attach debug-level logging for standard window lifecycle events.
 * Each handler logs event name plus current visible/focused state.
 */
export function attachEventLogging(window: BrowserWindow): void {
  window.on('show', () => logState('show', window));
  window.on('hide', () => logState('hide', window));
  window.on('focus', () => logState('focus', window));
  window.on('blur', () => logState('blur', window));
  window.on('minimize', () => logState('minimize', window));
  window.on('restore', () => logState('restore', window));
}

// ---------------------------------------------------------------------------
// Window health monitoring
// ---------------------------------------------------------------------------

/**
 * Attach health-monitoring handlers to a BrowserWindow's webContents:
 * console-message, did-fail-load, did-finish-load, did-navigate,
 * render-process-gone, unresponsive, responsive.
 */
export function attachHealthMonitoring(window: BrowserWindow): void {
  const { webContents } = window;

  webContents.on('console-message', (event: Event<WebContentsConsoleMessageEventParams>) => {
    if (isBenignRendererConsoleMessage(event.message, event.sourceId)) {
      windowLogger.debug('[Renderer:suppressed] [redacted]');
      return;
    }

    windowLogger.info(`[Renderer:${event.level}] [redacted]`);
  });

  webContents.on(
    'did-fail-load',
    (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
      if (isBenignSubframeLoadFailure(errorCode, validatedURL, isMainFrame)) {
        windowLogger.debug(
          `[Load] Suppressed expected subframe failure (${errorCode}) - ${sanitizeLogUrl(validatedURL)}`
        );
        return;
      }

      windowLogger.error(
        `[Load] FAILED ${isMainFrame ? '(main frame)' : '(subframe)'} (${errorCode}) — ${sanitizeLogUrl(validatedURL)}`
      );
    }
  );

  webContents.on('did-finish-load', () => {
    windowLogger.info(`[Load] did-finish-load: ${sanitizeLogUrl(webContents.getURL())}`);
  });

  webContents.on('did-navigate', (_event, navUrl, httpResponseCode) => {
    windowLogger.info(`[Nav] did-navigate: ${sanitizeLogUrl(navUrl)} (HTTP ${httpResponseCode})`);
  });

  webContents.on('render-process-gone', (_event, details) => {
    windowLogger.error(
      `[Renderer] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`
    );
  });

  webContents.on('unresponsive', () => {
    windowLogger.warn('[Renderer] unresponsive');
  });

  webContents.on('responsive', () => {
    windowLogger.info('[Renderer] responsive');
  });
}
