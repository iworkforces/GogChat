/**
 * Log-redaction tests for externalLinks: both entry points (setWindowOpenHandler and
 * will-navigate) with secret-bearing URLs through the REAL validators. Every logging branch
 * requires an expected call, every electron-log argument is scanned for sentinels, and the
 * validated target must still reach the routing and shell wrappers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  SECRET_AUTH_URL,
  expectNoSentinels,
  makeSecretError,
  messagesAt,
  spiesOf,
} from '../../../tests/mocks/logCapture';

const EXTERNAL_URL =
  'https://P2_USERINFO:P2_USERINFO@evil.example/P2_PATH?token=P2_QUERY' +
  '&continue=https%3A%2F%2Fchat.google.com%2Fchat%2FP2_CONTINUE#P2_FRAGMENT';
const VALIDATED_EXTERNAL_URL =
  'https://evil.example/P2_PATH?token=P2_QUERY' +
  '&continue=https%3A%2F%2Fchat.google.com%2Fchat%2FP2_CONTINUE#P2_FRAGMENT';
const ACCOUNT_2_URL =
  'https://chat.google.com/u/2/P2_PATH?token=P2_QUERY' +
  '&continue=https%3A%2F%2Fchat.google.com%2Fchat%2FP2_CONTINUE#P2_FRAGMENT';
const WHITELISTED_URL =
  'https://accounts.google.com/P2_PATH?token=P2_QUERY' +
  '&continue=https%3A%2F%2Fchat.google.com%2Fchat%2FP2_CONTINUE#P2_FRAGMENT';
const NON_HTTP_URL = 'gogchat://open/P2_PATH?token=P2_QUERY#P2_FRAGMENT';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  showMessageBox: vi.fn(),
  hasAccount: vi.fn(),
  isBootstrap: vi.fn(),
  markAsBootstrap: vi.fn(),
  focusAccount: vi.fn(),
  createAccountWindow: vi.fn(),
  loadAccountURL: vi.fn(),
  getAccountURL: vi.fn(),
  watchBootstrapAccount: vi.fn(),
  setHooksManager: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: vi.fn(),
  dialog: { showMessageBox: mocks.showMessageBox },
  shell: { openExternal: vi.fn() },
}));
vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../utils/security/shellWrapper.js', () => ({ openExternal: mocks.openExternal }));
vi.mock('../utils/account/accountWindowManager.js', () => ({
  getAccountWindowManager: () => ({
    hasAccount: mocks.hasAccount,
    isBootstrap: mocks.isBootstrap,
    markAsBootstrap: mocks.markAsBootstrap,
    focusAccount: mocks.focusAccount,
    getAccountWindow: vi.fn().mockReturnValue(null),
  }),
  createAccountWindow: mocks.createAccountWindow,
  getAccountIndex: vi.fn().mockReturnValue(0),
}));
vi.mock('../utils/account/accountNavigation.js', () => ({
  loadAccountURL: mocks.loadAccountURL,
  getAccountURL: mocks.getAccountURL,
}));
vi.mock('../utils/account/accountWebContentsHooks.js', () => ({
  setAccountWebContentsHooksManager: mocks.setHooksManager,
  onAccountWebContentsCreated: vi.fn(() => () => {}),
}));
vi.mock('../utils/account/bootstrapWatcher.js', () => ({
  watchBootstrapAccount: mocks.watchBootstrapAccount,
}));
vi.mock('../utils/lifecycle/resourceCleanup.js', () => ({
  cancelTrackedInterval: (handle: NodeJS.Timeout) => clearInterval(handle),
  createTrackedInterval: vi.fn().mockReturnValue({} as NodeJS.Timeout),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeWindow(currentUrl: string | (() => string) = 'https://chat.google.com/u/0/') {
  const getURL = typeof currentUrl === 'function' ? vi.fn(currentUrl) : vi.fn(() => currentUrl);
  const wc = new EventEmitter() as EventEmitter & Record<string, unknown>;
  wc.getURL = getURL;
  wc.setWindowOpenHandler = vi.fn();
  wc.isDestroyed = vi.fn(() => false);
  const win = { webContents: wc, isDestroyed: () => false };
  return { win: win as unknown as Electron.BrowserWindow, wc, getURL };
}

type OpenHandler = (details: { url: string }) => { action: string };

async function install(currentUrl?: string | (() => string), hostUrl?: string | (() => string)) {
  const feature = await import('./externalLinks.js');
  const { win, wc, getURL } = makeWindow(currentUrl);
  const host = hostUrl === undefined ? win : makeWindow(hostUrl).win;
  const dispose = feature.installExternalLinkGuards(wc as unknown as Electron.WebContents, host);
  const setHandler = wc.setWindowOpenHandler as ReturnType<typeof vi.fn>;
  const openHandler = setHandler.mock.calls[0]?.[0] as OpenHandler;
  const willNavigate = (url: string) => {
    const event = { preventDefault: vi.fn() };
    wc.emit('will-navigate', event, url);
    return event;
  };
  const spies = spiesOf((await import('electron-log')).default);
  return { feature, wc, getURL, dispose, openHandler, willNavigate, spies };
}

const flushImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A rejected promise that is already handled, so only the caller sees the rejection. */
function handledRejection(error: Error): Promise<void> {
  const rejected = Promise.reject(error);
  rejected.catch(() => undefined);
  return rejected;
}

