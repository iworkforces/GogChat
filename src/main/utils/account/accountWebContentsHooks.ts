/**
 * Multi-account WebContents lifecycle hooks (KD13).
 *
 * Features that need per-account WC install (e.g. externalLinks) subscribe here.
 * Managers call notify after a live account WC is created; subscribe backfills
 * existing accounts via enumerateAccountWebContents.
 */

import type { WebContents } from 'electron';
import log from 'electron-log';
import type { AccountIndex } from '../../../shared/types/branded.js';
import type { AccountBackendKind, IAccountWindowManager } from '../../../shared/types/window.js';

export type AccountWcListener = (info: {
  accountIndex: AccountIndex;
  webContents: WebContents;
  backend: AccountBackendKind;
}) => void | (() => void);

const listeners = new Set<AccountWcListener>();
const removalListeners = new Set<(accountIndex: AccountIndex) => void>();
/** Disposers per listener per account index */
const disposers = new Map<AccountWcListener, Map<AccountIndex, () => void>>();

let managerRef: IAccountWindowManager | null = null;

/**
 * Optional: set manager for backfill on subscribe. Call after account bootstrap.
 */
export function setAccountWebContentsHooksManager(manager: IAccountWindowManager | null): void {
  managerRef = manager;
}

export function onAccountWebContentsCreated(listener: AccountWcListener): () => void {
  listeners.add(listener);
  // Backfill existing accounts
  if (managerRef) {
    try {
      for (const info of managerRef.enumerateAccountWebContents()) {
        invokeListener(listener, {
          accountIndex: info.accountIndex,
          webContents: info.webContents,
          backend: info.backend,
        });
      }
    } catch {
      log.warn('[AccountWebContentsHooks] Backfill failed');
    }
  }
  return () => {
    offAccountWebContentsCreated(listener);
  };
}

export function offAccountWebContentsCreated(listener: AccountWcListener): void {
  const byAccount = disposers.get(listener);
  if (byAccount) {
    for (const dispose of byAccount.values()) {
      try {
        dispose();
      } catch {
        // ignore
      }
    }
    disposers.delete(listener);
  }
  listeners.delete(listener);
}

function invokeListener(
  listener: AccountWcListener,
  info: {
    accountIndex: AccountIndex;
    webContents: WebContents;
    backend: AccountBackendKind;
  }
): void {
  try {
    const disposer = listener(info);
    if (typeof disposer === 'function') {
      let byAccount = disposers.get(listener);
      if (!byAccount) {
        byAccount = new Map();
        disposers.set(listener, byAccount);
      }
      const prev = byAccount.get(info.accountIndex);
      if (prev) {
        try {
          prev();
        } catch {
          // ignore
        }
      }
      byAccount.set(info.accountIndex, disposer);
    }
  } catch {
    log.error('[AccountWebContentsHooks] Listener failed');
  }
}

/**
 * Called by account managers after a new account WebContents is ready.
 */
export function notifyAccountWebContentsCreated(info: {
  accountIndex: AccountIndex;
  webContents: WebContents;
  backend: AccountBackendKind;
}): void {
  for (const listener of listeners) {
    invokeListener(listener, info);
  }
}

/**
 * Run disposers for one account (unregister / destroy path).
 */
export function notifyAccountWebContentsDestroyed(accountIndex: AccountIndex): void {
  for (const [listener, byAccount] of disposers) {
    const dispose = byAccount.get(accountIndex);
    if (dispose) {
      try {
        dispose();
      } catch {
        // ignore
      }
      byAccount.delete(accountIndex);
    }
    void listener;
  }
}

export function onAccountRemoved(listener: (accountIndex: AccountIndex) => void): () => void {
  removalListeners.add(listener);
  return () => {
    removalListeners.delete(listener);
  };
}

export function notifyAccountRemoved(accountIndex: AccountIndex): void {
  for (const listener of removalListeners) {
    try {
      listener(accountIndex);
    } catch {
      log.error('[AccountWebContentsHooks] Removal listener failed');
    }
  }
}

/** Test helper */
export function clearAccountWebContentsHooksForTests(): void {
  for (const listener of [...listeners]) {
    offAccountWebContentsCreated(listener);
  }
  listeners.clear();
  disposers.clear();
  removalListeners.clear();
  managerRef = null;
}
