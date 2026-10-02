/**
 * Update checks — background silent poll (electron-update-notifier) plus
 * manual “Check for Updates…” via the native aurora update window.
 */

import { app } from 'electron';
import { setUpdateNotification, checkForUpdates } from 'electron-update-notifier';
import log from 'electron-log';
import { configGet } from '../config.js';
import {
  cancelTrackedInterval,
  createTrackedInterval,
  createTrackedTimeout,
} from '../utils/lifecycle/resourceCleanup.js';
import { getPackageInfo } from '../utils/platform/packageInfo.js';
import {
  beginUpdateDialogSession,
  isUpdateSessionDismissed,
  presentUpdateDialog,
} from '../utils/platform/updateWindow.js';
import { asType } from '../../shared/typeUtils.js';
import { validateExternalURL } from '../../shared/urlValidators.js';
import { openExternal } from '../utils/security/shellWrapper.js';
import { registerMenuAction } from './menuActionRegistry.js';

let interval: ReturnType<typeof setInterval> | null = null;
/** Single-flight guard for manual check sessions. */
let manualGate = false;

/** Test-only: release the single-flight guard after a hung or aborted case. */
export function resetManualUpdateGateForTests(): void {
  manualGate = false;
}

/** Deadline for the user-initiated GitHub releases fetch. */
export const MANUAL_UPDATE_FETCH_TIMEOUT_MS = 10_000;

export interface StableGithubRelease {
  tag_name: string;
  html_url: string;
  body?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isGithubReleaseHtmlUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    return false;
  }
  try {
    const parsed = new URL(value);
    const host = parsed.hostname;
    if (parsed.protocol !== 'https:') {
      return false;
    }
    if (host !== 'github.com' && host !== 'www.github.com') {
      return false;
    }
    return /^\/[^/]+\/[^/]+\/releases\//.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Parse one GitHub Releases API object from untrusted JSON.
 * Requires a non-empty tag, an HTTPS html_url, and explicit stable flags.
 */
export function parseStableGithubRelease(value: unknown): StableGithubRelease | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value['draft'] !== false || value['prerelease'] !== false) {
    return null;
  }
  const tagName = value['tag_name'];
  if (typeof tagName !== 'string' || tagName.trim().length === 0) {
    return null;
  }
  const htmlUrl = value['html_url'];
  if (!isGithubReleaseHtmlUrl(htmlUrl)) {
    return null;
  }

  const release: StableGithubRelease = {
    tag_name: tagName,
    html_url: htmlUrl,
  };
  const body = value['body'];
  if (typeof body === 'string') {
    release.body = body;
  }
  return release;
}

