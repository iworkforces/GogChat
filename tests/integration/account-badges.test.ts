import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Conf from 'conf';
import type { IpcMainEvent, NativeImage, Tray, WebContents } from 'electron';
import { schema } from '../../src/main/utils/config/configSchema.js';
import { APP_IDENTITY } from '../../src/shared/appIdentity.js';
import { IPC_CHANNELS } from '../../src/shared/constants.js';
import { asType } from '../../src/shared/typeUtils.js';
import { asAccountIndex } from '../../src/shared/types/branded.js';
import type { AccountIndex } from '../../src/shared/types/branded.js';
import type { StoreType } from '../../src/shared/types/config.js';
import type { AccountBackendKind, IAccountWindowManager } from '../../src/shared/types/window.js';
import {
  closeElectronApp,
  evaluateWithRequire,
  expect,
  launchElectronAppWithWindow,
  test,
  wrapEvaluateWithGcRetry,
} from '../helpers/electron-test.js';
import type { LaunchedElectronApp } from '../helpers/electron-test.js';

const projectRoot = join(import.meta.dirname, '../..');
const harnessUrl = pathToFileURL(join(projectRoot, 'tests/fixtures/electron-harness.html')).href;
const normalFavicon = 'https://ssl.gstatic.com/chat/favicon_normal.png';
const badgeFavicon = 'https://ssl.gstatic.com/chat/favicon_badge.png';

interface Presentation {
  readonly count: number;
  readonly image: string;
  readonly normalImage: string;
  readonly unreadImage: string;
  readonly indices: readonly AccountIndex[];
  readonly senderIds: Readonly<Record<string, number>>;
  readonly dehydrated: readonly AccountIndex[];
}

type Operation =
  | {
      readonly kind: 'create' | 'dehydrate' | 'hydrate' | 'remove' | 'native-close';
      readonly index: AccountIndex;
    }
  | {
      readonly kind: 'unread' | 'retired-unread';
      readonly index: AccountIndex;
      readonly value: number;
    }
  | { readonly kind: 'favicon'; readonly index: AccountIndex; readonly value: string }
  | { readonly kind: 'unmapped' | 'destroy-all' };

interface BadgeProbe {
  readonly manager: IAccountWindowManager;
  readonly snapshot: () => Presentation;
  readonly dispatch: (operation: Operation) => Promise<Presentation>;
  readonly advanceRateWindow: () => void;
  readonly dispose: () => void;
  tray?: Tray;
  image: string;
}

async function evaluateMain<Result>(
  app: LaunchedElectronApp,
  work: Parameters<typeof evaluateWithRequire<Result>>[1]
): Promise<Result> {
  return evaluateWithRequire<Result>(
    { evaluate: async (fn, arg) => asType<Result>(await app.evaluate(fn, arg)) },
    work
  );
}

async function seedUserData(directory: string, backend: AccountBackendKind): Promise<void> {
  for (const attempt of [1, 2]) {
    const cwd = `${directory}-a${attempt}`;
    const encryptionKey = createHash('sha256')
      .update(`${APP_IDENTITY.productName}-${cwd}`)
      .digest('hex');
    const config = new Conf<StoreType>({ cwd, schema, encryptionKey });
    config.set('app.useWebContentsView', backend === 'web-contents-view');
    config.set('app.autoCheckForUpdates', false);
    config.set('app.autoLaunchAtLogin', false);
    config.set('app.unreadDeltaNotifications', false);
    config.set('app.notificationPermissionRequested', true);
  }
}

