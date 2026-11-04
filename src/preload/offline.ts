/**
 * Offline page handler
 * Manages connectivity checks and restores the offline UI after a failed
 * recovery attempt without reloading the document. On an `online` result for the
 * current attempt, navigates once to the app URL via location.replace.
 * Older or unknown attemptIds cannot clear the deadline, restore retry, or navigate.
 */

import { ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/constants.js';
import { validateOnlineStatusData } from '../shared/dataValidators.js';
import { assertNever } from '../shared/typeUtils.js';
import type { OnlineStatusData } from '../shared/types/domain.js';
import urls from '../urls.js';

let unsubscribe: (() => void) | null = null;
let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
let deadlineFailed = false;
let currentAttemptId: string | null = null;
export const ONLINE_CHECK_DEADLINE_MS = 6_000;

function createAttemptId(): string {
  return globalThis.crypto.randomUUID();
}

function clearOnlineDeadline(): void {
  if (deadlineTimer !== null) {
    clearTimeout(deadlineTimer);
    deadlineTimer = null;
  }
}

/** Clears the in-flight attempt and its deadline. Used on unload and in tests. */
export function clearOfflineCheck(): void {
  currentAttemptId = null;
  deadlineFailed = false;
  clearOnlineDeadline();
}

function armOnlineDeadline(attemptId: string): void {
  clearOnlineDeadline();
  deadlineFailed = false;
  deadlineTimer = setTimeout(() => {
    deadlineTimer = null;
    if (currentAttemptId !== attemptId || deadlineFailed) {
      return;
    }
    deadlineFailed = true;
    currentAttemptId = null;
    dispatchCheckFailed({ outcome: 'timeout' });
  }, ONLINE_CHECK_DEADLINE_MS);
}

/**
 * DOM-only signal that a connectivity check failed.
 * The offline page listens, shows feedback for `detail`, and re-enables the
 * retry control. Does not reload the document.
 */
export const ONLINE_CHECK_FAILED_EVENT = 'app:onlineCheckFailed';

/** Failure categories the offline page can tell apart; `httpStatus` only for `http-error`. */
export type OnlineCheckFailedDetail =
  | { readonly outcome: 'http-error'; readonly httpStatus: number }
  | { readonly outcome: 'network-error' | 'timeout' };

function dispatchCheckFailed(detail: OnlineCheckFailedDetail): void {
  window.dispatchEvent(new CustomEvent(ONLINE_CHECK_FAILED_EVENT, { detail }));
}

/**
 * Handle online status response from main process.
 * Only the current attemptId may settle the deadline or change location.
 * `online` → single app-URL replacement. Any failure → DOM signal only (no reload).
 * Exported for unit tests.
 */
export const handleOnlineStatus = (status: OnlineStatusData): void => {
  if (currentAttemptId === null || status.attemptId !== currentAttemptId) {
    return;
  }
  clearOnlineDeadline();
  deadlineFailed = true;
  currentAttemptId = null;
  switch (status.outcome) {
    case 'online':
      window.location.replace(urls.appUrl);
      return;
    case 'http-error':
      dispatchCheckFailed({ outcome: status.outcome, httpStatus: status.httpStatus });
      return;
    case 'network-error':
    case 'timeout':
      dispatchCheckFailed({ outcome: status.outcome });
      return;
    default:
      assertNever(status);
  }
};

/**
 * Handle check connectivity button click from offline.html.
 * Starts a new attempt; older in-flight results become stale.
 * Exported for unit tests. Returns the new attemptId.
 */
export const handleCheckOnline = (): string => {
  const attemptId = createAttemptId();
  currentAttemptId = attemptId;
  armOnlineDeadline(attemptId);
  if (window.gogchat?.checkIfOnline) {
    window.gogchat.checkIfOnline(attemptId);
    return attemptId;
  }
  ipcRenderer.send(IPC_CHANNELS.CHECK_IF_ONLINE, { attemptId });
  return attemptId;
};

function cancelOnlineCheck(): void {
  const attemptId = currentAttemptId;
  if (attemptId === null) return;
  clearOfflineCheck();
  ipcRenderer.send(IPC_CHANNELS.CHECK_IF_ONLINE, { operation: 'cancel', attemptId });
}

export function installOffline(): void {
  window.addEventListener('DOMContentLoaded', () => {
    window.addEventListener('app:checkIfOnline', handleCheckOnline);
    window.addEventListener('app:cancelOnlineCheck', cancelOnlineCheck);

    if (window.gogchat?.onOnlineStatus) {
      unsubscribe = window.gogchat.onOnlineStatus(handleOnlineStatus);
    } else {
      const listener = (_event: Electron.IpcRendererEvent, data: unknown) => {
        try {
          handleOnlineStatus(validateOnlineStatusData(data));
        } catch {
          // Malformed or unknown payloads must not settle the current attempt.
        }
      };
      ipcRenderer.on(IPC_CHANNELS.ONLINE_STATUS, listener);
      unsubscribe = () => {
        ipcRenderer.removeListener(IPC_CHANNELS.ONLINE_STATUS, listener);
      };
    }
  });

  window.addEventListener('beforeunload', () => {
    window.removeEventListener('app:checkIfOnline', handleCheckOnline);
    window.removeEventListener('app:cancelOnlineCheck', cancelOnlineCheck);
    clearOfflineCheck();

    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  });
}
