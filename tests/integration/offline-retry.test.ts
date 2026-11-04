import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
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
  attemptId: string;
  aborted: boolean;
  methods: (string | undefined)[];
  navigations: string[];
  respond: (status: number) => void;
  fail: () => void;
}

interface PageState {
  marker: string;
  history: number;
  disabled: boolean;
  text: string;
  feedback: string;
}

const OFFLINE_CSP = "default-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'";
const RAW_ERROR_TEXT = ['fetch failed', 'ECONNRESET', 'secret-token'];

type MainApp = Parameters<typeof main>[0];

function inPage<Result>(app: MainApp, script: string): Promise<Result> {
  return app.evaluate((_electron, source: string) => {
    const probe: RetryProbe = Reflect.get(globalThis, '__offlineRetryProbe');
    return probe.contents.executeJavaScript(source);
  }, script) as Promise<Result>;
}

const clickRetry = (app: MainApp) =>
  inPage<void>(app, `document.getElementById('retry-btn').click()`);

const pageState = (app: MainApp) =>
  inPage<PageState>(
    app,
    `({marker:window.__retryMarker,history:history.length,disabled:document.getElementById('retry-btn').disabled,text:document.getElementById('retry-btn').innerText,feedback:document.getElementById('retry-status').textContent})`
  );

const failureDetails = (app: MainApp) => inPage<unknown[]>(app, `window.__retryDetails`);

async function waitForCalls(app: MainApp, calls: number) {
  await expect
    .poll(() => main(app, () => Reflect.get(globalThis, '__offlineRetryProbe').calls), {
      timeout: 5000,
    })
    .toBe(calls);
}

async function waitForFailures(app: MainApp, failures: number, timeout = 5000) {
  await expect
    .poll(() => inPage<number>(app, `window.__retryFailures`), { timeout })
    .toBe(failures);
}

async function sendStatus(app: MainApp, payload: unknown) {
  await app.evaluate((_electron, status: unknown) => {
    const probe: RetryProbe = Reflect.get(globalThis, '__offlineRetryProbe');
    const channels: typeof IPC_CHANNELS = Reflect.get(globalThis, '__offlineRetryChannels');
    probe.contents.send(channels.ONLINE_STATUS, status);
  }, payload);
}

async function captureFeedback(app: MainApp, name: string) {
  const screenshot = await main(app, async () => {
    const probe: RetryProbe = Reflect.get(globalThis, '__offlineRetryProbe');
    return (await probe.contents.capturePage()).toPNG().toString('base64');
  });
  await writeFile(test.info().outputPath(name), Buffer.from(screenshot, 'base64'));
}

