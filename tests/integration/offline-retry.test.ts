import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Conf from 'conf';
import type { WebContents } from 'electron';
import { schema } from '../../src/main/utils/config/configSchema.js';
import { APP_IDENTITY } from '../../src/shared/appIdentity.js';
import { IPC_CHANNELS } from '../../src/shared/constants.js';
import { asType } from '../../src/shared/typeUtils.js';
import type { StoreType } from '../../src/shared/types/config.js';
import type { IAccountWindowManager } from '../../src/shared/types/window.js';
import {
  closeElectronApp,
  evaluateWithRequire,
  expect,
  launchElectronAppWithWindow,
  test,
  wrapEvaluateWithGcRetry,
} from '../helpers/electron-test.js';
import type { LaunchedElectronApp } from '../helpers/electron-test.js';

interface RetryProbe {
  contents: WebContents;
  calls: number;
  requests: number;
  methods: (string | undefined)[];
  navigations: string[];
  settle: (status: number) => void;
}

async function main<Result>(
  app: LaunchedElectronApp,
  work: Parameters<typeof evaluateWithRequire<Result>>[1]
) {
  return evaluateWithRequire<Result>(
    { evaluate: async (fn, arg) => asType<Result>(await app.evaluate(fn, arg)) },
    work
  );
}

