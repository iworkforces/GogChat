/**
 * Built-app background update surface.
 *
 * Reuses the manual-update GitHub fixtures. The scheduled tick stays off until
 * the TESTING hook enables `app.autoCheckForUpdates` around one background run.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import Conf from 'conf';

import { schema } from '../../src/main/utils/config/configSchema.js';
import { APP_IDENTITY } from '../../src/shared/appIdentity.js';
import type { StoreType } from '../../src/shared/types/config.js';
import {
  closeElectronApp,
  launchElectronAppWithWindow,
  wrapEvaluateWithGcRetry,
  type LaunchedElectronApp,
} from '../helpers/electron-test';
import {
  GITHUB_UPDATE_STABLE_URL,
  githubUpdateFixture,
  temptingStableRelease,
  type GithubUpdateFixtureKind,
} from '../helpers/githubReleaseFixtures';
import {
  activeUserDataDir,
  launchEnv,
  quitApp,
  relaunchProfile,
  seedStoredApp,
} from '../helpers/profileRestart';
import {
  armNextFetch,
  awaitArmedFetch,
  clickMenu,
  clickUpdateButton,
  closeUpdateWindow,
  fetchCount,
  holdFetches,
  installUpdateProbe,
  menuState,
  openedUrls,
  releaseFetches,
  restoreUpdateProbe,
  setSnoozedUntil,
  settleBackgroundCheck,
  snoozeState,
  startBackgroundCheck,
  updateHooksInstalled,
  updateMenuInstalled,
  updateWindow,
} from '../helpers/updateSnoozeProbe';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const APP_PATH = PROJECT_ROOT;
const FEATURE_CHUNK = path.join(PROJECT_ROOT, 'lib/chunks/appUpdates.js');

const SILENT_KINDS: readonly GithubUpdateFixtureKind[] = [
  'draft-only',
  'prerelease-only',
  'malformed',
  'empty',
  'http-error',
  'timeout',
];

type UpdateWindowSnapshot = {
  phase: string | null;
  kind: string | null;
  message: string | null;
};

type BackgroundProbe = {
  openedUrls: string[];
  snapshots: UpdateWindowSnapshot[];
  fetchUrls: string[];
  fetchHadAbortSignal: boolean;
  fetchDelayMs: number | null;
  settled: boolean;
};

async function seedAutoCheckDisabled(userDataDir: string): Promise<void> {
  for (const attempt of [1, 2]) {
    const cwd = `${userDataDir}-a${attempt}`;
    const encryptionKey = createHash('sha256')
      .update(`${APP_IDENTITY.productName}-${cwd}`)
      .digest('hex');
    const config = new Conf<StoreType>({ cwd, schema, encryptionKey });
    config.set('app.autoCheckForUpdates', false);
    config.set('app.autoLaunchAtLogin', false);
    config.set('app.notificationPermissionRequested', true);
  }
}

async function probeBackground(
  app: LaunchedElectronApp,
  kind: GithubUpdateFixtureKind,
  source: 'hook' | 'timer' = 'hook'
): Promise<BackgroundProbe> {
  return app.evaluate(
    async ({ BrowserWindow, shell }, args) => {
      const hooks = globalThis as typeof globalThis & {
        __gogchatRunBackgroundUpdateCheck?: () => Promise<void>;
        __gogchatSetAutoCheckForUpdates?: (enabled: boolean) => void;
      };
      let run = hooks.__gogchatRunBackgroundUpdateCheck;
      let setAuto = hooks.__gogchatSetAutoCheckForUpdates;
      if (args.source === 'timer' && (typeof run !== 'function' || typeof setAuto !== 'function')) {
        const waitStarted = Date.now();
        while (Date.now() - waitStarted < 20_000) {
          const again = globalThis as typeof hooks;
          run = again.__gogchatRunBackgroundUpdateCheck;
          setAuto = again.__gogchatSetAutoCheckForUpdates;
          if (typeof run === 'function' && typeof setAuto === 'function') {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      if (typeof run !== 'function' || typeof setAuto !== 'function') {
        throw new Error('background update TESTING hooks are not installed');
      }

      const originalFetch = globalThis.fetch;
      const originalOpenExternal = shell.openExternal.bind(shell);
      const fetchUrls: string[] = [];
      const openedUrls: string[] = [];
      let fetchHadAbortSignal = false;
      let fetchedAt = 0;
      const snapshots: UpdateWindowSnapshot[] = [];

      const readUpdateWindow = async (): Promise<UpdateWindowSnapshot | null> => {
        const win = BrowserWindow.getAllWindows().find((candidate) => {
          return (
            !candidate.isDestroyed() &&
            candidate.isVisible() &&
            candidate.getTitle() === 'GogChat Updates'
          );
        });
        if (!win) return null;
        const dom = await win.webContents.executeJavaScript(`({
          phase: document.body?.dataset?.phase ?? null,
          kind: document.body?.dataset?.kind ?? null,
          message: document.getElementById('update-message')?.textContent ?? null,
        })`);
        return {
          phase: dom.phase,
          kind: dom.kind,
          message: dom.message,
        };
      };

      const record = async (): Promise<void> => {
        const snap = await readUpdateWindow();
        if (!snap) return;
        const previous = snapshots[snapshots.length - 1];
        if (!previous || previous.phase !== snap.phase || previous.message !== snap.message) {
          snapshots.push(snap);
        }
      };

      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const isReleaseFetch = url.includes('api.github.com/repos/') && url.includes('/releases');
        if (!isReleaseFetch) {
          return originalFetch(input, init);
        }
        if (fetchedAt === 0) {
          fetchedAt = Date.now();
        }
        fetchUrls.push(url);
        fetchHadAbortSignal = init?.signal instanceof AbortSignal;
        if (args.kind === 'timeout') {
          const signal = init?.signal;
          await new Promise((_resolve, reject) => {
            if (!signal) {
              reject(new Error('background update fetch missing AbortSignal'));
              return;
            }
            const fail = (): void => {
              reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
            };
            if (signal.aborted) {
              fail();
              return;
            }
            signal.addEventListener('abort', fail, { once: true });
          });
        }
        return {
          ok: args.fixture.ok,
          status: args.fixture.status,
          json: async () => args.fixture.body,
        } as Response;
      };

      shell.openExternal = async (url: string) => {
        openedUrls.push(url);
      };

      setAuto(true);
      let rejected = false;
      let finished = false;
      const running =
        args.source === 'timer'
          ? null
          : run()
              .then(() => {
                finished = true;
              })
              .catch(() => {
                rejected = true;
                finished = true;
              });

      const budget = args.source === 'timer' ? 12_000 : args.kind === 'timeout' ? 15_000 : 8_000;
      const started = Date.now();
      try {
        if (args.kind === 'stable') {
          let found = false;
          while (Date.now() - started < budget) {
            await record();
            const latest = snapshots[snapshots.length - 1];
            if (latest?.phase === 'result' && latest.message === 'New release available') {
              found = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          if (found) {
            const win = BrowserWindow.getAllWindows().find((candidate) => {
              return !candidate.isDestroyed() && candidate.getTitle() === 'GogChat Updates';
            });
            if (win) {
              await win.webContents
                .executeJavaScript(
                  'document.getElementById("update-btn-0")?.click() ?? (location.href = "https://gogchat.local/__update_action__/0")'
                )
                .catch(() => undefined);
            }
          }
          if (args.source === 'timer') {
            const openedStarted = Date.now();
            while (Date.now() - openedStarted < 3_000 && openedUrls.length === 0) {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            finished = found && openedUrls.length > 0;
          } else {
            await Promise.race([
              running,
              new Promise<void>((resolve) => {
                setTimeout(resolve, 2_000);
              }),
            ]);
          }
        } else {
          while (Date.now() - started < budget && !finished) {
            await record();
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          const extraStarted = Date.now();
          while (Date.now() - extraStarted < 300) {
            await record();
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        await record();
        const scheduledAt =
          (globalThis as { __gogchatBackgroundCheckScheduledAt?: number })
            .__gogchatBackgroundCheckScheduledAt ?? 0;
        return {
          openedUrls,
          snapshots,
          fetchUrls,
          fetchHadAbortSignal,
          fetchDelayMs: fetchedAt === 0 || scheduledAt === 0 ? null : fetchedAt - scheduledAt,
          settled: finished && !rejected,
        };
      } finally {
        setAuto(false);
        globalThis.fetch = originalFetch;
        shell.openExternal = originalOpenExternal;
        const leftover = BrowserWindow.getAllWindows().find((candidate) => {
          return !candidate.isDestroyed() && candidate.getTitle() === 'GogChat Updates';
        });
        leftover?.close();
      }
    },
    { kind, source, fixture: githubUpdateFixture(kind, GITHUB_UPDATE_STABLE_URL) }
  ) as Promise<BackgroundProbe>;
}

test.describe('background update silence', () => {
  test('opens only the validated stable URL and stays silent for failure fixtures', async () => {
    test.setTimeout(180_000);
    const userData = await realpath(
      await mkdtemp(path.join(tmpdir(), 'gogchat-background-update-'))
    );
    let app: LaunchedElectronApp | undefined;
    const teardown: string[] = [];

    try {
      expect(temptingStableRelease('http-error').html_url).toBe(GITHUB_UPDATE_STABLE_URL);
      expect(temptingStableRelease('timeout').html_url).toBe(GITHUB_UPDATE_STABLE_URL);
      expect(FEATURE_CHUNK.endsWith('lib/chunks/appUpdates.js')).toBe(true);
      const builtFeature = await readFile(FEATURE_CHUNK, 'utf8');
      expect(builtFeature.includes('AbortSignal.timeout')).toBe(true);
      expect(builtFeature.includes('__gogchatRunBackgroundUpdateCheck')).toBe(true);
      expect(builtFeature.includes('electron-update-notifier')).toBe(false);
      expect(builtFeature).toMatch(/5e3,\s*"appUpdates-initial-check"/);
      expect(builtFeature).toMatch(/864e5,\s*"appUpdates-daily-check"/);

      await seedAutoCheckDisabled(userData);
      const launched = await launchElectronAppWithWindow({
        appPath: APP_PATH,
        cwd: PROJECT_ROOT,
        userDataDir: userData,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          TESTING: 'true',
          GOGCHAT_DISABLE_PRECONNECT: '1',
        },
      });
      app = launched.app;

      const stable = await probeBackground(app, 'stable', 'timer');
      expect(stable.settled).toBe(true);
      expect(stable.fetchDelayMs).not.toBeNull();
      expect(stable.fetchDelayMs ?? 0).toBeGreaterThanOrEqual(4_500);
      expect(stable.fetchHadAbortSignal).toBe(true);
      expect(
        stable.fetchUrls.some((url) =>
          url.includes('api.github.com/repos/iworkforces/GogChat/releases')
        )
      ).toBe(true);
      expect(stable.snapshots.some((snap) => snap.phase === 'checking')).toBe(false);
      expect(stable.snapshots.some((snap) => snap.message === 'New release available')).toBe(true);
      expect(stable.openedUrls).toEqual([GITHUB_UPDATE_STABLE_URL]);

      for (const kind of SILENT_KINDS) {
        const result = await probeBackground(app, kind);
        expect(result.settled, kind).toBe(true);
        expect(result.openedUrls, kind).toEqual([]);
        expect(result.snapshots, kind).toEqual([]);
        expect(
          result.fetchUrls.some((url) =>
            url.includes('api.github.com/repos/iworkforces/GogChat/releases')
          ),
          kind
        ).toBe(true);
        expect(result.fetchHadAbortSignal, kind).toBe(true);
      }

      const again = await probeBackground(app, 'stable');
      expect(again.settled).toBe(true);
      expect(again.snapshots.some((snap) => snap.phase === 'checking')).toBe(false);
      expect(again.snapshots.some((snap) => snap.message === 'New release available')).toBe(true);
      expect(again.openedUrls).toEqual([GITHUB_UPDATE_STABLE_URL]);
    } finally {
      if (app) {
        await closeElectronApp(app);
        teardown.push('electron-app-closed');
      }
      await rm(userData, { recursive: true, force: true });
      await rm(`${userData}-a1`, { recursive: true, force: true });
      await rm(`${userData}-a2`, { recursive: true, force: true });
      teardown.push(`userData-removed:${userData}`);
      console.log(JSON.stringify({ teardown }));
    }
  });
});

const DAY_MS = 86_400_000;
const SNOOZE_ITEM = ['Preferences', 'Snooze Update Prompts for 24 Hours'] as const;
const RESUME_ITEM = ['Preferences', 'Resume Update Prompts'] as const;

async function waitForUpdateSurface(app: LaunchedElectronApp): Promise<void> {
  wrapEvaluateWithGcRetry(app);
  await expect.poll(() => updateHooksInstalled(app), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => updateMenuInstalled(app), { timeout: 30_000 }).toBe(true);
}

async function promptMessage(app: LaunchedElectronApp): Promise<string | null> {
  return (await updateWindow(app))?.message ?? null;
}

async function takeDownload(app: LaunchedElectronApp, expectedOpens: string[]): Promise<void> {
  await expect.poll(() => promptMessage(app), { timeout: 15_000 }).toBe('New release available');
  await clickUpdateButton(app, 0);
  await expect.poll(() => openedUrls(app), { timeout: 15_000 }).toEqual(expectedOpens);
  await closeUpdateWindow(app);
}

test.describe('background update snooze', () => {
  test('is controlled from the native menu, survives a restart, expires, and wins races', async () => {
    test.setTimeout(240_000);
    const userData = await realpath(await mkdtemp(path.join(tmpdir(), 'gogchat-update-snooze-')));
    const stableFixture = githubUpdateFixture('stable', GITHUB_UPDATE_STABLE_URL);
    const seededDeadline = Date.now() + DAY_MS;
    let app: LaunchedElectronApp | undefined;
    const teardown: string[] = [];

    try {
      seedStoredApp(userData, {
        autoLaunchAtLogin: false,
        notificationPermissionRequested: true,
        updateSnoozedUntil: seededDeadline,
      });
      app = (
        await launchElectronAppWithWindow({
          appPath: APP_PATH,
          cwd: PROJECT_ROOT,
          userDataDir: userData,
          env: launchEnv(),
        })
      ).app;
      await waitForUpdateSurface(app);
      await installUpdateProbe(app, stableFixture);

      // A future deadline in the store is restored with one armed timer; auto-check stays on.
      expect(await snoozeState(app)).toEqual({
        deadline: seededDeadline,
        active: true,
        timerArmed: true,
      });
      expect(await menuState(app)).toEqual({
        snoozeEnabled: false,
        resumeEnabled: true,
        autoCheckChecked: true,
        checkForUpdatesEnabled: true,
      });
      await startBackgroundCheck(app);
      await settleBackgroundCheck(app);
      expect(await fetchCount(app)).toBe(0);
      expect(await updateWindow(app)).toBeNull();

      // Early resume from the native menu offers exactly one check.
      await armNextFetch(app);
      await clickMenu(app, RESUME_ITEM);
      await awaitArmedFetch(app);
      await takeDownload(app, [GITHUB_UPDATE_STABLE_URL]);
      expect(await fetchCount(app)).toBe(1);
      expect(await snoozeState(app)).toEqual({ deadline: 0, active: false, timerArmed: false });
      expect(await menuState(app)).toMatchObject({
        snoozeEnabled: true,
        resumeEnabled: false,
        autoCheckChecked: true,
      });

      // Snooze from the native menu stores wall time plus 24 hours and arms the timer.
      const clicked = await clickMenu(app, SNOOZE_ITEM);
      const snoozed = await snoozeState(app);
      expect(snoozed.active).toBe(true);
      expect(snoozed.timerArmed).toBe(true);
      expect(snoozed.deadline - DAY_MS).toBeGreaterThanOrEqual(clicked.before);
      expect(snoozed.deadline - DAY_MS).toBeLessThanOrEqual(clicked.after);
      expect(await menuState(app)).toMatchObject({
        snoozeEnabled: false,
        resumeEnabled: true,
        autoCheckChecked: true,
      });

      // The same profile restarts snoozed: restored deadline, armed timer, suppressed check.
      const profileDir = await activeUserDataDir(app);
      await quitApp(app);
      app = await relaunchProfile({ appPath: APP_PATH, cwd: PROJECT_ROOT, profileDir });
      await waitForUpdateSurface(app);
      await installUpdateProbe(app, stableFixture);
      expect(await snoozeState(app)).toEqual({
        deadline: snoozed.deadline,
        active: true,
        timerArmed: true,
      });
      expect(await menuState(app)).toMatchObject({
        snoozeEnabled: false,
        resumeEnabled: true,
        autoCheckChecked: true,
      });
      await startBackgroundCheck(app);
      await settleBackgroundCheck(app);
      expect(await fetchCount(app)).toBe(0);

      // A short deadline expires through the real timer and offers one check; the menu follows.
      await armNextFetch(app);
      const shortDeadline = Date.now() + 3_000;
      expect(await setSnoozedUntil(app, shortDeadline)).toBe(true);
      expect(await snoozeState(app)).toEqual({
        deadline: shortDeadline,
        active: true,
        timerArmed: true,
      });
      await awaitArmedFetch(app);
      await takeDownload(app, [GITHUB_UPDATE_STABLE_URL]);
      expect(await fetchCount(app)).toBe(1);
      expect(await snoozeState(app)).toMatchObject({ active: false, timerArmed: false });
      await expect
        .poll(() => menuState(app), { timeout: 15_000 })
        .toMatchObject({ snoozeEnabled: true, resumeEnabled: false, autoCheckChecked: true });

      // Snooze then resume while a fetch is in flight: the old fetch never prompts and
      // the resume's own offer is not queued behind the held session gate.
      await holdFetches(app);
      await armNextFetch(app);
      await startBackgroundCheck(app);
      await awaitArmedFetch(app);
      await clickMenu(app, SNOOZE_ITEM);
      await clickMenu(app, RESUME_ITEM);
      await releaseFetches(app);
      await settleBackgroundCheck(app);
      expect(await updateWindow(app)).toBeNull();
      expect(await openedUrls(app)).toEqual([GITHUB_UPDATE_STABLE_URL]);
      expect(await fetchCount(app)).toBe(2);
      expect(await snoozeState(app)).toEqual({ deadline: 0, active: false, timerArmed: false });
      await restoreUpdateProbe(app);
    } finally {
      if (app) {
        await closeElectronApp(app);
        teardown.push('electron-app-closed');
      }
      await rm(userData, { recursive: true, force: true });
      await rm(`${userData}-a1`, { recursive: true, force: true });
      await rm(`${userData}-a2`, { recursive: true, force: true });
      teardown.push(`userData-removed:${userData}`);
      console.log(JSON.stringify({ teardown }));
    }
  });
});
