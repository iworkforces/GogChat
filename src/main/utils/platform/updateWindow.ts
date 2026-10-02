/**
 * Native “Check for Updates…” dialog — data: HTML with brand aurora (About-style).
 * Hide-cached between presentations; force-destroyed on quit/tests.
 *
 * CSP: script-src 'none' — action buttons wired from main via executeJavaScript
 * + navigation sentinels (never load).
 */

import { BrowserWindow, app } from 'electron';
import fs from 'fs';
import path from 'path';
import log from 'electron-log';
import { APP_ICON_AURORA_CSS, appIconWithAuroraHtml } from '../../../shared/appIconAurora.js';
import { escapeHtml } from '../../../shared/escapeHtml.js';
import { DIALOG_BACKGROUND_COLOR, platformDialogChrome } from './dialogChrome.js';
import { cancelTrackedTimeout, createTrackedTimeout } from '../lifecycle/resourceCleanup.js';

/** Deadline for the checking-phase `loadURL` so a hung data: document cannot stall the poll. */
export const UPDATE_CHECKING_LOAD_TIMEOUT_MS = 5_000;

/** Compatible with electron dialog.showMessageBox options used by update checks. */
export type UpdateDialogOptions = {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning';
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
  title?: string;
  message: string;
  detail?: string;
  /**
   * Visual phase:
   * - checking — aurora active, no primary actions; returns immediately so the poll can run
   * - result — terminal outcome; optional action buttons (omit for dismiss-only via Escape)
   */
  phase?: 'checking' | 'result';
};

export type UpdateDialogResult = { response: number };

const ACTION_PREFIX = 'https://gogchat.local/__update_action__/';
const CLOSE_URL = 'https://gogchat.local/__update_close__';

let updateWindow: BrowserWindow | null = null;
/**
 * Generation for presentations. Bumped on each present, settle, and destroy so
 * in-flight loadURL completions never re-show or cancel a newer waiter.
 */
let dialogGeneration = 0;
/** Result-phase waiter (checking phase returns immediately and has no waiter). */
let pending: {
  gen: number;
  cancelId: number;
  resolve: (result: UpdateDialogResult) => void;
} | null = null;
/** Cancel index for the active presentation (Escape / traffic-light close). */
let activeCancelId = 0;
/** Button count for the active presentation (action sentinels clamped to this). */
let activeButtonCount = 0;
/** True while a presentUpdateDialog call is awaiting a user action. */
let dialogOpen = false;
/** Active visual phase (checking dismiss is tracked separately). */
let activePhase: 'checking' | 'result' = 'result';
/**
 * True when the user dismissed the window during a checking/progress presentation
 * before a terminal result was shown. Scoped to the current manual session.
 */
let sessionDismissed = false;

let iconDataUriCache: string | null = null;

