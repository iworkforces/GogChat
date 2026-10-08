/**
 * Quit and relaunch against one profile restores account window bounds.
 * BrowserWindow restores every account. WebContentsView restores the host only.
 *
 * macOS fits a window into the work area when it is shown. A frame read before
 * that, or a rect taller than the display, does not come back after relaunch.
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Shrink and shift `preferred` so the frame stays inside `area` with a margin.
 * A window that crosses the work-area edge is moved on show; x/width may
 * survive while y/height snap to the visible frame.
 */
function fitBounds(area: Rect, preferred: Rect): Rect {
  const margin = 16;
  const horizontalBudget = area.width > margin * 2 ? area.width - margin * 2 : area.width;
  const verticalBudget = area.height > margin * 2 ? area.height - margin * 2 : area.height;
  const width = Math.min(Math.max(1, Math.round(preferred.width)), Math.max(1, horizontalBudget));
  const height = Math.min(Math.max(1, Math.round(preferred.height)), Math.max(1, verticalBudget));
  const slackX = Math.max(0, area.width - width);
  const slackY = Math.max(0, area.height - height);
  const padX = Math.min(margin, Math.floor(slackX / 2));
  const padY = Math.min(margin, Math.floor(slackY / 2));
  const minX = area.x + padX;
  const minY = area.y + padY;
  const maxX = area.x + slackX - padX;
  const maxY = area.y + slackY - padY;
  return {
    x: Math.round(Math.min(Math.max(preferred.x, minX), Math.max(minX, maxX))),
    y: Math.round(Math.min(Math.max(preferred.y, minY), Math.max(minY, maxY))),
    width,
    height,
  };
}

async function readWorkArea(app: LaunchedElectronApp): Promise<Rect> {
  return (await app.evaluate(({ screen }) => {
    const area = screen.getPrimaryDisplay().workArea;
    return { x: area.x, y: area.y, width: area.width, height: area.height };
  })) as Rect;
}

/** Visible frames only. A hidden window still reports the pre-show rect. */
async function whenFramesSettle<T extends { visible: boolean }>(
  read: () => Promise<T>,
  same: (previous: T, next: T) => boolean
): Promise<T> {
  let last = await read();
  let stable = 0;
  for (let attempt = 0; attempt < 40 && stable < 3; attempt++) {
    await delay(100);
    const next = await read();
    if (next.visible && same(last, next)) stable += 1;
    else stable = 0;
    last = next;
  }
  if (!last.visible) {
    throw new Error('window was still hidden when bounds were read');
  }
  return last;
}

