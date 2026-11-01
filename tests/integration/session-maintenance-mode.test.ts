/**
 * Built-app session maintenance policy on both account backends.
 *
 * The native Preferences radios choose the mode, one maintenance tick runs on
 * demand under a shifted clock with `session.fromPartition` spied for that one
 * synchronous call, and a quit/relaunch of the same profile proves the saved
 * selection. Conservative mode must suppress periodic HTTP-cache and
 * service-worker clearing while code-cache trimming and memory-pressure
 * dehydration stay active.
 */

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

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const APP_PATH = PROJECT_ROOT;
const HARNESS_URL = pathToFileURL(
  path.join(PROJECT_ROOT, 'tests/fixtures/electron-harness.html')
).href;

const MINUTE_MS = 60_000;
const HTTP_BAND_MS = 121 * MINUTE_MS;
const SERVICE_WORKER_BAND_MS = 361 * MINUTE_MS;
const PRESSURE_BAND_MS = 362 * MINUTE_MS;
const SPARSE_ACCOUNTS = [2, 5];

const MODE_ITEM = ['Preferences', 'Session Maintenance'] as const;
const DEFAULT_LABEL = 'Default';
const CONSERVATIVE_LABEL = 'Conservative (keep idle HTTP caches and service workers)';

type Backend = 'browser-window' | 'web-contents-view';

interface TickCalls {
  code: string[];
  http: string[];
  serviceWorker: string[];
}

interface AccountSnapshot {
  indices: number[];
  dehydrated: number[];
  bootstrap: number[];
  backends: string[];
}

interface RadioState {
  default: boolean | undefined;
  conservative: boolean | undefined;
}

async function waitForMaintenance(app: LaunchedElectronApp): Promise<void> {
  wrapEvaluateWithGcRetry(app);
  await expect
    .poll(
      () =>
        app.evaluate(
          () =>
            typeof Reflect.get(globalThis, '__gogchatGetAccountWindowManager') === 'function' &&
            typeof Reflect.get(globalThis, '__gogchatRunSessionMaintenanceTick') === 'function'
        ),
      { timeout: 30_000 }
    )
    .toBe(true);
  await expect.poll(() => radioState(app), { timeout: 30_000 }).not.toBeNull();
}

async function createSparseAccounts(app: LaunchedElectronApp): Promise<void> {
  await app.evaluate(
    (_electron, request) => {
      const manager = (
        Reflect.get(globalThis, '__gogchatGetAccountWindowManager') as () => {
          hasAccount: (index: number) => boolean;
          createAccountWindow: (url: string, index: number) => unknown;
        }
      )();
      for (const index of request.indices) {
        if (!manager.hasAccount(index)) {
          manager.createAccountWindow(request.url, index);
        }
      }
    },
    { indices: SPARSE_ACCOUNTS, url: HARNESS_URL }
  );
  await expect
    .poll(async () => (await accounts(app)).indices, { timeout: 20_000 })
    .toEqual(expect.arrayContaining(SPARSE_ACCOUNTS));
}

function accounts(app: LaunchedElectronApp): Promise<AccountSnapshot> {
  return app.evaluate(() => {
    const manager = (
      Reflect.get(globalThis, '__gogchatGetAccountWindowManager') as () => {
        listAccountIndices: () => number[];
        isDehydrated: (index: number) => boolean;
        getBootstrapAccounts: () => number[];
        enumerateAccountWebContents: () => Array<{ backend: string }>;
      }
    )();
    const indices = manager.listAccountIndices();
    return {
      indices,
      dehydrated: indices.filter((index) => manager.isDehydrated(index)),
      bootstrap: manager.getBootstrapAccounts(),
      backends: [...new Set(manager.enumerateAccountWebContents().map((entry) => entry.backend))],
    };
  });
}

