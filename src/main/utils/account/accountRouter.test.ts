/**
 * Unit tests for accountRouter — window creation routing logic
 *
 * Covers: existing window reuse, minimized restore, auth-flow guard,
 * new window creation via WindowFactory.
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
import { routeAccountWindow } from './accountRouter';
import { AccountWindowRegistry } from './accountWindowRegistry';
import { markAsBootstrap, clearAllBootstrap } from './bootstrapTracker';
import { MockBrowserWindow } from '../../../../tests/mocks/electron';
import type { BrowserWindow } from 'electron';
import log from 'electron-log';
import {
  SECRET_AUTH_URL,
  SECRET_CHAT_URL,
  clearSpies,
  expectNoSentinels,
  makeSecretError,
  messagesAt,
  spiesOf,
} from '../../../../tests/mocks/logCapture';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextWebContentsId = 7000;

function makeTypedWindow(): BrowserWindow {
  const win = new MockBrowserWindow();
  (win.webContents as unknown as { id: number }).id = nextWebContentsId++;
  return win as unknown as BrowserWindow;
}

function makeMockFactory() {
  return {
    createWindow: vi.fn<(url: string, partition: string) => Electron.BrowserWindow>(),
  };
}

function registerOn(registry: AccountWindowRegistry) {
  return (window: BrowserWindow, accountIndex: number) => {
    registry.registerWindow(window, accountIndex);
  };
}

// ---------------------------------------------------------------------------
// routeAccountWindow — new window creation
// ---------------------------------------------------------------------------

describe('routeAccountWindow — new window path', () => {
  let registry: AccountWindowRegistry;
  let mockFactory: ReturnType<typeof makeMockFactory>;

  beforeEach(() => {
    nextWebContentsId = 7000;
    registry = new AccountWindowRegistry();
    mockFactory = makeMockFactory();
  });

  it('creates a new window via WindowFactory when no existing window', () => {
    const newWin = makeTypedWindow();
    mockFactory.createWindow.mockReturnValue(newWin);

    const result = routeAccountWindow(
      registry,
      mockFactory,
      'https://chat.google.com',
      0,
      undefined,
      registerOn(registry)
    );

    expect(mockFactory.createWindow).toHaveBeenCalledWith(
      'https://chat.google.com',
      'persist:account-0'
    );
    expect(result).toBe(newWin);
    expect(registry.hasAccount(0)).toBe(true);
    expect(registry.getAccountWindow(0)).toBe(newWin);
  });

  it('creates new window with correct partition for account index 3', () => {
    const newWin = makeTypedWindow();
    mockFactory.createWindow.mockReturnValue(newWin);

    routeAccountWindow(
      registry,
      mockFactory,
      'https://chat.google.com',
      3,
      undefined,
      registerOn(registry)
    );

    expect(mockFactory.createWindow).toHaveBeenCalledWith(
      'https://chat.google.com',
      'persist:account-3'
    );
  });

  it('throws when no WindowFactory and no existing window', () => {
    expect(() => routeAccountWindow(registry, undefined, 'https://chat.google.com', 0)).toThrow(
      'No WindowFactory injected'
    );
  });

  it('creates new window when existing window is destroyed', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 0);
    (win as unknown as MockBrowserWindow).destroy();

    const newWin = makeTypedWindow();
    mockFactory.createWindow.mockReturnValue(newWin);

    const result = routeAccountWindow(
      registry,
      mockFactory,
      'https://chat.google.com',
      0,
      undefined,
      registerOn(registry)
    );

    expect(mockFactory.createWindow).toHaveBeenCalledWith(
      'https://chat.google.com',
      'persist:account-0'
    );
    expect(result).toBe(newWin);
  });
});

// ---------------------------------------------------------------------------
// routeAccountWindow — existing window reuse
// ---------------------------------------------------------------------------

describe('routeAccountWindow — existing window reuse', () => {
  let registry: AccountWindowRegistry;
  let mockFactory: ReturnType<typeof makeMockFactory>;

  beforeEach(() => {
    nextWebContentsId = 8000;
    registry = new AccountWindowRegistry();
    mockFactory = makeMockFactory();
  });

  it('restores minimized existing window instead of creating new', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 0);
    (win as unknown as MockBrowserWindow).minimize();

    const restoreSpy = vi.spyOn(win, 'restore');
    const showSpy = vi.spyOn(win, 'show');
    const focusSpy = vi.spyOn(win, 'focus');

    const result = routeAccountWindow(registry, mockFactory, 'https://chat.google.com', 0);

    expect(restoreSpy).toHaveBeenCalled();
    expect(showSpy).toHaveBeenCalled();
    expect(focusSpy).toHaveBeenCalled();
    expect(result).toBe(win);
    expect(mockFactory.createWindow).not.toHaveBeenCalled();
  });

  it('focuses non-minimized existing window and calls loadURL', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 0);

    const showSpy = vi.spyOn(win, 'show');
    const focusSpy = vi.spyOn(win, 'focus');
    const loadURLSpy = vi.spyOn(win, 'loadURL');

    routeAccountWindow(registry, mockFactory, 'https://chat.google.com/new', 0);

    expect(showSpy).toHaveBeenCalled();
    expect(focusSpy).toHaveBeenCalled();
    expect(loadURLSpy).toHaveBeenCalledWith('https://chat.google.com/new');
  });

  it('updates mostRecentAccountIndex when reusing existing window', () => {
    const win0 = makeTypedWindow();
    const win1 = makeTypedWindow();
    registry.registerWindow(win0, 0);
    registry.registerWindow(win1, 1);

    win1.emit('focus');
    expect(registry.getMostRecentWindow()).toBe(win1);

    routeAccountWindow(registry, mockFactory, 'https://chat.google.com', 0);
    expect(registry.getMostRecentWindow()).toBe(win0);
  });
});

// ---------------------------------------------------------------------------
// routeAccountWindow — bootstrap auth-flow guard
// ---------------------------------------------------------------------------

describe('routeAccountWindow — auth-flow guard', () => {
  let registry: AccountWindowRegistry;
  let mockFactory: ReturnType<typeof makeMockFactory>;
  const GOOGLE_ACCOUNTS_URL = 'https://accounts.google.com/signin/v2/identifier';
  const CHAT_URL = 'https://chat.google.com/u/0/';
  const BOOTSTRAP_TARGET = 'https://accounts.google.com/ServiceLogin';

  beforeEach(() => {
    nextWebContentsId = 9000;
    clearAllBootstrap();
    registry = new AccountWindowRegistry();
    mockFactory = makeMockFactory();
  });

  it('does not call loadURL when bootstrap window is on accounts.google.com', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 0);
    (win as unknown as MockBrowserWindow).webContents.url = GOOGLE_ACCOUNTS_URL;

    markAsBootstrap(0);

    const loadURLSpy = vi.spyOn(win, 'loadURL');
    routeAccountWindow(registry, mockFactory, BOOTSTRAP_TARGET, 0);
    expect(loadURLSpy).not.toHaveBeenCalled();
  });

  it('still shows and focuses the window when mid-auth', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 0);
    (win as unknown as MockBrowserWindow).webContents.url = GOOGLE_ACCOUNTS_URL;

    markAsBootstrap(0);

    const showSpy = vi.spyOn(win, 'show');
    const focusSpy = vi.spyOn(win, 'focus');

    routeAccountWindow(registry, mockFactory, BOOTSTRAP_TARGET, 0);

    expect(showSpy).toHaveBeenCalled();
    expect(focusSpy).toHaveBeenCalled();
  });

  it('calls loadURL when bootstrap window is NOT on auth URL', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 0);
    (win as unknown as MockBrowserWindow).webContents.url = CHAT_URL;

    markAsBootstrap(0);

    const loadURLSpy = vi.spyOn(win, 'loadURL');
    routeAccountWindow(registry, mockFactory, BOOTSTRAP_TARGET, 0);
    expect(loadURLSpy).toHaveBeenCalledWith(BOOTSTRAP_TARGET);
  });

  it('calls loadURL for non-bootstrap window even on auth URL', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 0);
    (win as unknown as MockBrowserWindow).webContents.url = GOOGLE_ACCOUNTS_URL;

    const loadURLSpy = vi.spyOn(win, 'loadURL');
    routeAccountWindow(registry, mockFactory, BOOTSTRAP_TARGET, 0);
    expect(loadURLSpy).toHaveBeenCalledWith(BOOTSTRAP_TARGET);
  });
});

// ---------------------------------------------------------------------------
// routeAccountWindow — auto-hydrate dehydrated accounts (T12/M3)
// ---------------------------------------------------------------------------

describe('routeAccountWindow — auto-hydrate dehydrated accounts', () => {
  let registry: AccountWindowRegistry;
  let mockFactory: ReturnType<typeof makeMockFactory>;

  beforeEach(() => {
    nextWebContentsId = 9500;
    clearAllBootstrap();
    registry = new AccountWindowRegistry();
    mockFactory = makeMockFactory();
  });

  it('invokes the hydration hook when the account is dehydrated and uses the hydrated window', () => {
    const hydrated = makeTypedWindow();
    const hydrate = vi.fn().mockImplementation(() => {
      registry.registerWindow(hydrated, 0);
      return hydrated;
    });
    const isDehydrated = vi.fn().mockReturnValue(true);

    const result = routeAccountWindow(registry, mockFactory, 'https://chat.google.com', 0, {
      isDehydrated,
      hydrate,
    });

    expect(isDehydrated).toHaveBeenCalledWith(0);
    expect(hydrate).toHaveBeenCalledWith(0);
    expect(result).toBe(hydrated);
    // Factory must NOT be invoked — the hydration hook owns window creation.
    expect(mockFactory.createWindow).not.toHaveBeenCalled();
  });

  it('applies the requested URL after hydrate when it differs from the restored snapshot', () => {
    const hydrated = makeTypedWindow();
    (hydrated as unknown as MockBrowserWindow).webContents.url = 'https://chat.google.com/u/1/';
    const loadURLSpy = vi.spyOn(hydrated, 'loadURL');

    routeAccountWindow(registry, mockFactory, 'https://chat.google.com/u/1/room/abc', 0, {
      isDehydrated: () => true,
      hydrate: () => {
        registry.registerWindow(hydrated, 0);
        return hydrated;
      },
    });

    expect(loadURLSpy).toHaveBeenCalledWith('https://chat.google.com/u/1/room/abc');
    expect(mockFactory.createWindow).not.toHaveBeenCalled();
  });

  it('does not interrupt a hydrated bootstrap window mid Google auth', () => {
    const hydrated = makeTypedWindow();
    (hydrated as unknown as MockBrowserWindow).webContents.url =
      'https://accounts.google.com/signin/v2/identifier';
    markAsBootstrap(0);
    const loadURLSpy = vi.spyOn(hydrated, 'loadURL');

    routeAccountWindow(registry, mockFactory, 'https://chat.google.com/u/0/', 0, {
      isDehydrated: () => true,
      hydrate: () => {
        registry.registerWindow(hydrated, 0);
        return hydrated;
      },
    });

    expect(loadURLSpy).not.toHaveBeenCalled();
  });

  it('does not call the hydration hook when the account is not dehydrated', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 0);
    const hydrate = vi.fn();
    const isDehydrated = vi.fn().mockReturnValue(false);

    routeAccountWindow(registry, mockFactory, 'https://chat.google.com', 0, {
      isDehydrated,
      hydrate,
    });

    expect(isDehydrated).toHaveBeenCalledWith(0);
    expect(hydrate).not.toHaveBeenCalled();
  });

  it('falls back to factory creation when hook is provided but reports not dehydrated', () => {
    const newWin = makeTypedWindow();
    mockFactory.createWindow.mockReturnValue(newWin);
    const hydrate = vi.fn();
    const isDehydrated = vi.fn().mockReturnValue(false);

    const result = routeAccountWindow(
      registry,
      mockFactory,
      'https://chat.google.com',
      0,
      {
        isDehydrated,
        hydrate,
      },
      registerOn(registry)
    );

    expect(result).toBe(newWin);
    expect(hydrate).not.toHaveBeenCalled();
  });
});

describe('routeAccountWindow — new-window registration callback', () => {
  let registry: AccountWindowRegistry;
  let mockFactory: ReturnType<typeof makeMockFactory>;

  beforeEach(() => {
    nextWebContentsId = 9800;
    clearAllBootstrap();
    registry = new AccountWindowRegistry();
    mockFactory = makeMockFactory();
  });

  it('requires a registration callback on the factory-created branch', () => {
    const newWin = makeTypedWindow();
    mockFactory.createWindow.mockReturnValue(newWin);

    expect(() => routeAccountWindow(registry, mockFactory, 'https://chat.google.com', 1)).toThrow(
      /registration callback/
    );
    expect(registry.hasAccount(1)).toBe(false);
  });

  it('invokes the callback only for factory-created windows', () => {
    const existing = makeTypedWindow();
    registry.registerWindow(existing, 0);
    const onNewWindow = vi.fn();

    routeAccountWindow(registry, mockFactory, 'https://chat.google.com', 0, undefined, onNewWindow);

    expect(onNewWindow).not.toHaveBeenCalled();
    expect(mockFactory.createWindow).not.toHaveBeenCalled();
  });

  it('does not invoke the callback when the hydration hook produces a window', () => {
    const hydrated = makeTypedWindow();
    const onNewWindow = vi.fn();
    routeAccountWindow(
      registry,
      mockFactory,
      'https://chat.google.com',
      0,
      {
        isDehydrated: () => true,
        hydrate: () => {
          registry.registerWindow(hydrated, 0);
          return hydrated;
        },
      },
      onNewWindow
    );
    expect(onNewWindow).not.toHaveBeenCalled();
  });

  it('destroys the factory window and leaves no registry entry when the callback throws', () => {
    const newWin = makeTypedWindow();
    mockFactory.createWindow.mockReturnValue(newWin);
    const destroySpy = vi.spyOn(newWin, 'destroy');

    expect(() =>
      routeAccountWindow(registry, mockFactory, 'https://chat.google.com', 1, undefined, () => {
        throw new Error('register failed');
      })
    ).toThrow('register failed');

    expect(destroySpy).toHaveBeenCalled();
    expect(registry.hasAccount(1)).toBe(false);
    expect(newWin.isDestroyed()).toBe(true);
  });
});

describe('routeAccountWindow — routing conformance schedules', () => {
  let registry: AccountWindowRegistry;
  let mockFactory: ReturnType<typeof makeMockFactory>;

  beforeEach(() => {
    nextWebContentsId = 9900;
    clearAllBootstrap();
    registry = new AccountWindowRegistry();
    mockFactory = makeMockFactory();
  });

  it('records show/focus before loadURL on a live window and never assumes settle order', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 2);
    const order: string[] = [];
    const first = 'https://chat.google.com/u/2/room/first';
    const second = 'https://chat.google.com/u/2/room/second';
    const pending: Array<() => void> = [];

    vi.spyOn(win, 'show').mockImplementation(() => {
      order.push('show');
    });
    vi.spyOn(win, 'focus').mockImplementation(() => {
      order.push('focus');
    });
    vi.spyOn(win, 'loadURL').mockImplementation((url: string) => {
      order.push(`load:${url}`);
      return new Promise<void>((resolve) => {
        pending.push(resolve);
      });
    });

    routeAccountWindow(registry, mockFactory, first, 2);
    routeAccountWindow(registry, mockFactory, second, 2);

    expect(order).toEqual(['show', 'focus', `load:${first}`, 'show', 'focus', `load:${second}`]);
    expect(pending).toHaveLength(2);
    expect(mockFactory.createWindow).not.toHaveBeenCalled();
    pending.forEach((resolve) => {
      resolve();
    });
  });

  it('hydrates a dehydrated account before applying a different requested URL', () => {
    const hydrated = makeTypedWindow();
    (hydrated as unknown as MockBrowserWindow).webContents.url = 'https://chat.google.com/u/2/';
    const order: string[] = [];
    const hydrate = vi.fn(() => {
      order.push('hydrate');
      registry.registerWindow(hydrated, 2);
      return hydrated;
    });
    vi.spyOn(hydrated, 'loadURL').mockImplementation((url: string) => {
      order.push(`load:${url}`);
      return Promise.resolve();
    });

    const result = routeAccountWindow(
      registry,
      mockFactory,
      'https://chat.google.com/u/2/room/abc',
      2,
      { isDehydrated: () => true, hydrate }
    );

    expect(result).toBe(hydrated);
    expect(order).toEqual(['hydrate', 'load:https://chat.google.com/u/2/room/abc']);
    expect(mockFactory.createWindow).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// routeAccountWindow — log redaction (every logging call, every level)
// ---------------------------------------------------------------------------

describe('routeAccountWindow — log redaction', () => {
  const spies = spiesOf(log);
  let registry: AccountWindowRegistry;
  let mockFactory: ReturnType<typeof makeMockFactory>;

  beforeEach(() => {
    nextWebContentsId = 9800;
    clearAllBootstrap();
    clearSpies(spies);
    registry = new AccountWindowRegistry();
    mockFactory = makeMockFactory();
  });

  it('skips an existing mid-auth bootstrap window without logging the auth URL', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 2);
    (win as unknown as MockBrowserWindow).webContents.url = SECRET_AUTH_URL;
    markAsBootstrap(2);
    const loadURLSpy = vi.spyOn(win, 'loadURL');

    routeAccountWindow(registry, mockFactory, SECRET_CHAT_URL, 2);

    expect(loadURLSpy).not.toHaveBeenCalled();
    expect(messagesAt(spies, 'info', '[AccountRouter]')).toEqual([
      expect.stringContaining('[AccountRouter] Skipping loadURL for account 2'),
    ]);
    expectNoSentinels(spies);
  });

  it('passes the original URL to loadURL for an existing window', () => {
    const win = makeTypedWindow();
    registry.registerWindow(win, 1);
    const loadURLSpy = vi.spyOn(win, 'loadURL');

    routeAccountWindow(registry, mockFactory, SECRET_CHAT_URL, 1);

    expect(loadURLSpy).toHaveBeenCalledExactlyOnceWith(SECRET_CHAT_URL);
    expect(messagesAt(spies, 'info', '[AccountRouter]')).toEqual([]);
  });

  it('logs the factory-created window with the original URL reaching the factory', () => {
    const win = makeTypedWindow();
    mockFactory.createWindow.mockReturnValue(win as unknown as Electron.BrowserWindow);

    routeAccountWindow(registry, mockFactory, SECRET_CHAT_URL, 3, undefined, registerOn(registry));

    expect(mockFactory.createWindow).toHaveBeenCalledExactlyOnceWith(
      SECRET_CHAT_URL,
      'persist:account-3'
    );
    expect(messagesAt(spies, 'info', '[AccountRouter]')).toEqual([
      '[AccountRouter] Created account window 3 with partition: persist:account-3',
    ]);
    expectNoSentinels(spies);
  });

  it('logs a null hydration hook result and falls back to the factory with the original URL', () => {
    const win = makeTypedWindow();
    mockFactory.createWindow.mockReturnValue(win as unknown as Electron.BrowserWindow);

    routeAccountWindow(
      registry,
      mockFactory,
      SECRET_CHAT_URL,
      4,
      { isDehydrated: () => true, hydrate: () => null },
      registerOn(registry)
    );

    expect(messagesAt(spies, 'warn', '[AccountRouter]')).toEqual([
      expect.stringContaining('[AccountRouter] Hydration hook returned null for account 4'),
    ]);
    expect(mockFactory.createWindow).toHaveBeenCalledExactlyOnceWith(
      SECRET_CHAT_URL,
      'persist:account-4'
    );
    expectNoSentinels(spies);
  });

  it('skips post-hydrate loadURL mid-auth without logging the auth URL', () => {
    const hydrated = makeTypedWindow();
    (hydrated as unknown as MockBrowserWindow).webContents.url = SECRET_AUTH_URL;
    markAsBootstrap(0);
    const loadURLSpy = vi.spyOn(hydrated, 'loadURL');

    routeAccountWindow(registry, mockFactory, SECRET_CHAT_URL, 0, {
      isDehydrated: () => true,
      hydrate: () => hydrated,
    });

    expect(loadURLSpy).not.toHaveBeenCalled();
    expect(messagesAt(spies, 'info', '[AccountRouter]')).toEqual([
      expect.stringContaining('[AccountRouter] Skipping post-hydrate loadURL for account 0'),
    ]);
    expectNoSentinels(spies);
  });

  it('applies the original URL after hydrate when getURL throws a secret-bearing Error', () => {
    const hydrated = makeTypedWindow();
    const secretError = makeSecretError();
    (hydrated as unknown as MockBrowserWindow).webContents.getURL = () => {
      throw secretError;
    };
    const loadURLSpy = vi.spyOn(hydrated, 'loadURL');

    routeAccountWindow(registry, mockFactory, SECRET_CHAT_URL, 0, {
      isDehydrated: () => true,
      hydrate: () => hydrated,
    });

    expect(loadURLSpy).toHaveBeenCalledExactlyOnceWith(SECRET_CHAT_URL);
    expect(messagesAt(spies, 'warn', '[AccountRouter]')).toEqual([
      expect.stringContaining('[AccountRouter] getURL failed after hydrate for account 0'),
    ]);
    expectNoSentinels(spies);
  });
});
