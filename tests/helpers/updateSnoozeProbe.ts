/**
 * Main-process probe for the built-app update-snooze cases.
 *
 * `installUpdateProbe` defines one closure in the ESM main process: a GitHub
 * releases fetch stub that can be held and released, a recording
 * `shell.openExternal`, and native-menu access. The exported functions only
 * call into it, so every wait is a fetch, window, or promise signal.
 */

import type { GithubUpdateFixture } from './githubReleaseFixtures.js';
import type { LaunchedElectronApp } from './electron-test.js';

export interface SnoozeState {
  deadline: number;
  active: boolean;
  timerArmed: boolean;
}

export interface UpdateMenuState {
  snoozeEnabled: boolean;
  resumeEnabled: boolean;
  autoCheckChecked: boolean;
  checkForUpdatesEnabled: boolean;
}

export interface UpdateWindowView {
  phase: string | null;
  message: string | null;
}

interface UpdateProbe {
  fetchUrls: string[];
  openedUrls: string[];
  holding: boolean;
  nextFetch: () => Promise<void>;
  setHolding: (holding: boolean) => void;
  release: () => void;
  startBackground: () => void;
  settleBackground: () => Promise<void>;
  clickMenu: (path: readonly string[]) => { before: number; after: number };
  menuState: () => UpdateMenuState;
  updateWindow: () => Promise<UpdateWindowView | null>;
  clickUpdateButton: (index: number) => Promise<void>;
  closeUpdateWindow: () => void;
  restore: () => void;
}

const PROBE_KEY = '__updateSnoozeProbe';

/** Install the probe once per launch. The fetch stub answers with `fixture` for GitHub release lists only. */
export async function installUpdateProbe(
  app: LaunchedElectronApp,
  fixture: GithubUpdateFixture
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow, Menu, shell }, args) => {
      const key = args.key;
      const originalFetch = globalThis.fetch;
      const originalOpenExternal = shell.openExternal.bind(shell);
      const hooks = globalThis as typeof globalThis & {
        __gogchatRunBackgroundUpdateCheck?: () => Promise<void>;
      };
      const waiters: Array<() => void> = [];
      let gate: Promise<void> | null = null;
      let openGate: (() => void) | null = null;
      let pendingRun: Promise<void> = Promise.resolve();

      const findUpdateWindow = (): Electron.BrowserWindow | undefined =>
        BrowserWindow.getAllWindows().find(
          (candidate) => !candidate.isDestroyed() && candidate.getTitle() === 'GogChat Updates'
        );

      const findItem = (path: readonly string[]): Electron.MenuItem | undefined => {
        let items: Electron.MenuItem[] = Menu.getApplicationMenu()?.items ?? [];
        let found: Electron.MenuItem | undefined;
        for (const label of path) {
          found = items.find((item) => item.label === label);
          items = found?.submenu?.items ?? [];
        }
        return found;
      };

      const probe: UpdateProbe = {
        fetchUrls: [],
        openedUrls: [],
        holding: false,
        nextFetch: () =>
          new Promise<void>((resolve) => {
            waiters.push(resolve);
          }),
        setHolding: (holding) => {
          probe.holding = holding;
          if (holding && !gate) {
            gate = new Promise<void>((resolve) => {
              openGate = resolve;
            });
          }
        },
        release: () => {
          probe.holding = false;
          openGate?.();
          gate = null;
          openGate = null;
        },
        startBackground: () => {
          const run = hooks.__gogchatRunBackgroundUpdateCheck;
          if (typeof run !== 'function') {
            throw new Error('background update TESTING hook is not installed');
          }
          pendingRun = run();
        },
        settleBackground: () => pendingRun,
        clickMenu: (path) => {
          const item = findItem(path);
          if (!item || !item.enabled) {
            throw new Error(`menu item not clickable: ${path.join(' > ')}`);
          }
          const before = Date.now();
          item.click();
          return { before, after: Date.now() };
        },
        menuState: () => ({
          snoozeEnabled:
            findItem(['Preferences', 'Snooze Update Prompts for 24 Hours'])?.enabled === true,
          resumeEnabled: findItem(['Preferences', 'Resume Update Prompts'])?.enabled === true,
          autoCheckChecked: findItem(['Preferences', 'Auto check for Updates'])?.checked === true,
          checkForUpdatesEnabled: findItem(['Help', 'Check For Updates'])?.enabled === true,
        }),
        updateWindow: async () => {
          const win = findUpdateWindow();
          if (!win || !win.isVisible()) return null;
          return win.webContents.executeJavaScript(`({
            phase: document.body?.dataset?.phase ?? null,
            message: document.getElementById('update-message')?.textContent ?? null,
          })`);
        },
        clickUpdateButton: async (index) => {
          await findUpdateWindow()
            ?.webContents.executeJavaScript(
              `document.getElementById("update-btn-${index}")?.click() ?? (location.href = "https://gogchat.local/__update_action__/${index}")`
            )
            .catch(() => undefined);
        },
        closeUpdateWindow: () => {
          findUpdateWindow()?.close();
        },
        restore: () => {
          globalThis.fetch = originalFetch;
          shell.openExternal = originalOpenExternal;
        },
      };

      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (!(url.includes('api.github.com/repos/') && url.includes('/releases'))) {
          return originalFetch(input, init);
        }
        probe.fetchUrls.push(url);
        for (const wake of waiters.splice(0)) wake();
        if (probe.holding && gate) await gate;
        return {
          ok: args.fixture.ok,
          status: args.fixture.status,
          json: async () => args.fixture.body,
        } as Response;
      };
      shell.openExternal = async (url: string) => {
        probe.openedUrls.push(url);
      };

      Reflect.set(globalThis, key, probe);
    },
    { key: PROBE_KEY, fixture }
  );
}