function resolveAppIconPath(): string {
  const relative = path.join('resources', 'icons', 'normal', 'scalable.svg');
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath();
  const candidates = [
    path.join(base, relative),
    path.join(base, 'resources', 'icons', 'normal', '256.png'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0]!;
}

function getIconDataUri(): string {
  if (iconDataUriCache !== null) {
    return iconDataUriCache;
  }
  try {
    const iconPath = resolveAppIconPath();
    const bytes = fs.readFileSync(iconPath);
    if (iconPath.endsWith('.svg')) {
      iconDataUriCache = `data:image/svg+xml,${encodeURIComponent(bytes.toString('utf-8'))}`;
    } else {
      iconDataUriCache = `data:image/png;base64,${bytes.toString('base64')}`;
    }
  } catch (error: unknown) {
    log.error('[Update] Failed to load app icon:', error);
    iconDataUriCache =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  }
  return iconDataUriCache;
}

function hideUpdateWindow(win: BrowserWindow): void {
  if (!win.isDestroyed() && win.isVisible()) {
    win.hide();
  }
}

function resolvePending(response: number): void {
  const current = pending;
  pending = null;
  dialogOpen = false;
  if (current) {
    current.resolve({ response });
  }
}

/**
 * Invalidate in-flight load completions for the presentation that is settling,
 * then hide and resolve any result waiter.
 */
function settleAndHide(response: number): void {
  if (activePhase === 'checking') {
    sessionDismissed = true;
  }
  dialogGeneration += 1;
  const win = updateWindow;
  if (win && !win.isDestroyed()) {
    hideUpdateWindow(win);
  }
  resolvePending(response);
}

export function isUpdateDialogOpen(): boolean {
  return dialogOpen;
}

/** Whether the user closed the dialog during the in-flight checking phase. */
export function isUpdateSessionDismissed(): boolean {
  return sessionDismissed;
}

/** Clear dismiss flag before starting a new manual check presentation. */
export function beginUpdateDialogSession(): void {
  sessionDismissed = false;
}

function phaseFromOptions(options: UpdateDialogOptions): 'checking' | 'result' {
  if (options.phase === 'checking') return 'checking';
  return 'result';
}

function visualKind(options: UpdateDialogOptions): 'checking' | 'error' | 'success' | 'info' {
  const phase = phaseFromOptions(options);
  if (phase === 'checking') return 'checking';
  if (options.type === 'error') return 'error';
  const msg = options.message.toLowerCase();
  if (msg.includes('up to date')) return 'success';
  if (msg.includes('couldn’t') || msg.includes("couldn't") || msg.includes('could not')) {
    return 'error';
  }
  return 'info';
}

/**
 * Outer height by action row count (caller-supplied buttons only).
 * Dismiss-only results have no footer button — same compact height as checking.
 */
export function updateWindowHeightForButtonCount(buttonCount: number): number {
  if (buttonCount >= 2) return 400;
  if (buttonCount === 1) return 380;
  return 340;
}

function buildHtml(options: UpdateDialogOptions): string {
  const title = escapeHtml(options.title ?? 'GogChat Updates');
  const message = escapeHtml(options.message);
  const detailRaw = options.detail ?? '';
  const detail = escapeHtml(detailRaw);
  const buttons = options.buttons ?? [];
  const defaultId = options.defaultId ?? 0;
  const phase = phaseFromOptions(options);
  const kind = visualKind(options);
  const isChecking = phase === 'checking';
  const dismissOnly = !isChecking && buttons.length === 0;

  const statusLabel =
    kind === 'checking'
      ? 'Checking for updates'
      : kind === 'error'
        ? 'Something went wrong'
        : kind === 'success'
          ? 'You’re up to date'
          : '';

  const buttonHtml =
    isChecking || dismissOnly
      ? ''
      : buttons
          .map((label, index) => {
            const primary = index === defaultId;
            const cls = primary ? 'btn btn--primary' : 'btn';
            const safe = escapeHtml(label);
            return `<button type="button" class="${cls}" data-action="${index}" id="update-btn-${index}">${safe}</button>`;
          })
          .join('\n      ');

  const detailBlock =
    detailRaw.length > 0
      ? `<p class="detail" id="update-detail">${detail}</p>`
      : `<p class="detail detail--empty" id="update-detail" hidden></p>`;

  const checkingHint = isChecking
    ? `<p class="checking-hint" id="update-checking">This usually takes a few seconds…</p>
    <p class="dismiss-hint" id="update-dismiss-hint">Press Esc to close</p>`
    : dismissOnly
      ? `<p class="dismiss-hint" id="update-dismiss-hint">Press Esc to close</p>`
      : `<p class="checking-hint" id="update-checking" hidden></p>
    <p class="dismiss-hint" id="update-dismiss-hint" hidden></p>`;

  const ariaDescribedBy = [
    detailRaw.length > 0 ? 'update-detail' : '',
    isChecking ? 'update-checking' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'">
<title>${title}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    color-scheme: dark;
    --bg: ${DIALOG_BACKGROUND_COLOR};
    --text-primary: #f5f5f7;
    --text-secondary: #ebebf5;
    --text-tertiary: #98989d;
    --control-fill: rgba(255, 255, 255, 0.1);
    --control-fill-hover: rgba(255, 255, 255, 0.14);
    --control-border: rgba(255, 255, 255, 0.14);
    --accent: #0a84ff;
    --accent-fill: rgba(10, 132, 255, 0.85);
    --accent-fill-hover: rgba(10, 132, 255, 0.95);
    --edge: rgba(255, 255, 255, 0.08);
    --traffic-safe: 40px;
    --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  }
  @media (prefers-contrast: more) {
    :root {
      --text-secondary: var(--text-primary);
      --text-tertiary: var(--text-primary);
      --control-border: var(--text-primary);
    }
  }
  html, body { height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif;
    background: ${DIALOG_BACKGROUND_COLOR};
    color: var(--text-primary);
    display: flex;
    flex-direction: column;
    align-items: center;
    height: 100vh;
    overflow-y: auto;
    -webkit-app-region: drag;
    user-select: none;
    -webkit-user-select: none;
    -webkit-font-smoothing: antialiased;
    padding: var(--traffic-safe) 28px 16px;
    position: relative;
  }
  body::before {
    content: "";
    position: absolute;
    inset: 0 0 auto 0;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--edge), transparent);
    pointer-events: none;
  }
  .stage {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    margin-top: 4px;
    animation: update-in 0.32s var(--ease-out) both;
  }
  @keyframes update-in {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .stage { animation: none; }
  }
  ${APP_ICON_AURORA_CSS}
  .app-icon-aurora--update {
    margin-bottom: 12px;
  }
  .eyebrow {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-tertiary);
    margin-bottom: 6px;
  }
  h1 {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.25;
    text-align: center;
    margin-bottom: 6px;
    color: var(--text-primary);
    max-width: 280px;
  }
  .detail {
    font-size: 12px;
    font-weight: 400;
    color: var(--text-tertiary);
    text-align: center;
    line-height: 1.45;
    letter-spacing: 0.01em;
    max-width: 280px;
    margin-bottom: 0;
  }
  .detail--empty { display: none; }
  .checking-hint {
    font-size: 11px;
    color: var(--text-tertiary);
    text-align: center;
    margin-top: 4px;
    margin-bottom: 0;
    opacity: 0.85;
  }
  .dismiss-hint {
    font-size: 11px;
    color: var(--text-tertiary);
    text-align: center;
    margin-top: 8px;
    opacity: 0.75;
  }
  .actions {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    -webkit-app-region: no-drag;
    width: 100%;
    max-width: 220px;
    margin-top: 16px;
    padding-top: 0;
  }
  .actions:empty { display: none; }
  .btn {
    font-family: inherit;
    font-size: 13px;
    font-weight: 500;
    letter-spacing: -0.01em;
    padding: 7px 16px;
    border-radius: 6px;
    border: 0.5px solid var(--control-border);
    background: var(--control-fill);
    color: var(--text-primary);
    cursor: pointer;
    -webkit-app-region: no-drag;
    transition: background-color 0.12s ease, transform 0.1s var(--ease-out);
  }
  .btn:hover { background: var(--control-fill-hover); }
  .btn:active { transform: scale(0.97); }
  .btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .btn--primary {
    background: var(--accent-fill);
    border-color: transparent;
    color: #fff;
  }
  .btn--primary:hover { background: var(--accent-fill-hover); }
  @media (prefers-reduced-motion: reduce) {
    .btn { transition: none; }
    .btn:active { transform: none; }
  }