async function installProbe(app: LaunchedElectronApp, backend: AccountBackendKind): Promise<void> {
  await app.evaluate((_electron, channels: typeof IPC_CHANNELS) => {
    Reflect.set(globalThis, '__accountBadgeChannels', channels);
  }, IPC_CHANNELS);
  await expect
    .poll(
      () =>
        evaluateMain(app, (api) => {
          const electron: typeof import('electron') = api.require('electron');
          const channels: typeof IPC_CHANNELS = Reflect.get(globalThis, '__accountBadgeChannels');
          return (
            typeof Reflect.get(globalThis, '__gogchatGetAccountWindowManager') === 'function' &&
            electron.ipcMain.listenerCount(channels.UNREAD_COUNT) > 0 &&
            electron.ipcMain.listenerCount(channels.FAVICON_CHANGED) > 0
          );
        }),
      { timeout: 15000 }
    )
    .toBe(true);
  const actualBackend = await evaluateMain(app, (api) => {
    const electron: typeof import('electron') = api.require('electron');
    const path: typeof import('node:path') = api.require('node:path');
    const url: typeof import('node:url') = api.require('node:url');
    const { once }: typeof import('node:events') = api.require('node:events');
    const getManager: () => IAccountWindowManager = Reflect.get(
      globalThis,
      '__gogchatGetAccountWindowManager'
    );
    const manager = getManager();
    const channels: typeof IPC_CHANNELS = Reflect.get(globalThis, '__accountBadgeChannels');
    const localUrl = url.pathToFileURL(
      path.join(process.cwd(), 'tests/fixtures/electron-harness.html')
    ).href;
    const retired = new Map<AccountIndex, WebContents>();
    const auxiliaryWindows: Electron.BrowserWindow[] = [];
    const originalSetImage = electron.Tray.prototype.setImage;
    const originalDateNow = Date.now;
    let now = originalDateNow();
    const normalImage = electron.nativeImage
      .createFromPath(path.join(process.cwd(), 'resources/icons/tray/iconTemplate.png'))
      .toPNG()
      .toString('base64');
    const unreadImage = electron.nativeImage
      .createFromPath(path.join(process.cwd(), 'resources/icons/tray/iconUnreadTemplate.png'))
      .toPNG()
      .toString('base64');
    if (!normalImage || !unreadImage || normalImage === unreadImage) {
      throw new Error('Native tray fixtures must contain distinct existing images');
    }

    const currentSender = (index: AccountIndex): WebContents => {
      const sender = manager.getAccountWebContents(index);
      if (!sender || sender.isDestroyed()) throw new Error(`Account ${index} has no live renderer`);
      return sender;
    };
    const waitForBridge = async (sender: WebContents): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const ready = await Promise.race([
          sender.executeJavaScript('typeof window.gogchat?.sendUnreadCount === "function"'),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Local renderer did not load its built bridge')),
              10000
            );
          }),
        ]);
        if (ready !== true) throw new Error('Local renderer is missing the built preload bridge');
      } finally {
        clearTimeout(timer);
      }
    };
    const send = async (
      sender: WebContents,
      channel: string,
      value: number | string
    ): Promise<void> => {
      const { promise: received, resolve, reject } = Promise.withResolvers<void>();
      const acknowledge = (event: IpcMainEvent, payload: unknown): void => {
        if (event.sender === sender && payload === value) resolve();
      };
      electron.ipcMain.on(channel, acknowledge);
      const timer = setTimeout(
        () => reject(new Error(`Renderer IPC ${channel} was not received`)),
        5000
      );
      try {
        const method = channel === channels.UNREAD_COUNT ? 'sendUnreadCount' : 'sendFaviconChanged';
        await Promise.all([
          sender.executeJavaScript(`window.gogchat.${method}(${JSON.stringify(value)})`),
          received,
        ]);
      } finally {
        clearTimeout(timer);
        electron.ipcMain.removeListener(channel, acknowledge);
      }
    };
    const snapshot = (): Presentation => ({
      count: electron.app.getBadgeCount(),
      image: probe.image,
      normalImage,
      unreadImage,
      indices: manager.listAccountIndices(),
      senderIds: Object.fromEntries(
        manager
          .enumerateAccountWebContents()
          .map(({ accountIndex, webContentsId }) => [String(accountIndex), Number(webContentsId)])
      ),
      dehydrated: manager.listAccountIndices().filter((index) => manager.isDehydrated(index)),
    });
    const probe: BadgeProbe = {
      manager,
      image: '',
      snapshot,
      advanceRateWindow: () => {
        now += 1000;
      },
      dispatch: async (operation) => {
        switch (operation.kind) {
          case 'create':
            manager.createAccountWindow(localUrl, operation.index);
            await waitForBridge(currentSender(operation.index));
            break;
          case 'unread':
            await send(currentSender(operation.index), channels.UNREAD_COUNT, operation.value);
            break;
          case 'favicon':
            await send(currentSender(operation.index), channels.FAVICON_CHANGED, operation.value);
            break;
          case 'dehydrate':
            retired.set(operation.index, currentSender(operation.index));
            manager.dehydrateAccount(operation.index);
            break;
          case 'hydrate':
            manager.hydrateAccount(operation.index);
            await waitForBridge(currentSender(operation.index));
            break;
          case 'remove': {
            const sender = manager.getAccountWebContents(operation.index);
            if (sender) retired.set(operation.index, sender);
            const backend = manager
              .enumerateAccountWebContents()
              .find(({ accountIndex }) => accountIndex === operation.index)?.backend;
            const destroyed =
              sender && backend === 'web-contents-view'
                ? once(sender, 'destroyed', { signal: AbortSignal.timeout(5000) })
                : undefined;
            manager.unregisterAccount(operation.index);
            await destroyed;
            break;
          }
          case 'retired-unread': {
            const sender = retired.get(operation.index);
            if (!sender) throw new Error('No retired sender was retained by the fixture');
            if (sender.isDestroyed()) {
              electron.ipcMain.emit(channels.UNREAD_COUNT, { sender }, operation.value);
            } else {
              await send(sender, channels.UNREAD_COUNT, operation.value);
            }
            break;
          }
          case 'native-close': {
            const window = manager.getAccountWindow(operation.index);
            if (!window) throw new Error('Native close requires a live account window');
            window.destroy();
            break;
          }
          case 'unmapped': {
            const window = new electron.BrowserWindow({
              show: false,
              webPreferences: {
                contextIsolation: true,
                sandbox: true,
                nodeIntegration: false,
                preload: path.join(process.cwd(), 'lib/preload/index.js'),
              },
            });
            auxiliaryWindows.push(window);
            await window.loadURL(localUrl);
            await waitForBridge(window.webContents);
            await send(window.webContents, channels.UNREAD_COUNT, 95);
            await send(
              window.webContents,
              channels.FAVICON_CHANGED,
              'https://ssl.gstatic.com/chat/favicon_badge.png'
            );
            break;
          }
          case 'destroy-all':
            manager.destroyAll();
            break;
        }
        return snapshot();
      },
      dispose: () => {
        try {
          manager.destroyAll();
        } finally {
          try {
            for (const window of auxiliaryWindows) {
              if (!window.isDestroyed()) window.destroy();
            }
            for (const window of electron.BrowserWindow.getAllWindows()) {
              if (!window.isDestroyed()) window.destroy();
            }
          } finally {
            Date.now = originalDateNow;
            electron.Tray.prototype.setImage = originalSetImage;
            if (probe.tray && !probe.tray.isDestroyed()) probe.tray.destroy();
            Reflect.deleteProperty(globalThis, '__accountBadgeProbe');
            Reflect.deleteProperty(globalThis, '__accountBadgeChannels');
          }
        }
      },
    };
    electron.Tray.prototype.setImage = function (image: NativeImage | string): void {
      probe.tray = this;
      probe.image = (typeof image === 'string' ? electron.nativeImage.createFromPath(image) : image)
        .toPNG()
        .toString('base64');
      originalSetImage.call(this, image);
    };
    Reflect.set(globalThis, '__accountBadgeProbe', probe);
    Date.now = () => now;
    return manager.enumerateAccountWebContents().map(({ backend }) => backend);
  });
  expect(actualBackend).toEqual([backend]);
  const initial = await operate(app, { kind: 'unread', index: asAccountIndex(0), value: 1 });
  expect(initial.count).toBe(1);
  expect(initial.image).toBe(initial.unreadImage);
  await app.evaluate(() => {
    const probe: BadgeProbe = Reflect.get(globalThis, '__accountBadgeProbe');
    probe.advanceRateWindow();
  });
}

