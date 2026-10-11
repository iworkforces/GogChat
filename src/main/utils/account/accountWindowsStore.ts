/**
 * Owner of the `accountWindows` config map.
 *
 * Both account backends call this module for reads, writes, restore, and
 * move/resize listeners. It is loaded on demand so the size-capped main
 * bundle does not include restore or throttle logic. Callers must not
 * import it statically.
 *
 * Malformed entries fall back to the factory defaults at read time.
 * `configSchema.ts` stays loose: a schema violation makes electron-store
 * clear the whole encrypted config.
 *
 * @module accountWindowsStore
 */

import * as electron from 'electron';
import type { BrowserWindow } from 'electron';
import log from 'electron-log';
import { configGet, configSet } from '../../config.js';
import { TIMING } from '../../../shared/constants.js';
import { sanitizeLogError } from '../../../shared/logSanitizer.js';
import { asType } from '../../../shared/typeUtils.js';
import { asAccountIndex } from '../../../shared/types/branded.js';
import type { AccountIndex } from '../../../shared/types/branded.js';
import type { AccountWindowState, AccountWindowsMap } from '../../../shared/types/window.js';

/** Matches `configSchema.ts` window / accountWindows defaults. */
const FACTORY_WIDTH = 800;
const FACTORY_HEIGHT = 600;
/** A window must overlap a display by this much to count as on-screen. */
const MIN_VISIBLE_PX = 48;

interface Throttle {
  invoke: () => void;
  cancel: () => void;
}

interface WatchedWindow {
  accountIndex: AccountIndex;
  throttle: Throttle;
  onGeometry: () => void;
  onMaximize: () => void;
  onUnmaximize: () => void;
  onClose: () => void;
  onEnterFullScreen: () => void;
  onLeaveFullScreen: () => void;
}

export interface CapturedAccountWindow {
  bounds: { x: number; y: number; width: number; height: number };
  isMaximized: boolean;
  isFullScreen?: boolean;
}

let accountWindowsWriteQueue: Promise<void> = Promise.resolve();
const watchedWindows = new Map<BrowserWindow, WatchedWindow>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Coordinates may sit at the origin or off-screen. Sizes must survive `Math.round`. */
function isCoord(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isPositiveSize(value: unknown): value is number {
  return isFiniteNumber(value) && Math.round(value) >= 1;
}

function isAccountWindowState(value: unknown): value is AccountWindowState {
  if (!isRecord(value) || typeof value['isMaximized'] !== 'boolean') return false;
  const bounds = value['bounds'];
  if (!isRecord(bounds)) return false;
  return (
    isCoord(bounds['x']) &&
    isCoord(bounds['y']) &&
    isPositiveSize(bounds['width']) &&
    isPositiveSize(bounds['height'])
  );
}

export function factoryAccountWindowState(): AccountWindowState {
  return {
    bounds: { x: null, y: null, width: FACTORY_WIDTH, height: FACTORY_HEIGHT },
    isMaximized: false,
  };
}

function copyState(state: AccountWindowState): AccountWindowState {
  const next: AccountWindowState = {
    bounds: {
      x: state.bounds.x,
      y: state.bounds.y,
      width: state.bounds.width,
      height: state.bounds.height,
    },
    isMaximized: state.isMaximized,
  };
  // Omit a false flag so older saves stay identical. A non-boolean is dropped.
  if (state.isFullScreen === true) next.isFullScreen = true;
  return next;
}

function currentMap(): AccountWindowsMap {
  const stored = configGet('accountWindows');
  if (!isRecord(stored)) return {};
  return asType<AccountWindowsMap>(stored);
}

/**
 * Drop non-finite geometry before it reaches `configSet`. Invalid siblings
 * become factory defaults so a later save cannot re-submit them.
 */
function persistableMap(next: AccountWindowsMap): AccountWindowsMap {
  const clean: AccountWindowsMap = {};
  const record = asType<Record<string, unknown>>(next);
  for (const key of Object.keys(record)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) continue;
    const value = record[key];
    const accountIndex = asAccountIndex(index);
    clean[accountIndex] = isAccountWindowState(value)
      ? copyState(value)
      : factoryAccountWindowState();
  }
  return clean;
}