</style>
</head>
<body
  role="dialog"
  aria-modal="true"
  aria-labelledby="update-message"
  ${ariaDescribedBy ? `aria-describedby="${ariaDescribedBy}"` : ''}
  data-phase="${isChecking ? 'checking' : 'result'}"
  data-kind="${kind}"
>
  <div class="stage">
    ${appIconWithAuroraHtml(getIconDataUri(), {
      size: 88,
      className: 'app-icon-aurora--update app-icon-aurora--about',
    })}
    ${
      statusLabel.length > 0
        ? `<p class="eyebrow" id="update-eyebrow">${escapeHtml(statusLabel)}</p>`
        : `<p class="eyebrow" id="update-eyebrow" hidden></p>`
    }
    <h1 id="update-message">${message}</h1>
    ${detailBlock}
    ${checkingHint}
    <div class="actions" id="update-actions">
      ${buttonHtml}
    </div>
  </div>
</body>
</html>`;
}

function wireActionHandlers(win: BrowserWindow, buttonCount: number, defaultId: number): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  const parts: string[] = [];
  for (let i = 0; i < buttonCount; i++) {
    parts.push(
      `document.getElementById(${JSON.stringify(`update-btn-${i}`)})?.addEventListener("click",()=>{location.href=${JSON.stringify(`${ACTION_PREFIX}${i}`)};});`
    );
  }
  if (buttonCount > 0) {
    parts.push(`document.getElementById(${JSON.stringify(`update-btn-${defaultId}`)})?.focus();`);
  }
  void win.webContents.executeJavaScript(parts.join('')).catch(() => undefined);
}

const UPDATE_WINDOW_WIDTH = 340;
let activeWindowHeight = updateWindowHeightForButtonCount(0);

function presentWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (typeof win.setSize === 'function') {
    win.setSize(UPDATE_WINDOW_WIDTH, activeWindowHeight);
  }
  win.show();
  win.focus();
}

function ensureWindow(): BrowserWindow {
  if (updateWindow && !updateWindow.isDestroyed()) {
    return updateWindow;
  }

  const chrome = platformDialogChrome('update');
  const win = new BrowserWindow({
    width: UPDATE_WINDOW_WIDTH,
    height: activeWindowHeight,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: false,
    center: true,
    show: false,
    title: 'GogChat Updates',
    ...chrome,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.setMenuBarVisibility(false);

  const onNavigate = (event: { preventDefault: () => void; url: string }): void => {
    event.preventDefault();
    const { url } = event;
    if (url === CLOSE_URL) {
      settleAndHide(activeCancelId);
      return;
    }
    if (url.startsWith(ACTION_PREFIX)) {
      const raw = url.slice(ACTION_PREFIX.length);
      const index = Number.parseInt(raw, 10);
      if (Number.isFinite(index) && index >= 0 && index < activeButtonCount) {
        settleAndHide(index);
      }
    }
  };
  win.webContents.on('will-navigate', onNavigate);
  win.webContents.on('will-frame-navigate', onNavigate);

  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      settleAndHide(activeCancelId);
    }
  });

  win.on('close', (event) => {
    event.preventDefault();
    settleAndHide(activeCancelId);
  });

  win.on('closed', () => {
    if (updateWindow === win) {
      updateWindow = null;
    }
    if (pending) {
      const cancel = pending.cancelId;
      dialogGeneration += 1;
      resolvePending(cancel);
    }
  });

  updateWindow = win;
  return win;
}

/**
 * Show the native update dialog and resolve when the user picks a button,
 * presses Escape, or closes the window (cancelId).
 */
export async function presentUpdateDialog(
  options: UpdateDialogOptions
): Promise<UpdateDialogResult> {
  // Supersede any in-flight result waiter with *its* cancelId (not the new one).
  if (pending) {
    const prev = pending;
    pending = null;
    dialogOpen = false;
    prev.resolve({ response: prev.cancelId });
  }

  const phase = phaseFromOptions(options);
  const buttons = options.buttons ?? [];
  const cancelId = options.cancelId ?? (buttons.length > 0 ? buttons.length - 1 : 0);
  const defaultId = options.defaultId ?? 0;
  activeCancelId = cancelId;
  activeButtonCount = buttons.length;
  activePhase = phase;
  activeWindowHeight = updateWindowHeightForButtonCount(phase === 'checking' ? 0 : buttons.length);
  if (phase === 'checking') {
    sessionDismissed = false;
  }
  dialogOpen = true;
  const gen = ++dialogGeneration;

  const win = ensureWindow();
  const html = buildHtml({ ...options, buttons });
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

  if (phase === 'checking') {
    let loadTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        win.loadURL(url),
        new Promise<never>((_, reject) => {
          loadTimeout = createTrackedTimeout(
            () => {
              reject(new Error('checking dialog load timed out'));
            },
            UPDATE_CHECKING_LOAD_TIMEOUT_MS,
            'update-checking-load'
          );
        }),
      ]);
    } catch (err: unknown) {
      log.error('[Update] Failed to load update dialog:', err);
    } finally {
      if (loadTimeout !== undefined) {
        cancelTrackedTimeout(loadTimeout);
      }
    }
    if (!win.isDestroyed() && gen === dialogGeneration) {
      wireActionHandlers(win, 0, 0);
      presentWindow(win);
    }
    return { response: -1 };
  }

  return new Promise<UpdateDialogResult>((resolve) => {
    pending = { gen, cancelId, resolve };

    void win
      .loadURL(url)
      .catch((err: unknown) => {
        log.error('[Update] Failed to load update dialog:', err);
      })
      .then(() => {
        if (win.isDestroyed() || gen !== dialogGeneration) {
          return;
        }
        if (!pending || pending.gen !== gen) {
          return;
        }
        wireActionHandlers(win, buttons.length, defaultId);
        presentWindow(win);
      });
  });
}

/** Force-destroy the cached update window (shutdown / tests). */
export function destroyUpdateWindow(): void {
  dialogGeneration += 1;
  if (pending) {
    const p = pending;
    pending = null;
    dialogOpen = false;
    p.resolve({ response: p.cancelId });
  }
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.removeAllListeners('close');
    updateWindow.destroy();
  }
  updateWindow = null;
  dialogOpen = false;
  activePhase = 'result';
  activeButtonCount = 0;
  sessionDismissed = false;
  iconDataUriCache = null;
}

/** App version string for dialogs that mention it (pure helper for tests). */
export function updateDialogAppVersion(): string {
  return app.getVersion();
}