async function operate(app: LaunchedElectronApp, operation: Operation): Promise<Presentation> {
  const presentation = asType<Presentation>(
    await app.evaluate((_electron, input: Operation) => {
      const probe: BadgeProbe = Reflect.get(globalThis, '__accountBadgeProbe');
      return probe.dispatch(input);
    }, operation)
  );
  const { image, normalImage, unreadImage, ...values } = presentation;
  console.info(
    'NATIVE_BADGE_QA',
    JSON.stringify({
      operation,
      ...values,
      trayUnread: image === unreadImage,
      trayNormal: image === normalImage,
    })
  );
  return presentation;
}

async function withBackend(
  backend: AccountBackendKind,
  run: (app: LaunchedElectronApp) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'gogchat-account-badges-'));
  let app: LaunchedElectronApp | undefined;
  try {
    await seedUserData(directory, backend);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TESTING: 'true',
      NODE_ENV: 'test',
      CI: 'true',
      GOGCHAT_DISABLE_PRECONNECT: '1',
      GOGCHAT_TEST_APP_URL: harnessUrl,
    };
    delete env['GOGCHAT_TEST_HANG_SHUTDOWN'];
    ({ app } = await launchElectronAppWithWindow({
      appPath: projectRoot,
      cwd: projectRoot,
      userDataDir: directory,
      env,
    }));
    wrapEvaluateWithGcRetry(app);
    await installProbe(app, backend);
    await run(app);
  } finally {
    try {
      if (app) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            app.evaluate(() => {
              const probe: BadgeProbe | undefined = Reflect.get(globalThis, '__accountBadgeProbe');
              probe?.dispose();
            }),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error('Native badge fixture teardown timed out')),
                3000
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
          await closeElectronApp(app);
        }
      }
    } finally {
      await Promise.all(
        [directory, `${directory}-a1`, `${directory}-a2`].map((path) =>
          rm(path, { recursive: true, force: true })
        )
      );
    }
  }
}

