/**
 * Unit tests for handleNotification feature — IPC wiring to nativeNotification
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

function makeFakeWindow() {
  const wc = new EventEmitter() as EventEmitter & { getURL: () => string };
  wc.getURL = vi.fn(() => 'https://chat.google.com');

  const win = new EventEmitter() as EventEmitter & {
    webContents: typeof wc;
    isDestroyed: () => boolean;
    destroy: () => void;
    show: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    isVisible: ReturnType<typeof vi.fn>;
    isFocused: ReturnType<typeof vi.fn>;
    isMinimized: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
    _destroyed: boolean;
  };

  win.webContents = wc;
  win._destroyed = false;
  win.isDestroyed = () => win._destroyed;
  win.destroy = () => {
    win._destroyed = true;
    win.emit('closed');
  };

  win.show = vi.fn();
  win.hide = vi.fn();
  win.focus = vi.fn();
  win.isVisible = vi.fn().mockReturnValue(true);
  win.isFocused = vi.fn().mockReturnValue(true);
  win.isMinimized = vi.fn().mockReturnValue(false);
  win.restore = vi.fn();

  return win;
}

const showNativeNotificationMock = vi.fn().mockReturnValue(true);
const cleanupActiveNativeNotificationsMock = vi.fn();
const focusNotificationSourceMock = vi.fn();
const resolveNotificationFocusWindowMock = vi.fn();
const resolveAccountIndexMock = vi.fn().mockReturnValue(0);
const buildAccountAwarePayloadMock = vi.fn((opts: Record<string, unknown>) => ({
  title: opts['title'],
  body: opts['body'],
  icon: opts['icon'],
  tag: `a0:${opts['chatTag'] ?? 'x'}`,
  subtitle: 'Account 1',
  groupId: 'gogchat-account-0',
}));

const ipcMainMock = {
  on: vi.fn(),
  removeListener: vi.fn(),
};

vi.mock('electron', () => ({
  BrowserWindow: Object.assign(vi.fn(), {
    fromWebContents: vi.fn(),
  }),
  ipcMain: ipcMainMock,
}));

vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../shared/constants.js', () => ({
  IPC_CHANNELS: {
    NOTIFICATION_SHOW: 'notificationShow',
    NOTIFICATION_CLICKED: 'notificationClicked',
  },
  RATE_LIMITS: {
    IPC_NOTIFICATION: 5,
  },
}));

vi.mock('../../shared/dataValidators.js', () => ({
  validateNotificationData: vi.fn(
    (data) => data as { title: string; body?: string; icon?: string; tag?: string }
  ),
}));

const defineIPCMock = vi.fn();
vi.mock('../utils/ipc/defineIPC.js', () => ({
  defineIPC: defineIPCMock,
}));

const getRateLimiterMock = vi.fn().mockReturnValue({
  isAllowed: vi.fn().mockReturnValue(true),
});
vi.mock('../utils/ipc/rateLimiter.js', () => ({
  getRateLimiter: getRateLimiterMock,
}));

vi.mock('../utils/platform/nativeNotification.js', () => ({
  showNativeNotification: (...args: unknown[]) => showNativeNotificationMock(...args),
  cleanupActiveNativeNotifications: () => cleanupActiveNativeNotificationsMock(),
  buildAccountAwareNotificationPayload: (...args: unknown[]) =>
    buildAccountAwarePayloadMock(...(args as [Record<string, unknown>])),
}));

vi.mock('../utils/platform/accountNotificationIdentity.js', () => ({
  resolveAccountIndexFromIpcEvent: (...args: unknown[]) => resolveAccountIndexMock(...args),
}));

vi.mock('../utils/platform/notificationFocus.js', () => ({
  focusNotificationSource: (...args: unknown[]) => focusNotificationSourceMock(...args),
  resolveNotificationFocusWindow: (...args: unknown[]) =>
    resolveNotificationFocusWindowMock(...args),
}));

describe('handleNotification feature', () => {
  let fakeWindow: ReturnType<typeof makeFakeWindow>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    showNativeNotificationMock.mockReturnValue(true);
    fakeWindow = makeFakeWindow();
    resolveNotificationFocusWindowMock.mockImplementation(
      (_event: unknown, fallback: unknown) => fallback
    );

    defineIPCMock.mockImplementation(() => () => {
      // cleanup
    });
  });

  it('sets up NOTIFICATION_SHOW and NOTIFICATION_CLICKED handlers', async () => {
    const feature = await import('./handleNotification.js');
    feature.default(fakeWindow as unknown as Electron.BrowserWindow);

    expect(defineIPCMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'notificationShow' })
    );
    expect(defineIPCMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'notificationClicked' })
    );
  });

  it('forwards account-aware bridge payload with subtitle and namespaced tag', async () => {
    const feature = await import('./handleNotification.js');
    feature.default(fakeWindow as unknown as Electron.BrowserWindow);

    const handlerConfig = defineIPCMock.mock.calls.find(
      (call: unknown[]) => (call[0] as { channel: string }).channel === 'notificationShow'
    )?.[0] as { handler: (data: unknown, event?: unknown) => void };

    const event = { sender: { id: 42, isDestroyed: () => false } };
    handlerConfig.handler(
      {
        title: 'Test Title',
        body: 'Test body',
        icon: 'test-icon.png',
        tag: 'tag1',
      },
      event
    );

    expect(resolveAccountIndexMock).toHaveBeenCalledWith(event);
    expect(buildAccountAwarePayloadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Test Title',
        body: 'Test body',
        chatTag: 'tag1',
        accountIndex: 0,
      })
    );
    expect(showNativeNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Test Title',
        subtitle: 'Account 1',
        tag: 'a0:tag1',
      }),
      expect.objectContaining({
        focusWindow: fakeWindow,
        ipcEvent: event,
        source: 'bridge',
        accountIndex: 0,
      })
    );
  });

  it('NOTIFICATION_CLICKED uses focusNotificationSource', async () => {
    const feature = await import('./handleNotification.js');
    feature.default(fakeWindow as unknown as Electron.BrowserWindow);

    const handlerConfig = defineIPCMock.mock.calls.find(
      (call: unknown[]) => (call[0] as { channel: string }).channel === 'notificationClicked'
    )?.[0] as { handler: (data: unknown, event?: unknown) => void };

    const event = { sender: { id: 7, isDestroyed: () => false } };
    handlerConfig.handler(undefined, event);

    expect(focusNotificationSourceMock).toHaveBeenCalledWith(event, fakeWindow);
  });

  it('cleanupNotificationHandler closes native notifications and removes IPC', async () => {
    const feature = await import('./handleNotification.js');
    feature.default(fakeWindow as unknown as Electron.BrowserWindow);

    feature.cleanupNotificationHandler();

    expect(cleanupActiveNativeNotificationsMock).toHaveBeenCalled();
    expect(() => feature.cleanupNotificationHandler()).not.toThrow();
  });
});
