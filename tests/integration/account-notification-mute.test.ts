import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeElectronApp,
  electronHarnessFileUrl,
  expect,
  launchElectronAppWithWindow,
  test,
  wrapEvaluateWithGcRetry,
} from '../helpers/electron-test.js';
import type { LaunchedElectronApp } from '../helpers/electron-test.js';
import {
  activeUserDataDir,
  launchEnv,
  quitApp,
  relaunchProfile,
  seedStoredApp,
} from '../helpers/profileRestart.js';
import { IPC_CHANNELS } from '../../src/shared/constants.js';
import type { IAccountWindowManager } from '../../src/shared/types/window.js';

const root = join(import.meta.dirname, '../..');
const url = electronHarnessFileUrl();

async function waitForMenu(app: LaunchedElectronApp): Promise<void> {
  wrapEvaluateWithGcRetry(app);
  await expect
    .poll(() =>
      app.evaluate(
        ({ Menu }) =>
          Boolean(
            Menu.getApplicationMenu()
              ?.items.find((item) => item.label === 'Preferences')
              ?.submenu?.items.find((item) => item.label === 'Mute Chat Notifications for One Hour')
          ),
        { timeout: 30000 }
      )
    )
    .toBe(true);
}

async function exercise(app: LaunchedElectronApp, action: 'mute' | 'resume' | 'none') {
  return app.evaluate(
    async ({ Menu, Notification, ipcMain }, input) => {
      const manager = (
        Reflect.get(globalThis, '__gogchatGetAccountWindowManager') as () => IAccountWindowManager
      )();
      const index = 2 as import('../../src/shared/types/branded.js').AccountIndex;
      if (!manager.hasAccount(index)) manager.createAccountWindow(input.url, index);
      const first = manager.getAccountWebContents(
        0 as import('../../src/shared/types/branded.js').AccountIndex
      );
      const second = manager.getAccountWebContents(index);
      if (!first || !second) throw new Error('Missing account renderers');
      for (const sender of [first, second]) {
        if (sender.isLoadingMainFrame()) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Account load timeout')), 10000);
            sender.once('did-stop-loading', () => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
      }
      if (ipcMain.listenerCount(input.channel) === 0) {
        await new Promise<void>((resolve, reject) => {
          const listener = (channel: string) => {
            if (channel !== input.channel) return;
            clearTimeout(timer);
            ipcMain.removeListener('newListener', listener);
            resolve();
          };
          const timer = setTimeout(() => {
            ipcMain.removeListener('newListener', listener);
            reject(new Error('Notification handler timeout'));
          }, 15000);
          ipcMain.on('newListener', listener);
        });
      }
      if (input.action !== 'none') {
        const target = manager.getAccountWindow(index);
        if (!target) throw new Error('Missing account window');
        await new Promise<void>((resolve, reject) => {
          const focused = () => {
            clearTimeout(timer);
            target.removeListener('focus', focused);
            resolve();
          };
          const timer = setTimeout(() => {
            target.removeListener('focus', focused);
            reject(new Error('Account focus timeout'));
          }, 10000);
          target.once('focus', focused);
          manager.focusAccount(index);
          if (target.isFocused()) focused();
        });
        const label =
          input.action === 'mute'
            ? 'Mute Chat Notifications for One Hour'
            : 'Resume Chat Notifications';
        const preferences = Menu.getApplicationMenu()?.items.find(
          (entry) => entry.label === 'Preferences'
        )?.submenu;
        preferences?.emit('menu-will-show');
        const item = preferences?.items.find((entry) => entry.label === label);
        if (!item?.enabled) throw new Error(`Menu action unavailable: ${label}`);
        item.click();
      }
      const originalShow = Notification.prototype.show;
      const originalClose = Notification.prototype.close;
      const originalSupported = Notification.isSupported;
      Notification.isSupported = () => true;
      Notification.prototype.close = () => {};
      try {
        const probe = async (sender: Electron.WebContents, title: string) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const shown = new Promise<string>((resolve) => {
            Notification.prototype.show = function () {
              if (this.title === title) resolve('shown');
            };
          });
          const closed = sender.executeJavaScript(`new Promise(resolve => {
          const n = new Notification(${JSON.stringify(title)});
          n.addEventListener('close', () => resolve('closed'), { once: true });
        })`);
          try {
            return await Promise.race([
              shown,
              closed,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Notification outcome timeout')), 10000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        };
        return {
          backends: manager.enumerateAccountWebContents().map((entry) => entry.backend),
          mutedAccount: await probe(second, `secondary-${input.action}`),
          otherAccount: await probe(first, `primary-${input.action}`),
        };
      } finally {
        Notification.prototype.show = originalShow;
        Notification.prototype.close = originalClose;
        Notification.isSupported = originalSupported;
      }
    },
    { action, url, channel: IPC_CHANNELS.NOTIFICATION_SHOW }
  );
}

for (const backend of ['browser-window', 'web-contents-view'] as const) {
  test(`menu mute survives restart and resume restores admission (${backend})`, async () => {
    test.setTimeout(180000);
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'gogchat-mute-integration-')));
    let app: LaunchedElectronApp | undefined;
    try {
      seedStoredApp(directory, {
        useWebContentsView: backend === 'web-contents-view',
        autoCheckForUpdates: false,
        autoLaunchAtLogin: false,
        notificationPermissionRequested: true,
      });
      app = (
        await launchElectronAppWithWindow({
          appPath: root,
          cwd: root,
          userDataDir: directory,
          env: launchEnv(),
        })
      ).app;
      await waitForMenu(app);
      const before = await exercise(app, 'mute');
      expect(before.backends).toEqual([backend, backend]);
      expect([before.mutedAccount, before.otherAccount]).toEqual(['closed', 'shown']);
      const profileDir = await activeUserDataDir(app);
      await quitApp(app);
      app = await relaunchProfile({ appPath: root, cwd: root, profileDir });
      await waitForMenu(app);
      const restored = await exercise(app, 'none');
      expect([restored.mutedAccount, restored.otherAccount]).toEqual(['closed', 'shown']);
      const resumed = await exercise(app, 'resume');
      expect([resumed.mutedAccount, resumed.otherAccount]).toEqual(['shown', 'shown']);
    } finally {
      if (app) await closeElectronApp(app);
      await Promise.all(
        [directory, `${directory}-a1`, `${directory}-a2`].map((path) =>
          rm(path, { recursive: true, force: true })
        )
      );
    }
  });
}
