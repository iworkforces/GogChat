/**
 * Unit tests for AccountWindowRegistry — window registration, lookup, lifecycle
 *
 * Covers: registerWindow, unregisterAccount, getAccountIndex, getAccountWindow,
 * getAccountWebContents, getAccountForWebContents, getAllWindows, getMostRecentWindow,
 * hasAccount, getAccountCount, destroyAll, event listener management.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
vi.mock('electron', () => require('../../../../tests/mocks/electron'));
vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AccountWindowRegistry } from './accountWindowRegistry';
import { MockBrowserWindow } from '../../../../tests/mocks/electron';
import type { BrowserWindow } from 'electron';
import { asAccountIndex, asWebContentsId } from '../../../shared/types/branded.js';
import { asType } from '../../../shared/typeUtils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextWebContentsId = 1000;

function makeTypedWindow(): BrowserWindow {
  const win = new MockBrowserWindow();
  (win.webContents as unknown as { id: number }).id = nextWebContentsId++;
  return win as unknown as BrowserWindow;
}

// ---------------------------------------------------------------------------
// registerWindow
// ---------------------------------------------------------------------------

describe('AccountWindowRegistry — registerWindow', () => {
  let registry: AccountWindowRegistry;

  beforeEach(() => {
    nextWebContentsId = 1000;
    registry = new AccountWindowRegistry();
  });

  it('registers a window and sets up reverse lookup', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 0);
    expect(registry.getAccountIndex(win)).toBe(0);
    expect(registry.getAccountWindow(0)).toBe(win);
  });

  it('re-registration with different index removes old index entry', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 0);
    expect(registry.getAccountWindow(0)).toBe(win);

    registry.registerWindow(win, 5);
    expect(registry.getAccountWindow(0)).toBeNull();
    expect(registry.getAccountWindow(5)).toBe(win);
    expect(registry.getAccountIndex(win)).toBe(5);
  });

  it('re-registration with same index is idempotent', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 0);
    registry.registerWindow(win, 0);
    expect(registry.getAccountIndex(win)).toBe(0);
    expect(registry.getAccountCount()).toBe(1);
  });

  it('cleans up old event listeners on re-registration', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 0);
    const listenerCountBefore = win.listenerCount('focus');

    registry.registerWindow(win, 1);
    expect(win.listenerCount('focus')).toBe(listenerCountBefore);
    expect(win.listenerCount('show')).toBe(listenerCountBefore);
    expect(win.listenerCount('closed')).toBe(listenerCountBefore);
  });

  it('updates webContents reverse index on registration', () => {
    const win = makeTypedWindow();
    const wcId = win.webContents.id;
    registry.registerWindow(win, 3);
    expect(registry.getAccountForWebContents(wcId)).toBe(3);
  });

  it('focus event updates mostRecentAccountIndex', () => {
    const win0 = makeTypedWindow();
    const win1 = makeTypedWindow();
    registry.registerWindow(win0, 0);
    registry.registerWindow(win1, 1);

    win0.emit('focus');
    expect(registry.getMostRecentWindow()).toBe(win0);

    win1.emit('focus');
    expect(registry.getMostRecentWindow()).toBe(win1);
  });

  it('show event updates mostRecentAccountIndex', () => {
    const win0 = makeTypedWindow();
    const win1 = makeTypedWindow();
    registry.registerWindow(win0, 0);
    registry.registerWindow(win1, 1);

    win1.emit('show');
    expect(registry.getMostRecentWindow()).toBe(win1);
  });

  it('closed event triggers unregisterAccount', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 0);
    expect(registry.hasAccount(0)).toBe(true);

    win.emit('closed');
    expect(registry.hasAccount(0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lookup methods
// ---------------------------------------------------------------------------

describe('AccountWindowRegistry — lookup methods', () => {
  let registry: AccountWindowRegistry;

  beforeEach(() => {
    nextWebContentsId = 2000;
    registry = new AccountWindowRegistry();
  });

  it('getAccountIndex returns null for unregistered window', () => {
    const win = makeTypedWindow();
    expect(registry.getAccountIndex(win)).toBeNull();
  });

  it('getAccountWindow returns null for unregistered index', () => {
    expect(registry.getAccountWindow(99)).toBeNull();
  });

  it('getAccountWebContents returns null for unregistered index', () => {
    expect(registry.getAccountWebContents(99)).toBeNull();
  });

  it('getAccountWebContents returns webContents for registered window', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 0);
    expect(registry.getAccountWebContents(0)).toBe(win.webContents);
  });

  it('getAccountForWebContents returns null for unknown webContentsId', () => {
    expect(registry.getAccountForWebContents(9999)).toBeNull();
  });

  it('getAllWindows returns empty array when no windows registered', () => {
    expect(registry.getAllWindows()).toEqual([]);
  });

  it('getAllWindows returns all registered windows', () => {
    const win0 = makeTypedWindow();
    const win1 = makeTypedWindow();
    registry.registerWindow(win0, 0);
    registry.registerWindow(win1, 1);
    const all = registry.getAllWindows();
    expect(all).toHaveLength(2);
    expect(all).toContain(win0);
    expect(all).toContain(win1);
  });

  it('getMostRecentWindow returns null when no windows exist', () => {
    expect(registry.getMostRecentWindow()).toBeNull();
  });

  it('hasAccount returns false for unregistered index', () => {
    expect(registry.hasAccount(0)).toBe(false);
  });

  it('hasAccount returns true for registered index', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 0);
    expect(registry.hasAccount(0)).toBe(true);
  });

  it('getAccountCount returns 0 when empty', () => {
    expect(registry.getAccountCount()).toBe(0);
  });

  it('getAccountCount returns correct count', () => {
    const win0 = makeTypedWindow();
    const win1 = makeTypedWindow();
    registry.registerWindow(win0, 0);
    registry.registerWindow(win1, 1);
    expect(registry.getAccountCount()).toBe(2);
  });

  it('setMostRecentAccountIndex updates the tracked index', () => {
    const win0 = makeTypedWindow();
    const win1 = makeTypedWindow();
    registry.registerWindow(win0, 0);
    registry.registerWindow(win1, 1);

    registry.setMostRecentAccountIndex(1);
    expect(registry.getMostRecentWindow()).toBe(win1);

    registry.setMostRecentAccountIndex(0);
    expect(registry.getMostRecentWindow()).toBe(win0);
  });
});

// ---------------------------------------------------------------------------
// unregisterAccount
// ---------------------------------------------------------------------------

describe('AccountWindowRegistry — unregisterAccount', () => {
  let registry: AccountWindowRegistry;

  beforeEach(() => {
    nextWebContentsId = 3000;
    registry = new AccountWindowRegistry();
  });

  it('removes window from all internal maps', () => {
    const win = makeTypedWindow();
    const wcId = win.webContents.id;
    registry.registerWindow(win, 0);

    registry.unregisterAccount(0);

    expect(registry.hasAccount(0)).toBe(false);
    expect(registry.getAccountIndex(win)).toBeNull();
    expect(registry.getAccountForWebContents(wcId)).toBeNull();
    expect(registry.getAccountCount()).toBe(0);
  });

  it('removes event listeners from window', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 0);
    const focusListenersBefore = win.listenerCount('focus');
    expect(focusListenersBefore).toBeGreaterThan(0);

    registry.unregisterAccount(0);

    expect(win.listenerCount('focus')).toBe(focusListenersBefore - 1);
    expect(win.listenerCount('show')).toBe(0);
    expect(win.listenerCount('closed')).toBe(0);
  });

  it('updates mostRecentAccountIndex to next newest window', () => {
    const win0 = makeTypedWindow();
    const win1 = makeTypedWindow();
    registry.registerWindow(win0, 0);
    registry.registerWindow(win1, 1);

    win0.emit('focus');
    expect(registry.getMostRecentWindow()).toBe(win0);

    registry.unregisterAccount(0);
    expect(registry.getMostRecentWindow()).toBe(win1);
  });

  it('sets mostRecentAccountIndex to null when last window unregistered', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 0);
    win.emit('focus');

    registry.unregisterAccount(0);
    expect(registry.getMostRecentWindow()).toBeNull();
  });

  it('is a no-op for unregistered account index', () => {
    expect(() => registry.unregisterAccount(99)).not.toThrow();
  });

  it('skips listener removal for destroyed window', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 0);

    (win as unknown as MockBrowserWindow).destroy();

    expect(() => registry.unregisterAccount(0)).not.toThrow();
  });

  it('removes webContents listeners on unregister', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 0);

    // Add a listener on webContents to verify it gets removed
    win.webContents.on('did-navigate', () => {});
    expect(win.webContents.listenerCount('did-navigate')).toBe(1);

    const removeAllSpy = vi.spyOn(win.webContents, 'removeAllListeners');
    registry.unregisterAccount(0);

    expect(removeAllSpy).toHaveBeenCalled();
    expect(win.webContents.listenerCount('did-navigate')).toBe(0);
  });

  it('skips webContents listener removal for destroyed webContents', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 0);

    // Destroy the window (which makes webContents inaccessible)
    (win as unknown as MockBrowserWindow).destroy();

    // Should not throw when webContents is destroyed
    expect(() => registry.unregisterAccount(0)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// destroyAll
// ---------------------------------------------------------------------------

describe('AccountWindowRegistry — destroyAll', () => {
  let registry: AccountWindowRegistry;

  beforeEach(() => {
    nextWebContentsId = 4000;
    registry = new AccountWindowRegistry();
  });

  it('destroys all windows and clears all internal state', () => {
    const win0 = makeTypedWindow();
    const win1 = makeTypedWindow();
    registry.registerWindow(win0, 0);
    registry.registerWindow(win1, 1);

    win0.emit('focus');

    registry.destroyAll();

    expect(registry.getAccountCount()).toBe(0);
    expect(registry.getAllWindows()).toEqual([]);
    expect(registry.getMostRecentWindow()).toBeNull();
    expect(registry.hasAccount(0)).toBe(false);
    expect(registry.hasAccount(1)).toBe(false);
  });

  it('calls destroy on non-destroyed windows', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 0);
    const destroySpy = vi.spyOn(win, 'destroy');

    registry.destroyAll();

    expect(destroySpy).toHaveBeenCalled();
  });

  it('skips destroy on already-destroyed windows', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 0);
    (win as unknown as MockBrowserWindow).destroy();

    expect(() => registry.destroyAll()).not.toThrow();
  });

  it('clears webContents reverse index', () => {
    const win = makeTypedWindow();
    const wcId = win.webContents.id;
    registry.registerWindow(win, 0);

    registry.destroyAll();

    expect(registry.getAccountForWebContents(wcId)).toBeNull();
  });

  it('is safe to call on empty registry', () => {
    expect(() => registry.destroyAll()).not.toThrow();
    expect(registry.getAccountCount()).toBe(0);
  });

  it('preserveBootstrap skips shared bootstrap teardown', async () => {
    const tracker = await import('./bootstrapTracker.js');
    const clearAll = vi.spyOn(tracker, 'clearAllBootstrap');
    const clearOne = vi.spyOn(tracker, 'clearBootstrap');
    const isolated = new AccountWindowRegistry({ preserveBootstrap: true });
    isolated.registerWindow(makeTypedWindow(), 0);
    isolated.destroyAll();
    expect(clearAll).not.toHaveBeenCalled();

    isolated.registerWindow(makeTypedWindow(), 1);
    isolated.unregisterAccount(1);
    expect(clearOne).not.toHaveBeenCalled();
    clearAll.mockRestore();
    clearOne.mockRestore();
  });
});

describe('AccountWindowRegistry — listAccountIndices', () => {
  let registry: AccountWindowRegistry;

  beforeEach(() => {
    nextWebContentsId = 1000;
    registry = new AccountWindowRegistry();
  });

  it('returns sorted sparse indices', () => {
    const win0 = makeTypedWindow();
    const win2 = makeTypedWindow();
    registry.registerWindow(win0, 0);
    registry.registerWindow(win2, 2);
    expect(registry.listAccountIndices()).toEqual([0, 2]);
    expect(registry.getAccountCount()).toBe(2);
  });

  it('returns empty array when no accounts', () => {
    expect(registry.listAccountIndices()).toEqual([]);
  });
});

describe('AccountWindowRegistry native close ownership', () => {
  it('removes destroyed-window reverse identity and reports its native close once', () => {
    const onAccountClosed = vi.fn();
    const registry = new AccountWindowRegistry({ onAccountClosed });
    const window = makeTypedWindow();
    const index = asAccountIndex(2);
    const senderId = asWebContentsId(window.webContents.id);
    registry.registerWindow(window, index);

    window.destroy();

    expect(onAccountClosed.mock.calls).toEqual([[index]]);
    expect(registry.getAccountForWebContents(senderId)).toBeNull();
    expect(registry.hasAccount(index)).toBe(false);
  });

  it('does not report internal unregistration or registry teardown as native close', () => {
    const onAccountClosed = vi.fn();
    const registry = new AccountWindowRegistry({ onAccountClosed });
    const first = makeTypedWindow();
    registry.registerWindow(first, asAccountIndex(2));
    registry.registerWindow(makeTypedWindow(), asAccountIndex(7));

    registry.unregisterAccount(asAccountIndex(2));
    first.destroy();
    registry.destroyAll();

    expect(onAccountClosed).not.toHaveBeenCalled();
  });

  it('does not let a delayed old closed event remove the replacement account', () => {
    const onAccountClosed = vi.fn();
    const registry = new AccountWindowRegistry({ onAccountClosed });
    const index = asAccountIndex(2);
    const oldWindow = makeTypedWindow();
    const replacement = makeTypedWindow();
    registry.registerWindow(oldWindow, index);
    const oldClosed = asType<() => void>(oldWindow.listeners('closed')[0]);
    registry.registerWindow(replacement, index);

    oldClosed();

    expect(registry.getAccountWindow(index)).toBe(replacement);
    expect(registry.getAccountForWebContents(asWebContentsId(oldWindow.webContents.id))).toBeNull();
    expect(registry.getAccountForWebContents(asWebContentsId(replacement.webContents.id))).toBe(
      index
    );
    expect(onAccountClosed).not.toHaveBeenCalled();
    registry.destroyAll();
    oldWindow.destroy();
  });
});
