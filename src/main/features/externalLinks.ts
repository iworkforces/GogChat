import type { BrowserWindow, HandlerDetails } from 'electron';
import { dialog } from 'electron';
import log from 'electron-log';
import { URL_PATTERNS, TIMING } from '../../shared/constants.js';
import {
  validateExternalURL,
  isWhitelistedHost,
  isGoogleAuthUrl,
} from '../../shared/urlValidators.js';
import {
  cancelTrackedInterval,
  createTrackedInterval,
} from '../utils/lifecycle/resourceCleanup.js';
import { watchBootstrapAccount } from '../utils/account/bootstrapWatcher.js';
import { asAccountIndex } from '../../shared/types/branded.js';
import {
  createAccountWindow,
  getAccountIndex,
  getAccountWindowManager,
} from '../utils/account/accountWindowManager.js';
import { loadAccountURL, getAccountURL } from '../utils/account/accountNavigation.js';
import {
  onAccountWebContentsCreated,
  setAccountWebContentsHooksManager,
} from '../utils/account/accountWebContentsHooks.js';
import { openExternal } from '../utils/security/shellWrapper.js';
import { registerMenuAction } from './menuActionRegistry.js';

let guardAgainstExternalLinks = true;
const RE_GUARD_IN_MINUTES = TIMING.EXTERNAL_LINKS_REGUARD / (60 * 1000);
let interval: NodeJS.Timeout | null = null;

const ACTION_DENIED = {
  action: 'deny' as const,
};

const ACTION_ALLOWED = {
  action: 'allow' as const,
};

/**
 * Extract hostname from URL safely
 */
function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    log.warn('[ExternalLinks] Failed to parse URL hostname:', url);
    return '';
  }
}

/**
 * Check if URL is a valid HTTP/HTTPS URL
 */