/**
 * Serialized read-modify-write for `accountWindows`. A failed `configSet`
 * is logged and the queue stays open for the next update.
 */
export function updateAccountWindows(
  updater: (current: AccountWindowsMap) => AccountWindowsMap
): Promise<void> {
  const run = accountWindowsWriteQueue.then(() => {
    const current = currentMap();
    const next = updater(current);
    if (next === current) return;
    configSet('accountWindows', persistableMap(next));
  });
  accountWindowsWriteQueue = run.catch((error: unknown) => {
    log.error('[AccountWindows] Failed to persist account window state:', sanitizeLogError(error));
  });
  return accountWindowsWriteQueue;
}

export function flushAccountWindowsWrites(): Promise<void> {
  return accountWindowsWriteQueue;
}

/**
 * `null` when the account has no entry. A present but malformed entry
 * returns factory defaults and does not write.
 */
export function readAccountWindowState(accountIndex: AccountIndex): AccountWindowState | null {
  const stored = configGet('accountWindows');
  if (!isRecord(stored)) return null;
  const record = asType<Record<string, unknown>>(stored);
  const key = String(accountIndex);
  if (!Object.hasOwn(record, key)) return null;
  const entry = record[key];
  if (!isAccountWindowState(entry)) return factoryAccountWindowState();
  return copyState(entry);
}

function boundsOf(window: BrowserWindow): { x: number; y: number; width: number; height: number } {
  if (typeof window.getNormalBounds === 'function') {
    return window.getNormalBounds();
  }
  return window.getBounds();
}

/**
 * Normal bounds (not the maximized screen rect) plus the maximized flag.
 * Returns `null` when the live numbers cannot be persisted.
 */
export function readNormalBounds(window: BrowserWindow): AccountWindowState | null {
  try {
    const raw = boundsOf(window);
    const state: AccountWindowState = {
      bounds: { x: raw.x, y: raw.y, width: raw.width, height: raw.height },
      isMaximized: window.isMaximized() === true,
    };
    if (typeof window.isFullScreen === 'function' && window.isFullScreen()) {
      state.isFullScreen = true;
    }
    return isAccountWindowState(state) ? state : null;
  } catch (error: unknown) {
    log.error('[AccountWindows] Failed to persist account window state:', sanitizeLogError(error));
    return null;
  }
}

export function captureAccountWindowSnapshot(window: BrowserWindow): CapturedAccountWindow {
  const captured = readNormalBounds(window);
  const x = captured?.bounds.x;
  const y = captured?.bounds.y;
  if (captured && typeof x === 'number' && typeof y === 'number') {
    return {
      bounds: { x, y, width: captured.bounds.width, height: captured.bounds.height },
      isMaximized: captured.isMaximized,
      ...(captured.isFullScreen === true ? { isFullScreen: true } : {}),
    };
  }
  let raw: { x: number; y: number; width: number; height: number } = {
    x: 0,
    y: 0,
    width: FACTORY_WIDTH,
    height: FACTORY_HEIGHT,
  };
  try {
    raw = window.getBounds();
  } catch (error: unknown) {
    log.error('[AccountWindows] Failed to persist account window state:', sanitizeLogError(error));
  }
  const fallback: CapturedAccountWindow = {
    bounds: {
      x: isFiniteNumber(raw.x) ? raw.x : 0,
      y: isFiniteNumber(raw.y) ? raw.y : 0,
      width: isPositiveSize(raw.width) ? raw.width : FACTORY_WIDTH,
      height: isPositiveSize(raw.height) ? raw.height : FACTORY_HEIGHT,
    },
    isMaximized: window.isMaximized() === true,
  };
  if (typeof window.isFullScreen === 'function' && window.isFullScreen()) {
    fallback.isFullScreen = true;
  }
  return fallback;
}

export function persistAccountWindowState(
  accountIndex: AccountIndex,
  state: unknown
): Promise<void> {
  if (!isAccountWindowState(state)) return Promise.resolve();
  const snapshot = copyState(state);
  return updateAccountWindows((current) => ({
    ...current,
    [accountIndex]: snapshot,
  }));
}