/** Partitions a tick may touch: tracked, non-bootstrap accounts. */
function eligible(snapshot: AccountSnapshot): string[] {
  return snapshot.indices
    .filter((index) => !snapshot.bootstrap.includes(index))
    .map((index) => `persist:account-${index}`)
    .sort();
}

/** Run one maintenance tick with the clock shifted by `offsetMs` and the three clear calls recorded. */
function runTick(app: LaunchedElectronApp, offsetMs: number): Promise<TickCalls> {
  return app.evaluate(({ session }, shift) => {
    const run = Reflect.get(globalThis, '__gogchatRunSessionMaintenanceTick') as () => void;
    const calls: TickCalls = { code: [], http: [], serviceWorker: [] };
    const originalFromPartition = session.fromPartition;
    const originalNow = Date.now;
    session.fromPartition = ((partition: string) => ({
      clearCodeCaches: async () => {
        calls.code.push(partition);
      },
      clearCache: async () => {
        calls.http.push(partition);
      },
      clearStorageData: async (options?: { storages?: string[] }) => {
        if (options?.storages?.includes('serviceworkers')) {
          calls.serviceWorker.push(partition);
        }
      },
    })) as unknown as typeof session.fromPartition;
    Date.now = () => originalNow() + shift;
    try {
      run();
    } finally {
      session.fromPartition = originalFromPartition;
      Date.now = originalNow;
    }
    calls.code.sort();
    calls.http.sort();
    calls.serviceWorker.sort();
    return calls;
  }, offsetMs);
}

/** Emit the macOS memory-pressure event with the clock shifted so every tracked account is idle. */
function emitPressure(app: LaunchedElectronApp, offsetMs: number): Promise<void> {
  return app.evaluate(({ app: electronApp }, shift) => {
    const originalNow = Date.now;
    Date.now = () => originalNow() + shift;
    try {
      (electronApp as unknown as NodeJS.EventEmitter).emit('memory-pressure');
    } finally {
      Date.now = originalNow;
    }
  }, offsetMs);
}

function radioState(app: LaunchedElectronApp): Promise<RadioState | null> {
  return app.evaluate(
    ({ Menu }, labels) => {
      const preferences = Menu.getApplicationMenu()?.items.find(
        (item) => item.label === 'Preferences'
      );
      const group = preferences?.submenu?.items.find(
        (item) => item.label === 'Session Maintenance'
      );
      const radios = group?.submenu?.items ?? [];
      if (radios.length === 0) return null;
      return {
        default: radios.find((item) => item.label === labels.standard)?.checked,
        conservative: radios.find((item) => item.label === labels.conservative)?.checked,
      };
    },
    { standard: DEFAULT_LABEL, conservative: CONSERVATIVE_LABEL }
  );
}

function chooseMode(app: LaunchedElectronApp, label: string): Promise<void> {
  return app.evaluate(
    ({ Menu }, request) => {
      const preferences = Menu.getApplicationMenu()?.items.find(
        (item) => item.label === request.path[0]
      );
      const group = preferences?.submenu?.items.find((item) => item.label === request.path[1]);
      const radio = group?.submenu?.items.find((item) => item.label === request.label);
      if (!radio || !radio.enabled) {
        throw new Error(`session maintenance radio not clickable: ${request.label}`);
      }
      radio.click();
    },
    { path: [...MODE_ITEM], label }
  );
}

const BACKENDS: readonly Backend[] = ['browser-window', 'web-contents-view'];

