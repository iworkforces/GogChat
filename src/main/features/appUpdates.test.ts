/**
 * Unit tests for appUpdates feature.
 */
/* global AbortSignal, AbortController, RequestInit, RequestInfo, Response, URL */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron-update-notifier', () => ({
  setUpdateNotification: vi.fn(),
  checkForUpdates: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn().mockReturnValue('3.0.0'),
    isPackaged: true,
  },
}));

vi.mock('electron-log', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockCreateTrackedTimeout, mockCreateTrackedInterval } = vi.hoisted(() => ({
  mockCreateTrackedTimeout: vi.fn((fn: () => void) => {
    fn();
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }),
  mockCreateTrackedInterval: vi.fn((fn: () => void) => {
    fn();
    return 1 as unknown as ReturnType<typeof setInterval>;
  }),
}));

vi.mock('../utils/lifecycle/resourceCleanup.js', () => ({
  cancelTrackedInterval: (handle: NodeJS.Timeout) => clearInterval(handle),
  createTrackedTimeout: mockCreateTrackedTimeout,
  createTrackedInterval: mockCreateTrackedInterval,
}));

vi.mock('../config.js', () => ({
  configGet: vi.fn().mockReturnValue(true),
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
  registerMenuAction: vi.fn(),
}));

import appUpdates, {
  checkForUpdatesManual,
  githubRepoSlug,
  isVersionNewer,
  resetManualUpdateGateForTests,
} from './appUpdates';
import * as appUpdatesModule from './appUpdates';
import { setUpdateNotification, checkForUpdates } from 'electron-update-notifier';
import { app } from 'electron';
import { configGet } from '../config.js';
import { presentUpdateDialog, isUpdateSessionDismissed } from '../utils/platform/updateWindow.js';
import { openExternal } from '../utils/security/shellWrapper.js';
import { getPackageInfo } from '../utils/platform/packageInfo.js';

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

function getReleaseParser(): ReleaseParser {
  const parse = (appUpdatesModule as { parseStableGithubRelease?: ReleaseParser })
    .parseStableGithubRelease;
  expect(parse).toEqual(expect.any(Function));
  return parse as ReleaseParser;
}

function getReleaseSelector(): ReleaseParser {
  const select = (appUpdatesModule as { selectFirstStableGithubRelease?: ReleaseParser })
    .selectFirstStableGithubRelease;
  expect(select).toEqual(expect.any(Function));
  return select as ReleaseParser;
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

describe('appUpdates background', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(configGet).mockReturnValue(true);
  });

  it('schedules initial and daily checks', () => {
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

  it('skips checks when auto-check is disabled', () => {
    vi.mocked(configGet).mockReturnValue(false);
    appUpdates();
    expect(setUpdateNotification).not.toHaveBeenCalled();
    expect(checkForUpdates).not.toHaveBeenCalled();
  });

  it('calls setUpdateNotification and checkForUpdates when auto-check is enabled', () => {
    appUpdates();
    expect(setUpdateNotification).toHaveBeenCalled();
    expect(checkForUpdates).toHaveBeenCalled();
  });
});

describe('stable GitHub release parser', () => {
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
        fetch: async () => ({ ok: false, status: 503, json: async () => null }),
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

  it('does not change the background notifier schedule', () => {
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
    expect(setUpdateNotification).toHaveBeenCalled();
    expect(checkForUpdates).toHaveBeenCalled();
  });
});