async function actualNetworkReachability(): Promise<string> {
  try {
    const response = await fetch('https://www.google.com/generate_204', {
      method: 'HEAD',
      signal: AbortSignal.timeout(3000),
    });
    return `reachable: HTTP ${response.status} ok=${response.ok}`;
  } catch {
    return 'unreachable';
  }
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
          attemptId: '',
          aborted: false,
          methods: [],
          navigations: [],
          respond: () => {
            throw new Error('No pending fetch');
          },
          fail: () => {
            throw new Error('No pending fetch');
          },
        };
        electron.ipcMain.on(
          channels.CHECK_IF_ONLINE,
          (event, data: { attemptId: string; operation?: string }) => {
            if (event.sender === contents) {
              probe.requests++;
              if (data.operation !== 'cancel') probe.attemptId = data.attemptId;
            }
          }
        );
        contents.on('did-start-navigation', (details) => {
          if (details.isMainFrame) probe.navigations.push(details.url);
        });
        globalThis.fetch = (_input, init) => {
          probe.calls++;
          probe.methods.push(init?.method);
          return new Promise<Response>((resolve, reject) => {
            probe.respond = (status) => resolve(new Response(null, { status }));
            probe.fail = () => reject(new TypeError('fetch failed: ECONNRESET secret-token'));
            init?.signal?.addEventListener(
              'abort',
              () => {
                probe.aborted = true;
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true }
            );
          });
        };
        Reflect.set(globalThis, '__offlineRetryProbe', probe);
        await contents.executeJavaScript(
          `window.__retryMarker = crypto.randomUUID(); window.__retryFailures = 0; window.__retryDetails = []; window.addEventListener('app:onlineCheckFailed', (event) => { window.__retryFailures++; window.__retryDetails.push(event.detail ?? null); });`
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
      await captureFeedback(app, `offline-${backend}.png`);

      // Controlled responses: main-process fetch is stubbed, so each case below is a
      // deterministic outcome through built preload and main, not real reachability.
      await clickRetry(app);
      await waitForCalls(app, 1);
      await captureFeedback(app, `offline-${backend}-pending.png`);
      const cancelledId = await main(
        app,
        () => Reflect.get(globalThis, '__offlineRetryProbe').attemptId
      );
      await clickRetry(app);
      await expect
        .poll(() => main(app, () => Reflect.get(globalThis, '__offlineRetryProbe').aborted))
        .toBe(true);
      await sendStatus(app, { attemptId: cancelledId, outcome: 'online' });
      const cancelled = await pageState(app);
      expect(cancelled).toMatchObject({
        marker: before.marker,
        history: before.history,
        disabled: false,
        text: 'Retry',
      });
      expect(cancelled.feedback).not.toBe('');
      await captureFeedback(app, `offline-${backend}-cancelled.png`);
      await clickRetry(app);
      await waitForCalls(app, 2);
      expect(await pageState(app)).toEqual({
        marker: before.marker,
        history: before.history,
        disabled: false,
        text: 'Cancel',
        feedback: '',
      });
      await main(app, () => Reflect.get(globalThis, '__offlineRetryProbe').respond(503));
      await waitForFailures(app, 1);
      const httpFeedback = await pageState(app);
      expect(httpFeedback).toMatchObject({
        marker: before.marker,
        history: before.history,
        disabled: false,
        text: 'Retry',
      });
      expect(httpFeedback.feedback).toContain('HTTP 503');
      await captureFeedback(app, `offline-${backend}-http-error.png`);
      await sendStatus(app, { attemptId: 'not-current', outcome: 'online' });
      await sendStatus(app, { attemptId: 'legacy-shape', online: true });

      await clickRetry(app);
      await waitForCalls(app, 3);
      await sendStatus(app, { attemptId: 'stale-while-pending', outcome: 'timeout' });
      await main(app, () => Reflect.get(globalThis, '__offlineRetryProbe').fail());
      await waitForFailures(app, 2);
      const networkFeedback = await pageState(app);
      expect(networkFeedback).toMatchObject({
        marker: before.marker,
        history: before.history,
        disabled: false,
        text: 'Retry',
      });
      expect(networkFeedback.feedback).not.toBe('');
      expect(networkFeedback.feedback).not.toBe(httpFeedback.feedback);
      for (const raw of RAW_ERROR_TEXT) expect(networkFeedback.feedback).not.toContain(raw);
      await captureFeedback(app, `offline-${backend}-network-error.png`);

      await clickRetry(app);
      await waitForCalls(app, 4);
      await waitForFailures(app, 3, 12_000);
      const timeoutFeedback = await pageState(app);
      expect(timeoutFeedback).toMatchObject({
        marker: before.marker,
        history: before.history,
        disabled: false,
        text: 'Retry',
      });
      expect(
        new Set([httpFeedback.feedback, networkFeedback.feedback, timeoutFeedback.feedback]).size
      ).toBe(3);
      await captureFeedback(app, `offline-${backend}-timeout.png`);

      expect(await failureDetails(app)).toEqual([
        { outcome: 'http-error', httpStatus: 503 },
        { outcome: 'network-error' },
        { outcome: 'timeout' },
      ]);
      expect(
        await main(app, () => Reflect.get(globalThis, '__offlineRetryProbe').navigations)
      ).toEqual([]);

      await clickRetry(app);
      await waitForCalls(app, 5);
      await main(app, () => Reflect.get(globalThis, '__offlineRetryProbe').respond(204));
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
        requests: 6,
        methods: ['HEAD', 'HEAD', 'HEAD', 'HEAD', 'HEAD'],
        navigations: ['https://chat.google.com/'],
        history: before.history,
      });

      test.info().annotations.push({
        type: 'evidence-class',
        description: `built-app controlled responses (stubbed main fetch) under ${backend}; not real network reachability`,
      });
      await test.info().attach(`controlled-responses-${backend}`, {
        contentType: 'application/json',
        body: JSON.stringify({
          backend,
          stubbedFetch: true,
          feedback: {
            httpError: httpFeedback.feedback,
            networkError: networkFeedback.feedback,
            timeout: timeoutFeedback.feedback,
          },
        }),
      });
      await test.info().attach(`actual-network-reachability-${backend}`, {
        contentType: 'text/plain',
        body: `${await actualNetworkReachability()} (informational; never asserted)`,
      });
    } finally {
      if (launched) await closeElectronApp(launched.app);
      for (const directory of [profile, `${profile}-a1`, `${profile}-a2`])
        await rm(directory, { recursive: true, force: true });
    }
  });
}

test('built offline page keeps the classic self-contained bundle, siblings, and CSP', async () => {
  const offline = join(import.meta.dirname, '../../lib/offline');
  const html = await readFile(join(offline, 'index.html'), 'utf8');
  const script = await readFile(join(offline, 'index.js'), 'utf8');
  expect(html).toContain(`content="${OFFLINE_CSP}"`);
  expect(html).toContain('<script src="index.js" async></script>');
  expect(html).not.toMatch(/type=["']module["']/);
  expect(html).toContain('id="retry-status"');
  expect(await readdir(offline)).toEqual(
    expect.arrayContaining(['index.html', 'index.css', 'index.js', 'scalable.svg'])
  );
  expect(script).not.toMatch(/^\s*(?:import|export)\s/m);
  expect(script).not.toMatch(/\bimport\(|\brequire\(|__webpack_require__\.[a-z]\s*=/);
});
