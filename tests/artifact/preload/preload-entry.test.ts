/**
 * Built-CJS preload entry fixture.
 * Loads the actual lib/preload/index.js — not TypeScript sources.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import { IPC_CHANNELS } from '../../../src/shared/constants.js';
import { validateOnlineCheckRequest } from '../../../src/shared/dataValidators.js';
import urls from '../../../src/urls.js';
import { closeElectronApp } from '../../helpers/electron-test';

declare global {
  interface Window {
    __offlineFailed: number;
    __offlineFailures: number[];
    __checkStarted: number;
    __documentId: string;
    __statusReplies: number;
  }
}

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');
const PRELOAD_PATH = path.join(PROJECT_ROOT, 'lib/preload/index.js');

const FIXTURE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="icon" href="https://www.google.com/favicon.ico" />
    <script>
      window.__credentialsAtParse = navigator.credentials;
    </script>
  </head>
  <body>
    <input name="q" id="search" />
    <div class="RuSDjb">
      <span class="OK1FOb" aria-label="3 unread messages">3</span>
    </div>
    <script>
      window.__offlineFailed = 0;
      window.__offlineFailures = [];
      window.__documentId = crypto.randomUUID();
      window.addEventListener('app:onlineCheckFailed', () => {
        window.__offlineFailed += 1;
        window.__offlineFailures.push(performance.now() - window.__checkStarted);
      });
    </script>
  </body>
</html>
`;

const FIXTURE_MAIN = `const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');

const preload = process.env.GOGCHAT_PRELOAD_PATH;
const page = process.env.GOGCHAT_FIXTURE_HTML;
const userData = process.env.GOGCHAT_USER_DATA;

if (!preload || !page || !userData) {
  throw new Error('missing fixture env');
}

app.setPath('userData', userData);
app.__gogchatIpc = [];

for (const channel of [
  'faviconChanged',
  'unreadCount',
  'checkIfOnline',
  'notificationShow',
  'passkeyAuthFailed',
]) {
  ipcMain.on(channel, (_event, data) => {
    app.__gogchatIpc.push({ channel, data });
  });
}

app.whenReady().then(() => {
  session.defaultSession.protocol.handle('https', () => new Response(
    '<!doctype html><title>Recovered fixture</title><body>Recovered</body>',
    { headers: { 'content-type': 'text/html' } }
  ));
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame) app.__gogchatIpc.push({ channel: 'fixture:navigation', data: details.url });
  });
  win.loadFile(page);
});
`;

async function recordedIpc(
  app: Awaited<ReturnType<typeof electron.launch>>
): Promise<Array<{ channel: string; data: unknown }>> {
  return app.evaluate(({ app: electronApp }) => {
    return (
      (electronApp as { __gogchatIpc?: Array<{ channel: string; data: unknown }> }).__gogchatIpc ??
      []
    );
  });
}

test.describe('built CJS preload entry', () => {
  test('installs production preload behaviors from lib/preload/index.js', async () => {
    const testInfo = test.info();
    const userData = await mkdtemp(path.join(tmpdir(), 'gogchat-preload-'));
    const htmlPath = path.join(userData, 'index.html');
    const mainPath = path.join(userData, 'main.cjs');
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
    const evidence: unknown[] = [];
    try {
      await writeFile(htmlPath, FIXTURE_HTML);
      await writeFile(mainPath, FIXTURE_MAIN);
      app = await electron.launch({
        args: [mainPath],
        env: {
          ...process.env,
          GOGCHAT_PRELOAD_PATH: PRELOAD_PATH,
          GOGCHAT_FIXTURE_HTML: htmlPath,
          GOGCHAT_USER_DATA: userData,
        },
      });

      const page = await app.firstWindow({ timeout: 25_000 });
      await page.waitForLoadState('domcontentloaded');

      await page.waitForFunction(() => navigator.credentials === undefined);

      const bridge = await page.evaluate(() => {
        const api = window.gogchat;
        return {
          exists: Boolean(api),
          methods: api ? Object.keys(api).sort() : [],
        };
      });
      expect(bridge.exists).toBe(true);
      expect(bridge.methods).toEqual([
        'checkIfOnline',
        'onOnlineStatus',
        'onSearchShortcut',
        'reportPasskeyFailure',
        'sendFaviconChanged',
        'sendNotificationClicked',
        'sendUnreadCount',
      ]);

      await page.waitForTimeout(250);
      const afterLoad = await recordedIpc(app);
      expect(afterLoad.some((item) => item.channel === 'unreadCount' && item.data === 3)).toBe(
        true
      );

      await page.evaluate(() => {
        const icon = document.querySelector('link[rel="icon"]');
        if (icon)
          icon.setAttribute(
            'href',
            'https://www.gstatic.com/images/branding/product/1x/googleg_32dp.png'
          );
      });
      await page.waitForTimeout(150);
      const afterFavicon = await recordedIpc(app);
      expect(afterFavicon.some((item) => item.channel === 'faviconChanged')).toBe(true);

      await page.evaluate(() => {
        window.gogchat.reportPasskeyFailure('NotAllowedError');
        window.dispatchEvent(
          new CustomEvent('__gogchatNotificationShow', {
            detail: { title: 'hello', body: 'world', tag: 't1' },
          })
        );
      });
      await page.waitForTimeout(50);
      const afterBridge = await recordedIpc(app);
      expect(afterBridge.some((item) => item.channel === 'passkeyAuthFailed')).toBe(true);
      expect(afterBridge.some((item) => item.channel === 'notificationShow')).toBe(true);

      await app.evaluate(({ BrowserWindow }, channel) => {
        const win = BrowserWindow.getAllWindows()[0];
        win?.webContents.send(channel);
      }, 'searchShortcut');
      await page.waitForTimeout(50);
      const activeId = await page.evaluate(() => document.activeElement?.id);
      expect(activeId).toBe('search');

      const localUrl = page.url();
      const documentId = await page.evaluate(() => window.__documentId);
      const initialHistoryLength = await page.evaluate(() => history.length);
      const navigations: string[] = [];
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) navigations.push(frame.url());
      });
      await page.evaluate(() => {
        window.__statusReplies = 0;
        window.gogchat.onOnlineStatus(() => {
          window.__statusReplies += 1;
        });
      });
      const runtime = app;
      let requestCount = 0;
      const checkOnline = async () => {
        await page.evaluate(() => {
          window.__checkStarted = performance.now();
          window.dispatchEvent(new Event('app:checkIfOnline'));
        });
        requestCount += 1;
        await expect
          .poll(
            async () =>
              (await recordedIpc(runtime)).filter(
                (item) => item.channel === IPC_CHANNELS.CHECK_IF_ONLINE
              ).length
          )
          .toBe(requestCount);
        const requests = (await recordedIpc(runtime)).filter(
          (item) => item.channel === IPC_CHANNELS.CHECK_IF_ONLINE
        );
        const { attemptId } = validateOnlineCheckRequest(requests[requestCount - 1]?.data);
        evidence.push({ phase: 'request', attemptId, requestCount, url: page.url() });
        return attemptId;
      };
      const reply = async (attemptId: string, online: boolean) => {
        const received = await page.evaluate(() => window.__statusReplies);
        evidence.push({ phase: 'reply', attemptId, online });
        await runtime.evaluate(
          ({ BrowserWindow }, payload) => {
            BrowserWindow.getAllWindows()[0]?.webContents.send(payload.channel, payload.status);
          },
          { channel: IPC_CHANNELS.ONLINE_STATUS, status: { attemptId, online } }
        );
        await page.waitForFunction((count) => window.__statusReplies === count + 1, received);
      };
      const retainedDocument = async (phase: string, failed: number) => {
        const state = await page.evaluate(() => ({
          url: location.href,
          documentId: window.__documentId,
          failed: window.__offlineFailed,
          elapsedMs: window.__offlineFailures,
          replies: window.__statusReplies,
        }));
        evidence.push({
          phase,
          ...state,
          navigations: [...navigations],
          navigationCount: navigations.length,
        });
        expect(state).toMatchObject({ url: localUrl, documentId, failed });
        expect(navigations).toEqual([]);
        expect(
          (await recordedIpc(runtime))
            .filter((item) => item.channel === 'fixture:navigation')
            .map((item) => item.data)
        ).toEqual([localUrl]);
      };

      const deadlineSupersededAttemptId = await checkOnline();
      const expiredAttemptId = await checkOnline();
      await reply(deadlineSupersededAttemptId, true);
      await reply(deadlineSupersededAttemptId, false);
      await reply('stale', false);
      await retainedDocument('older-replies-before-deadline', 0);
      await page.waitForFunction(() => window.__offlineFailed === 1, undefined, {
        timeout: 10_000,
      });
      await retainedDocument('production-deadline', 1);
      expect(await page.evaluate(() => window.__offlineFailures[0])).toBeGreaterThanOrEqual(5_500);
      await reply(expiredAttemptId, true);
      await reply(expiredAttemptId, false);
      await retainedDocument('late-correlated-replies', 1);

      const supersededAttemptId = await checkOnline();
      const currentAttemptId = await checkOnline();
      expect(currentAttemptId).not.toBe(supersededAttemptId);
      await reply('stale', false);
      await reply(supersededAttemptId, true);
      await reply(supersededAttemptId, false);
      await retainedDocument('superseded-replies', 1);
      await reply(currentAttemptId, false);
      await retainedDocument('current-false', 2);

      const successAttemptId = await checkOnline();
      const appUrl = new URL(urls.appUrl).href;
      await runtime.evaluate(
        ({ BrowserWindow }, payload) => {
          const contents = BrowserWindow.getAllWindows()[0]?.webContents;
          contents?.send(payload.channel, payload.status);
          contents?.send(payload.channel, payload.status);
        },
        {
          channel: IPC_CHANNELS.ONLINE_STATUS,
          status: { attemptId: successAttemptId, online: true },
        }
      );
      await page.waitForURL(appUrl, { timeout: 8_000, waitUntil: 'load' });
      expect(navigations).toEqual([appUrl]);
      const historyLength = await page.evaluate(() => history.length);
      expect(historyLength).toBe(initialHistoryLength);
      const startedNavigations = (await recordedIpc(runtime))
        .filter((item) => item.channel === 'fixture:navigation')
        .map((item) => item.data);
      expect(startedNavigations).toEqual([localUrl, appUrl]);
      evidence.push({
        phase: 'duplicate-current-success',
        expiredAttemptId,
        supersededAttemptId,
        currentAttemptId,
        successAttemptId,
        url: page.url(),
        navigations: [...navigations],
        startedNavigations,
        navigationCount: navigations.length,
        startedNavigationCount: startedNavigations.length,
        initialHistoryLength,
        historyLength,
      });
    } finally {
      if (app) {
        await closeElectronApp(app);
      }
      await rm(userData, { recursive: true, force: true });
      await testInfo.attach('built-cjs-offline-recovery', {
        body: JSON.stringify(evidence, null, 2),
        contentType: 'application/json',
      });
    }
  });
});
