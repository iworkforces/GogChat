import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Conf from 'conf';
import type { Page } from '@playwright/test';
import { schema } from '../../src/main/utils/config/configSchema.js';
import { APP_IDENTITY } from '../../src/shared/appIdentity.js';
import { IPC_CHANNELS } from '../../src/shared/constants.js';
import { asType } from '../../src/shared/typeUtils.js';
import type { StoreType } from '../../src/shared/types/config.js';
import type { IPCLatencySample } from '../../src/main/utils/lifecycle/performanceTypes.js';
import type { getPerformanceMonitor } from '../../src/main/utils/lifecycle/performanceMonitor.js';
import {
  test,
  expect,
  launchElectronAppWithWindow,
  closeElectronApp,
  wrapEvaluateWithGcRetry,
} from '../helpers/electron-test.js';

test('built bridge calls record real defineIPC and fast handler samples in main', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'gogchat-ipc-latency-')));
  for (const attempt of [1, 2]) {
    const cwd = `${directory}-a${attempt}`;
    const encryptionKey = createHash('sha256')
      .update(`${APP_IDENTITY.productName}-${cwd}`)
      .digest('hex');
    const config = new Conf<StoreType>({ cwd, schema, encryptionKey });
    config.set('app.autoCheckForUpdates', false);
    config.set('app.autoLaunchAtLogin', false);
    config.set('app.notificationPermissionRequested', true);
  }
  let launched: Awaited<ReturnType<typeof launchElectronAppWithWindow>> | undefined;
  try {
    launched = await launchElectronAppWithWindow({
      appPath: join(import.meta.dirname, '../..'),
      cwd: join(import.meta.dirname, '../..'),
      userDataDir: directory,
      env: {
        ...process.env,
        TESTING: 'true',
        NODE_ENV: 'test',
        CI: 'true',
        GOGCHAT_DISABLE_PRECONNECT: '1',
        GOGCHAT_TEST_HANG_SHUTDOWN: undefined,
      },
    });
    const { app } = launched;
    const window = asType<Page>(await app.firstWindow({ timeout: 15_000 }));
    wrapEvaluateWithGcRetry(app);
    await expect
      .poll(() =>
        app.evaluate(() => typeof Reflect.get(globalThis, '__gogchatIPCPerformance') === 'function')
      )
      .toBe(true);
    await window.waitForFunction(
      () =>
        typeof window.gogchat?.checkIfOnline === 'function' &&
        typeof window.gogchat?.sendUnreadCount === 'function',
      undefined,
      { timeout: 15_000 }
    );
    await app.evaluate(() => {
      globalThis.fetch = async () => new Response(null, { status: 503 });
    });
    const readSamples = async () =>
      asType<IPCLatencySample[]>(
        await app.evaluate(() => {
          const getMonitor: typeof getPerformanceMonitor = Reflect.get(
            globalThis,
            '__gogchatIPCPerformance'
          );
          return getMonitor().getIpcLatencySamples();
        })
      );
    const before = await readSamples();
    await window.evaluate(() => {
      window.gogchat.checkIfOnline('p3-built-handler');
      window.gogchat.sendUnreadCount(7);
    });
    for (const [channel, kind] of [
      [IPC_CHANNELS.CHECK_IF_ONLINE, 'on'],
      [IPC_CHANNELS.UNREAD_COUNT, 'fast'],
    ] as const) {
      const countBefore = before.filter((sample) => sample.channel === channel).length;
      await expect
        .poll(
          async () => (await readSamples()).filter((sample) => sample.channel === channel).length
        )
        .toBe(countBefore + 1);
      const recorded = (await readSamples()).filter((sample) => sample.channel === channel).at(-1);
      expect(recorded).toMatchObject({ channel, kind, accountIndex: 0 });
      expect(Number.isFinite(recorded?.durationMs)).toBe(true);
      expect(recorded?.durationMs).toBeGreaterThanOrEqual(0);
    }
  } finally {
    if (launched) await closeElectronApp(launched.app);
    await Promise.all(
      [directory, `${directory}-a1`, `${directory}-a2`].map((path) =>
        rm(path, { recursive: true, force: true })
      )
    );
  }
});
