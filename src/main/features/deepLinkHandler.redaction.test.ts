/**
 * Log-redaction tests for deep links and single-instance argv forwarding: secret-bearing URLs go
 * through the REAL validators, deep-link utilities, menu-action registry and shell wrapper, and
 * every electron-log argument is scanned for sentinels. Navigation collaborators must still
 * receive the original or validated URL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  SECRET_AUTH_URL,
  expectNoSentinels,
  makeSecretError,
  messagesAt,
  recordedCalls,
  spiesOf,
} from '../../../tests/mocks/logCapture';

const QUERY =
  '?token=P2_QUERY&continue=https%3A%2F%2Fchat.google.com%2Fchat%2FP2_CONTINUE#P2_FRAGMENT';
/** gogchat:// link; the validator turns it into this https URL (credentials stripped). */
const DEEP_LINK = `gogchat://u/2/room/P2_PATH${QUERY}`;
const VALIDATED_DEEP_LINK = `https://chat.google.com/u/2/room/P2_PATH${QUERY}`;
const EXTERNAL_HTTPS = `https://P2_USERINFO:P2_USERINFO@evil.example/P2_PATH${QUERY}`;
const VALIDATED_EXTERNAL = `https://evil.example/P2_PATH${QUERY}`;

const mocks = vi.hoisted(() => ({
  appHandlers: {} as Record<string, (...args: unknown[]) => void>,
  trackedHandlers: [] as Array<(...args: unknown[]) => void>,
  setAsDefaultProtocolClient: vi.fn(),
  openExternal: vi.fn(),
  createAccountWindow: vi.fn(),
  peekAccountWindowManager: vi.fn(),
  getMostRecentWindow: vi.fn(),
  loadAccountURL: vi.fn(),
  getAccountURL: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    setAsDefaultProtocolClient: mocks.setAsDefaultProtocolClient,
    requestSingleInstanceLock: vi.fn().mockReturnValue(true),
    exit: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      mocks.appHandlers[event] = handler;
    }),
  },
  shell: { openExternal: mocks.openExternal },
}));
vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../utils/account/accountWindowManager.js', () => ({
  createAccountWindow: mocks.createAccountWindow,
  peekAccountWindowManager: mocks.peekAccountWindowManager,
  getMostRecentWindow: mocks.getMostRecentWindow,
}));
vi.mock('../utils/account/accountNavigation.js', () => ({
  loadAccountURL: mocks.loadAccountURL,
  getAccountURL: mocks.getAccountURL,
}));
vi.mock('../utils/lifecycle/resourceCleanup.js', () => ({
  addTrackedListener: vi.fn(
    (_target: unknown, _event: string, handler: (...args: unknown[]) => void) => {
      mocks.trackedHandlers.push(handler);
    }
  ),
}));

function makeManager(hasAccount: boolean, webContents: unknown = null) {
  return {
    hasAccount: vi.fn().mockReturnValue(hasAccount),
    focusAccount: vi.fn(),
    getAccountWebContents: vi.fn().mockReturnValue(webContents),
  };
}

function makeWebContents() {
  const wc = new EventEmitter() as EventEmitter & Record<string, unknown>;
  wc.isDestroyed = vi.fn(() => false);
  return wc;
}

async function load() {
  const deepLink = await import('./deepLinkHandler.js');
  const singleInstance = await import('./singleInstance.js');
  const spies = spiesOf((await import('electron-log')).default);
  const openUrl = (url: string) => {
    const event = { preventDefault: vi.fn() };
    mocks.trackedHandlers.at(-1)?.(event, url);
    return event;
  };
  return { deepLink, singleInstance, spies, openUrl };
}

const liveWindow = () => ({ isDestroyed: () => false });

