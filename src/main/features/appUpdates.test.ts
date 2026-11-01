/**
 * Unit tests for appUpdates feature.
 */
/* global AbortSignal, AbortController, RequestInit, RequestInfo, Response, URL */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockCreateTrackedTimeout,
  mockCreateTrackedInterval,
  mockCancelTrackedInterval,
  mockCancelTrackedTimeout,
  mockRegisterCleanupTask,
  mockAddTrackedListener,
  powerListeners,
  registeredActions,
  mockRefreshMenu,
  beforeQuitHandler,
  cleanupLatch,
} = vi.hoisted(() => {
  const quit = { current: undefined as (() => void) | undefined };
  const latch = { current: undefined as (() => void) | undefined };
  const resumeListeners = new Set<() => void>();
  let nextTimerId = 10;
  return {
    mockCreateTrackedTimeout: vi.fn(() => {
      nextTimerId += 1;
      return nextTimerId as unknown as ReturnType<typeof setTimeout>;
    }),
    mockCreateTrackedInterval: vi.fn(() => {
      nextTimerId += 1;
      return nextTimerId as unknown as ReturnType<typeof setInterval>;
    }),
    mockCancelTrackedInterval: vi.fn(),
    mockCancelTrackedTimeout: vi.fn(),
    mockRegisterCleanupTask: vi.fn((name: string, callback: () => void) => {
      if (name === 'appUpdates-suppress-prompts') latch.current = callback;
    }),
    mockAddTrackedListener: vi.fn((_target: unknown, event: string, handler: () => void) => {
      if (event === 'resume') resumeListeners.add(handler);
    }),
    powerListeners: resumeListeners,
    registeredActions: {} as Record<string, { label: string; handler: () => unknown }>,
    mockRefreshMenu: vi.fn(),
    beforeQuitHandler: quit,
    cleanupLatch: latch,
  };
});

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn().mockReturnValue('3.0.0'),
    isPackaged: true,
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'before-quit') beforeQuitHandler.current = handler;
    }),
  },
  powerMonitor: {
    removeListener: vi.fn((event: string, handler: () => void) => {
      if (event === 'resume') powerListeners.delete(handler);
    }),
  },
}));

vi.mock('electron-log', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../utils/lifecycle/resourceCleanup.js', () => ({
  addTrackedListener: mockAddTrackedListener,
  cancelTrackedInterval: mockCancelTrackedInterval,
  cancelTrackedTimeout: mockCancelTrackedTimeout,
  createTrackedTimeout: mockCreateTrackedTimeout,
  createTrackedInterval: mockCreateTrackedInterval,
  registerCleanupTask: mockRegisterCleanupTask,
}));

vi.mock('../config.js', () => ({
  configGet: vi.fn().mockReturnValue(true),
  configSet: vi.fn(),
}));

vi.mock('../utils/platform/packageInfo.js', () => ({
  getPackageInfo: vi.fn().mockReturnValue({
    repository: 'https://github.com/iworkforces/GogChat',
    productName: 'GogChat',
  }),
}));

vi.mock('../utils/platform/updateWindow.js', () => ({
  beginUpdateDialogSession: vi.fn(),
  isUpdateSessionDismissed: vi.fn().mockReturnValue(false),
  presentUpdateDialog: vi.fn().mockResolvedValue({ response: 1 }),
}));

vi.mock('../utils/security/shellWrapper.js', () => ({
  openExternal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../shared/urlValidators.js', () => ({
  validateExternalURL: vi.fn((url: string) => url),
}));

vi.mock('./menuActionRegistry.js', () => ({
  registerMenuAction: vi.fn((id: string, action: { label: string; handler: () => unknown }) => {
    registeredActions[id] = action;
  }),
  getMenuAction: vi.fn((id: string) =>
    id === 'refreshApplicationMenu' ? { label: 'Refresh', handler: mockRefreshMenu } : undefined
  ),
}));

import appUpdates, {
  checkForUpdatesManual,
  githubRepoSlug,
  installUpdateTestHooks,
  isVersionNewer,
  resetBackgroundShutdownForTests,
  resetManualUpdateGateForTests,
  resumeUpdatePrompts,
  runBackgroundUpdateCheck,
  snoozeUpdatePrompts,
} from './appUpdates';
import * as appUpdatesModule from './appUpdates';
import { app, powerMonitor } from 'electron';
import log from 'electron-log';
import { configGet, configSet } from '../config.js';
import {
  beginUpdateDialogSession,
  presentUpdateDialog,
  isUpdateSessionDismissed,
} from '../utils/platform/updateWindow.js';
import { openExternal } from '../utils/security/shellWrapper.js';
import { validateExternalURL } from '../../shared/urlValidators.js';
import { getPackageInfo } from '../utils/platform/packageInfo.js';
import {
  githubUpdateFixture,
  GITHUB_UPDATE_STABLE_URL,
} from '../../../tests/helpers/githubReleaseFixtures.js';

const STABLE_V9 = {
  tag_name: 'v9.0.0',
  body: 'Release notes',
  html_url: 'https://github.com/iworkforces/GogChat/releases/tag/v9.0.0',
  draft: false,
  prerelease: false,
} as const;

const STABLE_CURRENT = {
  tag_name: 'v3.0.0',
  body: '',
  html_url: 'https://github.com/iworkforces/GogChat/releases/tag/v3.0.0',
  draft: false,
  prerelease: false,
} as const;

type ReleaseParser = (value: unknown) => {
  tag_name: string;
  html_url: string;
  body?: string;
} | null;

const RELEASE_REPO = 'iworkforces/GogChat';

function getReleaseParser(): ReleaseParser {
  const parse = appUpdatesModule.parseStableGithubRelease;
  expect(parse).toEqual(expect.any(Function));
  return (value: unknown) => parse(value, RELEASE_REPO);
}

function getReleaseSelector(): ReleaseParser {
  const select = appUpdatesModule.selectFirstStableGithubRelease;
  expect(select).toEqual(expect.any(Function));
  return (value: unknown) => select(value, RELEASE_REPO);
}