function isValidHttpURL(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function getAccountIndexFromUrl(input: string) {
  try {
    const parsed = new URL(input);
    const match = parsed.pathname.match(/^\/u\/(\d+)(?:\/|$)/);
    return asAccountIndex(match ? Number(match[1]) : 0);
  } catch {
    return asAccountIndex(0);
  }
}

function routeAccountUrl(window: BrowserWindow, url: string): boolean {
  const targetAccountIndex = getAccountIndexFromUrl(url);
  // Host window association (BW account window or WCV host → most-recent).
  // Used only to detect same-account opens; navigation always uses WC helpers.
  const currentAccountIndex = getAccountIndex(window) ?? asAccountIndex(0);

  if (targetAccountIndex === currentAccountIndex) {
    return false;
  }

  const manager = getAccountWindowManager();
  const accountExists = manager.hasAccount(targetAccountIndex);

  // Bootstrap mid-auth: focus only — never interrupt Google sign-in (WC-first URL).
  if (accountExists && manager.isBootstrap(targetAccountIndex)) {
    const currentUrl = getAccountURL(manager, targetAccountIndex);
    if (currentUrl !== null && isGoogleAuthUrl(currentUrl)) {
      manager.focusAccount(targetAccountIndex);
      log.info(
        `[ExternalLinks] Bootstrap auth already active for account ${targetAccountIndex} — skipping loadURL`
      );
      return true;
    }
  }

  if (!accountExists) {
    createAccountWindow(url, targetAccountIndex);
    manager.markAsBootstrap(targetAccountIndex);
    watchBootstrapAccount(targetAccountIndex);
    log.debug(`[ExternalLinks] Marked new account ${targetAccountIndex} window as bootstrap`);
  } else {
    // Hydrate first — dehydrated BW accounts have hasAccount=true but no live
    // WebContents, so loadAccountURL is a no-op until focus/hydrate recreates it.
    manager.focusAccount(targetAccountIndex);
    const currentUrl = getAccountURL(manager, targetAccountIndex);
    if (currentUrl !== url) {
      loadAccountURL(manager, targetAccountIndex, url);
    }
  }

  // Bring the target account UI forward (BW show/focus; WCV switch + unthrottle).
  manager.focusAccount(targetAccountIndex);

  log.info(
    `[ExternalLinks] Routed account URL to isolated account: ${currentAccountIndex} -> ${targetAccountIndex}`
  );

  return true;
}

/**
 * Check if URL should be opened externally
 */
function shouldOpenExternally(url: string, currentHost: string): boolean {
  const hostname = extractHostname(url);

  // Check if it's a download URL
  if (url.includes(URL_PATTERNS.DOWNLOAD)) {
    return true;
  }

  // Check if it's Gmail but not Chat
  const isGMailUrl = hostname === 'mail.google.com' && !url.startsWith(URL_PATTERNS.CHAT_PREFIX);

  if (isGMailUrl) {
    return true;
  }

  // Check if not whitelisted
  if (!isWhitelistedHost(url, currentHost)) {
    return true;
  }

  return false;
}

/**
 * Install open-handler + will-navigate guards on one account WebContents.
 * `hostWindow` is used for account routing / show-focus (BW account or WCV host).
 */
export function installExternalLinkGuards(
  webContents: Electron.WebContents,
  hostWindow: BrowserWindow
): () => void {
  const handleRedirect = (
    details: HandlerDetails
  ): typeof ACTION_DENIED | typeof ACTION_ALLOWED => {
    const url = details.url;

    if (!isValidHttpURL(url)) {
      log.warn('[ExternalLinks] Blocked non-HTTP URL:', url);
      return ACTION_DENIED;
    }

    if (!guardAgainstExternalLinks) {
      log.debug('[ExternalLinks] Guard disabled, allowing:', url);
      return ACTION_ALLOWED;
    }

    try {
      let currentHost = '';
      try {
        currentHost = extractHostname(webContents.getURL());
      } catch {
        currentHost = extractHostname(hostWindow.webContents.getURL());
      }

      if (extractHostname(url) === 'chat.google.com' && routeAccountUrl(hostWindow, url)) {
        return ACTION_DENIED;
      }

      if (shouldOpenExternally(url, currentHost)) {
        setImmediate(() => {
          try {
            const sanitizedURL = validateExternalURL(url);
            void openExternal(sanitizedURL);
            log.info('[ExternalLinks] Opened external URL:', sanitizedURL);
          } catch (error: unknown) {
            log.error('[ExternalLinks] Failed to open external URL:', error);
          }
        });

        return ACTION_DENIED;
      }

      log.debug('[ExternalLinks] Allowing whitelisted navigation:', url);
      return ACTION_ALLOWED;
    } catch (error: unknown) {
      log.error('[ExternalLinks] Error handling redirect:', error);
      return ACTION_DENIED;
    }
  };

  const onWillNavigate = (event: Electron.Event, url: string): void => {
    if (!isValidHttpURL(url)) {
      event.preventDefault();
      log.warn('[ExternalLinks] will-navigate: blocked non-HTTP URL:', url);
      return;
    }

    let currentHost: string;
    try {
      currentHost = extractHostname(webContents.getURL());
    } catch {
      currentHost = extractHostname(hostWindow.webContents.getURL());
    }

    if (extractHostname(url) === 'chat.google.com' && routeAccountUrl(hostWindow, url)) {
      event.preventDefault();
      return;
    }

    if (guardAgainstExternalLinks && shouldOpenExternally(url, currentHost)) {
      event.preventDefault();
      setImmediate(() => {
        try {
          const sanitizedURL = validateExternalURL(url);
          void openExternal(sanitizedURL);
          log.info('[ExternalLinks] will-navigate: Opened external URL:', sanitizedURL);
        } catch (error: unknown) {
          log.error('[ExternalLinks] will-navigate: Failed to open external URL:', error);
        }
      });
    }
  };

  webContents.setWindowOpenHandler(handleRedirect);
  webContents.on('will-navigate', onWillNavigate);

  return () => {
    try {
      if (!webContents.isDestroyed()) {
        webContents.removeListener('will-navigate', onWillNavigate);
        webContents.setWindowOpenHandler(() => ACTION_DENIED);
      }
    } catch {
      // webContents already gone
    }
  };
}

let hooksUnsub: (() => void) | null = null;

export default (window: BrowserWindow) => {
  const manager = getAccountWindowManager();
  setAccountWebContentsHooksManager(manager);

  if (hooksUnsub) {
    hooksUnsub();
    hooksUnsub = null;
  }

  hooksUnsub = onAccountWebContentsCreated(({ webContents, accountIndex }) => {
    const host = manager.getAccountWindow(accountIndex) ?? window;
    if (!host || host.isDestroyed()) {
      return;
    }
    return installExternalLinkGuards(webContents, host);
  });
};

const toggleExternalLinksGuard = (window: BrowserWindow) => {
  const actionLabel = guardAgainstExternalLinks ? 'Disable' : 'Enable';

  void dialog
    .showMessageBox(window, {
      type: 'warning',
      title: 'Confirm',
      message: 'Facing issues during authentication?',
      detail: `You can disable the external links security feature temporarily.\nDont forget to enable it back.\nIf you don't, it will be enabled automatically in ${RE_GUARD_IN_MINUTES} minutes.`,
      buttons: [`${actionLabel} Guard`, 'Close'],
      cancelId: 1,
      defaultId: 1,
    })
    .then(({ response }) => {
      if (response === 0) {
        guardAgainstExternalLinks = !guardAgainstExternalLinks;

        stopReGuardTimer();

        if (!guardAgainstExternalLinks) {
          startReGuardTimer();
        }

        logGuardStatus();
      }
    });
};

const logGuardStatus = () => {
  log.debug(`External links guard is set to: ${guardAgainstExternalLinks}`);
};

const stopReGuardTimer = () => {
  if (interval) {
    cancelTrackedInterval(interval);
    interval = null;
  }
};

const startReGuardTimer = () => {
  interval = createTrackedInterval(
    () => {
      guardAgainstExternalLinks = true;
      logGuardStatus();
    },
    1000 * 60 * RE_GUARD_IN_MINUTES,
    'externalLinks-reguard-timer'
  );
};

/**
 * Cleanup function for external links feature
 */
export function cleanupExternalLinks(): void {
  try {
    log.debug('[ExternalLinks] Cleaning up external links handler');
    if (hooksUnsub) {
      hooksUnsub();
      hooksUnsub = null;
    }
    setAccountWebContentsHooksManager(null);
    stopReGuardTimer();
    guardAgainstExternalLinks = true;
    log.info('[ExternalLinks] External links handler cleaned up');
  } catch (error: unknown) {
    log.error('[ExternalLinks] Failed to cleanup external links:', error);
  }
}

export { toggleExternalLinksGuard };

// Register toggle guard action in menu registry for appMenu consumption
// This replaces the direct feature→feature import boundary violation
registerMenuAction('toggleExternalLinksGuard', {
  label: 'Toggle External Links Guard',
  handler: (window: BrowserWindow) => toggleExternalLinksGuard(window),
});
