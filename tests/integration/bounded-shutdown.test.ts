/**
 * Process-level proof that a hung cleanup cannot stall quit past 8s.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron, type ElectronApplication, type TestInfo } from '@playwright/test';
import { closeElectronApp, expect, test } from '../helpers/electron-test';

const OVERALL_MS = 8_000;
const HARNESS_SLACK_MS = 2_000;
const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');

async function removeHarness(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

async function observeExit(app: ElectronApplication, quit: () => void): Promise<number | null> {
  const child = app.process();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  try {
    quit();
    return await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('process did not exit within shutdown ceiling plus slack')),
          OVERALL_MS + HARNESS_SLACK_MS
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test.describe('bounded shutdown', () => {
  test.describe('normal launch', () => {
    test.use({
      appPath: PROJECT_ROOT,
      extraElectronEnv: { GOGCHAT_TEST_HANG_SHUTDOWN: 'feature' },
    });

    test('exits the Electron child when a cleanup never settles', async ({
      electronApp,
    }: {
      electronApp: ElectronApplication;
    }) => {
      const started = Date.now();
      const code = await observeExit(electronApp, () => {
        void electronApp.evaluate(({ app }) => app.quit()).catch(() => undefined);
      });
      expect(Date.now() - started).toBeLessThanOrEqual(OVERALL_MS + HARNESS_SLACK_MS);
      expect(code).toBe(0);
    });
  });

  for (const settlement of ['held', 'resumed'] as const) {
    test(`normal pre-window quit is bounded with an admitted ${settlement} initializer`, async ({
      appPath,
    }: { appPath: string }, testInfo: TestInfo) => {
      const root = await mkdtemp(path.join(tmpdir(), 'gogchat-bounded-startup-'));
      const entry = path.join(root, 'entry.mjs');
      const evidencePath = path.join(root, 'startup.json');
      let app: ElectronApplication | undefined;
      const output: string[] = [];
      try {
        await writeFile(
          entry,
          `
import { app, BrowserWindow } from 'electron';
import { registerHooks } from 'node:module';
import { writeFileSync } from 'node:fs';
const evidence = { admitted: false, beforeQuit: false, resumed: false, windowsAtQuit: null, windowsCreated: 0, quitAt: null };
const save = () => writeFileSync(${JSON.stringify(evidencePath)}, JSON.stringify(evidence));
let releaseInitializer;
globalThis.__boundedEnter = (resolve) => { releaseInitializer = resolve; evidence.admitted = true; save(); };
save();
app.on('browser-window-created', () => { evidence.windowsCreated += 1; save(); });
app.on('before-quit', () => {
  evidence.beforeQuit = true;
  evidence.windowsAtQuit = BrowserWindow.getAllWindows().length;
  evidence.quitAt = Date.now();
  ${settlement === 'resumed' ? 'evidence.resumed = true; releaseInitializer();' : ''}
  save();
});
registerHooks({ load(url, context, nextLoad) {
  if (new URL(url).pathname.endsWith('/reportExceptions.js')) {
    const original = nextLoad(url, context);
    return { ...original, shortCircuit: true, source:
      'await new Promise((resolve) => globalThis.__boundedEnter(resolve));\\n' + Buffer.from(original.source).toString('utf8') };
  }
  return nextLoad(url, context);
} });
await import(${JSON.stringify(pathToFileURL(appPath).href)});
`
        );
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          TESTING: 'true',
          NODE_ENV: 'test',
          GOGCHAT_DISABLE_PRECONNECT: '1',
          GOGCHAT_TEST_APP_URL: pathToFileURL(
            path.join(PROJECT_ROOT, 'tests/fixtures/electron-harness.html')
          ).href,
        };
        delete env['GOGCHAT_TEST_HANG_SHUTDOWN'];
        app = await _electron.launch({
          args: [entry, `--user-data-dir=${path.join(root, 'profile')}`],
          cwd: PROJECT_ROOT,
          env,
          timeout: 20_000,
        });
        const child = app.process();
        child.stdout?.on('data', (data: Buffer) => output.push(data.toString()));
        child.stderr?.on('data', (data: Buffer) => output.push(data.toString()));
        await expect
          .poll(async () => JSON.parse(await readFile(evidencePath, 'utf8')).admitted, {
            timeout: 5_000,
          })
          .toBe(true);
        const electronApp = app;
        const code = await observeExit(app, () => {
          void electronApp.evaluate(({ app }) => app.quit()).catch(() => undefined);
        });
        const evidence: {
          admitted: boolean;
          beforeQuit: boolean;
          resumed: boolean;
          windowsAtQuit: number;
          windowsCreated: number;
          quitAt: number;
        } = JSON.parse(await readFile(evidencePath, 'utf8'));
        await testInfo.attach('startup-shutdown', {
          body: JSON.stringify({
            ...evidence,
            exitCode: code,
            elapsedMs: Date.now() - evidence.quitAt,
          }),
          contentType: 'application/json',
        });
        expect(evidence.admitted).toBe(true);
        expect(evidence.beforeQuit).toBe(true);
        expect(evidence.windowsAtQuit).toBe(0);
        expect(evidence.windowsCreated).toBe(0);
        expect(evidence.resumed).toBe(settlement === 'resumed');
        if (settlement === 'held')
          expect(Date.now() - evidence.quitAt).toBeGreaterThanOrEqual(2_000);
        expect(Date.now() - evidence.quitAt).toBeLessThanOrEqual(OVERALL_MS + HARNESS_SLACK_MS);
        expect(code).toBe(0);
      } finally {
        await testInfo.attach('electron-output', {
          body: output.join(''),
          contentType: 'text/plain',
        });
        if (app) await closeElectronApp(app);
        await removeHarness(root);
      }
    });
  }
});