function hungFetch(init: RequestInit | undefined): Promise<Response> {
  const signal = init?.signal;
  if (!signal) {
    return Promise.reject(new Error('manual update fetch missing AbortSignal'));
  }
  return new Promise((_resolve, reject) => {
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

describe('appUpdates helpers', () => {
  it('githubRepoSlug parses HTTPS and bare owner/repo', () => {
    expect(githubRepoSlug('https://github.com/iworkforces/GogChat')).toBe('iworkforces/GogChat');
    expect(githubRepoSlug('https://github.com/iworkforces/GogChat.git')).toBe(
      'iworkforces/GogChat'
    );
    expect(githubRepoSlug('iworkforces/GogChat')).toBe('iworkforces/GogChat');
    expect(githubRepoSlug('https://example.com/not-github')).toBeNull();
    expect(githubRepoSlug('')).toBeNull();
    expect(githubRepoSlug('   ')).toBeNull();
    expect(githubRepoSlug('https://www.github.com/iworkforces/GogChat')).toBe(
      'iworkforces/GogChat'
    );
    expect(githubRepoSlug('github.com/iworkforces/GogChat')).toBe('iworkforces/GogChat');
    expect(githubRepoSlug('https://github.com/only-owner')).toBeNull();
    expect(githubRepoSlug('http://[')).toBeNull();
  });

  it('isVersionNewer compares dotted segments', () => {
    expect(isVersionNewer('3.1.0', '3.0.0')).toBe(true);
    expect(isVersionNewer('v4.0.0', '3.18.5')).toBe(true);
    expect(isVersionNewer('3.0.0', '3.0.0')).toBe(false);
    expect(isVersionNewer('2.9.9', '3.0.0')).toBe(false);
    expect(isVersionNewer('3.0.0-beta', '3.0.0')).toBe(false);
    expect(isVersionNewer('3.0.1+build', '3.0.0')).toBe(true);
    expect(isVersionNewer('3.a.1', '3.0.0')).toBe(true);
  });
});

function timerCallback(calls: readonly unknown[][]): () => void {
  const callback = calls[0]?.[0];
  expect(callback).toEqual(expect.any(Function));
  return callback as () => void;
}

function loggedText(): string {
  return vi
    .mocked(log.error)
    .mock.calls.map((call) =>
      call
        .map((part) => {
          if (part instanceof Error) {
            return `${part.message}\n${part.stack ?? ''}`;
          }
          return String(part);
        })
        .join(' ')
    )
    .join('\n');
}

function fireBeforeQuit(): void {
  expect(beforeQuitHandler.current).toEqual(expect.any(Function));
  beforeQuitHandler.current?.();
}

function latchCleanupTask(): void {
  expect(cleanupLatch.current).toEqual(expect.any(Function));
  cleanupLatch.current?.();
}

function expectNoUpdateUi(): void {
  expect(presentUpdateDialog).not.toHaveBeenCalled();
  expect(beginUpdateDialogSession).not.toHaveBeenCalled();
  expect(openExternal).not.toHaveBeenCalled();
}

async function withNoUnhandledRejection(run: () => Promise<void>): Promise<void> {
  const reasons: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    await run();
    await new Promise((resolve) => setImmediate(resolve));
    expect(reasons).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}

describe('appUpdates background', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetManualUpdateGateForTests();
    resetBackgroundShutdownForTests();
    vi.mocked(configGet).mockReturnValue(true);
    vi.mocked(isUpdateSessionDismissed).mockReturnValue(false);
    vi.mocked(presentUpdateDialog).mockResolvedValue({ response: 1 });
    vi.mocked(openExternal).mockResolvedValue(undefined);
    vi.mocked(getPackageInfo).mockReturnValue({
      repository: 'https://github.com/iworkforces/GogChat',
      productName: 'GogChat',
    } as never);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [STABLE_V9],
      })
    );
  });

  afterEach(() => {
    resetManualUpdateGateForTests();
    resetBackgroundShutdownForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('schedules the first check at 5 seconds and then every 24 hours', () => {
    appUpdates();
    expect(mockCreateTrackedTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      5000,
      'appUpdates-initial-check'
    );
    expect(mockCreateTrackedInterval).toHaveBeenCalledWith(
      expect.any(Function),
      1000 * 60 * 60 * 24,
      'appUpdates-daily-check'
    );
  });

  it('replaces the previous daily interval and initial timeout when appUpdates starts again', () => {
    appUpdates();
    const firstTimeout = mockCreateTrackedTimeout.mock.results[0]?.value;
    const firstInterval = mockCreateTrackedInterval.mock.results[0]?.value;
    expect(firstTimeout).toBeDefined();
    expect(firstInterval).toBeDefined();
    expect(firstTimeout).not.toBe(firstInterval);

    appUpdates();

    expect(mockCancelTrackedTimeout).toHaveBeenLastCalledWith(firstTimeout);
    expect(mockCancelTrackedInterval).toHaveBeenLastCalledWith(firstInterval);
    expect(mockCancelTrackedTimeout).not.toHaveBeenCalledWith(firstInterval);
    expect(mockCancelTrackedInterval).not.toHaveBeenCalledWith(firstTimeout);
    const secondTimeout = mockCreateTrackedTimeout.mock.results.at(-1)?.value;
    expect(secondTimeout).not.toBe(firstTimeout);
    expect(mockCancelTrackedTimeout).not.toHaveBeenCalledWith(secondTimeout);
  });

  it('re-reads autoCheckForUpdates on every tick and stays silent when it is off', async () => {
    appUpdates();
    const tick = timerCallback(mockCreateTrackedTimeout.mock.calls);
    vi.mocked(configGet).mockReturnValue(false);
    tick();
    await Promise.resolve();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expectNoUpdateUi();
    expect(configGet).toHaveBeenCalledWith('app.autoCheckForUpdates');

    vi.mocked(configGet).mockReturnValue(true);
    vi.mocked(configGet).mockClear();
    await withNoUnhandledRejection(async () => {
      tick();
      await vi.waitFor(() => expect(presentUpdateDialog).toHaveBeenCalled());
    });
    expect(configGet).toHaveBeenCalledWith('app.autoCheckForUpdates');
    expect(presentUpdateDialog).not.toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'checking' })
    );
    expect(presentUpdateDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'result',
        message: 'New release available',
        buttons: ['Download', 'Later'],
      })
    );
  });

  it('runs the same check from the daily interval', async () => {
    appUpdates();
    const daily = timerCallback(mockCreateTrackedInterval.mock.calls);
    await withNoUnhandledRejection(async () => {
      daily();
      await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'https://api.github.com/repos/iworkforces/GogChat/releases',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('does not surface an unhandled rejection from a scheduled tick', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('https://user:pass@evil.example/secret'))
    );
    appUpdates();
    const tick = timerCallback(mockCreateTrackedTimeout.mock.calls);
    await withNoUnhandledRejection(async () => {
      tick();
      await vi.waitFor(() => expect(log.error).toHaveBeenCalled());
    });
    expectNoUpdateUi();
    expect(loggedText()).toContain('[redacted]');
    expect(loggedText()).not.toContain('evil.example');
    expect(loggedText()).not.toContain('secret');
  });

  it('stays packaged-only unless TESTING=true', async () => {
    const previousPackaged = app.isPackaged;
    const previousTesting = process.env['TESTING'];
    app.isPackaged = false;
    delete process.env['TESTING'];
    try {
      await runBackgroundUpdateCheck();
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expectNoUpdateUi();

      process.env['TESTING'] = 'true';
      await runBackgroundUpdateCheck();
      expect(vi.mocked(fetch)).toHaveBeenCalled();
    } finally {
      app.isPackaged = previousPackaged;
      if (previousTesting === undefined) {
        delete process.env['TESTING'];
      } else {
        process.env['TESTING'] = previousTesting;
      }
    }
  });

  it('stays silent for draft-only, malformed, empty, and non-GitHub release lists', async () => {
    const payloads: unknown[] = [
      [{ ...STABLE_V9, draft: true }],
      [
        {
          ...STABLE_V9,
          prerelease: true,
          tag_name: 'v10.0.0-rc.1',
          html_url: 'https://github.com/iworkforces/GogChat/releases/tag/v10.0.0-rc.1',
        },
      ],
      { not: 'an-array', html_url: 'https://evil.example/secret-token' },
      [],
      [
        {
          ...STABLE_V9,
          html_url: 'http://github.com/iworkforces/GogChat/releases/tag/v9.0.0',
        },
      ],
      [
        {
          ...STABLE_V9,
          html_url: 'https://evil.example/releases/tag/v9.0.0',
        },
      ],
      [
        {
          ...STABLE_V9,
          html_url: 'https://github.com/iworkforces/GogChat/releases/download/v9.0.0/GogChat.dmg',
        },
      ],
      [
        {
          ...STABLE_V9,
          html_url: 'https://user:pass@github.com/iworkforces/GogChat/releases/tag/v9.0.0',
        },
      ],
      [
        {
          ...STABLE_V9,
          html_url: 'https://github.com/other/repo/releases/tag/v9.0.0',
        },
      ],
      [
        {
          ...STABLE_V9,
          html_url: 'https://github.com/iworkforces/GogChat/releases/tag/v9.0.0?asset=1',
        },
      ],
    ];

    for (const payload of payloads) {
      vi.mocked(presentUpdateDialog).mockClear();
      vi.mocked(beginUpdateDialogSession).mockClear();
      vi.mocked(openExternal).mockClear();
      vi.mocked(log.error).mockClear();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => payload,
        })
      );

      await runBackgroundUpdateCheck();
      expectNoUpdateUi();
      const text = loggedText();
      expect(text).toContain('no stable release');
      expect(text).not.toContain('evil.example');
      expect(text).not.toContain('secret-token');
    }
  });

  it('stays silent when the first stable release is older, even if a later entry is newer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            ...STABLE_V9,
            tag_name: 'v1.0.0',
            html_url: 'https://github.com/iworkforces/GogChat/releases/tag/v1.0.0',
          },
          STABLE_V9,
        ],
      })
    );

    await runBackgroundUpdateCheck();
    expectNoUpdateUi();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('prompts for the first stable release after a prerelease and downloads only that URL', async () => {
    vi.mocked(presentUpdateDialog).mockResolvedValue({ response: 0 });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            ...STABLE_V9,
            prerelease: true,
            tag_name: 'v10.0.0-rc.1',
            html_url: 'https://github.com/iworkforces/GogChat/releases/tag/v10.0.0-rc.1',
          },
          {
            ...STABLE_V9,
            draft: true,
            tag_name: 'v10.0.0-draft',
            html_url: 'https://github.com/iworkforces/GogChat/releases/tag/v10.0.0-draft',
          },
          STABLE_V9,
        ],
      })
    );

    await runBackgroundUpdateCheck();
    expect(presentUpdateDialog).not.toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'checking' })
    );
    expect(presentUpdateDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'result',
        message: 'New release available',
        detail: expect.stringContaining('Release notes'),
      })
    );
    expect(validateExternalURL).toHaveBeenCalledWith(STABLE_V9.html_url);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(STABLE_V9.html_url);
  });

  it('does not open a URL when the user dismisses the background prompt', async () => {
    vi.mocked(presentUpdateDialog).mockResolvedValue({ response: 1 });
    await runBackgroundUpdateCheck();
    expect(openExternal).not.toHaveBeenCalled();
    expect(validateExternalURL).not.toHaveBeenCalled();
  });

  it('logs sanitized failures for HTTP errors, rejected fetches, and broken JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => [STABLE_V9],
      })
    );
    await withNoUnhandledRejection(() => runBackgroundUpdateCheck());
    expectNoUpdateUi();
    expect(loggedText()).toContain('[redacted]');
    expect(loggedText()).not.toContain('503');
    expect(loggedText()).not.toContain('GitHub releases HTTP');
    expect(loggedText()).not.toContain('releases/tag');
    expect(openExternal).not.toHaveBeenCalled();

    vi.mocked(log.error).mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new Error('https://evil.example/secret-token');
        },
      })
    );
    await withNoUnhandledRejection(() => runBackgroundUpdateCheck());
    expectNoUpdateUi();
    expect(loggedText()).not.toContain('evil.example');
    expect(loggedText()).not.toContain('secret-token');
    expect(loggedText()).toContain('[redacted]');
  });

  it('aborts a hung background fetch at 10 seconds without UI and releases the gate', async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort(new DOMException('The operation was aborted.', 'TimeoutError'));
      }, ms);
      return controller.signal;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => hungFetch(init))
    );

    const first = runBackgroundUpdateCheck();
    await Promise.resolve();
    await Promise.resolve();

    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    expect(log.error).not.toHaveBeenCalled();
    expectNoUpdateUi();

    await vi.advanceTimersByTimeAsync(9_999);
    expect(log.error).not.toHaveBeenCalled();
    expectNoUpdateUi();

    await vi.advanceTimersByTimeAsync(1);
    await first;

    expectNoUpdateUi();
    expect(loggedText()).toContain('[redacted]');
    expect(loggedText()).not.toContain('aborted');

    timeoutSpy.mockRestore();
    vi.useRealTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [STABLE_V9],
      })
    );
    vi.mocked(presentUpdateDialog).mockClear();

    await runBackgroundUpdateCheck();
    expect(presentUpdateDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'result',
        message: 'New release available',
      })
    );
  });

  it('discards an in-flight result when auto-check is switched off', async () => {
    let release!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      )
    );

    const pending = runBackgroundUpdateCheck();
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    vi.mocked(configGet).mockReturnValue(false);
    release({ ok: true, json: async () => [STABLE_V9] });
    await pending;

    expectNoUpdateUi();
  });

  it('does not fetch or present after shutdown cleanup has started', async () => {
    fireBeforeQuit();
    await runBackgroundUpdateCheck();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expectNoUpdateUi();
  });

  it('discards an in-flight result when resource cleanup is in progress', async () => {
    let release!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      )
    );

    const pending = runBackgroundUpdateCheck();
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    latchCleanupTask();
    release({ ok: true, json: async () => [STABLE_V9] });
    await pending;

    expectNoUpdateUi();
    vi.mocked(fetch).mockClear();
    resetManualUpdateGateForTests();
    await runBackgroundUpdateCheck();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expectNoUpdateUi();
  });

  it('keeps a held session gate when only the shutdown latch is reset', async () => {
    let release!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      )
    );

    const pending = runBackgroundUpdateCheck();
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
    resetBackgroundShutdownForTests();
    await runBackgroundUpdateCheck();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

    fireBeforeQuit();
    release({ ok: true, json: async () => [STABLE_V9] });
    await pending;
    expectNoUpdateUi();

    vi.mocked(fetch).mockClear();
    resetManualUpdateGateForTests();
    await runBackgroundUpdateCheck();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expectNoUpdateUi();
  });

  it('does not open the release page when the cleanup task latches during the prompt', async () => {
    vi.mocked(presentUpdateDialog).mockImplementation(async () => {
      latchCleanupTask();
      return { response: 0 };
    });

    await runBackgroundUpdateCheck();
    expect(presentUpdateDialog).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'result', message: 'New release available' })
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('logs a static repository failure without fetching or presenting', async () => {
    vi.mocked(getPackageInfo).mockReturnValueOnce({
      repository: 'https://evil.example/not-github',
      productName: 'GogChat',
    } as never);

    await runBackgroundUpdateCheck();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expectNoUpdateUi();
    expect(loggedText()).toContain('repository metadata is missing');
    expect(loggedText()).not.toContain('evil.example');
  });

  it('skips a second background check while the first session is in flight', async () => {
    let release!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      )
    );

    const first = runBackgroundUpdateCheck();
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
    const second = runBackgroundUpdateCheck();
    await second;
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(beginUpdateDialogSession).not.toHaveBeenCalled();

    release({ ok: true, json: async () => [STABLE_V9] });
    await first;
    expect(beginUpdateDialogSession).toHaveBeenCalledTimes(1);
  });

  it('skips a scheduled tick while a manual session is in progress', async () => {
    let release!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      )
    );

    const manual = checkForUpdatesManual();
    await vi.waitFor(() => expect(presentUpdateDialog).toHaveBeenCalled());
    const presents = vi.mocked(presentUpdateDialog).mock.calls.length;
    const begins = vi.mocked(beginUpdateDialogSession).mock.calls.length;

    appUpdates();
    timerCallback(mockCreateTrackedTimeout.mock.calls)();
    await Promise.resolve();
    await Promise.resolve();

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(presentUpdateDialog).toHaveBeenCalledTimes(presents);
    expect(beginUpdateDialogSession).toHaveBeenCalledTimes(begins);

    release({ ok: true, json: async () => [STABLE_V9] });
    await manual;
  });

  it('does not let a manual request reset or supersede an in-flight background session', async () => {
    let release!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    let fetches = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        fetches += 1;
        if (fetches === 1) {
          return new Promise((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve({ ok: true, json: async () => [STABLE_V9] });
      })
    );

    const background = runBackgroundUpdateCheck();
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
    expect(beginUpdateDialogSession).not.toHaveBeenCalled();
    expect(presentUpdateDialog).not.toHaveBeenCalled();

    const manual = checkForUpdatesManual();
    const extraManual = checkForUpdatesManual();
    await Promise.resolve();
    await Promise.resolve();

    expect(beginUpdateDialogSession).not.toHaveBeenCalled();
    expect(presentUpdateDialog).not.toHaveBeenCalled();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    await extraManual;

    release({ ok: true, json: async () => [STABLE_V9] });
    await background;
    await manual;

    const phases = vi.mocked(presentUpdateDialog).mock.calls.map((call) => {
      const options = call[0] as { phase?: string };
      return options.phase;
    });
    expect(phases[0]).toBe('result');
    expect(phases).toContain('checking');
    expect(beginUpdateDialogSession).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(presentUpdateDialog).mock.calls.filter((call) => {
        const options = call[0] as { phase?: string };
        return options.phase === 'checking';
      })
    ).toHaveLength(1);
  });

  it('does not reset dismissal or supersede a background prompt that is already up', async () => {
    let releaseDialog!: (value: { response: number }) => void;
    vi.mocked(presentUpdateDialog).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDialog = resolve;
        })
    );

    const background = runBackgroundUpdateCheck();
    await vi.waitFor(() => expect(beginUpdateDialogSession).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(presentUpdateDialog).toHaveBeenCalledTimes(1));

    const manual = checkForUpdatesManual();
    await Promise.resolve();
    await Promise.resolve();

    expect(beginUpdateDialogSession).toHaveBeenCalledTimes(1);
    expect(presentUpdateDialog).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();

    releaseDialog({ response: 0 });
    await background;
    await manual;
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(STABLE_V9.html_url);
    expect(beginUpdateDialogSession).toHaveBeenCalledTimes(2);
  });

  it('logs a sanitized open failure and still settles', async () => {
    vi.mocked(presentUpdateDialog).mockResolvedValue({ response: 0 });
    vi.mocked(openExternal).mockRejectedValueOnce(
      new Error('https://user:pass@evil.example/secret')
    );
    await withNoUnhandledRejection(async () => {
      await runBackgroundUpdateCheck();
    });
    expect(openExternal).toHaveBeenCalledWith(STABLE_V9.html_url);
    expect(loggedText()).toContain('[redacted]');
    expect(loggedText()).not.toContain('evil.example');
    expect(loggedText()).not.toContain('secret');
  });

  it('settles when the result dialog rejects and then allows another check', async () => {
    vi.mocked(presentUpdateDialog).mockRejectedValueOnce(new Error('https://dialog.example/boom'));
    await withNoUnhandledRejection(async () => {
      await runBackgroundUpdateCheck();
    });
    expect(loggedText()).toContain('[redacted]');
    expect(loggedText()).not.toContain('dialog.example');

    vi.mocked(presentUpdateDialog).mockResolvedValue({ response: 1 });
    vi.mocked(presentUpdateDialog).mockClear();
    await runBackgroundUpdateCheck();
    expect(presentUpdateDialog).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'New release available' })
    );
  });

  it('installs Playwright hooks only when TESTING=true', () => {
    const previous = process.env['TESTING'];
    const globals = globalThis as {
      __gogchatRunBackgroundUpdateCheck?: unknown;
      __gogchatCheckForUpdatesManual?: unknown;
      __gogchatSetAutoCheckForUpdates?: (enabled: boolean) => void;
      __gogchatBackgroundCheckScheduledAt?: number;
    };
    delete globals.__gogchatRunBackgroundUpdateCheck;
    delete globals.__gogchatCheckForUpdatesManual;
    delete globals.__gogchatSetAutoCheckForUpdates;
    delete globals.__gogchatBackgroundCheckScheduledAt;
    try {
      delete process.env['TESTING'];
      installUpdateTestHooks();
      expect(globals.__gogchatRunBackgroundUpdateCheck).toBeUndefined();
      expect(globals.__gogchatCheckForUpdatesManual).toBeUndefined();

      process.env['TESTING'] = 'true';
      installUpdateTestHooks();
      expect(globals.__gogchatRunBackgroundUpdateCheck).toBe(runBackgroundUpdateCheck);
      expect(globals.__gogchatCheckForUpdatesManual).toBe(checkForUpdatesManual);
      globals.__gogchatSetAutoCheckForUpdates?.(false);
      expect(configSet).toHaveBeenCalledWith('app.autoCheckForUpdates', false);
      const beforeSchedule = Date.now();
      appUpdates();
      expect(globals.__gogchatBackgroundCheckScheduledAt).toBeGreaterThanOrEqual(beforeSchedule);
      expect(globals.__gogchatBackgroundCheckScheduledAt ?? 0).toBeLessThanOrEqual(Date.now());
    } finally {
      delete globals.__gogchatRunBackgroundUpdateCheck;
      delete globals.__gogchatCheckForUpdatesManual;
      delete globals.__gogchatSetAutoCheckForUpdates;
      delete globals.__gogchatBackgroundCheckScheduledAt;
      if (previous === undefined) {
        delete process.env['TESTING'];
      } else {
        process.env['TESTING'] = previous;
      }
    }
  });
});