for (const backend of ['browser-window', 'web-contents-view'] satisfies AccountBackendKind[]) {
  test.describe(`Native account badges: ${backend}`, () => {
    test.skip(
      process.platform !== 'darwin',
      'Native Dock and template tray evidence is macOS-only'
    );

    test('keeps aggregate native badges when live renderers interleave counts and favicons', async () => {
      await withBackend(backend, async (app) => {
        const first = asAccountIndex(0);
        const second = asAccountIndex(2);
        await operate(app, { kind: 'create', index: second });
        expect((await operate(app, { kind: 'unread', index: first, value: 60 })).count).toBe(60);
        const capped = await operate(app, { kind: 'unread', index: second, value: 60 });
        expect(capped.count).toBe(99);
        expect(capped.image).toBe(capped.unreadImage);
        await operate(app, { kind: 'favicon', index: first, value: badgeFavicon });
        const interleaved = await operate(app, {
          kind: 'favicon',
          index: second,
          value: normalFavicon,
        });
        expect(interleaved.count).toBe(99);
        expect(interleaved.image).toBe(interleaved.unreadImage);
        await operate(app, { kind: 'unread', index: first, value: 60 });
        expect((await operate(app, { kind: 'unread', index: second, value: 0 })).count).toBe(60);
        const cleared = await operate(app, { kind: 'unread', index: first, value: 0 });
        expect(cleared.count).toBe(0);
        expect(cleared.image).toBe(cleared.normalImage);
      });
    });

    test('retains sparse parked counts but clears permanent removal, recreation and full teardown', async () => {
      await withBackend(backend, async (app) => {
        const first = asAccountIndex(0);
        const second = asAccountIndex(2);
        const sparse = asAccountIndex(7);
        await operate(app, { kind: 'create', index: second });
        await operate(app, { kind: 'create', index: sparse });
        await operate(app, { kind: 'unread', index: first, value: 5 });
        await operate(app, { kind: 'unread', index: second, value: 7 });
        const populated = await operate(app, { kind: 'unread', index: sparse, value: 11 });
        expect(populated.count).toBe(23);
        await operate(app, { kind: 'dehydrate', index: second });
        const parked = await operate(app, { kind: 'dehydrate', index: sparse });
        expect(parked.dehydrated).toEqual([second, sparse]);
        expect(parked.count).toBe(23);
        expect((await operate(app, { kind: 'unread', index: first, value: 0 })).count).toBe(18);
        expect((await operate(app, { kind: 'remove', index: sparse })).count).toBe(7);
        const hydrated = await operate(app, { kind: 'hydrate', index: second });
        if (backend === 'browser-window') {
          expect(hydrated.senderIds['2']).not.toBe(populated.senderIds['2']);
        } else {
          expect(hydrated.senderIds['2']).toBe(populated.senderIds['2']);
        }
        expect((await operate(app, { kind: 'unread', index: second, value: 9 })).count).toBe(9);
        expect((await operate(app, { kind: 'remove', index: second })).count).toBe(0);
        expect(
          (await operate(app, { kind: 'retired-unread', index: second, value: 95 })).count
        ).toBe(0);
        const recreated = await operate(app, { kind: 'create', index: second });
        expect(recreated.count).toBe(0);
        expect(recreated.senderIds['2']).not.toBe(hydrated.senderIds['2']);
        expect((await operate(app, { kind: 'unread', index: second, value: 4 })).count).toBe(4);
        await operate(app, { kind: 'dehydrate', index: second });
        const destroyed = await operate(app, { kind: 'destroy-all' });
        expect(destroyed.indices).toEqual([]);
        expect(destroyed.count).toBe(0);
        expect(destroyed.image).toBe(destroyed.normalImage);
      });
    });

    test('rejects an unmapped live renderer and clears native account close', async () => {
      await withBackend(backend, async (app) => {
        const second = asAccountIndex(2);
        await operate(app, { kind: 'create', index: second });
        const baseline = await operate(app, { kind: 'unread', index: second, value: 6 });
        expect(baseline.count).toBe(7);
        const unmapped = await operate(app, { kind: 'unmapped' });
        expect(unmapped.count).toBe(7);
        expect(unmapped.image).toBe(baseline.unreadImage);
        const closed = await operate(app, { kind: 'native-close', index: second });
        expect(closed.count).toBe(backend === 'browser-window' ? 1 : 0);
        expect(closed.indices).toEqual(backend === 'browser-window' ? [asAccountIndex(0)] : []);
        expect(closed.image).toBe(
          backend === 'browser-window' ? closed.unreadImage : closed.normalImage
        );
      });
    });
  });
}
