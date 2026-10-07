/**
 * Quit and relaunch against one profile restores account window bounds.
 * BrowserWindow restores every account. WebContentsView restores the host only.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from '@playwright/test';
import Conf from 'conf';
import { schema } from '../../src/main/utils/config/configSchema.js';
import { APP_IDENTITY } from '../../src/shared/appIdentity.js';
import { asAccountIndex } from '../../src/shared/types/branded.js';
import type { AccountIndex } from '../../src/shared/types/branded.js';
import type { StoreType } from '../../src/shared/types/config.js';
import type { AccountBackendKind, AccountWindowState } from '../../src/shared/types/window.js';
import {
  closeElectronApp,
  ELECTRON_FIRST_WINDOW_TIMEOUT_MS,
  expect,
  launchElectronAppWithWindow,
  peekElectronChildProcess,
  test,
  wrapEvaluateWithGcRetry,
} from '../helpers/electron-test.js';
import type { LaunchedElectronApp } from '../helpers/electron-test.js';

const projectRoot = join(import.meta.dirname, '../..');
const harnessUrl = pathToFileURL(join(projectRoot, 'tests/fixtures/electron-harness.html')).href;
const TOLERANCE_PX = 12;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PlacedWindows {
  account0: Rect;
  account1: Rect;
}

test.describe.configure({ timeout: 120_000 });

async function seedUserData(
  directory: string,
  backend: AccountBackendKind,
  secondary?: AccountWindowState
): Promise<void> {
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
    if (secondary) {
      config.set('accountWindows', { 1: secondary });
    }
  }
}

function launchEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TESTING: 'true',
    NODE_ENV: 'test',
    CI: 'true',
    GOGCHAT_DISABLE_PRECONNECT: '1',
    GOGCHAT_TEST_APP_URL: harnessUrl,
  };
  delete env['GOGCHAT_TEST_HANG_SHUTDOWN'];
  return env;
}

async function waitForManager(app: LaunchedElectronApp): Promise<void> {
  wrapEvaluateWithGcRetry(app);
  await expect
    .poll(
      () =>
        app.evaluate(
          () => typeof Reflect.get(globalThis, '__gogchatGetAccountWindowManager') === 'function'
        ),
      { timeout: 20_000 }
    )
    .toBe(true);
}

async function launch(directory: string): Promise<LaunchedElectronApp> {
  const { app } = await launchElectronAppWithWindow({
    appPath: projectRoot,
    cwd: projectRoot,
    userDataDir: directory,
    env: launchEnv(),
  });
  await waitForManager(app);
  return app;
}

/** Relaunch the same profile. The shared helper would switch directories after a singleton miss. */
async function launchExact(userDataDir: string): Promise<LaunchedElectronApp> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    let app: LaunchedElectronApp | undefined;
    try {
      app = await electron.launch({
        cwd: projectRoot,
        args: [projectRoot, `--user-data-dir=${userDataDir}`],
        env: launchEnv(),
        timeout: 45_000,
      });
      await app.firstWindow({ timeout: ELECTRON_FIRST_WINDOW_TIMEOUT_MS });
      await waitForManager(app);
      return app;
    } catch (error) {
      lastError = error;
      if (app) await closeElectronApp(app);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`relaunch failed for ${userDataDir}: ${String(lastError)}`);
}

async function quitApp(app: LaunchedElectronApp): Promise<void> {
  const child = peekElectronChildProcess(app);
  if (!child) throw new Error('Electron child process is unavailable');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  try {
    await app
      .evaluate(({ app: electronApp }) => {
        electronApp.quit();
      })
      .catch(() => undefined);
    await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('quit did not finish before the shutdown ceiling')),
          12_000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  expect(child.exitCode).toBe(0);
}

function expectNear(actual: Rect, expected: Rect, detail: string): void {
  const deltas = {
    x: Math.abs(actual.x - expected.x),
    y: Math.abs(actual.y - expected.y),
    width: Math.abs(actual.width - expected.width),
    height: Math.abs(actual.height - expected.height),
  };
  const off = (Object.entries(deltas) as Array<[string, number]>).filter(
    ([, delta]) => delta > TOLERANCE_PX
  );
  if (off.length > 0) {
    throw new Error(
      `${detail} off by ${off.map(([key, delta]) => `${key}:${delta}`).join(', ')} actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`
    );
  }
}

