/**
 * windowState delegates persistence to the account-window bridge.
 * Restore, migration, and listener ownership live in accountWindowsStore.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  prepareAccountWindows: vi.fn(async () => undefined),
  detachAccountWindowListeners: vi.fn(),
}));

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../utils/account/accountWindowPersistenceBridge.js', () => bridge);

import log from 'electron-log';
import persistWindowState, { cleanupWindowState } from './windowState.js';
import { makeSecretError } from '../../../tests/mocks/logCapture';

describe('windowState feature', () => {
  beforeEach(() => {
    bridge.prepareAccountWindows.mockReset();
    bridge.prepareAccountWindows.mockResolvedValue(undefined);
    bridge.detachAccountWindowListeners.mockReset();
    vi.mocked(log.error).mockClear();
  });

  it('prepares account-window persistence and does not require a live window', async () => {
    await persistWindowState({});
    expect(bridge.prepareAccountWindows).toHaveBeenCalledOnce();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs a sanitized error when prepare fails and does not throw', async () => {
    bridge.prepareAccountWindows.mockRejectedValueOnce(makeSecretError());
    await expect(persistWindowState()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      '[WindowState] Failed to initialize window state:',
      expect.objectContaining({ message: '[redacted]' })
    );
  });

  it('cleanup detaches bounds listeners', () => {
    cleanupWindowState({});
    expect(bridge.detachAccountWindowListeners).toHaveBeenCalledOnce();
  });

  it('cleanup logs a sanitized error and does not throw', () => {
    bridge.detachAccountWindowListeners.mockImplementationOnce(() => {
      throw makeSecretError();
    });
    expect(() => cleanupWindowState()).not.toThrow();
    expect(log.error).toHaveBeenCalledWith(
      '[WindowState] Failed to cleanup window state:',
      expect.objectContaining({ message: '[redacted]' })
    );
  });
});
