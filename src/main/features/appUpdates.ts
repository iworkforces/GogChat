/**
 * Update checks — silent background poll plus manual “Check for Updates…”
 * via the native aurora update window. Both modes share one session gate and
 * the validated GitHub release pipeline.
 */

import { app } from 'electron';
import log from 'electron-log';
import { sanitizeLogError } from '../../shared/logSanitizer.js';
import { configGet, configSet } from '../config.js';
import {
  cancelTrackedInterval,
  cancelTrackedTimeout,
  createTrackedInterval,
  createTrackedTimeout,
  registerCleanupTask,
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
let initialCheck: ReturnType<typeof setTimeout> | null = null;
/**
 * One update session at a time. Taken before `beginUpdateDialogSession()` and
 * held through Download so another entry cannot clear that session's dismissal
 * flag or supersede its pending prompt. Released in `finally`.
 */
let updateSessionGate = false;
type UpdateSessionOwner = 'manual' | 'background';
let sessionOwner: UpdateSessionOwner | null = null;
/** One manual check waiting for a background session to finish. */
let manualWaiter: (() => void) | null = null;
let manualWaitGeneration = 0;
/** Latches on `before-quit` and the update cleanup task. */
let backgroundShutdown = false;

/** Test-only: release the shared session gate after a hung or aborted case. */
export function resetManualUpdateGateForTests(): void {
  updateSessionGate = false;
  sessionOwner = null;
  manualWaitGeneration += 1;
  const wake = manualWaiter;
  manualWaiter = null;
  wake?.();
}

/** Test-only: clear the shutdown latch without touching the session gate. */
export function resetBackgroundShutdownForTests(): void {
  backgroundShutdown = false;
}

function shutdownBlocksUpdateUi(): boolean {
  return backgroundShutdown;
}

function releaseUpdateSession(): void {
  updateSessionGate = false;
  sessionOwner = null;
  const wake = manualWaiter;
  if (wake) {
    void Promise.resolve().then(wake);
  }
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

/**
 * `https://github.com/<repo>/releases/tag/<tag>` only.
 * One tag segment, equal to `tagName` or its encodeURIComponent form.
 * Rejects userinfo, query, hash, other repos, `/releases/download`, `/latest`,
 * and any tag that decodes into `/`, `\`, `.`, or `..`.
 * `www.github.com` is stored as `github.com`.
 */
function canonicalGithubReleaseTagUrl(
  value: unknown,
  repo: string,
  tagName: string
): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    return null;
  }
  if (
    tagName.length === 0 ||
    tagName === '.' ||
    tagName === '..' ||
    tagName.includes('/') ||
    tagName.includes('\\')
  ) {
    return null;
  }
  const slash = repo.indexOf('/');
  if (slash <= 0 || slash !== repo.lastIndexOf('/') || slash === repo.length - 1) {
    return null;
  }
  const owner = repo.slice(0, slash);
  const name = repo.slice(slash + 1);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    return null;
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    return null;
  }
  const parts = parsed.pathname.split('/').filter((part) => part.length > 0);
  if (parts.length !== 5 || parts[0] !== owner || parts[1] !== name) {
    return null;
  }
  if (parts[2] !== 'releases' || parts[3] !== 'tag') {
    return null;
  }
  const rawTag = parts[4];
  if (!rawTag || rawTag === '.' || rawTag === '..') {
    return null;
  }
  let decodedTag: string;
  try {
    decodedTag = decodeURIComponent(rawTag);
  } catch {
    return null;
  }
  if (
    decodedTag !== tagName ||
    decodedTag.includes('/') ||
    decodedTag.includes('\\') ||
    decodedTag === '.' ||
    decodedTag === '..'
  ) {
    return null;
  }
  if (rawTag !== tagName && rawTag !== encodeURIComponent(tagName)) {
    return null;
  }
  return `https://github.com/${owner}/${name}/releases/tag/${encodeURIComponent(tagName)}`;
}

/**
 * Parse one GitHub Releases API object from untrusted JSON.
 * Requires a non-empty tag, a canonical tag URL for `repo`, and explicit stable flags.
 */
