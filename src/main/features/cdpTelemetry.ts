/**
 * CDP Telemetry Feature
 *
 * Attaches the Chrome DevTools Protocol debugger to the account-0 webContents
 * and periodically samples `Performance.getMetrics`. All data is recorded
 * locally via {@link ../utils/cdpMetrics} — zero bytes leave the machine.
 *
 * Killable via `setDisableCdpTelemetry(true)` (safeStorage-backed). When the
 * user opens DevTools, the OS unilaterally detaches our debugger; we listen
 * for that and shut down gracefully without affecting the user.
 *
 * Phase: `deferred` and `required: false` — telemetry must never block startup
 * or crash the app. All failures are logged and swallowed.
 *
 * @module cdpTelemetry
 */

import type { WebContents } from 'electron';
import log from 'electron-log';
import { getDisableCdpTelemetry } from '../utils/security/secureFlags.js';
import {
  cancelTrackedInterval,
  createTrackedInterval,
} from '../utils/lifecycle/resourceCleanup.js';
import * as cdpMetrics from '../utils/lifecycle/cdpMetrics.js';
import { asAccountIndex } from '../../shared/types/branded.js';
import type { IAccountWindowManager } from '../../shared/types/window.js';
import { asType } from '../../shared/typeUtils.js';

/** Sampling cadence — 30s balances signal density against CDP overhead. */
const SAMPLE_INTERVAL_MS = 30_000;
/** Records older than this are pruned at attach time. */
const RETENTION_DAYS = 7;
/** CDP wire protocol version we negotiate with. */
const CDP_PROTOCOL_VERSION = '1.3';
/** Account we instrument in v1 (multi-account support is future work). */
const TARGET_ACCOUNT_INDEX = 0;

/** Shape of `Performance.getMetrics` reply we care about. */
interface PerformanceGetMetricsReply {
  metrics: Array<{ name: string; value: number }>;
}

/** Module-level handle so {@link teardownCdpTelemetry} can clean up on quit. */
interface TelemetryHandle {
  webContents: WebContents;
  interval: NodeJS.Timeout;
  detachListener: () => void;
}
let activeHandle: TelemetryHandle | null = null;

function flattenMetrics(reply: PerformanceGetMetricsReply): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { name, value } of reply.metrics) {
    out[name] = value;
  }
  return out;
}

/**
 * Attach CDP debugger to a webContents, enable Performance domain, and start
 * periodic sampling. Idempotent guard: returns false if already attached
 * (either by us or by an open DevTools window).
 */
async function setupCdpTelemetry(accountWC: WebContents): Promise<boolean> {
  if (getDisableCdpTelemetry()) {
    log.debug('[CdpTelemetry] Disabled via secure flag — skipping');
    return false;
  }

  if (accountWC.debugger.isAttached()) {
    log.warn('[CdpTelemetry] Debugger already attached (DevTools open?) — skipping');
    return false;
  }

  try {
    accountWC.debugger.attach(CDP_PROTOCOL_VERSION);
  } catch (error: unknown) {
    log.warn('[CdpTelemetry] debugger.attach failed:', error);
    return false;
  }

  try {
    await accountWC.debugger.sendCommand('Performance.enable');
  } catch (error: unknown) {
    log.warn('[CdpTelemetry] Performance.enable failed:', error);
    try {
      accountWC.debugger.detach();
    } catch {
      // best-effort cleanup
    }
    return false;
  }

  // Prune old samples once per attach — cheap, keeps file from growing across days.
  try {
    cdpMetrics.cleanupOldRecords(TARGET_ACCOUNT_INDEX, RETENTION_DAYS);
  } catch (error: unknown) {
    log.warn('[CdpTelemetry] cleanupOldRecords failed (non-fatal):', error);
  }

  const interval = createTrackedInterval(
    () => {
      void (async () => {
        if (!accountWC.debugger.isAttached()) return;
        try {
          const reply = asType<PerformanceGetMetricsReply>(
            await accountWC.debugger.sendCommand('Performance.getMetrics')
          );
          cdpMetrics.recordMetrics(TARGET_ACCOUNT_INDEX, flattenMetrics(reply));
        } catch (error: unknown) {
          // Sampling failure is non-fatal — log at debug to avoid noise.
          log.debug('[CdpTelemetry] sample failed:', error);
        }
      })();
    },
    SAMPLE_INTERVAL_MS,
    'cdp-telemetry-sample'
  );

  const detachListener = (): void => {
    log.info('[CdpTelemetry] Debugger detached — stopping sampling');
    cancelTrackedInterval(interval);
    activeHandle = null;
  };
  accountWC.debugger.once('detach', detachListener);

  activeHandle = { webContents: accountWC, interval, detachListener };
  log.info('[CdpTelemetry] Attached & sampling every', SAMPLE_INTERVAL_MS, 'ms');
  return true;
}

/**
 * Detach the debugger and stop sampling. Safe to call multiple times and
 * during shutdown; all errors are swallowed.
 */
export function teardownCdpTelemetry(): void {
  if (!activeHandle) return;
  const { webContents: wc, interval, detachListener } = activeHandle;
  activeHandle = null;
  try {
    cancelTrackedInterval(interval);
  } catch {
    // ignore
  }
  try {
    wc.debugger.removeListener('detach', detachListener);
  } catch {
    // ignore
  }
  try {
    if (!wc.isDestroyed() && wc.debugger.isAttached()) {
      wc.debugger.detach();
    }
  } catch (error: unknown) {
    log.debug('[CdpTelemetry] detach during teardown failed (non-fatal):', error);
  }
}

/**
 * Feature entry point. Locates account-0 via the window manager, then attaches
 * the debugger. Non-required: returns silently if the account is missing or
 * the debugger cannot be attached. Returns a cleanup callback the
 * featureRunner registers for graceful shutdown.
 */
export default async function initCdpTelemetry(
  accountWindowManager: IAccountWindowManager | undefined
): Promise<(() => void) | undefined> {
  if (!accountWindowManager) {
    log.debug('[CdpTelemetry] No account window manager — skipping');
    return undefined;
  }
  const wc = accountWindowManager.getAccountWebContents(asAccountIndex(TARGET_ACCOUNT_INDEX));
  if (!wc || wc.isDestroyed()) {
    log.debug('[CdpTelemetry] account-0 webContents unavailable — skipping');
    return undefined;
  }
  const attached = await setupCdpTelemetry(wc);
  return attached ? teardownCdpTelemetry : undefined;
}
