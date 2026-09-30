/**
 * Unit tests for aboutPanel feature with custom BrowserWindow dialog.
 *
 * Uses dynamic import + globalThis to expose mock state across
 * both Bun and Node.js Vitest runners.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';

interface MockBrowserWindow {
  loadURL: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  setMenuBarVisibility: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  webContents: {
    url: string;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
  options?: Record<string, unknown>;
}

interface AboutPanelMockState {
  instances: MockBrowserWindow[];
}

type GlobalWithMock = typeof globalThis & {
  __aboutPanelMock?: AboutPanelMockState;
};

vi.mock('electron', () => {
  const instances: MockBrowserWindow[] = [];
  (globalThis as GlobalWithMock).__aboutPanelMock = { instances };

  const BW = function MockBW(this: MockBrowserWindow, options?: Record<string, unknown>) {
    this.options = options;
    this.loadURL = vi.fn().mockResolvedValue(undefined);
    this.show = vi.fn();
    this.setMenuBarVisibility = vi.fn();
    this.once = vi.fn();
    this.on = vi.fn();
    this.focus = vi.fn();
    this.isVisible = vi.fn().mockReturnValue(false);
    this.isDestroyed = vi.fn().mockReturnValue(false);
    this.hide = vi.fn();
    this.destroy = vi.fn();
    this.removeAllListeners = vi.fn();
    this.webContents = {
      url: '',
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    };
    instances.push(this);
  };
  return {
    BrowserWindow: BW,
    app: {
      getVersion: vi.fn().mockReturnValue('3.18.5'),
      getAppPath: vi.fn().mockReturnValue('/mock/app'),
      isPackaged: false,
    },
  };
});

vi.mock('os', () => ({
  default: {
    type: vi.fn().mockReturnValue('Darwin'),
    release: vi.fn().mockReturnValue('23.0.0'),
    arch: vi.fn().mockReturnValue('arm64'),
  },
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue('<svg>icon</svg>'),
  },
}));

vi.mock('electron-log', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../utils/platform/packageInfo.js', () => ({
  getPackageInfo: vi.fn().mockReturnValue({
    productName: 'GogChat',
    version: '1.0.0',
    author: 'Test Author',
    description: 'Desktop wrapper for Google Chat',
    repository: 'https://github.com/iworkforces/GogChat',
    homepage: 'https://github.com/iworkforces/GogChat',
    name: 'gogchat',
  }),
}));

vi.mock('../utils/security/shellWrapper.js', () => ({
  openExternal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../shared/urlValidators.js', () => ({
  validateExternalURL: vi.fn((url: string) => url),
}));

vi.mock('./menuActionRegistry.js', () => ({
  registerMenuAction: vi.fn(),
}));

async function loadAboutPanel() {
  return await import('./aboutPanel');
}

function getInstances(): MockBrowserWindow[] {
  return (globalThis as GlobalWithMock).__aboutPanelMock?.instances ?? [];
}

// Cast helper: the mock satisfies the BrowserWindow shape used by aboutPanel
const asBrowserWindow = (win: { id: number }): BrowserWindow => win as unknown as BrowserWindow;

function decodeLoadedHtml(instance: MockBrowserWindow): string {
  const rawUrl: string = instance.loadURL.mock.calls[0]![0] as string;
  return decodeURIComponent(rawUrl.replace('data:text/html;charset=utf-8,', ''));
}

describe('aboutPanel', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const state = (globalThis as GlobalWithMock).__aboutPanelMock;
    if (state?.instances) state.instances.length = 0;
  });

  it('creates a BrowserWindow and loads aurora About HTML', async () => {
    const { default: aboutPanel } = await loadAboutPanel();
    aboutPanel(asBrowserWindow({ id: 1 }));

    const instances = getInstances();
    expect(instances).toHaveLength(1);

    const decoded = decodeLoadedHtml(instances[0]!);
    expect(decoded).toContain('GogChat');
    expect(decoded).toContain('Test Author');
    expect(decoded).toContain('Darwin');
    expect(decoded).toContain('arm64');
    expect(decoded).toContain('app-icon-aurora');
    expect(decoded).toContain('app-icon-aurora--about');
    expect(decoded).toContain('GitHub');
  });

  it('uses sandboxed webPreferences and product canvas chrome', async () => {
    const { default: aboutPanel } = await loadAboutPanel();
    aboutPanel(asBrowserWindow({ id: 1 }));

    const win = getInstances()[getInstances().length - 1]!;
    const prefs = win.options?.['webPreferences'] as Record<string, unknown> | undefined;
    expect(prefs).toEqual({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    });
    expect(win.options?.['backgroundColor']).toBe('#0d1117');
    expect(win.options?.['alwaysOnTop']).toBe(false);
    expect(win.setMenuBarVisibility).toHaveBeenCalledWith(false);
  });

  it('HTML-escapes package fields in the about document', async () => {
    const { getPackageInfo } = await import('../utils/platform/packageInfo.js');
    vi.mocked(getPackageInfo).mockReturnValue({
      productName: 'Gog<script>Chat',
      version: '1.0.0"><img',
      author: "O'Reilly & Co",
      name: 'gogchat',
      homepage: '',
      repository: 'https://github.com/iworkforces/GogChat',
      description: 'desc <b>x</b>',
    });

    const { default: aboutPanel } = await loadAboutPanel();
    aboutPanel(asBrowserWindow({ id: 1 }));

    const decoded = decodeLoadedHtml(getInstances()[0]!);
    expect(decoded).not.toContain('<script>');
    expect(decoded).toContain('Gog&lt;script&gt;Chat');
    expect(decoded).toContain('O&#39;Reilly &amp; Co');
    expect(decoded).toContain('desc &lt;b&gt;x&lt;/b&gt;');
  });

  it('shows window on ready-to-show event', async () => {
    const { default: aboutPanel } = await loadAboutPanel();
    aboutPanel(asBrowserWindow({ id: 1 }));

    const instances = getInstances();
    const win = instances[instances.length - 1]!;
    const readyCall = win.once.mock.calls.find((c: unknown[]) => c[0] === 'ready-to-show');
    expect(readyCall).toBeDefined();
    (readyCall as unknown as [string, () => void])[1]();
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
  });

  it('reuses existing window on second call', async () => {
    const { default: aboutPanel } = await loadAboutPanel();
    aboutPanel(asBrowserWindow({ id: 1 }));

    const count = getInstances().length;
    getInstances()[0]!.isVisible.mockReturnValue(true);
    aboutPanel(asBrowserWindow({ id: 1 }));
    expect(getInstances()).toHaveLength(count);
    expect(getInstances()[0]!.focus).toHaveBeenCalled();
  });

  it('creates new window when previous one is destroyed', async () => {
    const { default: aboutPanel } = await loadAboutPanel();
    aboutPanel(asBrowserWindow({ id: 1 }));

    const count = getInstances().length;
    getInstances()[getInstances().length - 1]!.isDestroyed.mockReturnValue(true);
    aboutPanel(asBrowserWindow({ id: 1 }));
    expect(getInstances()).toHaveLength(count + 1);
  });

  it('exports isSafeAboutRepositoryUrl for https only', async () => {
    const { isSafeAboutRepositoryUrl } = await loadAboutPanel();
    expect(isSafeAboutRepositoryUrl('https://github.com/iworkforces/GogChat')).toBe(true);
    expect(isSafeAboutRepositoryUrl('http://github.com/iworkforces/GogChat')).toBe(false);
    expect(isSafeAboutRepositoryUrl('not a url')).toBe(false);
  });

  it('destroyAboutWindow destroys the cached window', async () => {
    const { default: aboutPanel, destroyAboutWindow } = await loadAboutPanel();
    aboutPanel(asBrowserWindow({ id: 1 }));
    const win = getInstances()[0]!;
    destroyAboutWindow();
    expect(win.removeAllListeners).toHaveBeenCalledWith('close');
    expect(win.destroy).toHaveBeenCalled();
  });
});