for (const backend of BACKENDS) {
  test.describe(`session maintenance mode (${backend})`, () => {
    test('applies the native choice live, keeps it across restart, and keeps pressure handling', async () => {
      test.setTimeout(240_000);
      const userData = await realpath(
        await mkdtemp(path.join(tmpdir(), `gogchat-maintenance-${backend}-`))
      );
      let app: LaunchedElectronApp | undefined;
      const teardown: string[] = [];

      try {
        seedStoredApp(userData, {
          useWebContentsView: backend === 'web-contents-view',
          autoCheckForUpdates: false,
          autoLaunchAtLogin: false,
          unreadDeltaNotifications: false,
          notificationPermissionRequested: true,
        });
        app = (
          await launchElectronAppWithWindow({
            appPath: APP_PATH,
            cwd: PROJECT_ROOT,
            userDataDir: userData,
            env: launchEnv(),
          })
        ).app;
        await waitForMaintenance(app);
        await createSparseAccounts(app);

        const snapshot = await accounts(app);
        expect(snapshot.backends).toEqual([backend]);
        expect(snapshot.indices).toEqual(expect.arrayContaining([0, ...SPARSE_ACCOUNTS]));
        const partitions = eligible(snapshot);
        expect(partitions).toEqual(
          expect.arrayContaining(SPARSE_ACCOUNTS.map((index) => `persist:account-${index}`))
        );

        // An older store that predates the setting shows the existing behavior.
        expect(await radioState(app)).toEqual({ default: true, conservative: false });

        // Default mode: the HTTP-cache band, then the service-worker band, as before.
        const httpBand = await runTick(app, HTTP_BAND_MS);
        expect(httpBand).toEqual({ code: partitions, http: partitions, serviceWorker: [] });
        const workerBand = await runTick(app, SERVICE_WORKER_BAND_MS);
        expect(workerBand).toEqual({
          code: partitions,
          http: partitions,
          serviceWorker: partitions,
        });

        // Choosing Conservative from the native menu applies on the next tick, no restart.
        await chooseMode(app, CONSERVATIVE_LABEL);
        expect((await radioState(app))?.conservative).toBe(true);
        expect(await runTick(app, SERVICE_WORKER_BAND_MS)).toEqual({
          code: partitions,
          http: [],
          serviceWorker: [],
        });

        // Pressure handling stays armed: idle non-zero accounts dehydrate, account 0 never does.
        await emitPressure(app, PRESSURE_BAND_MS);
        const afterPressure = await accounts(app);
        expect(afterPressure.dehydrated).toEqual(
          afterPressure.indices.filter(
            (index) => index !== 0 && !afterPressure.bootstrap.includes(index)
          )
        );
        expect(afterPressure.dehydrated).toEqual(expect.arrayContaining(SPARSE_ACCOUNTS));
        expect(afterPressure.dehydrated).not.toContain(0);
        expect(await runTick(app, PRESSURE_BAND_MS)).toEqual({
          code: partitions,
          http: [],
          serviceWorker: [],
        });

        // Same profile, new process: the saved selection and the policy are restored.
        const profileDir = await activeUserDataDir(app);
        await quitApp(app);
        app = await relaunchProfile({ appPath: APP_PATH, cwd: PROJECT_ROOT, profileDir });
        await waitForMaintenance(app);
        expect(await radioState(app)).toEqual({ default: false, conservative: true });
        await createSparseAccounts(app);
        const restored = await accounts(app);
        expect(restored.backends).toEqual([backend]);
        const restoredPartitions = eligible(restored);
        expect(await runTick(app, SERVICE_WORKER_BAND_MS)).toEqual({
          code: restoredPartitions,
          http: [],
          serviceWorker: [],
        });

        // Back to Default, still without a restart.
        await chooseMode(app, DEFAULT_LABEL);
        expect(await runTick(app, SERVICE_WORKER_BAND_MS)).toEqual({
          code: restoredPartitions,
          http: restoredPartitions,
          serviceWorker: restoredPartitions,
        });
      } finally {
        if (app) {
          await closeElectronApp(app);
          teardown.push('electron-app-closed');
        }
        await rm(userData, { recursive: true, force: true });
        await rm(`${userData}-a1`, { recursive: true, force: true });
        await rm(`${userData}-a2`, { recursive: true, force: true });
        teardown.push(`userData-removed:${userData}`);
        console.log(JSON.stringify({ backend, teardown }));
      }
    });
  });
}
