/**
 * The static bridge loads account-window persistence on demand and
 * registers listener cleanup once.
 */

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const h = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
}));

vi.mock('electron', () => ({
  screen: {
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
}));

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  configGet: vi.fn((key: string) => h.store[key]),
  configSet: vi.fn((key: string, value: unknown) => {
    h.store[key] = value;
  }),
}));

import { asAccountIndex } from '../../../shared/types/branded.js';
import { asType } from '../../../shared/typeUtils.js';
import type { AccountWindowState } from '../../../shared/types/window.js';
import { getCleanupManager } from '../lifecycle/resourceCleanup.js';
import {
  applyAccountWindowState,
  captureAccountWindowSnapshot,
  detachAccountWindowListeners,
  flushAccountWindowPersistence,
  prepareAccountWindows,
  readAccountWindowState,
  readNormalBounds,
  resetAccountWindowPersistenceForTests,
  submitAccountWindowState,
} from './accountWindowPersistenceBridge.js';

function fakeWindow(): BrowserWindow & {
  bounds: { x: number; y: number; width: number; height: number };
  setBounds: ReturnType<typeof vi.fn>;
  listenerCount: (event: string) => number;
} {
  const emitter = new EventEmitter();
  const win = {
    destroyed: false,
    bounds: { x: 3, y: 4, width: 820, height: 640 },
    maximized: false,
    setBounds: vi.fn(),
    setSize: vi.fn(),
    center: vi.fn(),
    maximize: vi.fn(),
    getBounds() {
      return { ...this.bounds };
    },
    isMaximized() {
      return this.maximized;
    },
    isDestroyed() {
      return this.destroyed;
    },
    on: emitter.on.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    listenerCount: emitter.listenerCount.bind(emitter),
    emit: emitter.emit.bind(emitter),
  };
  return asType<
    BrowserWindow & {
      bounds: { x: number; y: number; width: number; height: number };
      setBounds: ReturnType<typeof vi.fn>;
      listenerCount: (event: string) => number;
    }
  >(win);
}

const saved: AccountWindowState = {
  bounds: { x: 12, y: 18, width: 900, height: 700 },
  isMaximized: false,
};

describe('accountWindowPersistenceBridge', () => {
  beforeEach(async () => {
    for (const key of Object.keys(h.store)) delete h.store[key];
    await resetAccountWindowPersistenceForTests();
    getCleanupManager().reset();
  });

  it('queues a write before the persistence module is installed', async () => {
    const win = fakeWindow();
    expect(readAccountWindowState(asAccountIndex(0))).toBeNull();
    applyAccountWindowState(win, asAccountIndex(0));
    expect(win.setBounds).not.toHaveBeenCalled();
    detachAccountWindowListeners();
    expect(captureAccountWindowSnapshot(win).bounds).toEqual(win.bounds);
    expect(readNormalBounds(win)?.bounds).toEqual(win.bounds);
    submitAccountWindowState(asAccountIndex(4), saved);
    await flushAccountWindowPersistence();
    const stored = h.store['accountWindows'] as Record<number, AccountWindowState>;
    expect(stored[4]).toEqual(saved);
  });

  it('migrates once per prepare and restores after the module is installed', async () => {
    h.store['window'] = saved;
    await prepareAccountWindows();
    await prepareAccountWindows();
    const stored = h.store['accountWindows'] as Record<number, AccountWindowState>;
    expect(stored[0]).toEqual(saved);
    const win = fakeWindow();
    applyAccountWindowState(win, asAccountIndex(0));
    expect(win.setBounds).toHaveBeenCalledWith({ x: 12, y: 18, width: 900, height: 700 });
    expect(readAccountWindowState(asAccountIndex(0))).toEqual(saved);
  });

  it('removes watched listeners from the registered cleanup task', async () => {
    h.store['accountWindows'] = { 0: saved };
    await prepareAccountWindows();
    const win = fakeWindow();
    const { watchAccountWindow } = await import('./accountWindowsStore.js');
    watchAccountWindow(win, asAccountIndex(0));
    expect(win.listenerCount('resize')).toBe(1);
    await getCleanupManager().cleanup({ includeGlobalResources: false, logDetails: false });
    expect(win.listenerCount('resize')).toBe(0);
    expect(win.listenerCount('maximize')).toBe(0);
  });

  it('runs migration again after a test reset', async () => {
    h.store['window'] = saved;
    await prepareAccountWindows();
    delete h.store['accountWindows'];
    await resetAccountWindowPersistenceForTests();
    getCleanupManager().reset();
    await prepareAccountWindows();
    expect((h.store['accountWindows'] as Record<number, AccountWindowState>)[0]).toEqual(saved);
  });
});