describe('stable GitHub release parser', () => {
  it('treats http-error and timeout fixtures as a newer stable list behind the failure', () => {
    for (const kind of ['http-error', 'timeout'] as const) {
      const fixture = githubUpdateFixture(kind);
      expect(fixture.ok).toBe(kind !== 'http-error');
      expect(fixture.status).toBe(kind === 'http-error' ? 503 : 200);
      expect(appUpdatesModule.selectFirstStableGithubRelease(fixture.body, RELEASE_REPO)).toEqual({
        tag_name: 'v99.0.0',
        html_url: GITHUB_UPDATE_STABLE_URL,
        body: 'Local fixture notes',
      });
    }
  });

  it('accepts only a valid tag, HTTPS url, and draft === false / prerelease === false', () => {
    const parse = getReleaseParser();

    expect(parse(STABLE_V9)).toEqual({
      tag_name: 'v9.0.0',
      html_url: 'https://github.com/iworkforces/GogChat/releases/tag/v9.0.0',
      body: 'Release notes',
    });
    expect(parse({ ...STABLE_V9, draft: true })).toBeNull();
    expect(parse({ ...STABLE_V9, prerelease: true })).toBeNull();
    expect(parse({ ...STABLE_V9, draft: undefined, prerelease: false })).toBeNull();
    expect(parse({ ...STABLE_V9, draft: false, prerelease: undefined })).toBeNull();
    expect(
      parse({
        ...STABLE_V9,
        html_url: 'http://github.com/iworkforces/GogChat/releases/tag/v9.0.0',
      })
    ).toBeNull();
    expect(parse({ ...STABLE_V9, tag_name: '' })).toBeNull();
    expect(parse({ ...STABLE_V9, tag_name: 9 })).toBeNull();
    expect(parse(null)).toBeNull();
    expect(parse('v9.0.0')).toBeNull();
    expect(parse({ ...STABLE_V9, html_url: '' })).toBeNull();
    expect(parse({ ...STABLE_V9, html_url: `https://github.com/${'x'.repeat(2049)}` })).toBeNull();
    expect(parse({ ...STABLE_V9, html_url: 'https://[bad' })).toBeNull();
    expect(
      parse({
        ...STABLE_V9,
        html_url: 'https://evil.example/releases/tag/v9.0.0',
      })
    ).toBeNull();
    expect(
      parse({
        ...STABLE_V9,
        html_url: 'https://github.com.evil.example/releases/tag/v9.0.0',
      })
    ).toBeNull();
    expect(
      parse({
        ...STABLE_V9,
        html_url: 'https://github.com/iworkforces/GogChat/issues/1',
      })
    ).toBeNull();
    expect(
      parse({
        ...STABLE_V9,
        html_url: 'https://github.com/iworkforces/GogChat/releases/download/v9.0.0/GogChat.dmg',
      })
    ).toBeNull();
    expect(
      parse({
        ...STABLE_V9,
        html_url: 'https://user:pass@github.com/iworkforces/GogChat/releases/tag/v9.0.0',
      })
    ).toBeNull();
    expect(
      parse({
        ...STABLE_V9,
        html_url: 'https://github.com/iworkforces/GogChat/releases/tag/v9.0.0?asset=1',
      })
    ).toBeNull();
    expect(
      parse({
        ...STABLE_V9,
        html_url: 'https://github.com/other/repo/releases/tag/v9.0.0',
      })
    ).toBeNull();
    expect(
      parse({
        ...STABLE_V9,
        tag_name: 'v8.0.0',
        html_url: 'https://github.com/iworkforces/GogChat/releases/tag/v9.0.0',
      })
    ).toBeNull();
    expect(
      parse({
        ...STABLE_V9,
        html_url: 'https://www.github.com/iworkforces/GogChat/releases/tag/v9.0.0',
      })
    ).toEqual({
      tag_name: 'v9.0.0',
      html_url: 'https://github.com/iworkforces/GogChat/releases/tag/v9.0.0',
      body: 'Release notes',
    });
    const encodedTraversal =
      'v99.0.0%2F..%2F..%2F..%2F..%2Fother%2Frepo%2Freleases%2Fdownload%2Fx%2Fmalware';
    expect(
      parse({
        ...STABLE_V9,
        tag_name: 'v99.0.0/../../../../other/repo/releases/download/x/malware',
        html_url: `https://github.com/iworkforces/GogChat/releases/tag/${encodedTraversal}`,
      })
    ).toBeNull();
    expect(
      parse({
        ...STABLE_V9,
        html_url: 'https://github.com/iworkforces/GogChat/releases/tag/v9%2e0%2e0',
      })
    ).toBeNull();
    expect(
      parse({
        ...STABLE_V9,
        tag_name: '..',
        html_url: 'https://github.com/iworkforces/GogChat/releases/tag/%2e%2e',
      })
    ).toBeNull();
    expect(
      parse({
        ...STABLE_V9,
        tag_name: '../',
        html_url: 'https://github.com/iworkforces/GogChat/releases/tag/%2e%2e%2f',
      })
    ).toBeNull();
    expect(
      parse({
        ...STABLE_V9,
        tag_name: 'v1.0.0+build',
        html_url: 'https://github.com/iworkforces/GogChat/releases/tag/v1.0.0%2Bbuild',
      })
    ).toEqual({
      tag_name: 'v1.0.0+build',
      html_url: 'https://github.com/iworkforces/GogChat/releases/tag/v1.0.0%2Bbuild',
      body: 'Release notes',
    });
    expect(parse({ ...STABLE_V9, body: 12 })).toEqual({
      tag_name: 'v9.0.0',
      html_url: STABLE_V9.html_url,
    });
    expect(parse({ ...STABLE_V9, body: undefined })).toEqual({
      tag_name: 'v9.0.0',
      html_url: STABLE_V9.html_url,
    });
  });

  it('selects the first valid stable API entry and skips drafts, prereleases, and malformed rows', () => {
    const select = getReleaseSelector();

    expect(select({ tag_name: 'v9.0.0' })).toBeNull();
    expect(select([])).toBeNull();
    expect(
      select([
        { ...STABLE_V9, draft: true, tag_name: 'v10.0.0-draft' },
        { ...STABLE_V9, prerelease: true, tag_name: 'v10.0.0-rc.1' },
        { tag_name: 'nope' },
        {
          ...STABLE_V9,
          html_url: 'http://github.com/iworkforces/GogChat/releases/tag/v8.0.0',
          tag_name: 'v8.0.0',
        },
        STABLE_V9,
        { ...STABLE_V9, tag_name: 'v11.0.0' },
      ])
    ).toEqual({
      tag_name: 'v9.0.0',
      html_url: 'https://github.com/iworkforces/GogChat/releases/tag/v9.0.0',
      body: 'Release notes',
    });
  });
});

