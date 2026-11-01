import { EventEmitter, once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainEvent, WebContents } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants.js';
import { asType } from '../../shared/typeUtils.js';
import { electronMock } from '../../../tests/mocks/electron.js';

const ipcMain = new EventEmitter();
const focus = vi.fn();

class NativeBanner extends EventEmitter {
  static readonly shown: NativeBanner[] = [];
  static isSupported() {
    return true;
  }
  readonly title: string;
  closeCount = 0;

  constructor(options: { title: string }) {
    super();
    this.title = options.title;
  }
  show() {
    NativeBanner.shown.push(this);
  }
  close() {
    this.closeCount += 1;
    this.emit('programmatic-close');
  }
}

vi.mock('electron', () => ({ ...electronMock, ipcMain, Notification: NativeBanner }));
vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../utils/platform/notificationFocus.js', () => ({
  focusNotificationSource: focus,
  resolveNotificationFocusWindow: (_event: unknown, window: BrowserWindow) => window,
}));
vi.mock('../utils/platform/accountNotificationIdentity.js', () => ({
  resolveAccountIndexFromIpcEvent: () => null,
  namespaceNotificationTag: (_index: unknown, tag: string) => tag,
  formatAccountNotificationLabel: () => 'GogChat',
  accountNotificationGroupId: () => 'unknown',
}));

afterEach(async () => {
  const feature = await import('./handleNotification.js');
  feature.cleanupNotificationHandler();
  const limiter = await import('../utils/ipc/rateLimiter.js');
  limiter.destroyRateLimiter();
  const cleanup = await import('../utils/lifecycle/resourceCleanup.js');
  cleanup.destroyCleanupManager();
  ipcMain.removeAllListeners();
  NativeBanner.shown.length = 0;
  vi.useRealTimers();
});

it('dismisses an accepted native banner after closes for 51 throttled shows in the same sender window', async () => {
  vi.useFakeTimers();
  const feature = await import('./handleNotification.js');
  feature.default(asType<BrowserWindow>({ isDestroyed: () => false }));
  const sender = asType<WebContents>(
    Object.assign(new EventEmitter(), {
      id: 7,
      isDestroyed: () => false,
      send: vi.fn(),
    })
  );
  const event = asType<IpcMainEvent>({ sender });
  for (let index = 0; index < 56; index += 1) {
    ipcMain.emit(IPC_CHANNELS.NOTIFICATION_SHOW, event, {
      title: String(index),
      tag: String(index),
      documentId: 'doc-1',
      instanceId: `n${index}`,
    });
  }
  expect(NativeBanner.shown).toHaveLength(5);
  const accepted = NativeBanner.shown[0];
  if (!accepted) throw new Error('No accepted native show');
  const lateClick = accepted.listeners('click');
  const closed = once(accepted, 'programmatic-close', {
    signal: globalThis.AbortSignal.timeout(1000),
  });

  for (let index = 5; index < 56; index += 1) {
    ipcMain.emit(IPC_CHANNELS.NOTIFICATION_CLOSE, event, {
      documentId: 'doc-1',
      instanceId: `n${index}`,
    });
  }
  ipcMain.emit(IPC_CHANNELS.NOTIFICATION_CLOSE, event, { documentId: 'doc-1', instanceId: 'n0' });
  await closed;
  for (const callback of lateClick) callback();

  expect(accepted.closeCount).toBe(1);
  expect(focus).not.toHaveBeenCalled();
  expect(sender.send).not.toHaveBeenCalled();
});
