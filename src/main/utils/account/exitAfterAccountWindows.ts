/**
 * Flush live account-window bounds, then end the process.
 *
 * File Quit and Relaunch call `app.exit()`. That does not emit
 * `before-quit`, so the shutdown stage never reads the open windows. The
 * 500ms move/resize timer would otherwise die with the process.
 *
 * @module exitAfterAccountWindows
 */

import { app } from 'electron';

/** Same budget as one shutdown stage. A stuck write must not block quitting. */
const PERSIST_BEFORE_EXIT_MS = 2_000;

/**
 * Read every watched window now and wait for the accountWindows queue.
 * Resolves after the flush, or after {@link PERSIST_BEFORE_EXIT_MS}.
 */
export function persistAccountWindowsBeforeExit(): Promise<void> {
  const run = (async () => {
    const { captureWatchedAccountWindows, flushAccountWindowsWrites } =
      await import('./accountWindowsStore.js');
    captureWatchedAccountWindows();
    await flushAccountWindowsWrites();
  })();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, PERSIST_BEFORE_EXIT_MS);
    const finish = (): void => {
      clearTimeout(timer);
      resolve();
    };
    void run.then(finish, finish);
  });
}

/** Persist, then `app.exit()`. Menu Quit uses this. */
export async function exitAppAfterSavingWindows(): Promise<void> {
  await persistAccountWindowsBeforeExit();
  app.exit();
}
