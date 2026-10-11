import log from 'electron-log';
import { sanitizeLogError } from '../../shared/logSanitizer.js';
import type { IAccountWindowManager } from '../../shared/types/window.js';
import {
  detachAccountWindowListeners,
  prepareAccountWindows,
} from '../utils/account/accountWindowPersistenceBridge.js';

interface WindowStateContext {
  accountWindowManager?: IAccountWindowManager;
}

/**
 * Account-window bounds are owned by `accountWindowsStore`. This feature
 * only makes sure startup migration has run and that shutdown can detach
 * the listeners. It does not write the legacy `window` key.
 */
export default async function persistWindowState(_context: WindowStateContext = {}): Promise<void> {
  try {
    await prepareAccountWindows();
  } catch (error: unknown) {
    log.error('[WindowState] Failed to initialize window state:', sanitizeLogError(error));
  }
}

/** Detach bounds listeners. Safe to call more than once. */
export function cleanupWindowState(_context: WindowStateContext = {}): void {
  try {
    detachAccountWindowListeners();
  } catch (error: unknown) {
    log.error('[WindowState] Failed to cleanup window state:', sanitizeLogError(error));
  }
}
