/**
 * Unit tests for native update dialog pure helpers and presentation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface MockBrowserWindow {
  loadURL: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  setSize: ReturnType<typeof vi.fn>;
  setMenuBarVisibility: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  webContents: {
    on: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
    executeJavaScript: ReturnType<typeof vi.fn>;
  };
  options?: Record<string, unknown>;
}

type GlobalWithMock = typeof globalThis & {
  __updateWindowMock?: { instances: MockBrowserWindow[] };
};

vi.mock('electron', () => {
  const instances: MockBrowserWindow[] = [];
  (globalThis as GlobalWithMock).__updateWindowMock = { instances };

  const BW = function MockBW(this: MockBrowserWindow, options?: Record<string, unknown>) {
    this.options = options;
    this.loadURL = vi.fn().mockResolvedValue(undefined);
    this.show = vi.fn();
    this.focus = vi.fn();
    this.setSize = vi.fn();
    this.setMenuBarVisibility = vi.fn();
    this.hide = vi.fn();
    this.isVisible = vi.fn().mockReturnValue(true);
    this.isDestroyed = vi.fn().mockReturnValue(false);
    this.destroy = vi.fn();
    this.removeAllListeners = vi.fn();
    this.on = vi.fn();
    this.once = vi.fn();
    this.webContents = {
      on: vi.fn(),
      isDestroyed: vi.fn().mockReturnValue(false),
      executeJavaScript: vi.fn().mockResolvedValue(undefined),
    };
    instances.push(this);
  };
  return {
    BrowserWindow: BW,
    app: {
      getVersion: vi.fn().mockReturnValue('1.2.3'),
      getAppPath: vi.fn().mockReturnValue('/mock/app'),
      isPackaged: false,
    },
  };
});

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue('<svg>icon</svg>'),
  },
}));

vi.mock('electron-log', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../lifecycle/resourceCleanup.js', () => ({
  cancelTrackedTimeout: (handle: NodeJS.Timeout) => clearTimeout(handle),
  createTrackedTimeout: vi.fn((fn: () => void, ms: number) => setTimeout(fn, ms)),
}));

function getInstances(): MockBrowserWindow[] {
  return (globalThis as GlobalWithMock).__updateWindowMock?.instances ?? [];
}

describe('updateWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    const state = (globalThis as GlobalWithMock).__updateWindowMock;
    if (state?.instances) state.instances.length = 0;
  });

  it('updateWindowHeightForButtonCount scales with actions', async () => {
    const { updateWindowHeightForButtonCount } = await import('./updateWindow.js');
    expect(updateWindowHeightForButtonCount(0)).toBe(340);
    expect(updateWindowHeightForButtonCount(1)).toBe(380);
    expect(updateWindowHeightForButtonCount(2)).toBe(400);
  });

  it('updateDialogAppVersion returns app version', async () => {
    const { updateDialogAppVersion } = await import('./updateWindow.js');
    expect(updateDialogAppVersion()).toBe('1.2.3');
  });

  it('checking phase returns immediately with aurora HTML', async () => {
    const { presentUpdateDialog, destroyUpdateWindow } = await import('./updateWindow.js');
    const result = await presentUpdateDialog({
      message: 'Checking for updates…',
      phase: 'checking',
    });
    expect(result.response).toBe(-1);

    const win = getInstances()[0]!;
    expect(win.loadURL).toHaveBeenCalled();
    const raw = win.loadURL.mock.calls[0]![0] as string;
    const html = decodeURIComponent(raw.replace('data:text/html;charset=utf-8,', ''));
    expect(html).toContain('app-icon-aurora--about');
    expect(html).toContain('Checking for updates');
    expect(html).toContain('data-phase="checking"');

    destroyUpdateWindow();
  });

  it('result phase waits for settle via Escape cancel', async () => {
    const mod = await import('./updateWindow.js');
    const promise = mod.presentUpdateDialog({
      message: 'GogChat is up to date',
      phase: 'result',
      buttons: [],
      cancelId: 0,
    });

    // Let loadURL .then run
    await Promise.resolve();
    await Promise.resolve();

    const win = getInstances()[0]!;
    const beforeInput = win.webContents.on.mock.calls.find(
      (c: unknown[]) => c[0] === 'before-input-event'
    );
    expect(beforeInput).toBeDefined();
    const handler = beforeInput![1] as (_e: unknown, input: { type: string; key: string }) => void;
    handler({}, { type: 'keyDown', key: 'Escape' });

    const result = await promise;
    expect(result.response).toBe(0);
    mod.destroyUpdateWindow();
  });

  it('beginUpdateDialogSession clears dismiss flag', async () => {
    const mod = await import('./updateWindow.js');
    mod.beginUpdateDialogSession();
    expect(mod.isUpdateSessionDismissed()).toBe(false);
    mod.destroyUpdateWindow();
  });

  it('Escape during checking marks the session dismissed and hides the window', async () => {
    const mod = await import('./updateWindow.js');
    mod.beginUpdateDialogSession();
    await mod.presentUpdateDialog({
      message: 'Checking for updates…',
      phase: 'checking',
    });

    const win = getInstances()[0]!;
    const beforeInput = win.webContents.on.mock.calls.find(
      (c: unknown[]) => c[0] === 'before-input-event'
    );
    expect(beforeInput).toBeDefined();
    const handler = beforeInput![1] as (_e: unknown, input: { type: string; key: string }) => void;
    handler({}, { type: 'keyDown', key: 'Escape' });

    expect(mod.isUpdateSessionDismissed()).toBe(true);
    expect(win.hide).toHaveBeenCalled();
    expect(mod.isUpdateDialogOpen()).toBe(false);
    mod.destroyUpdateWindow();
  });

  it('result phase after checking can settle without leaking a waiter', async () => {
    const mod = await import('./updateWindow.js');
    await mod.presentUpdateDialog({
      message: 'Checking for updates…',
      phase: 'checking',
    });

    const promise = mod.presentUpdateDialog({
      message: 'Couldn’t check for updates',
      type: 'error',
      phase: 'result',
      buttons: [],
      cancelId: 0,
    });

    await Promise.resolve();
    await Promise.resolve();

    const win = getInstances()[0]!;
    const beforeInput = win.webContents.on.mock.calls.find(
      (c: unknown[]) => c[0] === 'before-input-event'
    );
    const handler = beforeInput![1] as (_e: unknown, input: { type: string; key: string }) => void;
    handler({}, { type: 'keyDown', key: 'Escape' });

    await expect(promise).resolves.toEqual({ response: 0 });
    expect(mod.isUpdateDialogOpen()).toBe(false);
    mod.destroyUpdateWindow();
  });

  it('settles a result action from will-navigate and reuses the cached window', async () => {
    const mod = await import('./updateWindow.js');
    const first = await mod.presentUpdateDialog({
      message: 'Checking for updates…',
      phase: 'checking',
    });
    expect(first.response).toBe(-1);
    expect(getInstances()).toHaveLength(1);

    const promise = mod.presentUpdateDialog({
      message: 'Update available',
      type: 'info',
      phase: 'result',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    await Promise.resolve();
    await Promise.resolve();

    const win = getInstances()[0]!;
    expect(getInstances()).toHaveLength(1);
    const navigate = win.webContents.on.mock.calls.find((c: unknown[]) => c[0] === 'will-navigate');
    const handler = navigate![1] as (event: { preventDefault: () => void; url: string }) => void;
    handler({ preventDefault: vi.fn(), url: 'https://gogchat.local/__update_action__/0' });
    await expect(promise).resolves.toEqual({ response: 0 });
    expect(win.hide).toHaveBeenCalled();
    mod.destroyUpdateWindow();
  });

  it('treats close-url navigation and window close as cancel', async () => {
    const mod = await import('./updateWindow.js');
    const promise = mod.presentUpdateDialog({
      message: 'Error',
      type: 'error',
      phase: 'result',
      buttons: ['OK'],
      cancelId: 0,
    });
    await Promise.resolve();
    await Promise.resolve();
    const win = getInstances()[0]!;
    const frameNav = win.webContents.on.mock.calls.find(
      (c: unknown[]) => c[0] === 'will-frame-navigate'
    );
    const navHandler = frameNav![1] as (event: { preventDefault: () => void; url: string }) => void;
    navHandler({ preventDefault: vi.fn(), url: 'https://gogchat.local/__update_close__' });
    await expect(promise).resolves.toEqual({ response: 0 });

    const second = mod.presentUpdateDialog({
      message: 'Again',
      phase: 'result',
      buttons: ['OK'],
      cancelId: 0,
    });
    await Promise.resolve();
    await Promise.resolve();
    const close = win.on.mock.calls.find((c: unknown[]) => c[0] === 'close');
    close![1]({ preventDefault: vi.fn() });
    await expect(second).resolves.toEqual({ response: 0 });
    mod.destroyUpdateWindow();
  });

  it('resolves a pending waiter when the window is destroyed', async () => {
    const mod = await import('./updateWindow.js');
    const promise = mod.presentUpdateDialog({
      message: 'Pending',
      phase: 'result',
      buttons: ['OK'],
      cancelId: 0,
    });
    await Promise.resolve();
    await Promise.resolve();
    mod.destroyUpdateWindow();
    await expect(promise).resolves.toEqual({ response: 0 });
    expect(mod.isUpdateDialogOpen()).toBe(false);
    expect(mod.isUpdateSessionDismissed()).toBe(false);
  });

  it('abandons a hung checking loadURL after the load deadline', async () => {
    vi.useFakeTimers();
    try {
      const { presentUpdateDialog, destroyUpdateWindow, UPDATE_CHECKING_LOAD_TIMEOUT_MS } =
        await import('./updateWindow.js');
      await presentUpdateDialog({ message: 'Checking for updates…', phase: 'checking' });
      const win = getInstances()[0]!;
      win.loadURL.mockReturnValueOnce(new Promise(() => undefined));
      const resultPromise = presentUpdateDialog({
        message: 'Checking for updates…',
        phase: 'checking',
      });
      await vi.advanceTimersByTimeAsync(UPDATE_CHECKING_LOAD_TIMEOUT_MS);
      await expect(resultPromise).resolves.toEqual({ response: -1 });
      destroyUpdateWindow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs and continues when loadURL rejects in checking phase', async () => {
    const { presentUpdateDialog, destroyUpdateWindow } = await import('./updateWindow.js');
    await presentUpdateDialog({ message: 'Checking for updates…', phase: 'checking' });
    const win = getInstances()[0]!;
    win.loadURL.mockRejectedValueOnce(new Error('load failed'));
    const result = await presentUpdateDialog({
      message: 'Checking for updates…',
      phase: 'checking',
    });
    expect(result.response).toBe(-1);
    destroyUpdateWindow();
  });

  it('ignores out-of-range action indexes and executeJavaScript failures', async () => {
    const mod = await import('./updateWindow.js');
    const promise = mod.presentUpdateDialog({
      message: 'Update available',
      phase: 'result',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    await Promise.resolve();
    await Promise.resolve();
    const win = getInstances()[0]!;
    win.webContents.executeJavaScript.mockRejectedValueOnce(new Error('isolated world'));
    const navigate = win.webContents.on.mock.calls.find((c: unknown[]) => c[0] === 'will-navigate');
    const handler = navigate![1] as (event: { preventDefault: () => void; url: string }) => void;
    handler({ preventDefault: vi.fn(), url: 'https://gogchat.local/__update_action__/9' });
    handler({ preventDefault: vi.fn(), url: 'https://example.com/other' });
    handler({ preventDefault: vi.fn(), url: 'https://gogchat.local/__update_action__/1' });
    await expect(promise).resolves.toEqual({ response: 1 });
    mod.destroyUpdateWindow();
  });

  it('classifies could-not messages as errors and defaults cancel to the last button', async () => {
    const mod = await import('./updateWindow.js');
    const promise = mod.presentUpdateDialog({
      message: 'could not reach GitHub',
      buttons: ['Retry', 'Close'],
    });
    await Promise.resolve();
    await Promise.resolve();
    const win = getInstances()[0]!;
    const raw = win.loadURL.mock.calls.at(-1)![0] as string;
    const html = decodeURIComponent(raw.replace('data:text/html;charset=utf-8,', ''));
    expect(html).toContain('Something went wrong');
    const close = win.on.mock.calls.find((c: unknown[]) => c[0] === 'close');
    close![1]({ preventDefault: vi.fn() });
    await expect(promise).resolves.toEqual({ response: 1 });
    mod.destroyUpdateWindow();
  });

  it('supersedes an in-flight result waiter with its own cancel id', async () => {
    const mod = await import('./updateWindow.js');
    const first = mod.presentUpdateDialog({
      message: 'First',
      phase: 'result',
      buttons: ['A', 'B'],
      cancelId: 1,
    });
    await Promise.resolve();
    await Promise.resolve();
    const second = mod.presentUpdateDialog({
      message: 'Second',
      phase: 'result',
      buttons: ['OK'],
      cancelId: 0,
    });
    await expect(first).resolves.toEqual({ response: 1 });
    await Promise.resolve();
    await Promise.resolve();
    const win = getInstances()[0]!;
    const beforeInput = win.webContents.on.mock.calls.find(
      (c: unknown[]) => c[0] === 'before-input-event'
    );
    const handler = beforeInput![1] as (_e: unknown, input: { type: string; key: string }) => void;
    handler({}, { type: 'keyUp', key: 'Escape' });
    handler({}, { type: 'keyDown', key: 'Enter' });
    handler({}, { type: 'keyDown', key: 'Escape' });
    await expect(second).resolves.toEqual({ response: 0 });
    mod.destroyUpdateWindow();
  });

  it('falls back when the app icon cannot be read', async () => {
    const fs = await import('fs');
    vi.mocked(fs.default.readFileSync).mockImplementationOnce(() => {
      throw new Error('missing icon');
    });
    const { presentUpdateDialog, destroyUpdateWindow } = await import('./updateWindow.js');
    const result = await presentUpdateDialog({
      message: 'Checking for updates…',
      phase: 'checking',
      detail: 'Still working',
    });
    expect(result.response).toBe(-1);
    const win = getInstances()[0]!;
    const raw = win.loadURL.mock.calls[0]![0] as string;
    expect(raw).toContain('data:text/html');
    destroyUpdateWindow();
  });

  it('loads a PNG icon when the SVG candidate is missing', async () => {
    const fs = await import('fs');
    vi.mocked(fs.default.existsSync).mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.mocked(fs.default.readFileSync).mockReturnValueOnce(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { presentUpdateDialog, destroyUpdateWindow } = await import('./updateWindow.js');
    await presentUpdateDialog({ message: 'Checking for updates…', phase: 'checking' });
    const win = getInstances()[0]!;
    const raw = win.loadURL.mock.calls[0]![0] as string;
    const html = decodeURIComponent(raw.replace('data:text/html;charset=utf-8,', ''));
    expect(html).toContain('data:image/png;base64');
    destroyUpdateWindow();
  });

  it('does not show a destroyed checking window after loadURL resolves', async () => {
    const { presentUpdateDialog, destroyUpdateWindow } = await import('./updateWindow.js');
    await presentUpdateDialog({ message: 'Checking for updates…', phase: 'checking' });
    const win = getInstances()[0]!;
    win.isDestroyed.mockReturnValue(true);
    win.show.mockClear();
    const result = await presentUpdateDialog({
      message: 'Checking for updates…',
      phase: 'checking',
    });
    expect(result.response).toBe(-1);
    expect(win.show).not.toHaveBeenCalled();
    destroyUpdateWindow();
  });
});
