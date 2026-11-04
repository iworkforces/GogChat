import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  closeElectronApp,
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

const root = path.resolve(import.meta.dirname, '../..');
const harness = pathToFileURL(path.join(root, 'tests/fixtures/electron-harness.html')).href;
const cookieUrl = 'https://retained-accounts.example/';
const backends = ['browser-window', 'web-contents-view'] as const;

type Manager = {
  createAccountWindow: (url: string, index: number) => Electron.BrowserWindow;
  getAccountWebContents: (index: number) => Electron.WebContents | null;
  listAccountIndices: () => number[];
  hasAccount: (index: number) => boolean;
  clearBootstrap: (index: number) => void;
  markAsBootstrap: (index: number) => void;
  promoteBootstrap: (index: number) => boolean;
  focusAccount: (index: number) => void;
  dehydrateAccount: (index: number) => void;
  isDehydrated: (index: number) => boolean;
  enumerateAccountWebContents: () => Array<{ backend: string }>;
  forgetAccount: (index: number) => Promise<void>;
};

async function withProfile(
  backend: (typeof backends)[number],
  run: (app: LaunchedElectronApp, profile: string) => Promise<LaunchedElectronApp>
): Promise<void> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'gogchat-retained-')));
  let app: LaunchedElectronApp | undefined;
  try {
    seedStoredApp(directory, {
      useWebContentsView: backend === 'web-contents-view',
      autoCheckForUpdates: false,
      autoLaunchAtLogin: false,
      unreadDeltaNotifications: false,
      notificationPermissionRequested: true,
    });
    app = (
      await launchElectronAppWithWindow({
        appPath: root,
        cwd: root,
        userDataDir: directory,
        env: { ...launchEnv(), CI: 'true' },
      })
    ).app;
    wrapEvaluateWithGcRetry(app);
    const profile = await activeUserDataDir(app);
    app = await run(app, profile);
  } finally {
    if (app) await closeElectronApp(app);
    await rm(directory, { recursive: true, force: true });
    await rm(`${directory}-a1`, { recursive: true, force: true });
    await rm(`${directory}-a2`, { recursive: true, force: true });
  }
}

async function relaunch(
  app: LaunchedElectronApp,
  profileDir: string
): Promise<LaunchedElectronApp> {
  await quitApp(app);
  return relaunchProfile({ appPath: root, cwd: root, profileDir });
}

function snapshot(
  app: LaunchedElectronApp,
  operation: 'create' | 'read',
  indices: number[]
): Promise<unknown> {
  return app.evaluate(
    async (
      _electron,
      input: { operation: 'create' | 'read'; indices: number[]; url: string; cookieUrl: string }
    ) => {
      const getManager = Reflect.get(
        globalThis,
        '__gogchatGetAccountWindowManager'
      ) as () => Manager;
      const manager = getManager();
      const values: Array<{ index: number; local: string | null; cookie: string | null }> = [];
      for (const index of input.indices) {
        if (input.operation === 'create' && !manager.hasAccount(index)) {
          manager.createAccountWindow(input.url, index);
        }
        const wc = manager.getAccountWebContents(index);
        if (!wc) throw new Error(`missing account renderer ${index}`);
        if (wc.isLoadingMainFrame()) {
          await new Promise<void>((resolve, reject) => {
            const finish = () => {
              clearTimeout(timer);
              wc.removeListener('did-stop-loading', finish);
              resolve();
            };
            const timer = setTimeout(() => {
              wc.removeListener('did-stop-loading', finish);
              reject(new Error(`account ${index} load timed out`));
            }, 15_000);
            wc.once('did-stop-loading', finish);
            if (!wc.isLoadingMainFrame()) finish();
          });
        }
        if (input.operation === 'create') {
          await wc.executeJavaScript(
            `localStorage.setItem('retained-sentinel', ${JSON.stringify(`local-${index}`)})`
          );
          await wc.session.cookies.set({
            url: input.cookieUrl,
            name: 'retained-sentinel',
            value: `cookie-${index}`,
            expirationDate: 4102444800,
          });
          await wc.session.cookies.flushStore();
        }
        const local = await wc.executeJavaScript("localStorage.getItem('retained-sentinel')");
        const cookies = await wc.session.cookies.get({
          url: input.cookieUrl,
          name: 'retained-sentinel',
        });
        values.push({ index, local, cookie: cookies[0]?.value ?? null });
      }
      return {
        indices: manager.listAccountIndices(),
        backends: [...new Set(manager.enumerateAccountWebContents().map((entry) => entry.backend))],
        values,
      };
    },
    { operation, indices, url: harness, cookieUrl }
  );
}