/**
 * Copy the legacy `window` value onto account 0 when that entry is missing
 * or invalid. A valid account-0 entry is left untouched, including on repeat
 * calls. Does not run from a getter.
 */
export function migrateLegacyWindowToAccountZero(): Promise<void> {
  const accountZero = asAccountIndex(0);
  return updateAccountWindows((current) => {
    if (isAccountWindowState(current[accountZero])) return current;
    const legacy = configGet('window');
    if (!isAccountWindowState(legacy)) return current;
    return { ...current, [accountZero]: copyState(legacy) };
  });
}

interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlapsDisplay(bounds: WorkArea, area: WorkArea): boolean {
  const overlapWidth =
    Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
  const overlapHeight =
    Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
  return overlapWidth >= MIN_VISIBLE_PX && overlapHeight >= MIN_VISIBLE_PX;
}

/**
 * Keep bounds that meet a display. Otherwise center them on the primary
 * work area, shrinking only when they are larger than that area.
 * A missing `screen` (unit mocks) leaves the saved rect unchanged.
 */
function clampOntoADisplay(bounds: WorkArea): WorkArea {
  try {
    const screen = electron.screen;
    if (typeof screen?.getAllDisplays !== 'function') return bounds;
    const displays = screen.getAllDisplays();
    if (!Array.isArray(displays) || displays.length === 0) return bounds;
    for (const display of displays) {
      if (display.workArea && overlapsDisplay(bounds, display.workArea)) return bounds;
    }
    const area =
      typeof screen.getPrimaryDisplay === 'function' ? screen.getPrimaryDisplay()?.workArea : null;
    if (!area || area.width < 1 || area.height < 1) return bounds;
    const width = Math.min(bounds.width, area.width);
    const height = Math.min(bounds.height, area.height);
    return {
      x: area.x + Math.max(0, Math.round((area.width - width) / 2)),
      y: area.y + Math.max(0, Math.round((area.height - height) / 2)),
      width,
      height,
    };
  } catch (error: unknown) {
    log.error('[AccountWindows] Failed to place window on a display:', sanitizeLogError(error));
    return bounds;
  }
}

/**
 * Place `window` on its saved normal bounds, then maximize or fullscreen.
 * `setBounds` before `maximize` is what makes a later unmaximize return
 * to those normal bounds. Null coordinates center at the saved size.
 * Fullscreen wins over maximize. No-op when the account has no saved entry.
 * Call before the first show.
 */
export function applyAccountWindowState(window: BrowserWindow, accountIndex: AccountIndex): void {
  if (window.isDestroyed()) return;
  const state = readAccountWindowState(accountIndex);
  if (!state) return;
  const width = Math.round(state.bounds.width);
  const height = Math.round(state.bounds.height);
  const { x, y } = state.bounds;
  if (x === null || y === null) {
    window.setSize(width, height);
    window.center();
  } else {
    window.setBounds(clampOntoADisplay({ x: Math.round(x), y: Math.round(y), width, height }));
  }
  if (state.isFullScreen === true && typeof window.setFullScreen === 'function') {
    window.setFullScreen(true);
    return;
  }
  if (state.isMaximized) {
    window.maximize();
  }
}