describe('deep links and single instance — log redaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.trackedHandlers.length = 0;
    for (const key of Object.keys(mocks.appHandlers)) {
      delete mocks.appHandlers[key];
    }
    mocks.setAsDefaultProtocolClient.mockReturnValue(true);
    mocks.openExternal.mockResolvedValue(undefined);
    mocks.peekAccountWindowManager.mockReturnValue(makeManager(false));
    mocks.createAccountWindow.mockReturnValue(liveWindow());
    mocks.loadAccountURL.mockReturnValue(true);
    mocks.getAccountURL.mockReturnValue('https://chat.google.com/u/2/');
  });

  describe('processDeepLink', () => {
    it('creates a missing account with the validated URL and logs no URL', async () => {
      const manager = makeManager(false);
      mocks.peekAccountWindowManager.mockReturnValue(manager);
      const { deepLink, spies } = await load();

      deepLink.processDeepLink(DEEP_LINK);

      expect(mocks.createAccountWindow).toHaveBeenCalledExactlyOnceWith(VALIDATED_DEEP_LINK, 2);
      expect(manager.focusAccount).toHaveBeenCalledExactlyOnceWith(2);
      expect(messagesAt(spies, 'info')).toEqual(['[DeepLink] Received deep link']);
      expectNoSentinels(spies);
    });

    it('loads a differing URL into an existing account and logs navigation without it', async () => {
      const manager = makeManager(true);
      mocks.peekAccountWindowManager.mockReturnValue(manager);
      const { deepLink, spies } = await load();

      deepLink.processDeepLink(DEEP_LINK);

      expect(mocks.loadAccountURL).toHaveBeenCalledExactlyOnceWith(manager, 2, VALIDATED_DEEP_LINK);
      expect(messagesAt(spies, 'info')).toEqual([
        '[DeepLink] Received deep link',
        '[DeepLink] Navigating to',
      ]);
      expectNoSentinels(spies, 2);
    });

    it('buffers while Google auth is active and replays the validated URL after sign-in', async () => {
      const wc = makeWebContents();
      const manager = makeManager(true, wc);
      mocks.peekAccountWindowManager.mockReturnValue(manager);
      mocks.getAccountURL.mockReturnValue(SECRET_AUTH_URL);
      const { deepLink, spies } = await load();

      deepLink.processDeepLink(DEEP_LINK);

      expect(mocks.loadAccountURL).not.toHaveBeenCalled();
      expect(wc.listenerCount('did-navigate')).toBe(1);
      expect(wc.listenerCount('destroyed')).toBe(1);

      mocks.getAccountURL.mockReturnValue('https://chat.google.com/u/2/');
      wc.emit('did-navigate', {}, 'https://chat.google.com/u/2/P2_PATH?token=P2_QUERY');

      expect(wc.listenerCount('did-navigate')).toBe(0);
      expect(mocks.loadAccountURL).toHaveBeenCalledExactlyOnceWith(manager, 2, VALIDATED_DEEP_LINK);
      expect(messagesAt(spies, 'info')).toEqual([
        '[DeepLink] Received deep link',
        '[DeepLink] Google auth in progress, buffering URL',
        '[DeepLink] Processing buffered deep link',
        '[DeepLink] Navigating to',
      ]);
      expectNoSentinels(spies, 4);
    });

    it('re-buffers when loadAccountURL skips and arms the replay', async () => {
      const wc = makeWebContents();
      mocks.peekAccountWindowManager.mockReturnValue(makeManager(true, wc));
      mocks.loadAccountURL.mockReturnValue(false);
      const { deepLink, spies } = await load();

      deepLink.processDeepLink(DEEP_LINK);

      expect(messagesAt(spies, 'info')).toContain(
        '[DeepLink] loadAccountURL skipped, buffering URL'
      );
      expect(wc.listenerCount('did-navigate')).toBe(1);
      deepLink.cleanupDeepLinkHandler();
      expect(wc.listenerCount('did-navigate')).toBe(0);
      expectNoSentinels(spies, 3);
    });

    it('buffers when no manager exists or the created window is destroyed', async () => {
      mocks.peekAccountWindowManager.mockReturnValue(null);
      const { deepLink, spies } = await load();
      deepLink.processDeepLink(DEEP_LINK);

      mocks.peekAccountWindowManager.mockReturnValue(makeManager(false));
      mocks.createAccountWindow.mockReturnValue({ isDestroyed: () => true });
      deepLink.processDeepLink(DEEP_LINK);

      expect(messagesAt(spies, 'info').filter((m) => m.includes('buffering'))).toEqual([
        '[DeepLink] Window not ready, buffering URL',
        '[DeepLink] Window not ready, buffering URL',
      ]);
      expectNoSentinels(spies, 4);
    });

    it.each([
      ['an unparseable non-URL string', 'not a url P2_PATH?token=P2_QUERY#P2_FRAGMENT'],
      ['a non-Chat https host', EXTERNAL_HTTPS],
      ['an unsupported scheme', 'ftp://P2_USERINFO:P2_USERINFO@evil.example/P2_PATH?x=P2_QUERY'],
    ])('replaces the validation Error for %s with the fixed placeholder', async (_label, url) => {
      const { deepLink, spies } = await load();

      deepLink.processDeepLink(url);

      const [message, logged] = spies.error.mock.calls[0] as [string, Error];
      expect(message).toBe('[DeepLink] Failed to process deep link:');
      expect(logged).toBeInstanceOf(Error);
      expect(logged.message).toBe('[redacted]');
      expect(logged.stack).toBe('[redacted]');
      expect(logged.cause).toBeUndefined();
      expect(mocks.createAccountWindow).not.toHaveBeenCalled();
      expect(messagesAt(spies, 'info')).toEqual(['[DeepLink] Received deep link']);
      expectNoSentinels(spies, 2);
    });
  });

  describe('open-url listener', () => {
    it('routes a gogchat:// URL to processDeepLink and logs listener lifecycle without URLs', async () => {
      const { deepLink, spies, openUrl } = await load();
      deepLink.setupDeepLinkListener();
      deepLink.setupDeepLinkListener();

      const event = openUrl(DEEP_LINK);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mocks.createAccountWindow).toHaveBeenCalledExactlyOnceWith(VALIDATED_DEEP_LINK, 2);
      expect(messagesAt(spies, 'warn')).toEqual([
        '[DeepLink] open-url listener already registered',
      ]);
      expect(messagesAt(spies, 'info')).toEqual([
        '[DeepLink] open-url listener registered',
        '[DeepLink] open-url event',
        '[DeepLink] Received deep link',
      ]);
      expectNoSentinels(spies, 4);
    });

    it('opens an external https URL with the validated target and logs no URL', async () => {
      const { deepLink, spies, openUrl } = await load();
      deepLink.setupDeepLinkListener();

      openUrl(EXTERNAL_HTTPS);

      expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(VALIDATED_EXTERNAL);
      expect(messagesAt(spies, 'info')).toEqual([
        '[DeepLink] open-url listener registered',
        '[DeepLink] open-url event',
        '[DeepLink] Opening external URL in default browser',
      ]);
      expectNoSentinels(spies, 3);
    });

    it('replaces a validator failure for an external URL with the fixed placeholder', async () => {
      const { deepLink, spies, openUrl } = await load();
      deepLink.setupDeepLinkListener();

      openUrl(`https://evil.example/P2_PATH?x=javascript:P2_QUERY#P2_FRAGMENT`);

      expect(mocks.openExternal).not.toHaveBeenCalled();
      const [message, logged] = spies.error.mock.calls[0] as [string, Error];
      expect(message).toBe('[DeepLink] Failed to open external URL:');
      expect(logged.message).toBe('[redacted]');
      expect(logged.stack).toBe('[redacted]');
      expectNoSentinels(spies, 3);
    });

    it('ignores an unrecognized scheme without logging it', async () => {
      const { deepLink, spies, openUrl } = await load();
      deepLink.setupDeepLinkListener();

      openUrl('ftp://P2_USERINFO:P2_USERINFO@evil.example/P2_PATH?x=P2_QUERY#P2_FRAGMENT');

      expect(messagesAt(spies, 'warn')).toEqual(['[DeepLink] Ignoring unrecognized URL scheme']);
      expect(mocks.createAccountWindow).not.toHaveBeenCalled();
      expect(mocks.openExternal).not.toHaveBeenCalled();
      expectNoSentinels(spies, 3);
    });
  });

  describe('initialization and teardown', () => {
    it('processes a secret-bearing startup argv link and logs initialization without it', async () => {
      const argv = process.argv;
      process.argv = ['electron', 'app', DEEP_LINK];
      try {
        const { deepLink, spies } = await load();
        deepLink.default({});

        expect(mocks.createAccountWindow).toHaveBeenCalledExactlyOnceWith(VALIDATED_DEEP_LINK, 2);
        expect(messagesAt(spies, 'info')).toEqual([
          '[DeepLink] Registered as default protocol client for gogchat://',
          '[DeepLink] Received deep link',
          '[DeepLink] Deep link handler initialized',
        ]);
        expectNoSentinels(spies, 3);
      } finally {
        process.argv = argv;
      }
    });

    it('logs protocol registration failure and error without URLs', async () => {
      mocks.setAsDefaultProtocolClient.mockReturnValueOnce(false);
      const { deepLink, spies } = await load();
      deepLink.registerDeepLinkProtocol();
      expect(messagesAt(spies, 'error')).toEqual([
        '[DeepLink] Failed to register as default protocol client for gogchat://',
      ]);

      mocks.setAsDefaultProtocolClient.mockImplementationOnce(() => {
        throw makeSecretError();
      });
      deepLink.registerDeepLinkProtocol();

      const [message, logged] = spies.error.mock.calls[1] as [string, Error];
      expect(message).toBe('[DeepLink] Error registering protocol client:');
      expect(logged.message).toBe('[redacted]');
      expectNoSentinels(spies, 2);
    });

    it('replaces initialization and cleanup Errors with the fixed placeholder', async () => {
      mocks.setAsDefaultProtocolClient.mockImplementation(() => {
        throw makeSecretError();
      });
      const { deepLink, spies } = await load();
      deepLink.default({});
      deepLink.registerDeepLinkProtocol();
      spies.debug.mockImplementationOnce(() => {
        throw makeSecretError();
      });
      deepLink.cleanupDeepLinkHandler();

      const messages = spies.error.mock.calls.map(([message]) => message);
      expect(messages).toContain('[DeepLink] Error registering protocol client:');
      expect(messages).toContain('[DeepLink] Failed to cleanup:');
      for (const [, logged] of spies.error.mock.calls as Array<[string, Error]>) {
        expect(logged.message).toBe('[redacted]');
        expect(logged.stack).toBe('[redacted]');
      }
      expectNoSentinels(spies);
    });

    it('logs a failed handler initialization with the fixed placeholder', async () => {
      const { deepLink, spies } = await load();
      const registry = await import('./menuActionRegistry.js');
      vi.spyOn(registry, 'registerMenuAction').mockImplementationOnce(() => {
        throw makeSecretError();
      });
      deepLink.default({});

      const [message, logged] = spies.error.mock.calls[0] as [string, Error];
      expect(message).toBe('[DeepLink] Failed to initialize deep link handler:');
      expect(logged.message).toBe('[redacted]');
      expect(logged.stack).toBe('[redacted]');
      expectNoSentinels(spies);
    });

    it('logs buffered-link processing and cleanup', async () => {
      mocks.peekAccountWindowManager.mockReturnValue(null);
      const { deepLink, spies } = await load();
      deepLink.processDeepLink(DEEP_LINK);
      mocks.peekAccountWindowManager.mockReturnValue(makeManager(false));

      deepLink.default({});
      deepLink.cleanupDeepLinkHandler();

      expect(messagesAt(spies, 'info')).toContain('[DeepLink] Processing buffered deep link');
      expect(messagesAt(spies, 'debug')).toEqual(['[DeepLink] Cleaning up deep link handler']);
      expect(messagesAt(spies, 'info')).toContain('[DeepLink] Deep link handler cleaned up');
      expect(mocks.createAccountWindow).toHaveBeenCalledExactlyOnceWith(VALIDATED_DEEP_LINK, 2);
      expectNoSentinels(spies, 5);
    });
  });

  describe('single-instance argv forwarding', () => {
    function secondInstance() {
      const handler = mocks.appHandlers['second-instance'];
      expect(handler).toBeTypeOf('function');
      return (argv: string[]) => handler?.({}, argv);
    }

    it('forwards the original argv link to processDeepLink without logging it', async () => {
      const { deepLink, singleInstance, spies } = await load();
      deepLink.default({});
      singleInstance.restoreFirstInstance({});
      const window = {
        isMinimized: vi.fn().mockReturnValue(true),
        restore: vi.fn(),
        show: vi.fn(),
        focus: vi.fn(),
      };
      mocks.getMostRecentWindow.mockReturnValue(window);
      mocks.createAccountWindow.mockClear();

      secondInstance()(['electron', DEEP_LINK]);

      expect(window.restore).toHaveBeenCalledTimes(1);
      expect(window.show).toHaveBeenCalledTimes(1);
      expect(window.focus).toHaveBeenCalledTimes(1);
      expect(mocks.createAccountWindow).toHaveBeenCalledExactlyOnceWith(VALIDATED_DEEP_LINK, 2);
      expect(messagesAt(spies, 'info')).toEqual(
        expect.arrayContaining([
          '[SingleInstance] Received deep link from second instance',
          '[DeepLink] Received deep link',
        ])
      );
      expect(recordedCalls(spies).length).toBeGreaterThan(0);
      expectNoSentinels(spies, 3);
    });

    it('logs a dropped link when processDeepLink is not registered', async () => {
      const { singleInstance, spies } = await load();
      singleInstance.restoreFirstInstance({});
      mocks.getMostRecentWindow.mockReturnValue(null);

      secondInstance()(['electron', DEEP_LINK]);

      expect(messagesAt(spies, 'info')).toEqual([
        '[SingleInstance] Received deep link from second instance',
      ]);
      expect(messagesAt(spies, 'warn')).toEqual([
        '[SingleInstance] processDeepLink action not registered — deep link dropped',
      ]);
      expect(mocks.createAccountWindow).not.toHaveBeenCalled();
      expectNoSentinels(spies, 2);
    });

    it('stays silent for argv without a deep link even when other args carry secrets', async () => {
      const { singleInstance, spies } = await load();
      singleInstance.restoreFirstInstance({});
      mocks.getMostRecentWindow.mockReturnValue(null);

      secondInstance()(['electron', `--url=${EXTERNAL_HTTPS}`, SECRET_AUTH_URL]);

      expect(recordedCalls(spies)).toEqual([]);
      expectNoSentinels(spies, 0);
    });
  });
});
