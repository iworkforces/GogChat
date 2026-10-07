/**
 * Account-window persistence: validation, legacy migration, restore, and saves.
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const h = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
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

import log from 'electron-log';
import { configSet } from '../../config.js';
import { TIMING } from '../../../shared/constants.js';
import { asAccountIndex } from '../../../shared/types/branded.js';
import { asType } from '../../../shared/typeUtils.js';
import type { AccountWindowState, AccountWindowsMap } from '../../../shared/types/window.js';
import { schema } from '../config/configSchema.js';
import {
  applyAccountWindowState,
  captureAccountWindowSnapshot,
  detachAllAccountWindowListeners,
  factoryAccountWindowState,
  flushAccountWindowsWrites,
  migrateLegacyWindowToAccountZero,
  persistAccountWindowState,
  readAccountWindowState,
  readNormalBounds,
  resetAccountWindowsStoreForTests,
  unwatchAccountWindow,
  updateAccountWindows,
  watchAccountWindow,
} from './accountWindowsStore.js';

interface FakeWindow {
  destroyed: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  maximized: boolean;
  getNormalBounds?: () => { x: number; y: number; width: number; height: number };
  setBounds: ReturnType<typeof vi.fn>;
  setSize: ReturnType<typeof vi.fn>;
  center: ReturnType<typeof vi.fn>;
  maximize: ReturnType<typeof vi.fn>;
  getBounds: () => { x: number; y: number; width: number; height: number };
  isMaximized: () => boolean;
  isDestroyed: () => boolean;
  emit: EventEmitter['emit'];
  on: EventEmitter['on'];
  removeListener: EventEmitter['removeListener'];
  listenerCount: EventEmitter['listenerCount'];
}

function fakeWindow(): FakeWindow {
  const emitter = new EventEmitter();
  const win: FakeWindow = {
    destroyed: false,
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    maximized: false,
    setBounds: vi.fn((bounds: { x: number; y: number; width: number; height: number }) => {
      win.bounds = { ...bounds };
    }),
    setSize: vi.fn(),
    center: vi.fn(),
    maximize: vi.fn(),
    getBounds: () => ({ ...win.bounds }),
    isMaximized: () => win.maximized,
    isDestroyed: () => win.destroyed,
    emit: emitter.emit.bind(emitter),
    on: emitter.on.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    listenerCount: emitter.listenerCount.bind(emitter),
  };
  return win;
}

function asWindow(win: FakeWindow): BrowserWindow {
  return asType<BrowserWindow>(win);
}

function valid(x: number, y: number, width = 900, height = 700): AccountWindowState {
  return { bounds: { x, y, width, height }, isMaximized: false };
}

beforeEach(async () => {
  for (const key of Object.keys(h.store)) delete h.store[key];
  vi.mocked(configSet).mockImplementation((key: string, value: unknown) => {
    h.store[key] = value;
  });
  vi.mocked(log.error).mockClear();
  await resetAccountWindowsStoreForTests();
  vi.useRealTimers();
});

afterEach(async () => {
  await resetAccountWindowsStoreForTests();
  vi.useRealTimers();
});

describe('accountWindowsStore validation', () => {
  it('uses the schema factory defaults', () => {
    const windowDefault = asType<{
      bounds: { x: number | null; y: number | null; width: number; height: number };
      isMaximized: boolean;
    }>(schema.window.default);
    expect(factoryAccountWindowState()).toEqual(windowDefault);
  });

  it('returns null for a missing map, a missing account, and a non-object map', () => {
    expect(readAccountWindowState(asAccountIndex(0))).toBeNull();
    h.store['accountWindows'] = {
      1: valid(1, 2, 500, 600),
    };
    expect(readAccountWindowState(asAccountIndex(0))).toBeNull();
    h.store['accountWindows'] = 'nope';
    expect(readAccountWindowState(asAccountIndex(0))).toBeNull();
    h.store['accountWindows'] = [];
    expect(readAccountWindowState(asAccountIndex(0))).toBeNull();
  });

  it('returns a copy of a valid entry and factory defaults for a malformed one', () => {
    const entry = valid(4, 5);
    h.store['accountWindows'] = { 0: entry };
    h.store['app'] = { autoCheckForUpdates: false };
    const read = readAccountWindowState(asAccountIndex(0));
    expect(read).toEqual(entry);
    expect(read).not.toBe(entry);
    expect(configSet).not.toHaveBeenCalled();

    const malformed = [
      { bounds: { x: Number.NaN, y: 1, width: 10, height: 10 }, isMaximized: false },
      { bounds: { x: 1, y: 1, width: 0, height: 10 }, isMaximized: false },
      { bounds: { x: 1, y: 1, width: -5, height: 10 }, isMaximized: false },
      { bounds: { x: 1, y: 1, width: 0.4, height: 10 }, isMaximized: false },
      { bounds: { x: 1, y: 1, width: Number.POSITIVE_INFINITY, height: 10 }, isMaximized: false },
      { bounds: { x: 1, y: 1, width: 10, height: 10 }, isMaximized: 1 },
      { bounds: [1, 2, 3, 4], isMaximized: false },
      { isMaximized: false },
    ];
    for (const entryValue of malformed) {
      h.store['accountWindows'] = { 0: entryValue, 2: valid(8, 9, 510, 610) };
      expect(readAccountWindowState(asAccountIndex(0))).toEqual(factoryAccountWindowState());
      expect(readAccountWindowState(asAccountIndex(2))).toEqual(valid(8, 9, 510, 610));
    }
    expect(h.store['app']).toEqual({ autoCheckForUpdates: false });
    expect(configSet).not.toHaveBeenCalled();
  });

  it('keeps a positive size that still rounds to at least one pixel', async () => {
    await persistAccountWindowState(asAccountIndex(0), {
      bounds: { x: 0, y: null, width: 0.5, height: 600 },
      isMaximized: false,
    });
    const stored = h.store['accountWindows'] as Record<number, AccountWindowState>;
    expect(stored[0]?.bounds.width).toBe(0.5);
    expect(stored[0]?.bounds.y).toBeNull();
  });
});

describe('accountWindowsStore migration', () => {
  it('does not copy the legacy window value from a getter', () => {
    h.store['window'] = valid(5, 6);
    expect(readAccountWindowState(asAccountIndex(0))).toBeNull();
    expect(configSet).not.toHaveBeenCalled();
  });

  it('copies a valid legacy window onto a missing account 0 and keeps other accounts', async () => {
    h.store['window'] = valid(5, 6);
    h.store['accountWindows'] = { 1: valid(1, 2, 500, 600) };
    h.store['app'] = { autoCheckForUpdates: false };
    await migrateLegacyWindowToAccountZero();
    const stored = h.store['accountWindows'] as Record<number, AccountWindowState>;
    expect(stored[0]).toEqual(valid(5, 6));
    expect(stored[1]).toEqual(valid(1, 2, 500, 600));
    expect(h.store['app']).toEqual({ autoCheckForUpdates: false });
    vi.mocked(configSet).mockClear();
    await migrateLegacyWindowToAccountZero();
    expect(configSet).not.toHaveBeenCalled();
  });

  it('leaves a valid account 0 in place and replaces only an invalid one', async () => {
    h.store['window'] = valid(5, 6);
    h.store['accountWindows'] = { 0: valid(40, 50, 880, 640) };
    await migrateLegacyWindowToAccountZero();
    expect(configSet).not.toHaveBeenCalled();
    expect((h.store['accountWindows'] as Record<number, AccountWindowState>)[0]).toEqual(
      valid(40, 50, 880, 640)
    );

    h.store['accountWindows'] = {
      0: { bounds: { x: 1, y: 1, width: 0, height: 10 }, isMaximized: false },
      1: valid(3, 4, 520, 620),
    };
    await migrateLegacyWindowToAccountZero();
    const stored = h.store['accountWindows'] as Record<number, AccountWindowState>;
    expect(stored[0]).toEqual(valid(5, 6));
    expect(stored[1]).toEqual(valid(3, 4, 520, 620));
  });

  it('does not write when the legacy window value is also unusable', async () => {
    h.store['window'] = { bounds: { x: 1, y: 1, width: 0, height: 10 }, isMaximized: false };
    await migrateLegacyWindowToAccountZero();
    expect(configSet).not.toHaveBeenCalled();
    expect(h.store['accountWindows']).toBeUndefined();
  });
});

describe('accountWindowsStore writes', () => {
  it('merges a sparse account and refuses a non-finite value', async () => {
    await persistAccountWindowState(asAccountIndex(0), valid(1, 2, 500, 600));
    await persistAccountWindowState(asAccountIndex(4), valid(8, 9, 510, 610));
    vi.mocked(configSet).mockClear();
    await persistAccountWindowState(asAccountIndex(4), {
      bounds: { x: Number.NaN, y: 1, width: 10, height: 10 },
      isMaximized: false,
    });
    expect(configSet).not.toHaveBeenCalled();
    const stored = h.store['accountWindows'] as Record<number, AccountWindowState>;
    expect(stored[0]).toEqual(valid(1, 2, 500, 600));
    expect(stored[4]).toEqual(valid(8, 9, 510, 610));
  });

  it('replaces an invalid sibling with factory defaults instead of writing NaN', async () => {
    h.store['app'] = { autoCheckForUpdates: false };
    h.store['accountWindows'] = {
      0: { bounds: { x: Number.NaN, y: 1, width: 10, height: 10 }, isMaximized: false },
    };
    await persistAccountWindowState(asAccountIndex(1), valid(3, 4, 520, 620));
    const stored = h.store['accountWindows'] as Record<number, AccountWindowState>;
    expect(stored[0]).toEqual(factoryAccountWindowState());
    expect(stored[1]).toEqual(valid(3, 4, 520, 620));
    expect(h.store['app']).toEqual({ autoCheckForUpdates: false });
    expect(stored[0]?.bounds.width).toBe(800);
    expect(stored[0]?.bounds.height).toBe(600);
    expect(Number.isFinite(stored[0]?.bounds.width)).toBe(true);
    expect(Number.isFinite(stored[1]?.bounds.x)).toBe(true);
  });

  it('drops non-index keys when persisting the map', async () => {
    await updateAccountWindows(() =>
      asType<AccountWindowsMap>({
        nope: valid(1, 1, 500, 600),
        '-1': valid(2, 2, 500, 600),
        2: valid(3, 4, 520, 620),
      })
    );
    const stored = h.store['accountWindows'] as Record<string, AccountWindowState>;
    expect(stored['nope']).toBeUndefined();
    expect(stored['-1']).toBeUndefined();
    expect(stored['2']).toEqual(valid(3, 4, 520, 620));
  });

  it('logs a failed write and still runs the next queued update', async () => {
    let failed = false;
    vi.mocked(configSet).mockImplementation((key: string, value: unknown) => {
      if (!failed) {
        failed = true;
        throw new Error('disk full');
      }
      h.store[key] = value;
    });
    const first = persistAccountWindowState(asAccountIndex(0), valid(1, 2, 500, 600));
    const second = persistAccountWindowState(asAccountIndex(2), valid(8, 9, 510, 610));
    await first;
    await second;
    expect(log.error).toHaveBeenCalledWith(
      '[AccountWindows] Failed to persist account window state:',
      expect.objectContaining({ message: '[redacted]' })
    );
    const stored = h.store['accountWindows'] as Record<number, AccountWindowState>;
    expect(stored[2]).toEqual(valid(8, 9, 510, 610));
    await expect(flushAccountWindowsWrites()).resolves.toBeUndefined();
  });

  it('replaces an array map with the next valid account', async () => {
    h.store['accountWindows'] = [];
    await persistAccountWindowState(asAccountIndex(2), valid(3, 4, 520, 620));
    expect(Array.isArray(h.store['accountWindows'])).toBe(false);
    expect((h.store['accountWindows'] as Record<number, AccountWindowState>)[2]).toEqual(
      valid(3, 4, 520, 620)
    );
  });
});

describe('accountWindowsStore restore', () => {
  it('does nothing when the account has no entry or the window is destroyed', () => {
    const win = fakeWindow();
    applyAccountWindowState(asWindow(win), asAccountIndex(0));
    expect(win.setBounds).not.toHaveBeenCalled();
    h.store['accountWindows'] = { 0: valid(1, 2) };
    win.destroyed = true;
    applyAccountWindowState(asWindow(win), asAccountIndex(0));
    expect(win.setBounds).not.toHaveBeenCalled();
  });

  it('centers when a coordinate is null and maximizes only after normal bounds are applied', () => {
    const centered = fakeWindow();
    h.store['accountWindows'] = {
      0: { bounds: { x: null, y: 12, width: 810.2, height: 610.8 }, isMaximized: false },
    };
    applyAccountWindowState(asWindow(centered), asAccountIndex(0));
    expect(centered.setSize).toHaveBeenCalledWith(810, 611);
    expect(centered.center).toHaveBeenCalledOnce();
    expect(centered.setBounds).not.toHaveBeenCalled();
    expect(centered.maximize).not.toHaveBeenCalled();

    const placed = fakeWindow();
    h.store['accountWindows'] = {
      3: { bounds: { x: 12.6, y: 8.2, width: 900, height: 700 }, isMaximized: true },
    };
    applyAccountWindowState(asWindow(placed), asAccountIndex(3));
    expect(placed.setBounds).toHaveBeenCalledWith({ x: 13, y: 8, width: 900, height: 700 });
    expect(placed.setBounds.mock.invocationCallOrder[0]).toBeLessThan(
      placed.maximize.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('applies factory defaults for a malformed saved entry', () => {
    const win = fakeWindow();
    h.store['accountWindows'] = {
      0: { bounds: { x: 1, y: 1, width: 0, height: 10 }, isMaximized: false },
    };
    applyAccountWindowState(asWindow(win), asAccountIndex(0));
    expect(win.setSize).toHaveBeenCalledWith(800, 600);
    expect(win.center).toHaveBeenCalledOnce();
    expect(configSet).not.toHaveBeenCalled();
  });

  it('prefers normal bounds over the maximized screen rect', () => {
    const win = fakeWindow();
    win.bounds = { x: 0, y: 0, width: 1440, height: 900 };
    win.maximized = true;
    win.getNormalBounds = () => ({ x: 30, y: 40, width: 960, height: 720 });
    expect(readNormalBounds(asWindow(win))).toEqual({
      bounds: { x: 30, y: 40, width: 960, height: 720 },
      isMaximized: true,
    });
    expect(captureAccountWindowSnapshot(asWindow(win)).bounds).toEqual({
      x: 30,
      y: 40,
      width: 960,
      height: 720,
    });
  });

  it('falls back when live bounds cannot be persisted', () => {
    const win = fakeWindow();
    win.bounds = { x: Number.NaN, y: 1, width: 10, height: 10 };
    expect(readNormalBounds(asWindow(win))).toBeNull();
    const captured = captureAccountWindowSnapshot(asWindow(win));
    expect(captured.bounds).toEqual({ x: 0, y: 1, width: 10, height: 10 });

    win.getBounds = () => {
      throw new Error('bounds unavailable');
    };
    expect(readNormalBounds(asWindow(win))).toBeNull();
    expect(captureAccountWindowSnapshot(asWindow(win)).bounds).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
    expect(log.error).toHaveBeenCalledWith(
      '[AccountWindows] Failed to persist account window state:',
      expect.objectContaining({ message: '[redacted]' })
    );
  });
});

describe('accountWindowsStore listeners', () => {
  it('saves on a leading resize, a trailing move, and immediate maximize or unmaximize', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const win = fakeWindow();
    watchAccountWindow(asWindow(win), asAccountIndex(2));
    win.bounds = { x: 11, y: 12, width: 640, height: 580 };
    win.emit('resize');
    await flushAccountWindowsWrites();
    expect((h.store['accountWindows'] as Record<number, AccountWindowState>)[2]?.bounds.x).toBe(11);

    vi.mocked(configSet).mockClear();
    win.bounds = { x: 15, y: 16, width: 650, height: 590 };
    win.emit('move');
    await flushAccountWindowsWrites();
    expect(configSet).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(TIMING.WINDOW_STATE_SAVE);
    await flushAccountWindowsWrites();
    expect((h.store['accountWindows'] as Record<number, AccountWindowState>)[2]?.bounds.x).toBe(15);

    vi.mocked(configSet).mockClear();
    win.emit('resize');
    win.bounds = { x: 21, y: 22, width: 660, height: 600 };
    win.maximized = true;
    win.emit('maximize');
    await flushAccountWindowsWrites();
    await vi.advanceTimersByTimeAsync(TIMING.WINDOW_STATE_SAVE);
    await flushAccountWindowsWrites();
    const maximized = (h.store['accountWindows'] as Record<number, AccountWindowState>)[2];
    expect(maximized).toEqual({
      bounds: { x: 21, y: 22, width: 660, height: 600 },
      isMaximized: true,
    });
    expect(vi.mocked(configSet).mock.calls.length).toBe(1);

    win.maximized = false;
    win.bounds = { x: 21, y: 22, width: 660, height: 600 };
    win.emit('unmaximize');
    await flushAccountWindowsWrites();
    expect((h.store['accountWindows'] as Record<number, AccountWindowState>)[2]?.isMaximized).toBe(
      false
    );
  });

  it('does not let a bounds handler stop later resize listeners', () => {
    const win = fakeWindow();
    const seen = vi.fn();
    watchAccountWindow(asWindow(win), asAccountIndex(0));
    win.on('resize', seen);
    win.isDestroyed = () => {
      throw new Error('destroyed check');
    };
    expect(() => win.emit('resize')).not.toThrow();
    expect(seen).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalled();
  });

  it('skips a destroyed window and detaches every watched listener', () => {
    const win = fakeWindow();
    watchAccountWindow(asWindow(win), asAccountIndex(0));
    watchAccountWindow(asWindow(win), asAccountIndex(1));
    expect(win.listenerCount('resize')).toBe(1);
    win.destroyed = true;
    win.emit('resize');
    unwatchAccountWindow(asWindow(win));
    expect(win.listenerCount('resize')).toBe(1);

    const other = fakeWindow();
    watchAccountWindow(asWindow(other), asAccountIndex(3));
    expect(other.listenerCount('move')).toBe(1);
    detachAllAccountWindowListeners();
    expect(other.listenerCount('move')).toBe(0);
    expect(other.listenerCount('maximize')).toBe(0);
    expect(other.listenerCount('unmaximize')).toBe(0);
    unwatchAccountWindow(asWindow(other));
  });
});
