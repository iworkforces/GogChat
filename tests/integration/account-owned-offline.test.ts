import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestInfo } from '@playwright/test';
import {
  expect,
  test,
  evaluateWithRequire,
  launchElectronAppWithWindow,
  closeElectronApp,
} from '../helpers/electron-test';
import type { IAccountWindowManager } from '../../src/shared/types/window';

test('built connectivity routes and cancels locally for both real account backends', async ({
  appPath,
}, testInfo: TestInfo) => {
  test.setTimeout(120_000);
  const root = path.resolve(import.meta.dirname, '../..');
  const profile = await mkdtemp(path.join(tmpdir(), 'gogchat-owned-offline-'));
  let launched: Awaited<ReturnType<typeof launchElectronAppWithWindow>> | undefined;
  try {
    launched = await launchElectronAppWithWindow({
      appPath,
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
    const app = launched.app;
    await expect
      .poll(() => evaluateWithRequire(app, () => '__gogchatInitialConnectivity' in globalThis))
      .toBe(true);
    const results = await evaluateWithRequire(launched.app, async (api) => {
      const g = globalThis as typeof globalThis & {
        __gogchatPeekAccountWindowManager: () => IAccountWindowManager | null;
        __gogchatCreateAccountWindowManager: (factory: {
          createWindow: (url: string, partition: string) => Electron.BrowserWindow;
        }) => IAccountWindowManager;
        __gogchatCreateAccountViewManager: (factory: {
          createWindow: (url: string, partition: string) => Electron.BrowserWindow;
        }) => IAccountWindowManager;
        __gogchatInitialConnectivity: {
          checkForInternet: (manager: IAccountWindowManager) => Promise<void>;
          scheduleInitialConnectivity: (manager: IAccountWindowManager) => () => void;
        };
      };
      const url = api.require('node:url') as typeof import('node:url');
      const pathMod = api.require('node:path') as typeof import('node:path');
      const harness = url.pathToFileURL(
        pathMod.join(process.cwd(), 'tests/fixtures/electron-harness.html')
      ).href;
      const waitForInitialDocument = (contents: Electron.WebContents): Promise<void> => {
        if (!contents.isLoadingMainFrame() && contents.getURL() !== '') {
          return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
          const dispose = () => {
            contents.removeListener('did-finish-load', onLoaded);
            contents.removeListener('did-fail-load', onFailed);
          };
          const onLoaded = () => {
            dispose();
            resolve();
          };
          const onFailed = (
            _event: Electron.Event,
            errorCode: number,
            errorDescription: string,
            validatedURL: string,
            isMainFrame: boolean
          ) => {
            if (!isMainFrame) return;
            dispose();
            reject(
              new Error(`Initial document failed: ${errorCode} ${errorDescription} ${validatedURL}`)
            );
          };
          contents.once('did-finish-load', onLoaded);
          contents.on('did-fail-load', onFailed);
        });
      };
      const originalContents = g
        .__gogchatPeekAccountWindowManager()
        ?.getAccountWebContents(0 as Parameters<IAccountWindowManager['getAccountWebContents']>[0]);
      if (!originalContents) throw new Error('original account-0 content missing');
      await waitForInitialDocument(originalContents);
      await originalContents.loadURL(originalContents.getURL());
      const originalAppPath = api.app.getAppPath();
      const fsMod: typeof import('node:fs') = api.require('node:fs');
      const osMod: typeof import('node:os') = api.require('node:os');
      const fixtureAppPath = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'gogchat owned #?%-'));
      const originalFetch = globalThis.fetch;
      const Notification: typeof import('electron').Notification =
        api.require('electron').Notification;
      const originalShow = Notification.prototype.show;
      const banners: Electron.Notification[] = [];
      Notification.prototype.show = function () {
        banners.push(this);
      };
      const rows = [];
      try {
        fsMod.mkdirSync(pathMod.join(fixtureAppPath, 'lib'));
        fsMod.cpSync(
          pathMod.join(process.cwd(), 'lib/offline'),
          pathMod.join(fixtureAppPath, 'lib/offline'),
          { recursive: true }
        );
        api.app.setAppPath(fixtureAppPath);
        const offlineCandidate = pathMod.join(fixtureAppPath, 'lib/offline/index.html');
        const offlineCandidateExists = fsMod.existsSync(offlineCandidate);
        for (const backend of ['browser-window', 'web-contents-view'] as const) {
          const initialLoads = new Map<Electron.WebContents, Promise<void>>();
          const factory = {
            createWindow: (target: string, partition: string) => {
              const window = new api.BrowserWindow({
                show: false,
                webPreferences: {
                  partition,
                  sandbox: true,
                  contextIsolation: true,
                  nodeIntegration: false,
                  webSecurity: true,
                },
              });
              initialLoads.set(window.webContents, window.loadURL(target));
              return window;
            },
          };
          const manager =
            backend === 'browser-window'
              ? g.__gogchatCreateAccountWindowManager(factory)
              : g.__gogchatCreateAccountViewManager(factory);
          const zero = 0 as Parameters<IAccountWindowManager['getAccountWebContents']>[0];
          let dispose = () => {};
          try {
            manager.createAccountWindow(harness, zero);
            const contents = manager.getAccountWebContents(zero);
            if (!contents) throw new Error('account content missing');
            await (initialLoads.get(contents) ?? waitForInitialDocument(contents));
            const host = manager.getAccountWindow(zero);
            const hostBefore = host?.webContents.getURL();
            let probes = 0;
            globalThis.fetch = async (input, init) => {
              const requestUrl = input instanceof Request ? input.url : String(input);
              if (requestUrl !== 'https://www.google.com/generate_204') {
                return originalFetch(input, init);
              }
              probes += 1;
              return new Response(null, { status: 503 });
            };
            const bannersBefore = banners.length;
            await g.__gogchatInitialConnectivity.checkForInternet(manager);
            const initialBannerCount = banners.length - bannersBefore;
            const initialProbes = probes;
            const routedUrl = contents.getURL();
            const hostAfter = host?.webContents.getURL();
            const partition =
              contents.session ===
              api.require('electron').session.fromPartition('persist:account-0');
            const secondary = 2 as Parameters<IAccountWindowManager['getAccountWebContents']>[0];
            manager.createAccountWindow(harness, secondary);
            const secondaryContents = manager.getAccountWebContents(secondary);
            if (!secondaryContents) throw new Error('secondary account content missing');
            await (initialLoads.get(secondaryContents) ??
              waitForInitialDocument(secondaryContents));
            const distinctPartition =
              secondaryContents.session !== contents.session &&
              secondaryContents.session ===
                api.require('electron').session.fromPartition('persist:account-2');
            manager.focusAccount(secondary);
            const banner = banners.at(-1);
            if (!banner) throw new Error('offline banner was not shown');
            banner.emit('click');
            const account0VisibleAfterClick = manager.isAccountVisible(zero);
            await contents.loadURL(harness);
            probes = 0;
            dispose = g.__gogchatInitialConnectivity.scheduleInitialConnectivity(manager);
            await contents.loadURL(harness);
            await new Promise((resolve) => setTimeout(resolve, 3100));
            const navigationRaceProbes = probes;
            dispose();
            probes = 0;
            dispose = g.__gogchatInitialConnectivity.scheduleInitialConnectivity(manager);
            manager.dehydrateAccount(zero);
            await new Promise((resolve) => setTimeout(resolve, 3100));
            const dehydrateRaceProbes = probes;
            const dehydrated = manager.isDehydrated(zero);
            rows.push({
              backend,
              routedUrl,
              hostBefore,
              hostAfter,
              partition,
              distinctPartition,
              account0VisibleAfterClick,
              initialProbes,
              initialBannerCount,
              navigationRaceProbes,
              dehydrateRaceProbes,
              dehydrated,
            });
          } finally {
            dispose();
            manager.destroyAll();
          }
        }
        return { originalAppPath, fixtureAppPath, offlineCandidate, offlineCandidateExists, rows };
      } finally {
        globalThis.fetch = originalFetch;
        Notification.prototype.show = originalShow;
        api.app.setAppPath(originalAppPath);
        fsMod.rmSync(fixtureAppPath, { recursive: true, force: true });
      }
    });
    await testInfo.attach('account-owned-offline-routing-lifetime.json', {
      body: Buffer.from(JSON.stringify(results, null, 2)),
      contentType: 'application/json',
    });
    expect(results.rows).toHaveLength(2);
    for (const row of results.rows) {
      expect(row.routedUrl).toBe(pathToFileURL(results.offlineCandidate).href);
      expect(row.partition).toBe(true);
      expect(row.distinctPartition).toBe(true);
      expect(row.initialProbes).toBe(2);
      expect(row.initialBannerCount).toBe(1);
      expect(row.navigationRaceProbes).toBe(0);
      if (row.backend === 'web-contents-view') {
        expect(row.account0VisibleAfterClick).toBe(true);
        expect(row.hostAfter).toBe(row.hostBefore);
        expect(row.dehydrated).toBe(false);
        expect(row.dehydrateRaceProbes).toBe(2);
      } else {
        expect(row.dehydrated).toBe(true);
        expect(row.dehydrateRaceProbes).toBe(0);
      }
    }
  } finally {
    if (launched) await closeElectronApp(launched.app);
    await rm(profile, { recursive: true, force: true });
  }
});
