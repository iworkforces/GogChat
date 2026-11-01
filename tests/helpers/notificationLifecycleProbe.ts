import type { ElectronApplication } from '@playwright/test';
import type { Notification, WebContents } from 'electron';
import type { AccountIndex } from '../../src/shared/types/branded.js';
import type { AccountBackendKind, IAccountWindowManager } from '../../src/shared/types/window.js';
import { IPC_CHANNELS } from '../../src/shared/constants.js';

export async function exerciseNotificationLifecycle(
  app: ElectronApplication,
  options: {
    readonly backend: AccountBackendKind;
    readonly url: string;
    readonly indices: readonly AccountIndex[];
  }
) {
  const scenario = async (
    { Notification, ipcMain }: typeof import('electron'),
    input: typeof options & { readonly channels: typeof IPC_CHANNELS }
  ) => {
    if (ipcMain.listenerCount(input.channels.NOTIFICATION_SHOW) === 0) {
      await new Promise<void>((resolve, reject) => {
        const ready = (channel: string) => {
          if (channel !== input.channels.NOTIFICATION_SHOW) return;
          clearTimeout(timer);
          ipcMain.removeListener('newListener', ready);
          resolve();
        };
        const timer = setTimeout(() => {
          ipcMain.removeListener('newListener', ready);
          reject(new Error('Notification feature did not register'));
        }, 15000);
        ipcMain.on('newListener', ready);
      });
    }
    const getManager: () => IAccountWindowManager = Reflect.get(
      globalThis,
      '__gogchatGetAccountWindowManager'
    );
    const manager = getManager();
    const [zero, secondary] = input.indices;
    if (zero === undefined || secondary === undefined) throw new Error('Two accounts required');
    const originals = {
      show: Notification.prototype.show,
      close: Notification.prototype.close,
      supported: Notification.isSupported,
      focus: manager.focusAccount,
    };
    const pending = new Map<string, (notification: Notification) => void>();
    const closes: string[] = [];
    const focuses: AccountIndex[] = [];
    const barriers = new Map<number, number>();
    const senderFor = (index: AccountIndex): WebContents => {
      const sender = manager.getAccountWebContents(index);
      if (!sender || sender.isDestroyed()) throw new Error(`Missing account renderer ${index}`);
      return sender;
    };
    const initialize = async (sender: WebContents) => {
      if (sender.isLoadingMainFrame()) {
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            clearTimeout(timer);
              sender.removeListener('did-stop-loading', loaded);
            sender.removeListener('destroyed', destroyed);
          };
          const loaded = () => {
            finish();
            resolve();
          };
          const destroyed = () => {
            finish();
            reject(new Error('Account renderer destroyed during load'));
          };
          const timer = setTimeout(() => {
            finish();
              reject(new Error(`Account harness did not finish loading: ${sender.id} ${sender.getURL()}`));
          }, 5000);
            sender.once('did-stop-loading', loaded);
          sender.once('destroyed', destroyed);
        });
      }
      const ready = await sender.executeJavaScript(`(() => {
        if (window.__gogchatNotificationBridgeInstalled !== true) return false;
        window.__notificationProbe = { objects: {}, events: [], barrier: 0 };
        window.gogchat.onSearchShortcut(() => {
          window.__notificationProbe.barrier++;
          window.dispatchEvent(new Event('__notificationProbeBarrier'));
        });
        return true;
      })()`);
      if (ready !== true) throw new Error('Account missing built page Notification wrapper');
    };
    const snapshot = async (sender: WebContents): Promise<string[]> => {
      const count = (barriers.get(sender.id) ?? 0) + 1;
      barriers.set(sender.id, count);
      sender.send(input.channels.SEARCH_SHORTCUT);
      return sender.executeJavaScript(`new Promise((resolve, reject) => {
        const finish = () => {
          if (window.__notificationProbe.barrier < ${count}) return;
          clearTimeout(timer); window.removeEventListener('__notificationProbeBarrier', finish);
          resolve(window.__notificationProbe.events);
        };
        const timer = setTimeout(() => {
          window.removeEventListener('__notificationProbeBarrier', finish);
          reject(new Error('Lifecycle IPC barrier timed out'));
        }, 5000);
        window.addEventListener('__notificationProbeBarrier', finish); finish();
      })`);
    };
    const show = async (sender: WebContents, title: string): Promise<Notification> => {
      const { promise, resolve, reject } = Promise.withResolvers<Notification>();
      pending.set(title, resolve);
      const timer = setTimeout(() => reject(new Error(`No native show for ${title}`)), 5000);
      try {
        await sender.executeJavaScript(`(() => {
          const title = ${JSON.stringify(title)};
          const n = new Notification(title, { tag: 'same-room' });
          window.__notificationProbe.objects[title] = n;
          for (const type of ['click', 'close']) n.addEventListener(type, () => {
            window.__notificationProbe.events.push(title + ':' + type);
          });
        })()`);
        return await promise;
      } finally {
        clearTimeout(timer);
        pending.delete(title);
      }
    };
    const pageClose = async (sender: WebContents, title: string) => {
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          ipcMain.removeListener(input.channels.NOTIFICATION_CLOSE, receive);
        };
        const receive = (event: Electron.IpcMainEvent) => {
          if (event.sender !== sender) return;
          finish();
          resolve();
        };
        const timer = setTimeout(() => {
          finish();
          reject(new Error('Page close did not reach main'));
        }, 5000);
        ipcMain.on(input.channels.NOTIFICATION_CLOSE, receive);
        void sender
          .executeJavaScript(`window.__notificationProbe.objects[${JSON.stringify(title)}].close()`)
          .catch((error: unknown) => {
            finish();
            reject(error);
          });
      });
    };

    Notification.isSupported = () => true;
    Notification.prototype.show = function () {
      pending.get(this.title)?.(this);
    };
    Notification.prototype.close = function () {
      closes.push(this.title);
      if (this.title === 'throwing-close') throw new Error('Simulated native close failure');
    };
    manager.focusAccount = (index) => {
      focuses.push(index);
      originals.focus.call(manager, index);
    };
    try {
      manager.createAccountWindow(input.url, secondary);
      const first = senderFor(zero);
      const second = senderFor(secondary);
      await initialize(first);
      await initialize(second);
      focuses.length = 0;
      const backendKinds = manager.enumerateAccountWebContents().map(({ backend }) => backend);
      if (backendKinds.some((backend) => backend !== input.backend)) {
        throw new Error('Wrong backend launched');
      }
      const old = await show(first, 'old');
      const stale = [...old.listeners('click'), ...old.listeners('close')];
      const other = await show(second, 'other-account');
      const replacement = await show(first, 'replacement');
      for (const callback of stale) callback();
      other.emit('click');
      other.emit('click');
      replacement.emit('click');
      replacement.emit('click');
      const firstEvents = await snapshot(first);
      const secondEvents = await snapshot(second);
      await pageClose(second, 'other-account');
      const afterClose = await snapshot(second);
      const throwing = await show(first, 'throwing-close');
      await pageClose(first, 'throwing-close');
      throwing.emit('click');
      throwing.emit('close');
      const beforeNavigation = await show(first, 'before-navigation');
      const staleNavigation = [
        ...beforeNavigation.listeners('click'),
        ...beforeNavigation.listeners('close'),
      ];
      const senderId = first.id;
      await first.loadURL(`${input.url}?new-document=1`);
      barriers.delete(first.id);
      await initialize(first);
      const focusCount = focuses.length;
      for (const callback of staleNavigation) callback();
      const afterNavigation = await snapshot(first);
      return {
        backendKinds,
        firstEvents,
        secondEvents,
        afterClose,
        afterNavigation,
        focuses,
        focusCount,
        closes,
        survivingSender: senderFor(zero).id === senderId,
        staleNavigationFocused: focuses.length !== focusCount,
      };
    } finally {
      Notification.prototype.show = originals.show;
      Notification.prototype.close = originals.close;
      Notification.isSupported = originals.supported;
      manager.focusAccount = originals.focus;
    }
  };
  return app.evaluate(scenario, { ...options, channels: IPC_CHANNELS });
}