describe('checkForUpdatesManual', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isUpdateSessionDismissed).mockReturnValue(false);
    vi.mocked(presentUpdateDialog).mockResolvedValue({ response: 1 });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [STABLE_V9],
      })
    );
  });

  afterEach(() => {
    resetManualUpdateGateForTests();
    resetBackgroundShutdownForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows checking then new-release dialog when update exists', async () => {
    await checkForUpdatesManual();

    expect(presentUpdateDialog).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'checking' })
    );
    expect(presentUpdateDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'result',
        message: 'New release available',
        buttons: ['Download', 'Later'],
      })
    );
  });

  it('opens release page when user chooses Download', async () => {
    vi.mocked(presentUpdateDialog).mockImplementation(async (opts) => {
      if (opts.phase === 'result' && opts.buttons?.includes('Download')) {
        return { response: 0 };
      }
      return { response: -1 };
    });

    await checkForUpdatesManual();
    expect(openExternal).toHaveBeenCalledWith(
      'https://github.com/iworkforces/GogChat/releases/tag/v9.0.0'
    );
  });

  it('shows up-to-date when latest is not newer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [STABLE_CURRENT],
      })
    );

    await checkForUpdatesManual();
    expect(presentUpdateDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'result',
        message: expect.stringContaining('up to date'),
      })
    );
  });

  it('does not claim up to date when GitHub returns no stable release', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      })
    );

    await checkForUpdatesManual();
    expect(presentUpdateDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        message: 'No stable release found',
      })
    );
    expect(presentUpdateDialog).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('up to date'),
      })
    );
  });

  it('shows error dialog when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));

    await checkForUpdatesManual();
    expect(presentUpdateDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        message: 'Couldn’t check for updates',
      })
    );
  });

  it('never opens a URL for malformed, draft-only, or prerelease-only payloads', async () => {
    vi.mocked(presentUpdateDialog).mockImplementation(async (opts) => {
      if (opts.phase === 'result' && opts.buttons?.includes('Download')) {
        return { response: 0 };
      }
      return { response: -1 };
    });

    const payloads: unknown[] = [
      { not: 'an-array' },
      [
        {
          tag_name: 'v9.0.0',
          html_url: 'https://github.com/iworkforces/GogChat/releases/tag/v9.0.0',
          draft: true,
          prerelease: false,
        },
      ],
      [
        {
          tag_name: 'v9.0.0',
          html_url: 'https://github.com/iworkforces/GogChat/releases/tag/v9.0.0',
          draft: false,
          prerelease: true,
        },
      ],
    ];

    for (const payload of payloads) {
      vi.mocked(openExternal).mockClear();
      vi.mocked(presentUpdateDialog).mockClear();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => payload,
        })
      );

      await checkForUpdatesManual();
      expect(openExternal).not.toHaveBeenCalled();
    }
  });

  it('opens only the first validated stable HTTPS release URL', async () => {
    vi.mocked(presentUpdateDialog).mockImplementation(async (opts) => {
      if (opts.phase === 'result' && opts.buttons?.includes('Download')) {
        return { response: 0 };
      }
      return { response: -1 };
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            ...STABLE_V9,
            draft: true,
            tag_name: 'v10.0.0-draft',
            html_url: 'https://github.com/iworkforces/GogChat/releases/tag/v10.0.0-draft',
          },
          {
            ...STABLE_V9,
            prerelease: true,
            tag_name: 'v10.0.0-rc.1',
            html_url: 'https://github.com/iworkforces/GogChat/releases/tag/v10.0.0-rc.1',
          },
          {
            ...STABLE_V9,
            tag_name: 'v8.0.0',
            html_url: 'http://github.com/iworkforces/GogChat/releases/tag/v8.0.0',
          },
          STABLE_V9,
        ],
      })
    );

    await checkForUpdatesManual();
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(
      'https://github.com/iworkforces/GogChat/releases/tag/v9.0.0'
    );
  });

  it('aborts a hung fetch at 10 seconds, settles terminal UI, and releases the gate', async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort(new DOMException('The operation was aborted.', 'TimeoutError'));
      }, ms);
      return controller.signal;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => hungFetch(init))
    );

    const first = checkForUpdatesManual();
    await Promise.resolve();
    await Promise.resolve();

    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    expect(presentUpdateDialog).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'checking' })
    );

    await vi.advanceTimersByTimeAsync(9_999);
    expect(presentUpdateDialog).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' })
    );

    await vi.advanceTimersByTimeAsync(1);
    await first;

    expect(presentUpdateDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        phase: 'result',
        message: 'Couldn’t check for updates',
      })
    );

    timeoutSpy.mockRestore();
    vi.useRealTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [STABLE_V9],
      })
    );
    vi.mocked(presentUpdateDialog).mockClear();

    await checkForUpdatesManual();
    expect(presentUpdateDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'result',
        message: 'New release available',
      })
    );
  });

  it('releases the gate after timeout, malformed payload, empty list, HTTP failure, dismissal, and completion', async () => {
    const scenarios: Array<{
      name: string;
      fetch: () => Promise<unknown>;
      dismissed?: boolean;
    }> = [
      {
        name: 'malformed',
        fetch: async () => ({ ok: true, json: async () => ({ nope: true }) }),
      },
      {
        name: 'empty',
        fetch: async () => ({ ok: true, json: async () => [] }),
      },
      {
        name: 'http-failure',
        fetch: async () => ({ ok: false, status: 503, json: async () => [STABLE_V9] }),
      },
      {
        name: 'dismissal',
        fetch: async () => ({ ok: true, json: async () => [STABLE_V9] }),
        dismissed: true,
      },
      {
        name: 'completion',
        fetch: async () => ({ ok: true, json: async () => [STABLE_V9] }),
      },
    ];

    for (const scenario of scenarios) {
      vi.mocked(presentUpdateDialog).mockClear();
      vi.mocked(isUpdateSessionDismissed).mockImplementation(() => scenario.dismissed === true);
      vi.stubGlobal('fetch', vi.fn(scenario.fetch));

      await checkForUpdatesManual();
      await checkForUpdatesManual();

      expect(presentUpdateDialog, scenario.name).toHaveBeenCalledWith(
        expect.objectContaining({ phase: 'checking' })
      );
      expect(vi.mocked(presentUpdateDialog).mock.calls.length, scenario.name).toBeGreaterThan(1);
      if (scenario.name === 'http-failure') {
        expect(presentUpdateDialog, scenario.name).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'Couldn’t check for updates' })
        );
        expect(presentUpdateDialog, scenario.name).not.toHaveBeenCalledWith(
          expect.objectContaining({ message: 'New release available' })
        );
      }
    }
  });

  it('returns immediately when a manual check is already in flight', async () => {
    let release!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      )
    );

    const first = checkForUpdatesManual();
    await vi.waitFor(() => expect(presentUpdateDialog).toHaveBeenCalled());
    const calls = vi.mocked(presentUpdateDialog).mock.calls.length;
    await checkForUpdatesManual();
    expect(vi.mocked(presentUpdateDialog).mock.calls.length).toBe(calls);
    release({ ok: true, json: async () => [STABLE_V9] });
    await first;
  });

  it('explains that updates are packaged-only when not packaged and not testing', async () => {
    const previousPackaged = app.isPackaged;
    const previousTesting = process.env['TESTING'];
    app.isPackaged = false;
    delete process.env['TESTING'];
    try {
      await checkForUpdatesManual();
      expect(presentUpdateDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Updates are only available in packaged installs',
          phase: 'result',
        })
      );
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    } finally {
      app.isPackaged = previousPackaged;
      if (previousTesting === undefined) {
        delete process.env['TESTING'];
      } else {
        process.env['TESTING'] = previousTesting;
      }
    }
  });

  it('shows a repository error when package metadata has no GitHub slug', async () => {
    vi.mocked(getPackageInfo).mockReturnValueOnce({
      repository: '',
      productName: 'GogChat',
    } as never);
    await checkForUpdatesManual();
    expect(presentUpdateDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        detail: 'Repository URL is missing or invalid in package metadata.',
      })
    );
  });

  it('does not open a second error dialog when the user dismissed during a failed fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    vi.mocked(isUpdateSessionDismissed).mockReturnValue(true);
    await checkForUpdatesManual();
    expect(presentUpdateDialog).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'checking' })
    );
    expect(presentUpdateDialog).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' })
    );
  });

  it('omits empty release notes from the download detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ ...STABLE_V9, body: '   ' }],
      })
    );
    await checkForUpdatesManual();
    expect(presentUpdateDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'New release available',
        detail: expect.not.stringMatching(/\n\n/),
      })
    );
  });
});