for (const backend of ['browser-window', 'web-contents-view'] as const) {
  test(`built file retry reaches preload and main under ${backend}`, async () => {
    test.setTimeout(120_000);
    const root = join(import.meta.dirname, '../..');
    const profile = await realpath(await mkdtemp(join(tmpdir(), 'gogchat-offline-retry-')));
    let launched: Awaited<ReturnType<typeof launchElectronAppWithWindow>> | undefined;
    try {
      for (const attempt of [1, 2]) {
        const cwd = `${profile}-a${attempt}`;
        const encryptionKey = createHash('sha256')
          .update(`${APP_IDENTITY.productName}-${cwd}`)
          .digest('hex');
        const config = new Conf<StoreType>({ cwd, schema, encryptionKey });
        config.set('app.useWebContentsView', backend === 'web-contents-view');
        config.set('app.autoCheckForUpdates', false);
        config.set('app.autoLaunchAtLogin', false);
        config.set('app.notificationPermissionRequested', true);
      }
      launched = await launchElectronAppWithWindow({
        appPath: root,
        cwd: root,
        userDataDir: profile,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          TESTING: 'true',
          CI: 'true',
          GOGCHAT_DISABLE_PRECONNECT: '1',
        },
      });
      const app = wrapEvaluateWithGcRetry(launched.app);
      await app.evaluate((_electron, channels: typeof IPC_CHANNELS) => {
        Reflect.set(globalThis, '__offlineRetryChannels', channels);
      }, IPC_CHANNELS);
      await expect
        .poll(() => main(app, () => '__gogchatInitialConnectivity' in globalThis), {
          timeout: 15_000,
        })
        .toBe(true);
      await expect
        .poll(
          () =>
            main(app, () => {
              const getManager: () => IAccountWindowManager = Reflect.get(
                globalThis,
                '__gogchatGetAccountWindowManager'
              );
              const contents = getManager().enumerateAccountWebContents()[0]?.webContents;
              return (
                contents?.getURL().endsWith('/electron-harness.html') &&
                !contents.isLoadingMainFrame()
              );
            }),
          { timeout: 15_000 }
        )
        .toBe(true);
      const actualBackend = await main(app, async (api) => {
        const getManager: () => IAccountWindowManager = Reflect.get(
          globalThis,
          '__gogchatGetAccountWindowManager'
        );
        const manager = getManager();
        const entry = manager.enumerateAccountWebContents()[0];
        if (!entry) throw new Error('Account content missing');
        const contents = entry.webContents;
        const path: typeof import('node:path') = api.require('node:path');
        const url: typeof import('node:url') = api.require('node:url');
        const electron: typeof import('electron') = api.require('electron');
        const channels: typeof IPC_CHANNELS = Reflect.get(globalThis, '__offlineRetryChannels');
        await contents.session.protocol.handle(
          'https',
          () =>
            new Response('<!doctype html><title>Recovered</title>', {
              headers: { 'content-type': 'text/html' },
            })
        );
        globalThis.fetch = async () => new Response(null, { status: 503 });
        const connectivity: {
          checkForInternet: (manager: IAccountWindowManager) => Promise<void>;
        } = Reflect.get(globalThis, '__gogchatInitialConnectivity');
        await connectivity.checkForInternet(manager);
        const expected = url.pathToFileURL(path.join(process.cwd(), 'lib/offline/index.html')).href;
        if (contents.getURL() !== expected)
          throw new Error(`Not the built offline page: ${contents.getURL()}`);
        const probe: RetryProbe = {
          contents,
          calls: 0,
          requests: 0,
          methods: [],
          navigations: [],
          settle: () => {
            throw new Error('No pending fetch');
          },
        };
        electron.ipcMain.on(channels.CHECK_IF_ONLINE, (event) => {
          if (event.sender === contents) probe.requests++;
        });
        contents.on('did-start-navigation', (details) => {
          if (details.isMainFrame) probe.navigations.push(details.url);
        });
        globalThis.fetch = (_input, init) => {
          probe.calls++;
          probe.methods.push(init?.method);
          return new Promise<Response>((resolve) => {
            probe.settle = (status) => resolve(new Response(null, { status }));
          });
        };
        Reflect.set(globalThis, '__offlineRetryProbe', probe);
        await contents.executeJavaScript(
          `window.__retryMarker = crypto.randomUUID(); window.__retryFailures = 0; window.addEventListener('app:onlineCheckFailed', () => window.__retryFailures++);`
        );
        return entry.backend;
      });
      expect(actualBackend).toBe(backend);
      const before = await main(app, () => {
        const probe: RetryProbe = Reflect.get(globalThis, '__offlineRetryProbe');
        return probe.contents.executeJavaScript(
          `({marker:window.__retryMarker, history:history.length, bridge:typeof window.gogchat.checkIfOnline, logo:document.querySelector('.logo').complete && document.querySelector('.logo').naturalWidth > 0})`
        );
      });
      expect(before.bridge).toBe('function');
      expect(before.logo).toBe(true);
      const screenshot = await main(app, async () => {
        const probe: RetryProbe = Reflect.get(globalThis, '__offlineRetryProbe');
        return (await probe.contents.capturePage()).toPNG().toString('base64');
      });
      await writeFile(
        test.info().outputPath(`offline-${backend}.png`),
        Buffer.from(screenshot, 'base64')
      );
      await main(app, async () => {
        const probe: RetryProbe = Reflect.get(globalThis, '__offlineRetryProbe');
        await probe.contents.executeJavaScript(`document.getElementById('retry-btn').click()`);
      });
      await expect
        .poll(() => main(app, () => Reflect.get(globalThis, '__offlineRetryProbe').calls), {
          timeout: 5000,
        })
        .toBe(1);
      const pending = await main(app, () =>
        Reflect.get(globalThis, '__offlineRetryProbe').contents.executeJavaScript(
          `({disabled:document.getElementById('retry-btn').disabled,text:document.getElementById('retry-btn').innerText})`
        )
      );
      expect(pending).toEqual({ disabled: true, text: 'Checking...' });
      await main(app, () => Reflect.get(globalThis, '__offlineRetryProbe').settle(503));
      await expect
        .poll(
          () =>
            main(app, () =>
              Reflect.get(globalThis, '__offlineRetryProbe').contents.executeJavaScript(
                `window.__retryFailures`
              )
            ),
          { timeout: 5000 }
        )
        .toBe(1);
      const failed = await main(app, () => {
        const probe: RetryProbe = Reflect.get(globalThis, '__offlineRetryProbe');
        return probe.contents.executeJavaScript(
          `({marker:window.__retryMarker,history:history.length,disabled:document.getElementById('retry-btn').disabled,text:document.getElementById('retry-btn').innerText})`
        );
      });
      expect(failed).toEqual({
        marker: before.marker,
        history: before.history,
        disabled: false,
        text: 'Retry',
      });
      expect(
        await main(app, () => Reflect.get(globalThis, '__offlineRetryProbe').navigations)
      ).toEqual([]);
      await main(app, () =>
        Reflect.get(globalThis, '__offlineRetryProbe').contents.executeJavaScript(
          `document.getElementById('retry-btn').click()`
        )
      );
      await expect
        .poll(() => main(app, () => Reflect.get(globalThis, '__offlineRetryProbe').calls), {
          timeout: 5000,
        })
        .toBe(2);
      await main(app, () => Reflect.get(globalThis, '__offlineRetryProbe').settle(204));
      await expect
        .poll(
          () => main(app, () => Reflect.get(globalThis, '__offlineRetryProbe').contents.getURL()),
          { timeout: 10_000 }
        )
        .toBe('https://chat.google.com/');
      await expect
        .poll(() =>
          main(app, () =>
            Reflect.get(globalThis, '__offlineRetryProbe').contents.isLoadingMainFrame()
          )
        )
        .toBe(false);
      const result = await main(app, async () => {
        const probe: RetryProbe = Reflect.get(globalThis, '__offlineRetryProbe');
        return {
          requests: probe.requests,
          methods: probe.methods,
          navigations: probe.navigations,
          history: await probe.contents.executeJavaScript('history.length'),
        };
      });
      expect(result).toEqual({
        requests: 2,
        methods: ['HEAD', 'HEAD'],
        navigations: ['https://chat.google.com/'],
        history: before.history,
      });
    } finally {
      if (launched) await closeElectronApp(launched.app);
      for (const directory of [profile, `${profile}-a1`, `${profile}-a2`])
        await rm(directory, { recursive: true, force: true });
    }
  });
}
