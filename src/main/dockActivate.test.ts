/**
 * Dock activate restore. The main entry registers onDockActivate.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { asType } from '../shared/typeUtils.js';

const mocks = vi.hoisted(() => ({
  getMostRecentWindow: vi.fn((): BrowserWindow | null => null),
}));

vi.mock('./utils/account/accountWindowManager.js', () => ({
  getMostRecentWindow: () => mocks.getMostRecentWindow(),
}));

import { onDockActivate, setDockActivateMainWindowGetter } from './dockActivate.js';

function fakeWindow(state: { minimized?: boolean; destroyed?: boolean } = {}): BrowserWindow {
  return asType<BrowserWindow>({
    isMinimized: vi.fn(() => state.minimized === true),
    isDestroyed: vi.fn(() => state.destroyed === true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  });
}

describe('onDockActivate', () => {
  beforeEach(() => {
    mocks.getMostRecentWindow.mockReset();
    mocks.getMostRecentWindow.mockReturnValue(null);
    setDockActivateMainWindowGetter(() => null);
  });

  it('is the activate listener registered by the main entry', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    expect(source).toMatch(/app\.on\(\s*'activate'\s*,\s*onDockActivate\s*\)/);
    expect(source).not.toMatch(/setActivationPolicy|dock\.hide|dock\?\.hide/);
  });

  it('shows and focuses a hidden window', () => {
    const window = fakeWindow();
    mocks.getMostRecentWindow.mockReturnValue(window);
    onDockActivate();

    expect(window.restore).not.toHaveBeenCalled();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    const showOrder = vi.mocked(window.show).mock.invocationCallOrder[0];
    const focusOrder = vi.mocked(window.focus).mock.invocationCallOrder[0];
    expect(showOrder).toBeLessThan(focusOrder ?? 0);
  });

  it('restores a minimized window before show and focus', () => {
    const window = fakeWindow({ minimized: true });
    mocks.getMostRecentWindow.mockReturnValue(window);
    onDockActivate();

    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    const restoreOrder = vi.mocked(window.restore).mock.invocationCallOrder[0];
    const showOrder = vi.mocked(window.show).mock.invocationCallOrder[0];
    const focusOrder = vi.mocked(window.focus).mock.invocationCallOrder[0];
    expect(restoreOrder).toBeLessThan(showOrder ?? 0);
    expect(showOrder).toBeLessThan(focusOrder ?? 0);
  });

  it('does not create a window when none exists or the window is destroyed', () => {
    const destroyed = fakeWindow({ destroyed: true });
    mocks.getMostRecentWindow.mockReturnValue(destroyed);
    onDockActivate();
    expect(destroyed.restore).not.toHaveBeenCalled();
    expect(destroyed.show).not.toHaveBeenCalled();
    expect(destroyed.focus).not.toHaveBeenCalled();

    mocks.getMostRecentWindow.mockReturnValue(null);
    expect(() => onDockActivate()).not.toThrow();
    expect(destroyed.show).not.toHaveBeenCalled();
  });

  it('falls back to the main-entry window when no account window is current', () => {
    const window = fakeWindow();
    setDockActivateMainWindowGetter(() => window);
    onDockActivate();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(window.restore).not.toHaveBeenCalled();
  });
});