const sentinel = (index: number) => ({ index, local: `local-${index}`, cookie: `cookie-${index}` });

for (const backend of backends) {
  test.describe(`retained accounts (${backend})`, () => {
    test('refreshes Forget after creation and bootstrap promotion before any restart', async () => {
      await withProfile(backend, async (app) => {
        await expect
          .poll(() =>
            app.evaluate(({ Menu }) =>
              Menu.getApplicationMenu()
                ?.items.find((item) => item.label === 'File')
                ?.submenu?.items.find((item) => item.label === 'Forget Account')
                ?.submenu?.items.map((item) => item.label)
            )
          )
          .toEqual([]);

        const result = await app.evaluate(({ Menu }, url: string) => {
          const manager = (
            Reflect.get(globalThis, '__gogchatGetAccountWindowManager') as () => Manager
          )();
          const readForgetMenu = () =>
            Menu.getApplicationMenu()
              ?.items.find((item) => item.label === 'File')
              ?.submenu?.items.find((item) => item.label === 'Forget Account')
              ?.submenu?.items.map((item) => ({ label: item.label, enabled: item.enabled }));

          manager.createAccountWindow(url, 2);
          manager.createAccountWindow(url, 7);
          const created = readForgetMenu();
          manager.markAsBootstrap(7);
          const bootstrap = readForgetMenu();
          const promoted = manager.promoteBootstrap(7);
          return { created, bootstrap, promoted, authenticated: readForgetMenu() };
        }, harness);

        expect(result).toEqual({
          created: [
            { label: 'Account 3', enabled: true },
            { label: 'Account 8', enabled: true },
          ],
          bootstrap: [
            { label: 'Account 3', enabled: true },
            { label: 'Account 8', enabled: false },
          ],
          promoted: true,
          authenticated: [
            { label: 'Account 3', enabled: true },
            { label: 'Account 8', enabled: true },
          ],
        });
        return app;
      });
    });

    test('restores sparse membership and isolated storage, then forgets live and dehydrated accounts durably', async () => {
      test.setTimeout(240_000);
      await withProfile(backend, async (initial, profile) => {
        let app = initial;
        try {
          expect(await snapshot(app, 'create', [0, 2, 7])).toEqual({
            indices: [0, 2, 7],
            backends: [backend],
            values: [sentinel(0), sentinel(2), sentinel(7)],
          });
          app = await relaunch(app, profile);
          expect(await snapshot(app, 'read', [0, 2, 7])).toEqual({
            indices: [0, 2, 7],
            backends: [backend],
            values: [sentinel(0), sentinel(2), sentinel(7)],
          });
          await app.evaluate(() => {
            const manager = (
              Reflect.get(globalThis, '__gogchatGetAccountWindowManager') as () => Manager
            )();
            manager.clearBootstrap(2);
            manager.focusAccount(7);
          });
          await expect
            .poll(() =>
              app.evaluate(({ Menu }) =>
                Menu.getApplicationMenu()
                  ?.items.find((item) => item.label === 'File')
                  ?.submenu?.items.find((item) => item.label === 'Forget Account')
                  ?.submenu?.items.map((item) => item.label)
              )
            )
            .toEqual(['Account 3', 'Account 8']);
          await app.evaluate(async ({ Menu, dialog }) => {
            const item = Menu.getApplicationMenu()
              ?.items.find((entry) => entry.label === 'File')
              ?.submenu?.items.find((entry) => entry.label === 'Forget Account')
              ?.submenu?.items.find((entry) => entry.label === 'Account 3');
            if (!item?.enabled) throw new Error('Forget Account 3 menu item unavailable');
            const original = dialog.showMessageBox;
            dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
            try {
              item.click();
              await new Promise<void>((resolve) => setImmediate(resolve));
            } finally {
              dialog.showMessageBox = original;
            }
          });
          expect(await snapshot(app, 'read', [0, 2, 7])).toEqual({
            indices: [0, 2, 7],
            backends: [backend],
            values: [sentinel(0), sentinel(2), sentinel(7)],
          });
          const menuResult = await app.evaluate(async ({ Menu, dialog }) => {
            const manager = (
              Reflect.get(globalThis, '__gogchatGetAccountWindowManager') as () => Manager
            )();
            const item = Menu.getApplicationMenu()
              ?.items.find((entry) => entry.label === 'File')
              ?.submenu?.items.find((entry) => entry.label === 'Forget Account')
              ?.submenu?.items.find((entry) => entry.label === 'Account 3');
            if (!item?.enabled) throw new Error('Forget Account 3 menu item unavailable');
            const originalDialog = dialog.showMessageBox;
            const originalForget = manager.forgetAccount;
            let resolveForget: (index: number) => void = () => {};
            let rejectForget: (error: unknown) => void = () => {};
            const completed = new Promise<number>((resolve, reject) => {
              resolveForget = resolve;
              rejectForget = reject;
            });
            manager.forgetAccount = async (index) => {
              try {
                await originalForget.call(manager, index);
                resolveForget(index);
              } catch (error) {
                rejectForget(error);
                throw error;
              }
            };
            dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              item.click();
              const forgotten = await Promise.race([
                completed,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(() => reject(new Error('Forget Account timed out')), 15_000);
                }),
              ]);
              await new Promise<void>((resolve) => setImmediate(resolve));
              return {
                forgotten,
                menu: Menu.getApplicationMenu()
                  ?.items.find((entry) => entry.label === 'File')
                  ?.submenu?.items.find((entry) => entry.label === 'Forget Account')
                  ?.submenu?.items.map((entry) => entry.label),
              };
            } finally {
              clearTimeout(timer);
              dialog.showMessageBox = originalDialog;
              manager.forgetAccount = originalForget;
            }
          });
          expect(menuResult).toEqual({ forgotten: 2, menu: ['Account 8'] });
          app = await relaunch(app, profile);
          expect(await snapshot(app, 'read', [0, 7])).toEqual({
            indices: [0, 7],
            backends: [backend],
            values: [sentinel(0), sentinel(7)],
          });
          const state = await app.evaluate(async () => {
            const manager = (
              Reflect.get(globalThis, '__gogchatGetAccountWindowManager') as () => Manager
            )();
            manager.clearBootstrap(2);
            manager.clearBootstrap(7);
            manager.dehydrateAccount(7);
            const dehydrated = manager.isDehydrated(7);
            await manager.forgetAccount(7);
            return {
              dehydrated,
              indices: manager.listAccountIndices(),
              has2: manager.hasAccount(2),
              has7: manager.hasAccount(7),
            };
          });
          expect(state).toEqual({ dehydrated: true, indices: [0], has2: false, has7: false });
          app = await relaunch(app, profile);
          expect(await snapshot(app, 'read', [0])).toEqual({
            indices: [0],
            backends: [backend],
            values: [sentinel(0)],
          });
          await app.evaluate((_electron, url: string) => {
            const manager = (
              Reflect.get(globalThis, '__gogchatGetAccountWindowManager') as () => Manager
            )();
            manager.createAccountWindow(url, 2);
            manager.createAccountWindow(url, 7);
          }, harness);
          expect(await snapshot(app, 'read', [0, 2, 7])).toEqual({
            indices: [0, 2, 7],
            backends: [backend],
            values: [
              sentinel(0),
              { index: 2, local: null, cookie: null },
              { index: 7, local: null, cookie: null },
            ],
          });
          return app;
        } catch (error) {
          await closeElectronApp(app);
          throw error;
        }
      });
    });

    for (const method of ['clearStorageData', 'clearCache'] as const) {
      test(`retains membership and retries when ${method} fails once`, async () => {
        test.setTimeout(180_000);
        await withProfile(backend, async (initial, profile) => {
          let app = initial;
          try {
            await snapshot(app, 'create', [0, 2, 7]);
            const result = await app.evaluate(
              async ({ session }, failedMethod: 'clearStorageData' | 'clearCache') => {
                const manager = (
                  Reflect.get(globalThis, '__gogchatGetAccountWindowManager') as () => Manager
                )();
                manager.clearBootstrap(2);
                const partition = session.fromPartition('persist:account-2');
                const original = partition[failedMethod].bind(partition);
                partition[failedMethod] = async () => {
                  throw new Error('injected clear failure');
                };
                let failure = '';
                try {
                  await manager.forgetAccount(2);
                } catch (error) {
                  failure = String(error);
                } finally {
                  partition[failedMethod] = original;
                }
                return failure;
              },
              method
            );
            expect(result).toContain('injected clear failure');
            app = await relaunch(app, profile);
            expect(await snapshot(app, 'read', [0, 7])).toEqual({
              indices: [0, 2, 7],
              backends: [backend],
              values: [sentinel(0), sentinel(7)],
            });
            await app.evaluate(async () => {
              const manager = (
                Reflect.get(globalThis, '__gogchatGetAccountWindowManager') as () => Manager
              )();
              manager.clearBootstrap(2);
              await manager.forgetAccount(2);
            });
            app = await relaunch(app, profile);
            expect(await snapshot(app, 'read', [0, 7])).toEqual({
              indices: [0, 7],
              backends: [backend],
              values: [sentinel(0), sentinel(7)],
            });
            return app;
          } catch (error) {
            await closeElectronApp(app);
            throw error;
          }
        });
      });
    }

    test('blocks same-account reopening while storage clearing is pending', async () => {
      test.setTimeout(180_000);
      await withProfile(backend, async (app) => {
        await snapshot(app, 'create', [0, 2, 7]);
        const result = await app.evaluate(async ({ session }, url: string) => {
          const manager = (
            Reflect.get(globalThis, '__gogchatGetAccountWindowManager') as () => Manager
          )();
          manager.clearBootstrap(2);
          const partition = session.fromPartition('persist:account-2');
          const original = partition.clearStorageData.bind(partition);
          let release = () => {};
          let entered = () => {};
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const started = new Promise<void>((resolve) => {
            entered = resolve;
          });
          partition.clearStorageData = async (options) => {
            entered();
            await gate;
            await original(options);
          };
          const forgetting = manager.forgetAccount(2);
          try {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                started,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(() => reject(new Error('clearing did not start')), 15_000);
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
            let blocked = false;
            try {
              manager.createAccountWindow(url, 2);
            } catch {
              blocked = true;
            }
            const during = manager.getAccountWebContents(2);
            release();
            await forgetting;
            return {
              blocked,
              rendererDuringClear: during !== null,
              indices: manager.listAccountIndices(),
            };
          } finally {
            release();
            partition.clearStorageData = original;
            await forgetting;
          }
        }, harness);
        expect(result).toEqual({ blocked: true, rendererDuringClear: false, indices: [0, 7] });
        expect(await snapshot(app, 'read', [0, 7])).toEqual({
          indices: [0, 7],
          backends: [backend],
          values: [sentinel(0), sentinel(7)],
        });
        return app;
      });
    });
  });
}
