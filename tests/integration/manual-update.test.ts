/**
 * Built-app manual update surface.
 *
 * Owns its Electron launch so main-process fetch can be replaced with a local
 * fixture, a temp userData directory can be removed, and no public GitHub
 * network access is required.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import {
  closeElectronApp,
  launchElectronAppWithWindow,
  type LaunchedElectronApp,
} from '../helpers/electron-test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const APP_PATH = path.join(PROJECT_ROOT, 'lib/main/index.js');
const FEATURE_CHUNK = path.join(PROJECT_ROOT, 'lib/chunks/appUpdates.js');

const STABLE_URL = 'https://github.com/iworkforces/GogChat/releases/tag/v99.0.0';

type FixtureKind =
  'stable' | 'draft-only' | 'prerelease-only' | 'malformed' | 'empty' | 'http-error' | 'timeout';

type UpdateWindowSnapshot = {
  title: string;
  visible: boolean;
  phase: string | null;
  kind: string | null;
  message: string | null;
};

type ManualUpdateProbe = {
  importedExportNames: string[];
  invokedVia: 'named-export' | 'test-hook' | 'menu';
  openedUrls: string[];
  snapshots: UpdateWindowSnapshot[];
  fetchUrls: string[];
  fetchHadAbortSignal: boolean;
};

async function probeManualUpdate(
  app: LaunchedElectronApp,
  kind: FixtureKind
): Promise<ManualUpdateProbe> {
  return app.evaluate(
    async ({ BrowserWindow, Menu, shell }, args) => {
      const findUpdateItem = (
        items: Array<{ label?: string; click?: () => void; submenu?: { items: unknown[] } }>
      ): { click: () => void } | undefined => {
        for (const item of items) {
          if (item.label === 'Check For Updates' && item.click) {
            return { click: item.click };
          }
          const submenu = item.submenu;
          if (submenu && Array.isArray(submenu.items)) {
            const found = findUpdateItem(
              submenu.items as Array<{
                label?: string;
                click?: () => void;
                submenu?: { items: unknown[] };
              }>
            );
            if (found) return found;
          }
        }
        return undefined;
      };

      const originalFetch = globalThis.fetch;
      const originalOpenExternal = shell.openExternal.bind(shell);
      const fetchUrls: string[] = [];
      const openedUrls: string[] = [];
      let fetchHadAbortSignal = false;

      const fixtureFor = (
        fixtureKind: typeof args.kind
      ): { ok: boolean; status: number; body: unknown } => {
        if (fixtureKind === 'malformed') {
          return { ok: true, status: 200, body: { not: 'an-array' } };
        }
        if (fixtureKind === 'empty') {
          return { ok: true, status: 200, body: [] };
        }
        if (fixtureKind === 'http-error') {
          return { ok: false, status: 503, body: null };
        }
        if (fixtureKind === 'draft-only') {
          return {
            ok: true,
            status: 200,
            body: [
              {
                tag_name: 'v99.0.0',
                html_url: args.stableUrl,
                draft: true,
                prerelease: false,
              },
            ],
          };
        }
        if (fixtureKind === 'prerelease-only') {
          return {
            ok: true,
            status: 200,
            body: [
              {
                tag_name: 'v99.0.0',
                html_url: args.stableUrl,
                draft: false,
                prerelease: true,
              },
            ],
          };
        }
        return {
          ok: true,
          status: 200,
          body: [
            {
              tag_name: 'v98.0.0-draft',
              html_url: 'https://github.com/iworkforces/GogChat/releases/tag/v98.0.0-draft',
              draft: true,
              prerelease: false,
            },
            {
              tag_name: 'v98.0.0-rc.1',
              html_url: 'https://github.com/iworkforces/GogChat/releases/tag/v98.0.0-rc.1',
              draft: false,
              prerelease: true,
            },
            {
              tag_name: 'v99.0.0',
              html_url: args.stableUrl,
              body: 'Local fixture notes',
              draft: false,
              prerelease: false,
            },
          ],
        };
      };

      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchUrls.push(url);
        fetchHadAbortSignal = init?.signal instanceof AbortSignal;
        if (args.kind === 'timeout') {
          const signal = init?.signal;
          await new Promise((_resolve, reject) => {
            if (!signal) {
              reject(new Error('manual update fetch missing AbortSignal'));
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
        const fixture = fixtureFor(args.kind);
        return {
          ok: fixture.ok,
          status: fixture.status,
          json: async () => fixture.body,
        } as Response;
      };

      shell.openExternal = async (url: string) => {
        openedUrls.push(url);
      };

      const snapshots: UpdateWindowSnapshot[] = [];

      const readUpdateWindow = async (): Promise<UpdateWindowSnapshot | null> => {
        const win = BrowserWindow.getAllWindows().find((candidate) => {
          return !candidate.isDestroyed() && candidate.getTitle() === 'GogChat Updates';
        });
        if (!win) return null;
        const dom = await win.webContents.executeJavaScript(`({
        phase: document.body?.dataset?.phase ?? null,
        kind: document.body?.dataset?.kind ?? null,
        message: document.getElementById('update-message')?.textContent ?? null,
      })`);
        return {
          title: win.getTitle(),
          visible: win.isVisible(),
          phase: dom.phase,
          kind: dom.kind,
          message: dom.message,
        };
      };

      const collectUntil = async (
        predicate: (snap: UpdateWindowSnapshot) => boolean,
        timeoutMs: number
      ): Promise<UpdateWindowSnapshot | null> => {
        const started = Date.now();
        let last: UpdateWindowSnapshot | null = null;
        while (Date.now() - started < timeoutMs) {
          const snap = await readUpdateWindow();
          if (snap) {
            const previous = snapshots[snapshots.length - 1];
            if (
              !previous ||
              previous.phase !== snap.phase ||
              previous.message !== snap.message ||
              previous.visible !== snap.visible
            ) {
              snapshots.push(snap);
            }
            last = snap;
            if (predicate(snap)) {
              return snap;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return last;
      };

      const dismissUpdateWindow = (): void => {
        const win = BrowserWindow.getAllWindows().find((candidate) => {
          return !candidate.isDestroyed() && candidate.getTitle() === 'GogChat Updates';
        });
        win?.close();
      };

      const clickDownload = async (): Promise<void> => {
        const win = BrowserWindow.getAllWindows().find((candidate) => {
          return !candidate.isDestroyed() && candidate.getTitle() === 'GogChat Updates';
        });
        if (!win) return;
        await win.webContents
          .executeJavaScript(
            'document.getElementById("update-btn-0")?.click() ?? (location.href = "https://gogchat.local/__update_action__/0")'
          )
          .catch(() => undefined);
      };

      try {
        const importedExportNames = ['lib/chunks/appUpdates.js'];

        const waitStarted = Date.now();
        while (Date.now() - waitStarted < 15_000) {
          const hookedNow = (
            globalThis as typeof globalThis & {
              __gogchatCheckForUpdatesManual?: () => Promise<void>;
            }
          ).__gogchatCheckForUpdatesManual;
          if (typeof hookedNow === 'function') {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        const hooked = (
          globalThis as typeof globalThis & {
            __gogchatCheckForUpdatesManual?: () => Promise<void>;
          }
        ).__gogchatCheckForUpdatesManual;

        let invokedVia: ManualUpdateProbe['invokedVia'] = 'menu';
        const invoke = async (): Promise<void> => {
          if (typeof hooked === 'function') {
            invokedVia = 'test-hook';
            await hooked();
            return;
          }
          invokedVia = 'menu';
          const started = Date.now();
          let item: { click: () => void } | undefined;
          while (Date.now() - started < 15_000) {
            const menu = Menu.getApplicationMenu();
            item = menu ? findUpdateItem(menu.items) : undefined;
            if (item) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          if (!item) {
            throw new Error('Check For Updates menu action was not registered');
          }
          item.click();
        };

        const running = invoke();
        const resultWait = args.kind === 'timeout' ? 15_000 : 8_000;
        const result = await collectUntil((snap) => snap.phase === 'result', resultWait);
        if (result?.message === 'New release available') {
          await clickDownload();
        } else {
          dismissUpdateWindow();
        }
        await Promise.race([
          running.catch(() => undefined),
          new Promise<void>((resolve) => {
            setTimeout(resolve, 2_000);
          }),
        ]);
        const trailing = await readUpdateWindow();
        if (trailing) snapshots.push(trailing);

        return {
          importedExportNames,
          invokedVia,
          openedUrls,
          snapshots,
          fetchUrls,
          fetchHadAbortSignal,
        };
      } finally {
        globalThis.fetch = originalFetch;
        shell.openExternal = originalOpenExternal;
        const leftover = BrowserWindow.getAllWindows().find((candidate) => {
          return !candidate.isDestroyed() && candidate.getTitle() === 'GogChat Updates';
        });
        leftover?.close();
      }
    },
    {
      kind,
      stableUrl: STABLE_URL,
      featureChunk: FEATURE_CHUNK,
      appPath: APP_PATH,
      projectRoot: PROJECT_ROOT,
    }
  );
}

test.describe('manual update liveness', () => {
  test('imports the built feature, bounds fetch, and only opens a validated stable URL', async () => {
    test.setTimeout(180_000);
    const userData = await mkdtemp(path.join(tmpdir(), 'gogchat-manual-update-'));
    let app: LaunchedElectronApp | undefined;
    const teardown: string[] = [];

    try {
      expect(FEATURE_CHUNK.endsWith('lib/chunks/appUpdates.js')).toBe(true);
      const builtFeature = await readFile(FEATURE_CHUNK, 'utf8');
      expect(builtFeature.includes('AbortSignal.timeout')).toBe(true);
      expect(builtFeature.includes('__gogchatCheckForUpdatesManual')).toBe(true);

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
      const hookReady = await app.evaluate(async () => {
        const started = Date.now();
        while (Date.now() - started < 20_000) {
          const hooked = (
            globalThis as typeof globalThis & {
              __gogchatCheckForUpdatesManual?: () => Promise<void>;
            }
          ).__gogchatCheckForUpdatesManual;
          if (typeof hooked === 'function') {
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return false;
      });
      expect(hookReady).toBe(true);

      const stable = await probeManualUpdate(app, 'stable');
      expect(stable.importedExportNames.length).toBeGreaterThan(0);
      expect(stable.fetchUrls.some((url) => url.includes('api.github.com'))).toBe(true);
      expect(stable.fetchHadAbortSignal).toBe(true);
      expect(
        stable.snapshots.some((snap) => snap.phase === 'checking' || snap.phase === 'result')
      ).toBe(true);
      expect(stable.snapshots.some((snap) => snap.message === 'New release available')).toBe(true);
      expect(stable.openedUrls).toEqual([STABLE_URL]);

      const blocked: FixtureKind[] = [
        'draft-only',
        'prerelease-only',
        'malformed',
        'empty',
        'http-error',
      ];
      for (const kind of blocked) {
        const result = await probeManualUpdate(app, kind);
        expect(result.openedUrls, kind).toEqual([]);
        expect(
          result.snapshots.some((snap) => snap.phase === 'result'),
          `${kind} settles a result phase`
        ).toBe(true);
      }

      const timedOut = await probeManualUpdate(app, 'timeout');
      expect(timedOut.fetchHadAbortSignal).toBe(true);
      expect(timedOut.openedUrls).toEqual([]);
      expect(
        timedOut.snapshots.some(
          (snap) =>
            snap.phase === 'result' && (snap.kind === 'error' || snap.message?.includes('Couldn’t'))
        )
      ).toBe(true);

      const again = await probeManualUpdate(app, 'stable');
      expect(
        again.snapshots.some(
          (snap) => snap.phase === 'result' && snap.message === 'New release available'
        )
      ).toBe(true);
      expect(again.openedUrls).toEqual([STABLE_URL]);
    } finally {
      if (app) {
        await closeElectronApp(app);
        teardown.push('electron-app-closed');
      }
      await rm(userData, { recursive: true, force: true });
      teardown.push(`userData-removed:${userData}`);
      console.log(JSON.stringify({ teardown }));
    }
  });
});
