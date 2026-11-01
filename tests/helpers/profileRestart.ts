/**
 * Quit and relaunch one Electron profile, and seed the encrypted store of a
 * profile that predates a setting. Shared by the built-app update-snooze and
 * session-maintenance cases.
 */

import { createHash } from 'node:crypto';
import { _electron as electron } from '@playwright/test';
import Conf from 'conf';
import { APP_IDENTITY } from '../../src/shared/appIdentity.js';
import {
  closeElectronApp,
  ELECTRON_FIRST_WINDOW_TIMEOUT_MS,
  electronHarnessFileUrl,
  peekElectronChildProcess,
  wrapEvaluateWithGcRetry,
} from './electron-test.js';
import type { LaunchedElectronApp } from './electron-test.js';

const QUIT_CEILING_MS = 15_000;

/**
 * Write `app` verbatim into both launch-attempt profiles. The store is opened
 * without the product schema, so keys the caller omits stay absent and the
 * app meets them exactly like an install that predates them.
 */
export function seedStoredApp(userDataDir: string, app: Record<string, unknown>): void {
  for (const attempt of [1, 2]) {
    const cwd = `${userDataDir}-a${attempt}`;
    const encryptionKey = createHash('sha256')
      .update(`${APP_IDENTITY.productName}-${cwd}`)
      .digest('hex');
    new Conf<Record<string, unknown>>({ cwd, encryptionKey }).set('app', app);
  }
}

export function launchEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    TESTING: 'true',
    GOGCHAT_DISABLE_PRECONNECT: '1',
    GOGCHAT_TEST_APP_URL: electronHarnessFileUrl(),
  };
  delete env['GOGCHAT_TEST_HANG_SHUTDOWN'];
  return env;
}

/** The profile directory the running app actually opened (attempt suffix included). */
export async function activeUserDataDir(app: LaunchedElectronApp): Promise<string> {
  return (await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))) as string;
}

/** Quit through `app.quit()` and wait for the child to exit; kill only if the wait is exceeded. */
export async function quitApp(app: LaunchedElectronApp): Promise<void> {
  const child = peekElectronChildProcess(app);
  if (!child) {
    throw new Error('Electron child process is unavailable');
  }
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
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, QUIT_CEILING_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await closeElectronApp(app);
  }
}

/** Launch the exact directory an earlier run used; the shared helper would pick a fresh suffix. */
export async function relaunchProfile(options: {
  appPath: string;
  cwd: string;
  profileDir: string;
}): Promise<LaunchedElectronApp> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    let app: LaunchedElectronApp | undefined;
    try {
      app = await electron.launch({
        cwd: options.cwd,
        args: [options.appPath, `--user-data-dir=${options.profileDir}`],
        env: launchEnv(),
        timeout: 45_000,
      });
      await app.firstWindow({ timeout: ELECTRON_FIRST_WINDOW_TIMEOUT_MS });
      wrapEvaluateWithGcRetry(app);
      return app;
    } catch (error) {
      lastError = error;
      if (app) {
        await closeElectronApp(app);
      }
    }
  }
  throw new Error(`relaunch failed for ${options.profileDir}: ${String(lastError)}`);
}
