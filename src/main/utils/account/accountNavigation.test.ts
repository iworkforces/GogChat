/**
 * Unit tests for WebContents-first account navigation helpers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IAccountWindowManager } from '../../../shared/types/window.js';
import { asAccountIndex } from '../../../shared/types/branded.js';
import { loadAccountURL, getAccountURL, sendToAccount } from './accountNavigation.js';

vi.mock('electron-log', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../shared/urlValidators.js', () => ({
  isGoogleAuthUrl: vi.fn().mockReturnValue(false),
}));

import { isGoogleAuthUrl } from '../../../shared/urlValidators.js';
import * as navigation from './accountNavigation.js';
import log from 'electron-log';
import {
  SECRET_AUTH_URL,
  SECRET_CHAT_URL,
  clearSpies,
  expectNoSentinels,
  makeSecretError,
  messagesAt,
  spiesOf,
} from '../../../../tests/mocks/logCapture.js';

function makeManager(
  wc: {
    isDestroyed: () => boolean;
    getURL: () => string;
    loadURL: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  } | null
): IAccountWindowManager {
  return {
    getAccountWebContents: vi.fn().mockReturnValue(wc),
    isDehydrated: vi.fn().mockReturnValue(false),
  } as unknown as IAccountWindowManager;
}

describe('accountNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isGoogleAuthUrl).mockReturnValue(false);
  });

  describe('loadAccountURL', () => {
    it('consumes a rejected synchronous load without changing its boolean contract', async () => {
      const manager = makeManager({
        isDestroyed: () => false,
        getURL: () => 'https://chat.google.com/u/0',
        loadURL: vi.fn().mockRejectedValue(new Error('ERR_ABORTED')),
        send: vi.fn(),
      });
      expect(loadAccountURL(manager, asAccountIndex(0), 'file:///offline')).toBe(true);
      await Promise.resolve();
      const log = await import('electron-log');
      expect(log.default.warn).toHaveBeenCalledTimes(1);
    });

    it('refuses parked content at both navigation boundaries without hydrating', async () => {
      const loadURL = vi.fn();
      const manager = makeManager({
        isDestroyed: () => false,
        getURL: () => '',
        loadURL,
        send: vi.fn(),
      });
      vi.mocked(manager.isDehydrated).mockReturnValue(true);
      expect(loadAccountURL(manager, asAccountIndex(0), 'file:///offline')).toBe(false);
      expect(
        await navigation.loadAccountURLAndWait(manager, asAccountIndex(0), 'file:///offline')
      ).toBe(false);
      expect(loadURL).not.toHaveBeenCalled();
    });
    it('reports rejected navigation as false through the awaitable boundary', async () => {
      const manager = makeManager({
        isDestroyed: () => false,
        getURL: () => 'https://chat.google.com/u/0',
        loadURL: vi.fn().mockRejectedValue(new Error('ERR_ABORTED')),
        send: vi.fn(),
      });
      expect(
        await navigation.loadAccountURLAndWait(manager, asAccountIndex(0), 'file:///offline')
      ).toBe(false);
    });
    it('loads URL on live WebContents', () => {
      const loadURL = vi.fn().mockResolvedValue(undefined);
      const manager = makeManager({
        isDestroyed: () => false,
        getURL: () => 'https://mail.google.com/chat/u/0',
        loadURL,
        send: vi.fn(),
      });

      expect(
        loadAccountURL(manager, asAccountIndex(0), 'https://mail.google.com/chat/u/0/r/1')
      ).toBe(true);
      expect(loadURL).toHaveBeenCalledWith('https://mail.google.com/chat/u/0/r/1');
    });

    it('returns false when WebContents missing', () => {
      const manager = makeManager(null);
      expect(loadAccountURL(manager, asAccountIndex(1), 'https://chat.google.com/u/1')).toBe(false);
    });

    it('skips loadURL on Google auth pages', () => {
      vi.mocked(isGoogleAuthUrl).mockReturnValue(true);
      const loadURL = vi.fn();
      const manager = makeManager({
        isDestroyed: () => false,
        getURL: () => 'https://accounts.google.com/signin',
        loadURL,
        send: vi.fn(),
      });

      expect(loadAccountURL(manager, asAccountIndex(0), 'https://mail.google.com/chat/u/0')).toBe(
        false
      );
      expect(loadURL).not.toHaveBeenCalled();
    });
  });

  describe('getAccountURL', () => {
    it('returns current URL', () => {
      const manager = makeManager({
        isDestroyed: () => false,
        getURL: () => 'https://chat.google.com/u/0',
        loadURL: vi.fn(),
        send: vi.fn(),
      });
      expect(getAccountURL(manager, asAccountIndex(0))).toBe('https://chat.google.com/u/0');
    });

    it('returns null when destroyed', () => {
      const manager = makeManager({
        isDestroyed: () => true,
        getURL: () => 'https://chat.google.com/u/0',
        loadURL: vi.fn(),
        send: vi.fn(),
      });
      expect(getAccountURL(manager, asAccountIndex(0))).toBeNull();
    });
  });

  describe('sendToAccount', () => {
    it('sends IPC to account WebContents', () => {
      const send = vi.fn();
      const manager = makeManager({
        isDestroyed: () => false,
        getURL: () => 'https://chat.google.com/u/0',
        loadURL: vi.fn(),
        send,
      });
      expect(sendToAccount(manager, asAccountIndex(0), 'searchShortcut')).toBe(true);
      expect(send).toHaveBeenCalledWith('searchShortcut');
    });

    it('returns false without WebContents', () => {
      expect(sendToAccount(makeManager(null), asAccountIndex(0), 'searchShortcut')).toBe(false);
    });
  });

  describe('routing conformance schedules', () => {
    it('records both loadURL calls when the first promise is still pending', () => {
      const pending: Array<{ url: string; resolve: () => void }> = [];
      const loadURL = vi.fn((url: string) => {
        return new Promise<void>((resolve) => {
          pending.push({ url, resolve });
        });
      });
      const manager = makeManager({
        isDestroyed: () => false,
        getURL: () => 'https://chat.google.com/u/2/',
        loadURL,
        send: vi.fn(),
      });

      const first = 'https://chat.google.com/u/2/room/first';
      const second = 'https://chat.google.com/u/2/room/second';
      expect(loadAccountURL(manager, asAccountIndex(2), first)).toBe(true);
      expect(loadAccountURL(manager, asAccountIndex(2), second)).toBe(true);

      expect(loadURL.mock.calls.map((call) => call[0])).toEqual([first, second]);
      expect(pending).toHaveLength(2);
      expect(pending[0]?.url).toBe(first);
      expect(pending[1]?.url).toBe(second);
      pending.forEach((item) => {
        item.resolve();
      });
    });

    it('returns false for destroyed WebContents and does not load', () => {
      const loadURL = vi.fn();
      const manager = makeManager({
        isDestroyed: () => true,
        getURL: () => 'https://chat.google.com/u/2/',
        loadURL,
        send: vi.fn(),
      });
      expect(loadAccountURL(manager, asAccountIndex(2), 'https://chat.google.com/u/2/room/x')).toBe(
        false
      );
      expect(loadURL).not.toHaveBeenCalled();
    });

    it('still loads when getURL throws (auth check is best-effort)', () => {
      const loadURL = vi.fn().mockResolvedValue(undefined);
      const manager = makeManager({
        isDestroyed: () => false,
        getURL: () => {
          throw new Error('webContents gone');
        },
        loadURL,
        send: vi.fn(),
      });
      expect(loadAccountURL(manager, asAccountIndex(2), 'https://chat.google.com/u/2/room/x')).toBe(
        true
      );
      expect(loadURL).toHaveBeenCalledWith('https://chat.google.com/u/2/room/x');
    });
  });
});

describe('accountNavigation — log redaction', () => {
  const spies = spiesOf(log);
  const account = asAccountIndex(2);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isGoogleAuthUrl).mockReturnValue(false);
    clearSpies(spies);
  });

  function liveWebContents(overrides: Record<string, unknown> = {}) {
    return {
      isDestroyed: () => false,
      getURL: () => 'https://chat.google.com/u/2',
      loadURL: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(),
      ...overrides,
    };
  }

  it('logs a missing live WebContents at debug level without a URL', () => {
    expect(loadAccountURL(makeManager(null), account, SECRET_CHAT_URL)).toBe(false);
    expect(messagesAt(spies, 'debug')).toEqual([
      '[AccountNavigation] loadAccountURL: no live WebContents for account 2',
    ]);
    expectNoSentinels(spies);
  });

  it('logs the auth-page skip without the auth URL and never loads', () => {
    vi.mocked(isGoogleAuthUrl).mockReturnValue(true);
    const wc = liveWebContents({ getURL: () => SECRET_AUTH_URL });
    expect(loadAccountURL(makeManager(wc), account, SECRET_CHAT_URL)).toBe(false);
    expect(isGoogleAuthUrl).toHaveBeenCalledExactlyOnceWith(SECRET_AUTH_URL);
    expect(wc.loadURL).not.toHaveBeenCalled();
    expect(messagesAt(spies, 'info')).toEqual([
      expect.stringContaining('[AccountNavigation] Skipping loadURL for account 2'),
    ]);
    expectNoSentinels(spies);
  });

  it('keeps loading the original URL when getURL throws a secret-bearing Error', () => {
    const wc = liveWebContents({
      getURL: () => {
        throw makeSecretError();
      },
    });
    expect(loadAccountURL(makeManager(wc), account, SECRET_CHAT_URL)).toBe(true);
    expect(wc.loadURL).toHaveBeenCalledExactlyOnceWith(SECRET_CHAT_URL);
    expect(messagesAt(spies, 'warn')).toEqual(['[AccountNavigation] getURL failed for account 2']);
    expectNoSentinels(spies);
  });

  it('logs an asynchronous load rejection without its Error', async () => {
    const wc = liveWebContents({ loadURL: vi.fn().mockRejectedValue(makeSecretError()) });
    await expect(
      navigation.loadAccountURLAndWait(makeManager(wc), account, SECRET_CHAT_URL)
    ).resolves.toBe(false);
    expect(wc.loadURL).toHaveBeenCalledExactlyOnceWith(SECRET_CHAT_URL);
    expect(messagesAt(spies, 'warn')).toEqual(['[AccountNavigation] loadURL failed for account 2']);
    expectNoSentinels(spies);
  });

  it('logs a synchronous load throw without its Error', () => {
    const wc = liveWebContents({
      loadURL: vi.fn(() => {
        throw makeSecretError();
      }),
    });
    expect(loadAccountURL(makeManager(wc), account, SECRET_CHAT_URL)).toBe(false);
    expect(messagesAt(spies, 'warn')).toEqual(['[AccountNavigation] loadURL failed for account 2']);
    expectNoSentinels(spies);
  });
});
