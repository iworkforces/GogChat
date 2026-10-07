/**
 * Static entry for account-window persistence.
 *
 * The restore, migration, and listener implementation is loaded on demand
 * from `accountWindowsStore.ts` so it stays out of `lib/main/index.js`.
 * This module must not be imported by that store (the dynamic import is one-way).
 *
 * @module accountWindowPersistenceBridge
 */

import type { BrowserWindow } from 'electron';
import { registerCleanupTask } from '../lifecycle/resourceCleanup.js';
import type { AccountIndex } from '../../../shared/types/branded.js';
import type { AccountWindowState } from '../../../shared/types/window.js';

interface CapturedAccountWindow {
  bounds: { x: number; y: number; width: number; height: number };
  isMaximized: boolean;
  isFullScreen?: boolean;
}

/** Short keys match `accountWindowApi()` so this file does not repeat export names. */
interface AccountWindowApi {
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
}

let api: AccountWindowApi | null = null;
let loading: Promise<AccountWindowApi> | null = null;
let preparing: Promise<void> | null = null;
let tail: Promise<void> = Promise.resolve();
let cleanupRegistered = false;

function loadApi(): Promise<AccountWindowApi> {
  if (!loading) {
    loading = import('./accountWindowsStore.js').then((mod) => {
      const loaded = mod.accountWindowApi();
      api = loaded;
      return loaded;
    });
  }
  return loading;
}

function geometryFromWindow(window: BrowserWindow): CapturedAccountWindow {
  const bounds = window.getBounds();
  return {
    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    isMaximized: window.isMaximized() === true,
  };
}

/**
 * Idempotent startup step: install listener cleanup, then copy a legacy
 * `window` value onto account 0 when that entry is missing or invalid.
 */
export function prepareAccountWindows(): Promise<void> {
  if (!preparing) {
    preparing = loadApi().then(async (loaded) => {
      if (!cleanupRegistered) {
        cleanupRegistered = true;
        registerCleanupTask('accountWindowState', () => {
          loaded.detach();
        });
      }
      await loaded.migrate();
    });
  }
  return preparing;
}

export function applyAccountWindowState(window: BrowserWindow, accountIndex: AccountIndex): void {
  api?.apply(window, accountIndex);
}

export function watchAccountWindow(window: BrowserWindow, accountIndex: AccountIndex): void {
  api?.watch(window, accountIndex);
}

export function unwatchAccountWindow(window: BrowserWindow): void {
  api?.unwatch(window);
}

export function readAccountWindowState(accountIndex: AccountIndex): AccountWindowState | null {
  if (!api) return null;
  return api.read(accountIndex);
}

export function readNormalBounds(window: BrowserWindow): AccountWindowState | null {
  if (api) return api.bounds(window);
  return geometryFromWindow(window);
}

export function captureAccountWindowSnapshot(window: BrowserWindow): CapturedAccountWindow {
  if (api) return api.capture(window);
  return geometryFromWindow(window);
}

/** Capture already happened. Queues a validated write; skips non-finite geometry. */
export function submitAccountWindowState(
  accountIndex: AccountIndex,
  state: AccountWindowState
): void {
  if (api) {
    void api.persist(accountIndex, state);
    return;
  }
  const run = tail.then(async () => {
    const loaded = await loadApi();
    await loaded.persist(accountIndex, state);
  });
  tail = run.then(
    () => undefined,
    () => undefined
  );
}

export function flushAccountWindowPersistence(): Promise<void> {
  return tail.then(async () => {
    const loaded = await loadApi();
    await loaded.flush();
  });
}

export function detachAccountWindowListeners(): void {
  api?.detach();
}

export async function resetAccountWindowPersistenceForTests(): Promise<void> {
  if (api) await api.reset();
  preparing = null;
  cleanupRegistered = false;
  tail = Promise.resolve();
}
