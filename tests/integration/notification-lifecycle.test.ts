import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Conf from 'conf';
import { schema } from '../../src/main/utils/config/configSchema.js';
import { APP_IDENTITY } from '../../src/shared/appIdentity.js';
import { asAccountIndex } from '../../src/shared/types/branded.js';
import type { StoreType } from '../../src/shared/types/config.js';
import type { AccountBackendKind } from '../../src/shared/types/window.js';
import {
  closeElectronApp,
  expect,
  launchElectronAppWithWindow,
  test,
  wrapEvaluateWithGcRetry,
} from '../helpers/electron-test.js';
import type { LaunchedElectronApp } from '../helpers/electron-test.js';
import { exerciseNotificationLifecycle } from '../helpers/notificationLifecycleProbe.js';

const projectRoot = join(import.meta.dirname, '../..');
const harnessUrl = pathToFileURL(join(projectRoot, 'tests/fixtures/electron-harness.html')).href;
const backends: readonly AccountBackendKind[] = ['browser-window', 'web-contents-view'];

for (const backend of backends) {
  test(`notification document lifecycle and sender routing (${backend}, simulated OS callbacks)`, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'gogchat-notification-')));
    let app: LaunchedElectronApp | undefined;
    try {
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
      }
      const env = {
        ...process.env,
        TESTING: 'true',
        NODE_ENV: 'test',
        CI: 'true',
        GOGCHAT_DISABLE_PRECONNECT: '1',
        GOGCHAT_TEST_APP_URL: harnessUrl,
      };
      Reflect.deleteProperty(env, 'GOGCHAT_TEST_HANG_SHUTDOWN');
      ({ app } = await launchElectronAppWithWindow({
        appPath: projectRoot,
        cwd: projectRoot,
        userDataDir: directory,
        env,
      }));
      wrapEvaluateWithGcRetry(app);
      const evidence = await exerciseNotificationLifecycle(app, {
        backend,
        url: harnessUrl,
        indices: [asAccountIndex(0), asAccountIndex(2)],
      });
      expect(evidence.backendKinds).toEqual([backend, backend]);
      expect(evidence.firstEvents).toEqual(['old:close', 'replacement:click']);
      expect(evidence.secondEvents).toEqual(['other-account:click']);
      expect(evidence.afterClose).toEqual(['other-account:click', 'other-account:close']);
      expect(evidence.focuses).toEqual([2, 0]);
      expect(evidence.closes).toEqual([
        'old',
        'other-account',
        'replacement',
        'throwing-close',
        'before-navigation',
      ]);
      expect(evidence.survivingSender).toBe(true);
      expect(evidence.afterNavigation).toEqual([]);
      expect(evidence.staleNavigationFocused).toBe(false);
      await test.info().attach('notification-lifecycle-simulated-native', {
        body: JSON.stringify(evidence, null, 2),
        contentType: 'application/json',
      });
    } finally {
      try {
        if (app) await closeElectronApp(app);
      } finally {
        await Promise.all(
          [directory, `${directory}-a1`, `${directory}-a2`].map((path) =>
            rm(path, { recursive: true, force: true })
          )
        );
      }
    }
  });
}
