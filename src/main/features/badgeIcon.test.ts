/**
 * Unit tests for badgeIcon feature (thin registration layer).
 *
 * Tests delegation to setupBadgeHandlers and the cleanupBadgeIcon API.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  app: { setBadgeCount: vi.fn() },
  BrowserWindow: vi.fn(),
}));

vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

const faviconCleanup = vi.fn();
const unreadCleanup = vi.fn();
const webContentsCleanup = vi.fn();
const accountRemovedCleanup = vi.fn();
const sessionCleanup = vi.fn();
const cleanups = {
  faviconCleanup,
  unreadCleanup,
  webContentsCleanup,
  accountRemovedCleanup,
  sessionCleanup,
};
const setupBadgeHandlers = vi.fn(() => cleanups);

vi.mock('../utils/platform/badgeHelpers.js', () => ({
  setupBadgeHandlers: (...args: unknown[]) =>
    setupBadgeHandlers(...(args as Parameters<typeof setupBadgeHandlers>)),
}));

function fakeWindow() {
  return {} as unknown as Electron.BrowserWindow;
}
describe('badgeIcon feature', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    setupBadgeHandlers.mockReturnValue(cleanups);
  });

  describe('default export', () => {
    it('delegates handler setup to setupBadgeHandlers', async () => {
      const win = fakeWindow();
      const feature = await import('./badgeIcon.js');

      feature.default(win);

      expect(setupBadgeHandlers).toHaveBeenCalledWith(win);
    });

    it('returns void (cleanup is via named export)', async () => {
      const feature = await import('./badgeIcon.js');
      const result = feature.default(fakeWindow());
      expect(result).toBeUndefined();
    });
  });

  describe('cleanupBadgeIcon', () => {
    it('does not throw when called with no handlers registered', async () => {
      const feature = await import('./badgeIcon.js');
      expect(() => feature.cleanupBadgeIcon()).not.toThrow();
    });

    it('invokes every IPC, hook and session cleanup callback', async () => {
      const feature = await import('./badgeIcon.js');
      feature.default(fakeWindow());

      feature.cleanupBadgeIcon();

      for (const cleanup of Object.values(cleanups)) {
        expect(cleanup).toHaveBeenCalledTimes(1);
      }
    });

    it('is idempotent — second call does not re-invoke cleanups', async () => {
      const feature = await import('./badgeIcon.js');
      feature.default(fakeWindow());

      feature.cleanupBadgeIcon();
      feature.cleanupBadgeIcon();

      expect(faviconCleanup).toHaveBeenCalledTimes(1);
      expect(unreadCleanup).toHaveBeenCalledTimes(1);
    });

    it('attempts every cleanup once even when IPC and hook disposal fail', async () => {
      faviconCleanup.mockImplementation(() => {
        throw new Error('IPC disposal failed');
      });
      webContentsCleanup.mockImplementation(() => {
        throw new Error('hook disposal failed');
      });
      const feature = await import('./badgeIcon.js');
      feature.default(fakeWindow());

      expect(() => feature.cleanupBadgeIcon()).not.toThrow();
      feature.cleanupBadgeIcon();

      for (const cleanup of Object.values(cleanups)) {
        expect(cleanup).toHaveBeenCalledTimes(1);
      }
    });
  });
});
