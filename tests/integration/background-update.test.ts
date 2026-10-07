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
  type LaunchedElectronApp,
} from '../helpers/electron-test';
import {
  GITHUB_UPDATE_STABLE_URL,
  githubUpdateFixture,
  type GithubUpdateFixtureKind,
} from '../helpers/githubReleaseFixtures';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const APP_PATH = path.join(PROJECT_ROOT, 'lib/main/index.js');
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
        fetchUrls.push(String(input));
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
        return {
          openedUrls,
          snapshots,
          fetchUrls,
          fetchHadAbortSignal,
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
    const userData = await realpath(await mkdtemp(path.join(tmpdir(), 'gogchat-background-update-')));
    let app: LaunchedElectronApp | undefined;
    const teardown: string[] = [];

    try {
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
