import type { BrowserWindow, IpcMainEvent, WebContents } from 'electron';
import { Notification, app } from 'electron';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'node:url';
import log from 'electron-log';
import { IPC_CHANNELS, TIMING } from '../../shared/constants.js';
import { validateOnlineCheckRequest } from '../../shared/dataValidators.js';
import { sanitizeLogError } from '../../shared/logSanitizer.js';
import type { OnlineProbeResult, OnlineStatusData } from '../../shared/types/domain.js';
import { defineIPC } from '../utils/ipc/defineIPC.js';
import { createTrackedTimeout, cancelTrackedTimeout } from '../utils/lifecycle/resourceCleanup.js';
import { getIconCache } from '../utils/platform/iconCache.js';
import type { IAccountWindowManager } from '../../shared/types/window.js';
import { asAccountIndex } from '../../shared/types/branded.js';
import { loadAccountURLAndWait } from '../utils/account/accountNavigation.js';
import { asType } from '../../shared/typeUtils.js';

let checkIfOnlineCleanup: (() => void) | null = null;

/** Min gap between generate_204 fetches per sender. Applied after supersession. */
export const ONLINE_FETCH_MIN_INTERVAL_MS = 1_000;

interface ActiveOnlineProbe {
  attemptId: string;
  generation: number;
  controller: AbortController;
  sender: WebContents;
  onDestroyed: () => void;
  coalesceTimer: NodeJS.Timeout | null;
}

/** At most one in-flight probe per sender. Different senders stay independent. */
const activeProbes = new Map<number, ActiveOnlineProbe>();
const lastFetchStartedAt = new Map<number, number>();
let nextProbeGeneration = 1;

function clearCoalesceTimer(probe: ActiveOnlineProbe): void {
  if (probe.coalesceTimer === null) {
    return;
  }
  cancelTrackedTimeout(probe.coalesceTimer);
  probe.coalesceTimer = null;
}

function abortActiveProbe(senderId: number, clearFetchGate = false): void {
  const existing = activeProbes.get(senderId);
  if (existing) {
    clearCoalesceTimer(existing);
    existing.controller.abort();
    try {
      existing.sender.removeListener('destroyed', existing.onDestroyed);
    } catch {
      // Sender may already be gone.
    }
    activeProbes.delete(senderId);
  }
  if (clearFetchGate) {
    lastFetchStartedAt.delete(senderId);
  }
}

function abortAllProbes(): void {
  for (const senderId of activeProbes.keys()) {
    abortActiveProbe(senderId, true);
  }
  lastFetchStartedAt.clear();
}

function senderIsGone(sender: WebContents): boolean {
  try {
    return sender.isDestroyed();
  } catch {
    return true;
  }
}

/** External cancellation is not a probe outcome: callers drop it silently. */
type ProbeSettlement = OnlineProbeResult | { readonly outcome: 'cancelled' };

const CANCELLED: ProbeSettlement = { outcome: 'cancelled' };

/** Only a real 3xx-5xx status is reportable; anything else (e.g. 0) is a failed request. */
function isHttpErrorStatus(status: unknown): status is number {
  return typeof status === 'number' && Number.isInteger(status) && status >= 300 && status <= 599;
}

/**
 * Probe internet connectivity using native fetch.
 * Uses Google's generate_204 endpoint which is designed for connectivity checks.
 * Success stays `response.ok`; the probe's own deadline is `timeout`; an abort of
 * `externalSignal` settles as `cancelled`.
 */
const probeOnline = async (
  timeout: number = TIMING.CONNECTIVITY_CHECK_FAST,
  externalSignal?: AbortSignal
): Promise<ProbeSettlement> => {
  const controller = new AbortController();
  let deadlineElapsed = false;
  const timeoutId = setTimeout(() => {
    deadlineElapsed = true;
    controller.abort();
  }, timeout);
  const onExternalAbort = (): void => {
    controller.abort();
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timeoutId);
      return CANCELLED;
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const response = await fetch('https://www.google.com/generate_204', {
      method: 'HEAD',
      signal: controller.signal,
      cache: 'no-cache',
    });
    if (externalSignal?.aborted) {
      return CANCELLED;
    }
    if (deadlineElapsed) {
      return { outcome: 'timeout' };
    }
    if (response.ok) {
      return { outcome: 'online' };
    }
    return isHttpErrorStatus(response.status)
      ? { outcome: 'http-error', httpStatus: response.status }
      : { outcome: 'network-error' };
  } catch {
    if (externalSignal?.aborted) {
      return CANCELLED;
    }
    const settlement: ProbeSettlement = deadlineElapsed
      ? { outcome: 'timeout' }
      : { outcome: 'network-error' };
    log.debug(`[Connectivity] Probe failed: ${settlement.outcome}`);
    return settlement;
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
};

