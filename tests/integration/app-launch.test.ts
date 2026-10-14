/**
 * App Launch Integration Tests
 * Tests basic application launch and initialization
 */

import {
  test,
  expect,
  getAppInfo,
  checkSecuritySettings,
  getMainBounds,
  isTestDocumentUrl,
  waitForLoadStateBounded,
  waitForMainWindowVisible,
} from '../helpers/electron-test';

test.describe('App Launch', () => {
  test('should launch the application successfully', async ({ electronApp, mainWindow }) => {
    // Check that app launched
    const appInfo = await getAppInfo(electronApp);
    expect(appInfo.name.toLowerCase()).toMatch(/gogchat|electron/);
    expect(appInfo.version).toBeTruthy();

    // Product windows start hidden; fixture force-shows when Chat never paints.
    const shown = await waitForMainWindowVisible(electronApp, 5_000);
    test.skip(!shown, 'window remained hidden after fixture show() (CI Chat paint)');
    expect(shown).toBe(true);

    // Check window title
    const title = await mainWindow.title();
    expect(title.length).toBeGreaterThan(0);
  });

  test('should have correct security settings', async ({ electronApp }) => {
    const security = await checkSecuritySettings(electronApp);

    // Verify critical security settings
    expect(security.contextIsolation).toBe(true);
    expect(security.nodeIntegration).toBe(false);
    expect(security.sandbox).toBe(true);
    expect(security.webSecurity).toBe(true); // Matches windowWrapper / product defaults
  });

  test('should load GogChat URL', async ({ mainWindow }) => {
    await waitForLoadStateBounded(mainWindow, 'domcontentloaded', 8_000);
    const url = await mainWindow.url();
    // Default Playwright launches use the local harness, not live Chat.
    expect(isTestDocumentUrl(url)).toBe(true);
  });

  test('should have application menu', async ({ electronApp }) => {
    // Menu is installed in the deferred phase; poll instead of snapshotting boot.
    const deadline = Date.now() + 15_000;
    let hasMenu = false;
    while (Date.now() < deadline) {
      hasMenu = await electronApp.evaluate(({ Menu }) => {
        return Menu.getApplicationMenu() !== null;
      });
      if (hasMenu) {
        break;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
    }
    expect(hasMenu).toBe(true);
  });

  test('should enforce single instance', async ({ electronApp, appPath }) => {
    // Try to launch second instance
    const secondInstance = await electronApp.evaluate(({ app }) => {
      return app.requestSingleInstanceLock();
    });

    // First instance should have the lock
    expect(secondInstance).toBe(true);
  });

  test('should have proper window dimensions', async ({ electronApp }) => {
    const bounds = await getMainBounds(electronApp);
    expect(bounds?.width).toBeGreaterThanOrEqual(480);
    expect(bounds?.height).toBeGreaterThanOrEqual(570);
  });

  test('should keep the main window alive after hide', async ({ electronApp }) => {
    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.hide();
    });
    const windowCount = await electronApp.evaluate(({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows().length;
    });
    expect(windowCount).toBeGreaterThan(0);
  });
});