function createThrottle(wait: number, fn: () => void): Throttle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: number | null = null;
  return {
    invoke(): void {
      const now = Date.now();
      const remaining = last === null ? 0 : wait - (now - last);
      if (last === null || remaining <= 0) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        last = now;
        fn();
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn();
      }, remaining);
    },
    cancel(): void {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function saveWatchedWindow(window: BrowserWindow, accountIndex: AccountIndex): void {
  try {
    if (window.isDestroyed()) return;
    const state = readNormalBounds(window);
    if (!state) return;
    void persistAccountWindowState(accountIndex, state);
  } catch (error: unknown) {
    log.error('[AccountWindows] Failed to persist account window state:', sanitizeLogError(error));
  }
}

export function watchAccountWindow(window: BrowserWindow, accountIndex: AccountIndex): void {
  unwatchAccountWindow(window);
  const throttle = createThrottle(TIMING.WINDOW_STATE_SAVE, () => {
    saveWatchedWindow(window, accountIndex);
  });
  const onGeometry = (): void => {
    throttle.invoke();
  };
  const onMaximize = (): void => {
    throttle.cancel();
    saveWatchedWindow(window, accountIndex);
  };
  const onUnmaximize = (): void => {
    throttle.cancel();
    saveWatchedWindow(window, accountIndex);
  };
  // `close` still has a live window. `closed` is too late: unwatch cancels the timer.
  const onClose = (): void => {
    throttle.cancel();
    saveWatchedWindow(window, accountIndex);
  };
  const onEnterFullScreen = (): void => {
    throttle.cancel();
    saveWatchedWindow(window, accountIndex);
  };
  const onLeaveFullScreen = (): void => {
    throttle.cancel();
    saveWatchedWindow(window, accountIndex);
  };
  window.on('resize', onGeometry);
  window.on('move', onGeometry);
  window.on('maximize', onMaximize);
  window.on('unmaximize', onUnmaximize);
  window.on('close', onClose);
  window.on('enter-full-screen', onEnterFullScreen);
  window.on('leave-full-screen', onLeaveFullScreen);
  watchedWindows.set(window, {
    accountIndex,
    throttle,
    onGeometry,
    onMaximize,
    onUnmaximize,
    onClose,
    onEnterFullScreen,
    onLeaveFullScreen,
  });
}

/** Read every watched window now. A pending move/resize timer is cancelled first. */
export function captureWatchedAccountWindows(): void {
  for (const [window, watched] of watchedWindows) {
    watched.throttle.cancel();
    saveWatchedWindow(window, watched.accountIndex);
  }
}

export function unwatchAccountWindow(window: BrowserWindow): void {
  const watched = watchedWindows.get(window);
  if (!watched) return;
  watched.throttle.cancel();
  watchedWindows.delete(window);
  try {
    if (window.isDestroyed()) return;
    window.removeListener('resize', watched.onGeometry);
    window.removeListener('move', watched.onGeometry);
    window.removeListener('maximize', watched.onMaximize);
    window.removeListener('unmaximize', watched.onUnmaximize);
    window.removeListener('close', watched.onClose);
    window.removeListener('enter-full-screen', watched.onEnterFullScreen);
    window.removeListener('leave-full-screen', watched.onLeaveFullScreen);
  } catch (error: unknown) {
    // Later watched windows still detach when this one cannot answer isDestroyed.
    log.error(
      '[AccountWindows] Failed to detach account window listeners:',
      sanitizeLogError(error)
    );
  }
}

export function detachAllAccountWindowListeners(): void {
  for (const window of [...watchedWindows.keys()]) {
    unwatchAccountWindow(window);
  }
}

export async function resetAccountWindowsStoreForTests(): Promise<void> {
  detachAllAccountWindowListeners();
  await accountWindowsWriteQueue;
  accountWindowsWriteQueue = Promise.resolve();
}

/**
 * Single dynamic-import binding for the static bridge.
 * Short keys keep those names out of the size-capped entry bundle.
 */
export function accountWindowApi(): {
  migrate: () => Promise<void>;
  apply: (window: BrowserWindow, accountIndex: AccountIndex) => void;
  watch: (window: BrowserWindow, accountIndex: AccountIndex) => void;
  unwatch: (window: BrowserWindow) => void;
  read: (accountIndex: AccountIndex) => AccountWindowState | null;
  bounds: (window: BrowserWindow) => AccountWindowState | null;
  capture: (window: BrowserWindow) => CapturedAccountWindow;
  persist: (accountIndex: AccountIndex, state: unknown) => Promise<void>;
  flush: () => Promise<void>;
  detach: () => void;
  reset: () => Promise<void>;
} {
  return {
    migrate: migrateLegacyWindowToAccountZero,
    apply: applyAccountWindowState,
    watch: watchAccountWindow,
    unwatch: unwatchAccountWindow,
    read: readAccountWindowState,
    bounds: readNormalBounds,
    capture: captureAccountWindowSnapshot,
    persist: persistAccountWindowState,
    flush: flushAccountWindowsWrites,
    detach: detachAllAccountWindowListeners,
    reset: resetAccountWindowsStoreForTests,
  };
}