function replyIfCurrent(
  event: IpcMainEvent,
  sender: WebContents,
  senderId: number,
  generation: number,
  status: OnlineStatusData,
  controller: AbortController
): void {
  if (controller.signal.aborted) {
    return;
  }
  const current = activeProbes.get(senderId);
  if (!current || current.generation !== generation) {
    return;
  }
  try {
    if (senderIsGone(sender)) {
      return;
    }
    event.reply(IPC_CHANNELS.ONLINE_STATUS, status);
  } catch {
    // Send raced a destroy between the liveness check and reply.
  }
}

function beginProbeFetch(
  event: IpcMainEvent,
  sender: WebContents,
  senderId: number,
  probe: ActiveOnlineProbe
): void {
  const { attemptId, generation, controller } = probe;
  lastFetchStartedAt.set(senderId, Date.now());

  void (async () => {
    try {
      log.debug('[Connectivity] Checking online status...');
      const settlement = await probeOnline(TIMING.CONNECTIVITY_CHECK, controller.signal);
      if (settlement.outcome === 'cancelled') {
        return;
      }
      replyIfCurrent(event, sender, senderId, generation, { attemptId, ...settlement }, controller);
      log.debug(`[Connectivity] Online status: ${settlement.outcome}`);
    } catch (error: unknown) {
      log.error('[Connectivity] Failed to handle checkIfOnline:', sanitizeLogError(error));
      replyIfCurrent(
        event,
        sender,
        senderId,
        generation,
        { attemptId, outcome: 'network-error' },
        controller
      );
    } finally {
      const current = activeProbes.get(senderId);
      if (current?.generation === generation) {
        abortActiveProbe(senderId);
      }
    }
  })();
}

function startSenderProbe(attemptId: string, event: IpcMainEvent): void {
  const sender = event.sender;
  if (!sender) {
    return;
  }
  const senderId = sender.id;
  if (typeof senderId !== 'number') {
    return;
  }

  abortActiveProbe(senderId);

  if (senderIsGone(sender)) {
    return;
  }

  const controller = new AbortController();
  const generation = nextProbeGeneration;
  nextProbeGeneration += 1;
  const onDestroyed = (): void => {
    abortActiveProbe(senderId, true);
  };

  try {
    sender.once('destroyed', onDestroyed);
  } catch {
    return;
  }

  const probe: ActiveOnlineProbe = {
    attemptId,
    generation,
    controller,
    sender,
    onDestroyed,
    coalesceTimer: null,
  };
  activeProbes.set(senderId, probe);

  const lastStarted = lastFetchStartedAt.get(senderId);
  const now = Date.now();
  if (lastStarted === undefined || now - lastStarted >= ONLINE_FETCH_MIN_INTERVAL_MS) {
    beginProbeFetch(event, sender, senderId, probe);
    return;
  }

  const waitMs = ONLINE_FETCH_MIN_INTERVAL_MS - (now - lastStarted);
  probe.coalesceTimer = createTrackedTimeout(
    () => {
      probe.coalesceTimer = null;
      const current = activeProbes.get(senderId);
      if (!current || current.generation !== generation) {
        return;
      }
      if (current.controller.signal.aborted || senderIsGone(sender)) {
        return;
      }
      beginProbeFetch(event, sender, senderId, current);
    },
    waitMs,
    `online-probe-coalesce-${senderId}`
  );
}