export function parseStableGithubRelease(value: unknown, repo: string): StableGithubRelease | null {
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
  const htmlUrl = canonicalGithubReleaseTagUrl(value['html_url'], repo, tagName);
  if (!htmlUrl) {
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

/** First valid stable entry in a GitHub Releases API array for `repo`. */
export function selectFirstStableGithubRelease(
  payload: unknown,
  repo: string
): StableGithubRelease | null {
  if (!Array.isArray(payload)) {
    return null;
  }
  for (const entry of payload) {
    const parsed = parseStableGithubRelease(entry, repo);
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
  return selectFirstStableGithubRelease(payload, repo);
}

function releaseAvailableDetail(latest: StableGithubRelease): string {
  const bodySnippet = (latest.body ?? '').trim().slice(0, 400);
  return [
    `Installed: v${app.getVersion()}`,
    `Latest: ${latest.tag_name}`,
    bodySnippet.length > 0 ? `\n${bodySnippet}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function openReleasePage(url: string, repo: string, tagName: string): Promise<void> {
  const canonical = canonicalGithubReleaseTagUrl(url, repo, tagName);
  if (!canonical) {
    log.error('[Updates] Refusing to open a non-release URL');
    return;
  }
  try {
    const validated = validateExternalURL(canonical);
    await openExternal(validated);
  } catch (err: unknown) {
    log.error('[Updates] Failed to open release URL:', sanitizeLogError(err));
  }
}

function canRunUpdateFetch(): boolean {
  return app.isPackaged || process.env['TESTING'] === 'true';
}

/**
 * User-initiated “Check for Updates…” from Help.
 * Always surfaces the native update dialog for terminal outcomes.
 */
export async function checkForUpdatesManual(): Promise<void> {
  // Another manual session stays a no-op. A background session is left untouched;
  // this click runs only after that session releases the gate.
  if (updateSessionGate && sessionOwner === 'manual') {
    return;
  }
  if (updateSessionGate && sessionOwner === 'background') {
    if (manualWaiter) {
      return;
    }
    const generation = manualWaitGeneration;
    await new Promise<void>((resolve) => {
      manualWaiter = resolve;
    });
    if (generation !== manualWaitGeneration) {
      return;
    }
    manualWaiter = null;
  }
  if (backgroundShutdown || updateSessionGate) {
    return;
  }
  updateSessionGate = true;
  sessionOwner = 'manual';

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
      log.error('[Updates] Manual check failed:', sanitizeLogError(err));
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

    const { response } = await presentUpdateDialog({
      type: 'info',
      title: 'GogChat Updates',
      message: 'New release available',
      detail: releaseAvailableDetail(latest),
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
      phase: 'result',
    });

    if (response === 0) {
      await openReleasePage(latest.html_url, repo, latest.tag_name);
    }
  } finally {
    releaseUpdateSession();
  }
}

/**
 * Scheduled update check. Silent unless a newer stable release exists:
 * no checking, up-to-date, or error window, and no rejected promise.
 */
export async function runBackgroundUpdateCheck(): Promise<void> {
  let acquired = false;
  try {
    if (!configGet('app.autoCheckForUpdates')) {
      return;
    }
    if (!canRunUpdateFetch()) {
      return;
    }
    if (shutdownBlocksUpdateUi()) {
      return;
    }
    if (updateSessionGate) {
      return;
    }
    updateSessionGate = true;
    sessionOwner = 'background';
    acquired = true;

    const pkg = getPackageInfo();
    const repo = githubRepoSlug(pkg.repository);
    if (!repo) {
      log.error('[Updates] Background check failed: repository metadata is missing');
      return;
    }

    let latest: StableGithubRelease | null;
    try {
      latest = await fetchLatestRelease(repo);
    } catch (err: unknown) {
      log.error('[Updates] Background check failed:', sanitizeLogError(err));
      return;
    }

    if (!configGet('app.autoCheckForUpdates') || shutdownBlocksUpdateUi()) {
      return;
    }
    if (!latest) {
      log.error('[Updates] Background check failed: no stable release');
      return;
    }
    if (!isVersionNewer(latest.tag_name, app.getVersion())) {
      return;
    }

    beginUpdateDialogSession();
    const { response } = await presentUpdateDialog({
      type: 'info',
      title: 'GogChat Updates',
      message: 'New release available',
      detail: releaseAvailableDetail(latest),
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
      phase: 'result',
    });

    if (shutdownBlocksUpdateUi()) {
      return;
    }
    if (response === 0) {
      await openReleasePage(latest.html_url, repo, latest.tag_name);
    }
  } catch (err: unknown) {
    log.error('[Updates] Background check failed:', sanitizeLogError(err));
  } finally {
    if (acquired) {
      releaseUpdateSession();
    }
  }
}

export default () => {
  if (initialCheck) cancelTrackedTimeout(initialCheck);
  if (interval) cancelTrackedInterval(interval);

  const runScheduledBackgroundCheck = (): void => {
    void runBackgroundUpdateCheck();
  };

  initialCheck = createTrackedTimeout(
    runScheduledBackgroundCheck,
    5000,
    'appUpdates-initial-check'
  );
  noteBackgroundCheckScheduled();

  interval = createTrackedInterval(
    runScheduledBackgroundCheck,
    1000 * 60 * 60 * 24,
    'appUpdates-daily-check'
  );
};

// Untracked on purpose: tracked removal runs before an in-flight check can see the latch.
if (typeof app.on === 'function') {
  app.on('before-quit', () => {
    backgroundShutdown = true;
  });
}

registerCleanupTask('appUpdates-suppress-prompts', () => {
  backgroundShutdown = true;
});

registerMenuAction('checkForUpdates', {
  label: 'Check For Updates',
  handler: () => {
    void checkForUpdatesManual();
  },
});

type UpdateTestGlobal = typeof globalThis & {
  __gogchatCheckForUpdatesManual?: typeof checkForUpdatesManual;
  __gogchatRunBackgroundUpdateCheck?: typeof runBackgroundUpdateCheck;
  __gogchatSetAutoCheckForUpdates?: (enabled: boolean) => void;
  __gogchatBackgroundCheckScheduledAt?: number;
};

function noteBackgroundCheckScheduled(): void {
  if (process.env['TESTING'] !== 'true') {
    return;
  }
  const testGlobal = asType<UpdateTestGlobal>(globalThis);
  testGlobal.__gogchatBackgroundCheckScheduledAt = Date.now();
}

/** Playwright seam. Installed only when `TESTING=true`. */
export function installUpdateTestHooks(): void {
  if (process.env['TESTING'] !== 'true') {
    return;
  }
  const testGlobal = asType<UpdateTestGlobal>(globalThis);
  testGlobal.__gogchatCheckForUpdatesManual = checkForUpdatesManual;
  testGlobal.__gogchatRunBackgroundUpdateCheck = runBackgroundUpdateCheck;
  testGlobal.__gogchatSetAutoCheckForUpdates = (enabled: boolean): void => {
    configSet('app.autoCheckForUpdates', enabled);
  };
}

installUpdateTestHooks();