test('restores BrowserWindow account bounds after quit and relaunch', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'gogchat-window-bounds-bw-')));
  let app: LaunchedElectronApp | undefined;
  try {
    await seedUserData(directory, 'browser-window');
    app = await launch(directory);
    const area = await readWorkArea(app);
    const requested0 = fitBounds(area, {
      x: area.x + 40,
      y: area.y + 28,
      width: 900,
      height: 640,
    });
    const requested1 = fitBounds(area, {
      x: area.x + 80,
      y: area.y + 48,
      width: Math.max(480, requested0.width - 120),
      height: 580,
    });
    await app.evaluate(
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
        if (!primary.isVisible()) primary.show();
        if (!secondary.isVisible()) secondary.show();
      },
      {
        url: harnessUrl,
        secondary: asAccountIndex(1),
        account0: requested0,
        account1: requested1,
      }
    );
    const readAccounts = (): Promise<PlacedWindows & { visible: boolean }> =>
      app!.evaluate(({ BrowserWindow }) => {
        const found = new Map<string, { bounds: Rect; visible: boolean }>();
        for (const win of BrowserWindow.getAllWindows()) {
          const storagePath = win.webContents.session.storagePath ?? '';
          const entry = { bounds: win.getBounds(), visible: win.isVisible() };
          if (storagePath.includes('account-1')) found.set('1', entry);
          else if (storagePath.includes('account-0')) found.set('0', entry);
        }
        const primary = found.get('0');
        const secondary = found.get('1');
        if (!primary || !secondary) {
          throw new Error('account windows were missing while bounds settled');
        }
        return {
          account0: primary.bounds,
          account1: secondary.bounds,
          visible: primary.visible && secondary.visible,
        };
      }) as Promise<PlacedWindows & { visible: boolean }>;
    const placed = await whenFramesSettle(
      readAccounts,
      (previous, next) =>
        sameRect(previous.account0, next.account0) && sameRect(previous.account1, next.account1)
    );
    expectNear(placed.account0, requested0, 'account 0 accepted');
    expectNear(placed.account1, requested1, 'account 1 accepted');
    expect(Math.abs(placed.account0.width - placed.account1.width)).toBeGreaterThan(TOLERANCE_PX);
    const userData = String(
      await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    );
    await quitApp(app);
    app = undefined;

    app = await launchExact(userData);
    await app.evaluate(
      ({ BrowserWindow }, input: { url: string; secondary: AccountIndex }) => {
        const getManager = Reflect.get(globalThis, '__gogchatGetAccountWindowManager') as () => {
          createAccountWindow: (url: string, accountIndex: AccountIndex) => unknown;
        };
        getManager().createAccountWindow(input.url, input.secondary);
        for (const win of BrowserWindow.getAllWindows()) {
          const storagePath = win.webContents.session.storagePath ?? '';
          const account = storagePath.includes('account-1') || storagePath.includes('account-0');
          if (account && !win.isVisible()) win.show();
        }
      },
      { url: harnessUrl, secondary: asAccountIndex(1) }
    );
    const restored = await whenFramesSettle(
      readAccounts,
      (previous, next) =>
        sameRect(previous.account0, next.account0) && sameRect(previous.account1, next.account1)
    );
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
    const area = await readWorkArea(app);
    const requestedHost = fitBounds(area, {
      x: area.x + 32,
      y: area.y + 28,
      width: 880,
      height: 620,
    });
    await app.evaluate(({ BrowserWindow }, rect: Rect) => {
      const wins = BrowserWindow.getAllWindows();
      const host = wins[0];
      if (!host || wins.length !== 1) throw new Error(`expected one host, saw ${wins.length}`);
      host.setBounds(rect);
      if (!host.isVisible()) host.show();
    }, requestedHost);
    const readHost = (): Promise<{
      bounds: Rect;
      visible: boolean;
      secondary: AccountWindowState | null;
    }> =>
      app!.evaluate(({ BrowserWindow }) => {
        const wins = BrowserWindow.getAllWindows();
        const host = wins[0];
        if (!host || wins.length !== 1) throw new Error(`expected one host, saw ${wins.length}`);
        const getManager = Reflect.get(globalThis, '__gogchatGetAccountWindowManager') as () => {
          getAccountWindowState: (accountIndex: AccountIndex) => AccountWindowState | null;
        };
        return {
          bounds: host.getBounds(),
          visible: host.isVisible(),
          secondary: getManager().getAccountWindowState(1 as AccountIndex),
        };
      }) as Promise<{ bounds: Rect; visible: boolean; secondary: AccountWindowState | null }>;
    const placed = await whenFramesSettle(readHost, (previous, next) =>
      sameRect(previous.bounds, next.bounds)
    );
    expectNear(placed.bounds, requestedHost, 'host accepted');
    expect(placed.secondary).toEqual(secondary);
    const userData = String(
      await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    );
    await quitApp(app);
    app = undefined;

    app = await launchExact(userData);
    await app.evaluate(({ BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows()[0];
      if (host && !host.isVisible()) host.show();
    });
    const restored = await whenFramesSettle(readHost, (previous, next) =>
      sameRect(previous.bounds, next.bounds)
    );
    expectNear(restored.bounds, placed.bounds, 'host');
    expect(restored.secondary).toEqual(secondary);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    await rm(`${directory}-a1`, { recursive: true, force: true });
    await rm(`${directory}-a2`, { recursive: true, force: true });
  }
});