function captureInitialDocument(manager: IAccountWindowManager) {
  const accountIndex = asAccountIndex(0);
  const contents = manager.getAccountWebContents(accountIndex);
  const controller = new AbortController();
  let active = true;
  let expectedNavigation: string | null = null;
  let delay: NodeJS.Timeout | null = null;
  let notification: Notification | null = null;

  const disposeBanner = (): void => {
    notification?.removeListener('click', onClick);
    notification?.close();
    notification = null;
  };
  const dispose = (): void => {
    if (!active) return;
    active = false;
    controller.abort();
    if (delay) cancelTrackedTimeout(delay);
    delay = null;
    contents?.removeListener('did-start-navigation', onNavigation);
    contents?.removeListener('destroyed', dispose);
    disposeBanner();
  };
  const isCurrent = (): boolean => {
    if (
      !active ||
      !contents ||
      contents.isDestroyed() ||
      manager.isDehydrated(accountIndex) ||
      manager.getAccountWebContents(accountIndex) !== contents
    ) {
      dispose();
      return false;
    }
    return true;
  };
  const onClick = (): void => {
    if (isCurrent()) manager.focusAccount(accountIndex);
    disposeBanner();
  };
  const onNavigation = (details: { isMainFrame: boolean; url: string }): void => {
    if (!details.isMainFrame) return;
    if (expectedNavigation === details.url) {
      expectedNavigation = null;
      return;
    }
    dispose();
  };
  if (isCurrent()) {
    contents?.on('did-start-navigation', onNavigation);
    contents?.once('destroyed', dispose);
  }

  const run = async (): Promise<void> => {
    if (!isCurrent()) return;
    const fast = await probeOnline(TIMING.CONNECTIVITY_CHECK_FAST, controller.signal);
    if (!isCurrent() || fast.outcome === 'cancelled') return;
    if (fast.outcome === 'online') {
      dispose();
      return;
    }
    const confirmation = await probeOnline(TIMING.CONNECTIVITY_CHECK, controller.signal);
    if (!isCurrent() || confirmation.outcome === 'cancelled') return;
    if (confirmation.outcome === 'online') {
      dispose();
      return;
    }
    const offlinePagePath = path.join(app.getAppPath(), 'lib/offline/index.html');
    if (fs.existsSync(offlinePagePath)) {
      expectedNavigation = pathToFileURL(offlinePagePath).href;
      const loaded = await loadAccountURLAndWait(manager, accountIndex, expectedNavigation);
      expectedNavigation = null;
      if (!isCurrent()) return;
      if (!loaded) {
        dispose();
        return;
      }
    } else {
      log.error(
        `[Connectivity] Offline page missing at ${offlinePagePath} - staying on current page`
      );
    }
    if (!isCurrent()) return;
    notification = new Notification({
      title: 'GogChat',
      body: `You are offline.\nCheck your internet connection.`,
      silent: true,
      timeoutType: 'default',
      icon: getIconCache().getIcon('resources/icons/normal/256.png'),
    });
    notification.on('click', onClick);
    notification.show();
  };
  return {
    run,
    dispose,
    schedule: () => {
      if (isCurrent())
        delay = createTrackedTimeout(
          () => {
            delay = null;
            void run().catch((error: unknown) => {
              dispose();
              log.error('[Connectivity] Failed to check internet:', error);
            });
          },
          3000,
          'initial-connectivity-check'
        );
    },
  };
}

export function scheduleInitialConnectivity(manager: IAccountWindowManager): () => void {
  const owner = captureInitialDocument(manager);
  owner.schedule();
  return () => {
    owner.dispose();
    cleanupConnectivityHandler();
  };
}

const checkForInternet = (manager: IAccountWindowManager): Promise<void> =>
  captureInitialDocument(manager).run();

/**
 * Setup IPC handlers for connectivity checks
 */
export default (_window?: BrowserWindow) => {
  // No defineIPC rateLimit: a 1/s cap would drop a replacement before
  // same-sender supersession. Fetch cadence is gated after the handler runs.
  checkIfOnlineCleanup = defineIPC({
    kind: 'on',
    channel: IPC_CHANNELS.CHECK_IF_ONLINE,
    validator: validateOnlineCheckRequest,
    description: 'Connectivity check',
    handler: (data, event) => {
      if (!('reply' in event)) {
        return;
      }
      startSenderProbe(data.attemptId, event);
    },
  });
};

/**
 * Cleanup function for connectivity handler
 */
export function cleanupConnectivityHandler(): void {
  try {
    log.debug('[Connectivity] Cleaning up connectivity handler');
    abortAllProbes();
    if (checkIfOnlineCleanup) {
      checkIfOnlineCleanup();
      checkIfOnlineCleanup = null;
    }
    log.info('[Connectivity] Connectivity handler cleaned up');
  } catch (error: unknown) {
    log.error('[Connectivity] Failed to cleanup connectivity handler:', error);
  }
}

export { checkForInternet };

if (process.env['TESTING'] === 'true') {
  const testGlobal = asType<
    typeof globalThis & {
      __gogchatInitialConnectivity?: {
        checkForInternet: typeof checkForInternet;
        scheduleInitialConnectivity: typeof scheduleInitialConnectivity;
      };
    }
  >(globalThis);
  testGlobal.__gogchatInitialConnectivity = { checkForInternet, scheduleInitialConnectivity };
}