describe('update prompt snooze', () => {
  const NOW = Date.parse('2026-03-01T12:00:00Z');
  const DAY = 86_400_000;
  const MAX_DELAY = 2_147_483_647;
  const SNOOZE_TIMER = 'appUpdates-snooze-expiry';
  const config: Record<string, unknown> = {};
  let failWrites = false;

  type FetchBody = { ok: boolean; json: () => Promise<unknown> };

  async function flush(): Promise<void> {
    for (let turn = 0; turn < 25; turn += 1) {
      await Promise.resolve();
    }
  }

  function snoozeTimers(): Array<{ fire: () => void; delay: number; id: unknown }> {
    const calls = mockCreateTrackedTimeout.mock.calls as unknown as unknown[][];
    return calls.flatMap((call, index) =>
      call[2] === SNOOZE_TIMER
        ? [
            {
              fire: call[0] as () => void,
              delay: call[1] as number,
              id: mockCreateTrackedTimeout.mock.results[index]?.value,
            },
          ]
        : []
    );
  }

  function lastSnoozeTimer(): { fire: () => void; delay: number; id: unknown } {
    const timer = snoozeTimers().at(-1);
    if (!timer) throw new Error('no snooze expiry timer was created');
    return timer;
  }

  function heldFetch(): { fetchMock: ReturnType<typeof vi.fn>; release: (index?: number) => void } {
    const pending: Array<(value: FetchBody) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<FetchBody>((resolve) => {
          pending.push(resolve);
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    return {
      fetchMock,
      release: (index = 0) => pending[index]?.({ ok: true, json: async () => [STABLE_V9] }),
    };
  }

  function immediateFetch(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [STABLE_V9] });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function initialCheckTick(): () => void {
    const calls = mockCreateTrackedTimeout.mock.calls as unknown as unknown[][];
    const call = calls.find((entry) => entry[2] === 'appUpdates-initial-check');
    if (!call) throw new Error('initial check was not scheduled');
    return call[0] as () => void;
  }

  function dailyTick(): () => void {
    return timerCallback(mockCreateTrackedInterval.mock.calls);
  }

  function startWith(deadline: number): void {
    config['app.updateSnoozedUntil'] = deadline;
    appUpdates();
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    config['app.autoCheckForUpdates'] = true;
    config['app.updateSnoozedUntil'] = 0;
    failWrites = false;
    vi.mocked(configGet).mockImplementation(((key: string) => config[key]) as never);
    vi.mocked(configSet).mockImplementation(((key: string, value: unknown) => {
      if (failWrites) throw new Error('https://user:pass@evil.example/disk-full');
      config[key] = value;
    }) as never);
    resetManualUpdateGateForTests();
    resetBackgroundShutdownForTests();
    vi.mocked(isUpdateSessionDismissed).mockReturnValue(false);
    vi.mocked(presentUpdateDialog).mockResolvedValue({ response: 1 });
    vi.mocked(openExternal).mockResolvedValue(undefined);
    vi.mocked(getPackageInfo).mockReturnValue({
      repository: 'https://github.com/iworkforces/GogChat',
      productName: 'GogChat',
    } as never);
    appUpdates();
    vi.clearAllMocks();
    immediateFetch();
  });

  afterEach(() => {
    resetManualUpdateGateForTests();
    resetBackgroundShutdownForTests();
    startWith(0);
    vi.mocked(configGet).mockReset();
    vi.mocked(configGet).mockReturnValue(true);
    vi.mocked(configSet).mockReset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('Preferences actions', () => {
    it('registers dedicated typed actions that are not the manual-check action', () => {
      expect(registeredActions['snoozeUpdatePrompts']?.handler).toBe(snoozeUpdatePrompts);
      expect(registeredActions['resumeUpdatePrompts']?.handler).toBe(resumeUpdatePrompts);
      expect(registeredActions['checkForUpdates']?.handler).not.toBe(snoozeUpdatePrompts);
    });

    it('stores wall time plus 86,400,000 ms and arms one expiry timer without touching auto-check', () => {
      expect(snoozeUpdatePrompts()).toBe(true);

      expect(configSet).toHaveBeenCalledTimes(1);
      expect(configSet).toHaveBeenCalledWith('app.updateSnoozedUntil', NOW + DAY);
      expect(config['app.autoCheckForUpdates']).toBe(true);
      expect(snoozeTimers()).toHaveLength(1);
      expect(lastSnoozeTimer().delay).toBe(DAY);
    });

    it('replaces the expiry timer when snoozed again', () => {
      snoozeUpdatePrompts();
      const first = lastSnoozeTimer();
      vi.setSystemTime(NOW + 1000);

      snoozeUpdatePrompts();

      expect(mockCancelTrackedTimeout).toHaveBeenCalledWith(first.id);
      expect(snoozeTimers()).toHaveLength(2);
      expect(config['app.updateSnoozedUntil']).toBe(NOW + 1000 + DAY);
    });

    it('stores zero on resume, cancels the timer, and leaves auto-check alone', () => {
      snoozeUpdatePrompts();
      const timer = lastSnoozeTimer();

      expect(resumeUpdatePrompts()).toBe(true);

      expect(configSet).toHaveBeenLastCalledWith('app.updateSnoozedUntil', 0);
      expect(mockCancelTrackedTimeout).toHaveBeenCalledWith(timer.id);
      expect(snoozeTimers()).toHaveLength(1);
      expect(config['app.autoCheckForUpdates']).toBe(true);
      expect(mockRefreshMenu).toHaveBeenCalledTimes(1);
    });

    it('leaves policy, timer, and auto-check intact when persisting a snooze fails', async () => {
      failWrites = true;

      expect(snoozeUpdatePrompts()).toBe(false);

      expect(config['app.updateSnoozedUntil']).toBe(0);
      expect(snoozeTimers()).toHaveLength(0);
      expect(config['app.autoCheckForUpdates']).toBe(true);
      expect(loggedText()).toContain('[redacted]');
      expect(loggedText()).not.toContain('evil.example');
      await runBackgroundUpdateCheck();
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    it('keeps an active snooze and its timer when persisting a resume fails', async () => {
      snoozeUpdatePrompts();
      const timer = lastSnoozeTimer();
      mockCancelTrackedTimeout.mockClear();
      failWrites = true;

      expect(resumeUpdatePrompts()).toBe(false);

      expect(config['app.updateSnoozedUntil']).toBe(NOW + DAY);
      expect(mockCancelTrackedTimeout).not.toHaveBeenCalled();
      expect(snoozeTimers()).toEqual([expect.objectContaining({ id: timer.id })]);
      await runBackgroundUpdateCheck();
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(mockRefreshMenu).not.toHaveBeenCalled();
    });

    it('does not invalidate an in-flight fetch when the snooze write fails', async () => {
      const { release } = heldFetch();
      const pending = runBackgroundUpdateCheck();
      failWrites = true;
      snoozeUpdatePrompts();

      release();
      await pending;

      expect(presentUpdateDialog).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'New release available' })
      );
    });
  });

  describe('background eligibility', () => {
    it('suppresses background fetches while snoozed without queueing catch-up work', async () => {
      config['app.updateSnoozedUntil'] = NOW + 1;

      await runBackgroundUpdateCheck();

      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expectNoUpdateUi();
      vi.setSystemTime(NOW + 1);
      await flush();
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it.each([
      ['inactive', 0],
      ['expired', NOW - 1],
      ['exactly now', NOW],
    ])('runs the check when the deadline is %s', async (_label, deadline) => {
      config['app.updateSnoozedUntil'] = deadline;

      await runBackgroundUpdateCheck();

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      expect(presentUpdateDialog).toHaveBeenCalledTimes(1);
    });

    it('suppresses the prompt of a fetch that was in flight when the snooze began', async () => {
      const { fetchMock, release } = heldFetch();
      const pending = runBackgroundUpdateCheck();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      snoozeUpdatePrompts();
      release();
      await pending;

      expectNoUpdateUi();
    });

    it('suppresses that prompt even when the user resumes before the fetch finishes', async () => {
      const { fetchMock, release } = heldFetch();
      const pending = runBackgroundUpdateCheck();

      snoozeUpdatePrompts();
      resumeUpdatePrompts();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      release();
      await pending;

      expectNoUpdateUi();
      const next = immediateFetch();
      await runBackgroundUpdateCheck();
      expect(next).toHaveBeenCalledTimes(1);
      expect(presentUpdateDialog).toHaveBeenCalledTimes(1);
    });

    it('releases the session gate so a later check can prompt after a suppressed fetch', async () => {
      const { release } = heldFetch();
      const pending = runBackgroundUpdateCheck();
      snoozeUpdatePrompts();
      release();
      await pending;

      immediateFetch();
      resumeUpdatePrompts();
      await flush();

      expect(vi.mocked(presentUpdateDialog)).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'New release available' })
      );
    });

    it('leaves an already-visible prompt open and functional after a snooze', async () => {
      let answer!: (value: { response: number }) => void;
      vi.mocked(presentUpdateDialog).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          })
      );
      const pending = runBackgroundUpdateCheck();
      await vi.waitFor(() => expect(presentUpdateDialog).toHaveBeenCalledTimes(1));

      snoozeUpdatePrompts();
      answer({ response: 0 });
      await pending;

      expect(openExternal).toHaveBeenCalledWith(STABLE_V9.html_url);
    });

    it('keeps blocking on disabled auto-check and shutdown while the snooze is inactive', async () => {
      config['app.autoCheckForUpdates'] = false;
      await runBackgroundUpdateCheck();
      config['app.autoCheckForUpdates'] = true;
      fireBeforeQuit();
      await runBackgroundUpdateCheck();

      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });
  });

  describe('expiry timer', () => {
    it('restores a future deadline on initialization with one capped-safe timer', () => {
      startWith(NOW + 5000);

      expect(snoozeTimers()).toHaveLength(1);
      expect(lastSnoozeTimer().delay).toBe(5000);
      expect(mockCreateTrackedTimeout).toHaveBeenCalledWith(
        expect.any(Function),
        5000,
        'appUpdates-initial-check'
      );
    });

    it.each([
      ['inactive', 0],
      ['already expired', NOW - 1],
    ])('arms no expiry timer for an %s restored deadline', (_label, deadline) => {
      startWith(deadline);

      expect(snoozeTimers()).toHaveLength(0);
    });

    it('uses the normal startup check for an already-expired restored deadline', async () => {
      startWith(NOW - 1);
      await flush();
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();

      initialCheckTick()();
      await flush();

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      expect(mockRefreshMenu).not.toHaveBeenCalled();
    });

    it('skips the startup check while snoozed and offers one check at expiry', async () => {
      startWith(NOW + 60_000);
      initialCheckTick()();
      await flush();
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();

      vi.setSystemTime(NOW + 60_000);
      lastSnoozeTimer().fire();
      await flush();

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      expect(presentUpdateDialog).toHaveBeenCalledTimes(1);
      expect(mockRefreshMenu).toHaveBeenCalledTimes(1);
    });

    it('offers at most one check per consumed expiry', async () => {
      startWith(NOW + 1000);
      const timer = lastSnoozeTimer();
      vi.setSystemTime(NOW + 1000);

      timer.fire();
      await flush();
      timer.fire();
      await flush();

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      expect(snoozeTimers()).toHaveLength(1);
    });

    it('caps the delay and re-arms from the wall clock until the deadline', async () => {
      const deadline = NOW + 40 * DAY;
      startWith(deadline);
      expect(lastSnoozeTimer().delay).toBe(MAX_DELAY);

      vi.setSystemTime(NOW + MAX_DELAY);
      lastSnoozeTimer().fire();
      await flush();
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(snoozeTimers()).toHaveLength(2);
      expect(lastSnoozeTimer().delay).toBe(deadline - (NOW + MAX_DELAY));

      vi.setSystemTime(deadline);
      lastSnoozeTimer().fire();
      await flush();
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    it('re-arms with the remaining wall time when the clock moved backward', async () => {
      startWith(NOW + 10_000);
      vi.setSystemTime(NOW - 50_000);

      lastSnoozeTimer().fire();
      await flush();

      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(lastSnoozeTimer().delay).toBe(60_000);
      expect(snoozeTimers()).toHaveLength(2);
    });

    it('does not queue the expiry check behind a held session gate', async () => {
      const { release } = heldFetch();
      const manual = checkForUpdatesManual();
      await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
      startWith(NOW + 1000);
      vi.setSystemTime(NOW + 1000);

      lastSnoozeTimer().fire();
      release();
      await manual;
      await flush();

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    it('offers one check on early resume and queues nothing behind a held gate', async () => {
      snoozeUpdatePrompts();
      const { release } = heldFetch();
      const manual = checkForUpdatesManual();
      await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));

      resumeUpdatePrompts();
      release();
      await manual;
      await flush();

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    it('offers one check on early resume when the gate is free', async () => {
      snoozeUpdatePrompts();

      resumeUpdatePrompts();
      await flush();

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      expect(presentUpdateDialog).toHaveBeenCalledTimes(1);
    });

    it('does not request a check when resuming without an active snooze', async () => {
      resumeUpdatePrompts();
      await flush();

      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(mockRefreshMenu).not.toHaveBeenCalled();
    });

    it('replaces the timer and the resume listener on repeated initialization', () => {
      startWith(NOW + 10_000);
      const first = lastSnoozeTimer();
      const firstListener = [...powerListeners][0];
      expect(powerListeners.size).toBe(1);

      appUpdates();

      expect(mockCancelTrackedTimeout).toHaveBeenCalledWith(first.id);
      expect(snoozeTimers()).toHaveLength(2);
      expect(powerMonitor.removeListener).toHaveBeenCalledWith('resume', firstListener);
      expect(powerListeners.size).toBe(1);
      expect([...powerListeners][0]).not.toBe(firstListener);
      expect(mockAddTrackedListener).toHaveBeenLastCalledWith(
        powerMonitor,
        'resume',
        expect.any(Function),
        'appUpdates-snooze-resume'
      );
    });
  });

  describe('reconciliation points', () => {
    it('consumes an expiry that passed during sleep when the system resumes', async () => {
      startWith(NOW + 3_600_000);
      vi.setSystemTime(NOW + 4_000_000);

      for (const listener of powerListeners) listener();
      await flush();

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      expect(mockRefreshMenu).toHaveBeenCalledTimes(1);
      for (const listener of powerListeners) listener();
      await flush();
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    it('re-arms on system resume while the deadline is still in the future', async () => {
      startWith(NOW + 3_600_000);
      vi.setSystemTime(NOW + 600_000);

      for (const listener of powerListeners) listener();
      await flush();

      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(lastSnoozeTimer().delay).toBe(3_000_000);
    });

    it('lets the scheduled check be the only check when the poll finds an expiry', async () => {
      startWith(NOW + 1000);
      vi.setSystemTime(NOW + 5000);

      dailyTick()();
      await flush();

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      expect(mockRefreshMenu).toHaveBeenCalledTimes(1);
    });

    it('keeps the poll suppressed and the timer armed while still snoozed', async () => {
      startWith(NOW + DAY);

      dailyTick()();
      await flush();

      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(lastSnoozeTimer().delay).toBe(DAY);
    });
  });

  describe('shutdown and manual checks', () => {
    it('offers nothing at expiry or resume once shutdown has latched', async () => {
      startWith(NOW + 1000);
      const timer = lastSnoozeTimer();
      fireBeforeQuit();
      vi.setSystemTime(NOW + 1000);

      timer.fire();
      resumeUpdatePrompts();
      for (const listener of powerListeners) listener();
      await flush();

      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(snoozeTimers()).toHaveLength(1);
      expectNoUpdateUi();
    });

    it('creates no expiry timer for a snooze persisted after the cleanup latch', () => {
      latchCleanupTask();

      expect(snoozeUpdatePrompts()).toBe(true);

      expect(snoozeTimers()).toHaveLength(0);
    });

    it('keeps Check For Updates available during a snooze and leaves the snooze alone', async () => {
      config['app.updateSnoozedUntil'] = NOW + DAY;

      await checkForUpdatesManual();

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      expect(presentUpdateDialog).toHaveBeenCalledWith(
        expect.objectContaining({ phase: 'checking' })
      );
      expect(presentUpdateDialog).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'New release available' })
      );
      expect(configSet).not.toHaveBeenCalled();
    });

    it('still lets a manual request wait for a background session started before a snooze', async () => {
      const { release } = heldFetch();
      const background = runBackgroundUpdateCheck();
      snoozeUpdatePrompts();
      const manual = checkForUpdatesManual();
      await flush();
      expect(presentUpdateDialog).not.toHaveBeenCalled();

      vi.stubGlobal('fetch', immediateFetch());
      release();
      await background;
      await manual;

      expect(presentUpdateDialog).toHaveBeenCalledWith(
        expect.objectContaining({ phase: 'checking' })
      );
    });
  });

  describe('Playwright hooks', () => {
    it('persists an arbitrary deadline through the real snooze path and reports state', async () => {
      const previous = process.env['TESTING'];
      const globals = globalThis as typeof globalThis & {
        __gogchatSetUpdateSnoozedUntil?: (deadline: number) => boolean;
        __gogchatGetUpdateSnoozeState?: () => {
          deadline: number;
          active: boolean;
          timerArmed: boolean;
        };
      };
      try {
        process.env['TESTING'] = 'true';
        installUpdateTestHooks();
        expect(globals.__gogchatGetUpdateSnoozeState?.()).toEqual({
          deadline: 0,
          active: false,
          timerArmed: false,
        });

        expect(globals.__gogchatSetUpdateSnoozedUntil?.(NOW + 1500)).toBe(true);

        expect(globals.__gogchatGetUpdateSnoozeState?.()).toEqual({
          deadline: NOW + 1500,
          active: true,
          timerArmed: true,
        });
        expect(lastSnoozeTimer().delay).toBe(1500);
        await runBackgroundUpdateCheck();
        expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      } finally {
        delete globals.__gogchatSetUpdateSnoozedUntil;
        delete globals.__gogchatGetUpdateSnoozeState;
        if (previous === undefined) {
          delete process.env['TESTING'];
        } else {
          process.env['TESTING'] = previous;
        }
      }
    });
  });
});
