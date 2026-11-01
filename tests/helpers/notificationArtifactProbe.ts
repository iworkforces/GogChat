import type { ElectronApplication, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { IPC_CHANNELS } from '../../src/shared/constants.js';
import { validateNotificationCloseRequest } from '../../src/shared/dataValidators.js';
import type { NotificationInstanceRef } from '../../src/shared/types/domain.js';

export async function exerciseBuiltNotificationWrapper(app: ElectronApplication, page: Page) {
  const construct = async () => {
    await page.waitForFunction(
      () => Reflect.get(window, '__gogchatNotificationBridgeInstalled') === true
    );
    const create = () => {
      const events: string[] = [];
      const objects = ['old', 'new'].map((title) => {
        const notification = new Notification(title, { tag: 'artifact-room' });
        notification.onclick = () => events.push(`${title}:click`);
        notification.onclose = () => events.push(`${title}:close`);
        return notification;
      });
      Reflect.set(window, '__notificationProbe', { events, objects, barrier: 0 });
      window.gogchat.onSearchShortcut(() => {
        const probe = Reflect.get(window, '__notificationProbe');
        probe.barrier += 1;
      });
    };
    const refs = await app.evaluate(
      ({ ipcMain, BrowserWindow }, source) =>
        new Promise<unknown[]>((resolve, reject) => {
          const sender = BrowserWindow.getAllWindows()[0]?.webContents;
          const records: unknown[] = [];
          const finish = () => {
            clearTimeout(timer);
            ipcMain.removeListener('notificationShow', receive);
          };
          const receive = (event: Electron.IpcMainEvent, data: unknown) => {
            if (event.sender !== sender) return;
            records.push(data);
            if (records.length === 2) {
              finish();
              resolve(records);
            }
          };
          const timer = setTimeout(() => {
            finish();
            reject(new Error('Built notification show IPC was not received'));
          }, 5000);
          ipcMain.on('notificationShow', receive);
          void sender?.executeJavaScript(source).catch((error: unknown) => {
            finish();
            reject(error);
          });
        }),
      `(${create.toString()})()`
    );
    return refs.map(validateNotificationCloseRequest);
  };
  const deliver = async (
    events: readonly (NotificationInstanceRef & { type: 'click' | 'close' })[]
  ) => {
    const previous = await page.evaluate(() => Reflect.get(window, '__notificationProbe').barrier);
    await app.evaluate(
      ({ BrowserWindow }, payload) => {
        const sender = BrowserWindow.getAllWindows()[0]?.webContents;
        for (const event of payload.events) sender?.send(payload.channel, event);
        sender?.send(payload.barrier);
      },
      { events, channel: IPC_CHANNELS.NOTIFICATION_EVENT, barrier: IPC_CHANNELS.SEARCH_SHORTCUT }
    );
    await page.waitForFunction(
      (count) => Reflect.get(window, '__notificationProbe').barrier === count + 1,
      previous
    );
  };

  const [old, replacement] = await construct();
  if (!old || !replacement) throw new Error('Built wrapper did not send both show requests');
  expect(old.documentId).toBe(replacement.documentId);
  expect(old.instanceId).not.toBe(replacement.instanceId);
  await deliver([
    { ...old, type: 'close' },
    { ...old, type: 'click' },
    { ...old, type: 'close' },
    { ...replacement, documentId: 'foreign-document', type: 'close' },
    { ...replacement, type: 'click' },
    { ...replacement, type: 'click' },
  ]);
  await app.evaluate(
    ({ ipcMain, BrowserWindow }) =>
      new Promise<void>((resolve, reject) => {
        const sender = BrowserWindow.getAllWindows()[0]?.webContents;
        const receive = (event: Electron.IpcMainEvent) => {
          if (event.sender !== sender) return;
          clearTimeout(timer);
          ipcMain.removeListener('notificationClose', receive);
          resolve();
        };
        const timer = setTimeout(() => {
          ipcMain.removeListener('notificationClose', receive);
          reject(new Error('Built notification close IPC was not received'));
        }, 5000);
        ipcMain.on('notificationClose', receive);
        void sender
          ?.executeJavaScript(
            `(() => {
      const probe = window.__notificationProbe;
      probe.objects[1].close();
      probe.objects[1].close();
    })()`
          )
          .catch((error: unknown) => {
            clearTimeout(timer);
            ipcMain.removeListener('notificationClose', receive);
            reject(error);
          });
      })
  );
  const events = await page.evaluate(() => Reflect.get(window, '__notificationProbe').events);
  expect(events).toEqual(['old:close', 'new:click', 'new:close']);
  const closeRecords = await app.evaluate(({ app: runtime }) => {
    const records: { channel: string; data: unknown }[] = Reflect.get(runtime, '__gogchatIpc');
    return records.filter(({ channel }) => channel === 'notificationClose');
  });
  expect(closeRecords.map(({ data }) => validateNotificationCloseRequest(data))).toEqual([
    replacement,
  ]);

  await page.reload({ waitUntil: 'load' });
  const [fresh] = await construct();
  if (!fresh) throw new Error('New document did not install its built notification wrapper');
  expect(fresh.documentId).not.toBe(old.documentId);
  expect(fresh.instanceId).toBe(old.instanceId);
  await deliver([
    { ...old, type: 'click' },
    { ...old, type: 'close' },
  ]);
  expect(await page.evaluate(() => Reflect.get(window, '__notificationProbe').events)).toEqual([]);
  return { events, old, replacement, fresh, staleDocumentSuppressed: true };
}