function call<Result>(
  app: LaunchedElectronApp,
  method: keyof UpdateProbe,
  ...args: unknown[]
): Promise<Result> {
  return app.evaluate(
    async (_electron, request) => {
      const probe = Reflect.get(globalThis, request.key) as Record<string, unknown>;
      const target = probe[request.method];
      return typeof target === 'function'
        ? (target as (...values: unknown[]) => unknown).apply(probe, request.args)
        : target;
    },
    { key: PROBE_KEY, method, args }
  ) as Promise<Result>;
}

/** Resolves when the fetch stub is next called; arm it before the action that triggers the fetch. */
export function armNextFetch(app: LaunchedElectronApp): Promise<void> {
  return app.evaluate((_electron, key) => {
    const probe = Reflect.get(globalThis, key) as UpdateProbe;
    Reflect.set(globalThis, `${key}:next`, probe.nextFetch());
  }, PROBE_KEY);
}

/** Settles when the armed fetch signal arrives; rejects after `timeoutMs` so a missed fetch fails fast. */
export function awaitArmedFetch(app: LaunchedElectronApp, timeoutMs = 20_000): Promise<void> {
  return app.evaluate(
    async (_electron, request) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Reflect.get(globalThis, `${request.key}:next`) as Promise<void>,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('expected update fetch did not happen')),
              request.timeoutMs
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    { key: PROBE_KEY, timeoutMs }
  );
}

export const fetchCount = (app: LaunchedElectronApp): Promise<number> =>
  call<string[]>(app, 'fetchUrls').then((urls) => urls.length);
export const openedUrls = (app: LaunchedElectronApp): Promise<string[]> =>
  call<string[]>(app, 'openedUrls');
export const holdFetches = (app: LaunchedElectronApp): Promise<void> =>
  call<void>(app, 'setHolding', true);
export const releaseFetches = (app: LaunchedElectronApp): Promise<void> =>
  call<void>(app, 'release');
export const startBackgroundCheck = (app: LaunchedElectronApp): Promise<void> =>
  call<void>(app, 'startBackground');
export const settleBackgroundCheck = (app: LaunchedElectronApp): Promise<void> =>
  call<void>(app, 'settleBackground');
export const clickMenu = (
  app: LaunchedElectronApp,
  path: readonly string[]
): Promise<{ before: number; after: number }> => call(app, 'clickMenu', path);
export const menuState = (app: LaunchedElectronApp): Promise<UpdateMenuState> =>
  call<UpdateMenuState>(app, 'menuState');
export const updateWindow = (app: LaunchedElectronApp): Promise<UpdateWindowView | null> =>
  call<UpdateWindowView | null>(app, 'updateWindow');
export const clickUpdateButton = (app: LaunchedElectronApp, index: number): Promise<void> =>
  call<void>(app, 'clickUpdateButton', index);
export const closeUpdateWindow = (app: LaunchedElectronApp): Promise<void> =>
  call<void>(app, 'closeUpdateWindow');
export const restoreUpdateProbe = (app: LaunchedElectronApp): Promise<void> =>
  call<void>(app, 'restore');

export function snoozeState(app: LaunchedElectronApp): Promise<SnoozeState> {
  return app.evaluate(() => {
    const read = (
      globalThis as typeof globalThis & { __gogchatGetUpdateSnoozeState?: () => SnoozeState }
    ).__gogchatGetUpdateSnoozeState;
    if (typeof read !== 'function') {
      throw new Error('update snooze TESTING hook is not installed');
    }
    return read();
  });
}

export function setSnoozedUntil(app: LaunchedElectronApp, deadline: number): Promise<boolean> {
  return app.evaluate((_electron, value) => {
    const set = (
      globalThis as typeof globalThis & {
        __gogchatSetUpdateSnoozedUntil?: (deadline: number) => boolean;
      }
    ).__gogchatSetUpdateSnoozedUntil;
    if (typeof set !== 'function') {
      throw new Error('update snooze TESTING hook is not installed');
    }
    return set(value);
  }, deadline);
}

/** The TESTING hooks arrive with the deferred appUpdates feature, after the first window. */
export function updateHooksInstalled(app: LaunchedElectronApp): Promise<boolean> {
  return app.evaluate(() => {
    const hooks = globalThis as typeof globalThis & Record<string, unknown>;
    return (
      typeof hooks['__gogchatGetUpdateSnoozeState'] === 'function' &&
      typeof hooks['__gogchatSetUpdateSnoozedUntil'] === 'function' &&
      typeof hooks['__gogchatRunBackgroundUpdateCheck'] === 'function' &&
      typeof hooks['__gogchatCheckForUpdatesManual'] === 'function'
    );
  });
}

/** The application menu is installed by the deferred appMenu feature. */
export function updateMenuInstalled(app: LaunchedElectronApp): Promise<boolean> {
  return app.evaluate(({ Menu }) => {
    const preferences = Menu.getApplicationMenu()?.items.find(
      (item) => item.label === 'Preferences'
    );
    return (preferences?.submenu?.items ?? []).some(
      (item) => item.label === 'Resume Update Prompts'
    );
  });
}