describe('externalLinks — log redaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.openExternal.mockResolvedValue(undefined);
    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    mocks.hasAccount.mockReturnValue(false);
    mocks.isBootstrap.mockReturnValue(false);
    mocks.getAccountURL.mockReturnValue(null);
    mocks.loadAccountURL.mockReturnValue(true);
  });

  describe('attach / detach', () => {
    it('installs one open handler and one will-navigate listener and detaches only the listener', async () => {
      const { wc, dispose } = await install();
      const setHandler = wc.setWindowOpenHandler as ReturnType<typeof vi.fn>;
      expect(setHandler).toHaveBeenCalledTimes(1);
      expect(wc.listenerCount('will-navigate')).toBe(1);

      dispose();

      expect(wc.listenerCount('will-navigate')).toBe(0);
      expect(setHandler).toHaveBeenCalledTimes(2);
      expect((setHandler.mock.calls[1]?.[0] as OpenHandler)({ url: 'x' })).toEqual({
        action: 'deny',
      });
    });
  });

  describe('setWindowOpenHandler entry point', () => {
    it('blocks a non-HTTP URL and logs only a fixed warning', async () => {
      const { openHandler, spies } = await install();

      expect(openHandler({ url: NON_HTTP_URL })).toEqual({ action: 'deny' });

      expect(messagesAt(spies, 'warn')).toEqual(['[ExternalLinks] Blocked non-HTTP URL']);
      expectNoSentinels(spies);
    });

    it('opens an external URL with the validated target and logs no URL', async () => {
      const { openHandler, spies } = await install();

      expect(openHandler({ url: EXTERNAL_URL })).toEqual({ action: 'deny' });
      await flushImmediate();

      expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(VALIDATED_EXTERNAL_URL);
      expect(messagesAt(spies, 'info')).toEqual(['[ExternalLinks] Opened external URL']);
      expectNoSentinels(spies);
    });

    it('logs an open failure without its Error', async () => {
      mocks.openExternal.mockImplementationOnce(() => {
        throw makeSecretError(EXTERNAL_URL);
      });
      const { openHandler, spies } = await install();

      expect(openHandler({ url: EXTERNAL_URL })).toEqual({ action: 'deny' });
      await flushImmediate();

      expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(VALIDATED_EXTERNAL_URL);
      expect(messagesAt(spies, 'error')).toEqual(['[ExternalLinks] Failed to open external URL']);
      expectNoSentinels(spies);
    });

    it('logs a validator rejection without leaking the URL (dangerous pattern)', async () => {
      const dangerous = 'https://evil.example/P2_PATH?x=javascript:P2_QUERY#P2_FRAGMENT';
      const { openHandler, spies } = await install();

      expect(openHandler({ url: dangerous })).toEqual({ action: 'deny' });
      await flushImmediate();

      expect(mocks.openExternal).not.toHaveBeenCalled();
      expect(messagesAt(spies, 'error')).toEqual(['[ExternalLinks] Failed to open external URL']);
      expectNoSentinels(spies);
    });

    it('logs success for an asynchronous shell rejection that is reported elsewhere', async () => {
      mocks.openExternal.mockReturnValueOnce(handledRejection(makeSecretError(EXTERNAL_URL)));
      const { openHandler, spies } = await install();

      expect(openHandler({ url: EXTERNAL_URL })).toEqual({ action: 'deny' });
      await flushImmediate();

      expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(VALIDATED_EXTERNAL_URL);
      expect(messagesAt(spies, 'info')).toEqual(['[ExternalLinks] Opened external URL']);
      expectNoSentinels(spies);
    });

    it('allows whitelisted navigation and logs only a fixed debug line', async () => {
      const { openHandler, spies } = await install();

      expect(openHandler({ url: WHITELISTED_URL })).toEqual({ action: 'allow' });

      expect(messagesAt(spies, 'debug')).toEqual([
        '[ExternalLinks] Allowing whitelisted navigation',
      ]);
      expect(mocks.openExternal).not.toHaveBeenCalled();
      expectNoSentinels(spies);
    });

    it('logs guard-disabled allows without the URL', async () => {
      mocks.showMessageBox.mockResolvedValue({ response: 0 });
      const { feature, openHandler, spies } = await install();
      feature.toggleExternalLinksGuard({} as Electron.BrowserWindow);
      await flushImmediate();

      expect(openHandler({ url: EXTERNAL_URL })).toEqual({ action: 'allow' });

      expect(messagesAt(spies, 'debug')).toEqual([
        'External links guard is set to: false',
        '[ExternalLinks] Guard disabled, allowing',
      ]);
      expect(mocks.openExternal).not.toHaveBeenCalled();
      expectNoSentinels(spies, 2);
    });

    it('logs an unparseable current-window URL as a fixed warning', async () => {
      const { openHandler, spies } = await install('not a url P2_PATH?token=P2_QUERY#P2_FRAGMENT');

      expect(openHandler({ url: WHITELISTED_URL })).toEqual({ action: 'allow' });

      expect(messagesAt(spies, 'warn')).toEqual(['[ExternalLinks] Failed to parse URL hostname']);
      expectNoSentinels(spies);
    });

    it('logs a redirect-handling failure without its Error and denies', async () => {
      const failing = () => {
        throw makeSecretError();
      };
      const { openHandler, spies } = await install(failing, failing);

      expect(openHandler({ url: EXTERNAL_URL })).toEqual({ action: 'deny' });

      expect(messagesAt(spies, 'error')).toEqual(['[ExternalLinks] Error handling redirect']);
      expect(mocks.openExternal).not.toHaveBeenCalled();
      expectNoSentinels(spies);
    });

    it('creates a missing account with the original URL and logs URL-free routing lines', async () => {
      const { openHandler, spies } = await install();

      expect(openHandler({ url: ACCOUNT_2_URL })).toEqual({ action: 'deny' });

      expect(mocks.createAccountWindow).toHaveBeenCalledExactlyOnceWith(ACCOUNT_2_URL, 2);
      expect(mocks.markAsBootstrap).toHaveBeenCalledExactlyOnceWith(2);
      expect(mocks.watchBootstrapAccount).toHaveBeenCalledExactlyOnceWith(2);
      expect(messagesAt(spies, 'debug')).toEqual([
        '[ExternalLinks] Marked new account 2 window as bootstrap',
      ]);
      expect(messagesAt(spies, 'info')).toEqual([
        '[ExternalLinks] Routed account URL to isolated account: 0 -> 2',
      ]);
      expectNoSentinels(spies, 2);
    });

    it('routes to an existing account with the original URL via loadAccountURL', async () => {
      mocks.hasAccount.mockReturnValue(true);
      mocks.getAccountURL.mockReturnValue('https://chat.google.com/u/2/');
      const { openHandler, spies } = await install();

      expect(openHandler({ url: ACCOUNT_2_URL })).toEqual({ action: 'deny' });

      expect(mocks.focusAccount).toHaveBeenCalledWith(2);
      expect(mocks.loadAccountURL).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        2,
        ACCOUNT_2_URL
      );
      expect(messagesAt(spies, 'info')).toEqual([
        '[ExternalLinks] Routed account URL to isolated account: 0 -> 2',
      ]);
      expectNoSentinels(spies);
    });

    it('skips loading into a bootstrap account that is mid-auth without logging the auth URL', async () => {
      mocks.hasAccount.mockReturnValue(true);
      mocks.isBootstrap.mockReturnValue(true);
      mocks.getAccountURL.mockReturnValue(SECRET_AUTH_URL);
      const { openHandler, spies } = await install();

      expect(openHandler({ url: ACCOUNT_2_URL })).toEqual({ action: 'deny' });

      expect(mocks.focusAccount).toHaveBeenCalledExactlyOnceWith(2);
      expect(mocks.loadAccountURL).not.toHaveBeenCalled();
      expect(messagesAt(spies, 'info')).toEqual([
        '[ExternalLinks] Bootstrap auth already active for account 2 — skipping loadURL',
      ]);
      expectNoSentinels(spies);
    });
  });

  describe('will-navigate entry point', () => {
    it('prevents a non-HTTP URL and logs only a fixed warning', async () => {
      const { willNavigate, spies } = await install();

      const event = willNavigate(NON_HTTP_URL);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(messagesAt(spies, 'warn')).toEqual([
        '[ExternalLinks] will-navigate: blocked non-HTTP URL',
      ]);
      expectNoSentinels(spies);
    });

    it('opens an external URL with the validated target and logs no URL', async () => {
      const { willNavigate, spies } = await install();

      const event = willNavigate(EXTERNAL_URL);
      await flushImmediate();

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(VALIDATED_EXTERNAL_URL);
      expect(messagesAt(spies, 'info')).toEqual([
        '[ExternalLinks] will-navigate: Opened external URL',
      ]);
      expectNoSentinels(spies);
    });

    it('logs an open failure without its Error', async () => {
      mocks.openExternal.mockImplementationOnce(() => {
        throw makeSecretError(EXTERNAL_URL);
      });
      const { willNavigate, spies } = await install();

      willNavigate(EXTERNAL_URL);
      await flushImmediate();

      expect(messagesAt(spies, 'error')).toEqual([
        '[ExternalLinks] will-navigate: Failed to open external URL',
      ]);
      expectNoSentinels(spies);
    });

    it('logs success for an asynchronous shell rejection that is reported elsewhere', async () => {
      mocks.openExternal.mockReturnValueOnce(handledRejection(makeSecretError(EXTERNAL_URL)));
      const { willNavigate, spies } = await install();

      willNavigate(EXTERNAL_URL);
      await flushImmediate();

      expect(messagesAt(spies, 'info')).toEqual([
        '[ExternalLinks] will-navigate: Opened external URL',
      ]);
      expectNoSentinels(spies);
    });

    it('routes a Chat account URL with the original URL and prevents default', async () => {
      const { willNavigate, spies } = await install();

      const event = willNavigate(ACCOUNT_2_URL);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mocks.createAccountWindow).toHaveBeenCalledExactlyOnceWith(ACCOUNT_2_URL, 2);
      expectNoSentinels(spies, 2);
    });

    it('lets whitelisted navigation proceed without logging', async () => {
      const { willNavigate, spies } = await install();

      const event = willNavigate(WHITELISTED_URL);
      await flushImmediate();

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(mocks.openExternal).not.toHaveBeenCalled();
      expect(spies.warn).not.toHaveBeenCalled();
      expect(spies.error).not.toHaveBeenCalled();
      expectNoSentinels(spies, 0);
    });
  });

  describe('cleanup', () => {
    it('logs cleanup, and a cleanup failure without its Error', async () => {
      const { feature, spies } = await install();
      feature.cleanupExternalLinks();
      expect(messagesAt(spies, 'info')).toContain(
        '[ExternalLinks] External links handler cleaned up'
      );

      mocks.setHooksManager.mockImplementationOnce(() => {
        throw makeSecretError();
      });
      feature.cleanupExternalLinks();

      expect(messagesAt(spies, 'error')).toEqual([
        '[ExternalLinks] Failed to cleanup external links',
      ]);
      expectNoSentinels(spies);
    });
  });
});