test('restores BrowserWindow account bounds after quit and relaunch', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'gogchat-window-bounds-bw-')));
  let app: LaunchedElectronApp | undefined;
  try {
    await seedUserData(directory, 'browser-window');
    app = await launch(directory);
    const placed = (await app.evaluate(
      (
        { BrowserWindow },
        input: { url: string; secondary: AccountIndex; account0: Rect; account1: Rect }
      ) => {
        const getManager = Reflect.get(globalThis, '__gogchatGetAccountWindowManager') as () => {
          createAccountWindow: (url: string, accountIndex: AccountIndex) => unknown;
        };
        getManager().createAccountWindow(input.url, input.secondary);
        const found = new Map<string, Electron.BrowserWindow>();
        for (const win of BrowserWindow.getAllWindows()) {
          const storagePath = win.webContents.session.storagePath ?? '';
          if (storagePath.includes('account-1')) found.set('1', win);
          else if (storagePath.includes('account-0')) found.set('0', win);
        }
        const primary = found.get('0');
        const secondary = found.get('1');
        if (!primary || !secondary) {
          throw new Error(
            `expected account windows, saw ${BrowserWindow.getAllWindows()
              .map((win) => win.webContents.session.storagePath ?? 'none')
              .join(',')}`
          );
        }
        primary.setBounds(input.account0);
        secondary.setBounds(input.account1);
        return { account0: primary.getBounds(), account1: secondary.getBounds() };
      },
      {
        url: harnessUrl,
        secondary: asAccountIndex(1),
        account0: { x: 40, y: 60, width: 900, height: 700 },
        account1: { x: 140, y: 90, width: 820, height: 640 },
      }
    )) as PlacedWindows;
    expect(Math.abs(placed.account0.width - placed.account1.width)).toBeGreaterThan(TOLERANCE_PX);
    const userData = String(
      await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    );
    await quitApp(app);
    app = undefined;

    app = await launchExact(userData);
    const restored = (await app.evaluate(
      ({ BrowserWindow }, input: { url: string; secondary: AccountIndex }) => {
        const getManager = Reflect.get(globalThis, '__gogchatGetAccountWindowManager') as () => {
          createAccountWindow: (url: string, accountIndex: AccountIndex) => unknown;
        };
        getManager().createAccountWindow(input.url, input.secondary);
        const found = new Map<string, { x: number; y: number; width: number; height: number }>();
        for (const win of BrowserWindow.getAllWindows()) {
          const storagePath = win.webContents.session.storagePath ?? '';
          const bounds = win.getBounds();
          if (storagePath.includes('account-1')) found.set('1', bounds);
          else if (storagePath.includes('account-0')) found.set('0', bounds);
        }
        return { account0: found.get('0'), account1: found.get('1') };
      },
      { url: harnessUrl, secondary: asAccountIndex(1) }
    )) as { account0?: Rect; account1?: Rect };
    if (!restored.account0 || !restored.account1) {
      throw new Error('relaunched account windows were missing');
    }
    expectNear(restored.account0, placed.account0, 'account 0');
    expectNear(restored.account1, placed.account1, 'account 1');
  } finally {
    await app?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    await rm(`${directory}-a1`, { recursive: true, force: true });
    await rm(`${directory}-a2`, { recursive: true, force: true });
  }
});

test('restores the WebContentsView host and keeps a secondary entry', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'gogchat-window-bounds-wcv-')));
  const secondary: AccountWindowState = {
    bounds: { x: 300, y: 220, width: 640, height: 580 },
    isMaximized: false,
  };
  let app: LaunchedElectronApp | undefined;
  try {
    await seedUserData(directory, 'web-contents-view', secondary);
    app = await launch(directory);
    const placed = (await app.evaluate(
      ({ BrowserWindow }, rect: Rect) => {
        const wins = BrowserWindow.getAllWindows();
        const host = wins[0];
        if (!host || wins.length !== 1) throw new Error(`expected one host, saw ${wins.length}`);
        host.setBounds(rect);
        const getManager = Reflect.get(globalThis, '__gogchatGetAccountWindowManager') as () => {
          getAccountWindowState: (accountIndex: AccountIndex) => AccountWindowState | null;
        };
        return {
          bounds: host.getBounds(),
          secondary: getManager().getAccountWindowState(1 as AccountIndex),
        };
      },
      { x: 48, y: 72, width: 980, height: 720 }
    )) as {
      bounds: Rect;
      secondary: AccountWindowState | null;
    };
    expect(placed.secondary).toEqual(secondary);
    const userData = String(
      await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    );
    await quitApp(app);
    app = undefined;

    app = await launchExact(userData);
    const restored = (await app.evaluate(({ BrowserWindow }) => {
      const wins = BrowserWindow.getAllWindows();
      const host = wins[0];
      if (!host || wins.length !== 1) throw new Error(`expected one host, saw ${wins.length}`);
      const getManager = Reflect.get(globalThis, '__gogchatGetAccountWindowManager') as () => {
        getAccountWindowState: (accountIndex: AccountIndex) => AccountWindowState | null;
      };
      return {
        bounds: host.getBounds(),
        secondary: getManager().getAccountWindowState(1 as AccountIndex),
      };
    })) as { bounds: Rect; secondary: AccountWindowState | null };
    expectNear(restored.bounds, placed.bounds, 'host');
    expect(restored.secondary).toEqual(secondary);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    await rm(`${directory}-a1`, { recursive: true, force: true });
    await rm(`${directory}-a2`, { recursive: true, force: true });
  }
});