/** First valid stable entry in a GitHub Releases API array. */
export function selectFirstStableGithubRelease(payload: unknown): StableGithubRelease | null {
  if (!Array.isArray(payload)) {
    return null;
  }
  for (const entry of payload) {
    const parsed = parseStableGithubRelease(entry);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

/** Extract `owner/repo` from a GitHub repository URL or `owner/repo` string. */
export function githubRepoSlug(repository: string): string | null {
  const trimmed = repository.trim();
  if (!trimmed) return null;

  // Bare owner/repo
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
      return null;
    }
    const parts = url.pathname
      .replace(/^\//, '')
      .replace(/\.git$/, '')
      .split('/')
      .filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
  } catch {
    return null;
  }
  return null;
}

/** Strip leading `v` and compare dotted numeric segments (semver-ish). */
export function isVersionNewer(latest: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map((p) => {
        const n = Number.parseInt(p, 10);
        return Number.isFinite(n) ? n : 0;
      });

  const a = parse(latest);
  const b = parse(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

async function fetchLatestRelease(repo: string): Promise<StableGithubRelease | null> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `GogChat/${app.getVersion()}`,
    },
    signal: AbortSignal.timeout(MANUAL_UPDATE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GitHub releases HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  return selectFirstStableGithubRelease(payload);
}

async function openReleasePage(url: string): Promise<void> {
  try {
    const validated = validateExternalURL(url);
    await openExternal(validated);
  } catch (err: unknown) {
    log.error('[Updates] Failed to open release URL:', err);
  }
}

/**
 * User-initiated “Check for Updates…” from Help / tray.
 * Always surfaces the native update dialog for terminal outcomes.
 */
export async function checkForUpdatesManual(): Promise<void> {
  if (manualGate) {
    return;
  }
  manualGate = true;

  try {
    beginUpdateDialogSession();

    if (!app.isPackaged && process.env['TESTING'] !== 'true') {
      await presentUpdateDialog({
        type: 'info',
        title: 'GogChat Updates',
        message: 'Updates are only available in packaged installs',
        detail: 'Run a packaged build (DMG) to check for and install updates.',
        buttons: [],
        phase: 'result',
      });
      return;
    }

    await presentUpdateDialog({
      type: 'info',
      title: 'GogChat Updates',
      message: 'Checking for updates…',
      phase: 'checking',
    });

    if (isUpdateSessionDismissed()) {
      return;
    }

    const pkg = getPackageInfo();
    const repo = githubRepoSlug(pkg.repository);
    if (!repo) {
      await presentUpdateDialog({
        type: 'error',
        title: 'GogChat Updates',
        message: 'Couldn’t check for updates',
        detail: 'Repository URL is missing or invalid in package metadata.',
        buttons: [],
        phase: 'result',
      });
      return;
    }

    let latest: StableGithubRelease | null;
    try {
      latest = await fetchLatestRelease(repo);
    } catch (err: unknown) {
      log.error('[Updates] Manual check failed:', err);
      if (isUpdateSessionDismissed()) return;
      await presentUpdateDialog({
        type: 'error',
        title: 'GogChat Updates',
        message: 'Couldn’t check for updates',
        detail: 'Check your network connection and try again. Details are in the log.',
        buttons: [],
        phase: 'result',
      });
      return;
    }

    if (isUpdateSessionDismissed()) {
      return;
    }

    if (!latest) {
      await presentUpdateDialog({
        type: 'error',
        title: 'GogChat Updates',
        message: 'No stable release found',
        detail:
          'GitHub returned no published stable releases. This does not mean the installed build is up to date.',
        buttons: [],
        phase: 'result',
      });
      return;
    }

    if (!isVersionNewer(latest.tag_name, app.getVersion())) {
      await presentUpdateDialog({
        type: 'info',
        title: 'GogChat Updates',
        message: `GogChat is up to date (v${app.getVersion()})`,
        detail: `Latest release on GitHub is ${latest.tag_name}.`,
        buttons: [],
        phase: 'result',
      });
      return;
    }

    const bodySnippet = (latest.body ?? '').trim().slice(0, 400);
    const detail = [
      `Installed: v${app.getVersion()}`,
      `Latest: ${latest.tag_name}`,
      bodySnippet.length > 0 ? `\n${bodySnippet}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const { response } = await presentUpdateDialog({
      type: 'info',
      title: 'GogChat Updates',
      message: 'New release available',
      detail,
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
      phase: 'result',
    });

    if (response === 0) {
      await openReleasePage(latest.html_url);
    }
  } finally {
    manualGate = false;
  }
}

export default () => {
  if (interval) cancelTrackedInterval(interval);

  const shouldCheckForUpdates = () => {
    return configGet('app.autoCheckForUpdates');
  };

  // Runs once at startup (silent system path via electron-update-notifier)
  createTrackedTimeout(
    () => {
      if (shouldCheckForUpdates()) {
        setUpdateNotification();
      }
    },
    5000,
    'appUpdates-initial-check'
  );

  interval = createTrackedInterval(
    () => {
      if (shouldCheckForUpdates()) {
        void checkForUpdates();
      }
    },
    1000 * 60 * 60 * 24,
    'appUpdates-daily-check'
  );
};

registerMenuAction('checkForUpdates', {
  label: 'Check For Updates',
  handler: () => {
    void checkForUpdatesManual();
  },
});

if (process.env['TESTING'] === 'true') {
  const testGlobal = asType<
    typeof globalThis & { __gogchatCheckForUpdatesManual?: typeof checkForUpdatesManual }
  >(globalThis);
  testGlobal.__gogchatCheckForUpdatesManual = checkForUpdatesManual;
}
