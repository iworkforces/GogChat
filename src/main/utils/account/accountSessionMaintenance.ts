/**
 * Account Session Maintenance — periodic clearCodeCaches on idle accounts (T11)
 *
 * Tracks per-account activity (focus/blur/show/hide) and periodically clears V8
 * code caches for accounts that have been idle beyond a threshold. This frees
 * memory tied to compiled JS without touching cookies, localStorage, or IDB.
 *
 * The {@link AccountActivityTracker} is a general-purpose timestamp registry —
 * T12 will reuse it with a different threshold (5 min) for window dehydration.
 *
 * @module accountSessionMaintenance
 */

import { app, session } from 'electron';
import log from 'electron-log';
import { cancelTrackedInterval, createTrackedInterval } from '../lifecycle/resourceCleanup.js';
import { toErrorMessage } from '../lifecycle/errorUtils.js';
import { asType } from '../../../shared/typeUtils.js';
import type { IAccountWindowManager } from '../../../shared/types/window.js';
import type { AccountIndex } from '../../../shared/types/branded.js';
import { toPartition } from '../../../shared/types/branded.js';

/** Tick interval for the maintenance scheduler (5 minutes). */
const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;

/** Idle threshold for clearCodeCaches (30 minutes). */
const IDLE_THRESHOLD_MS = 30 * 60 * 1000;

/** Idle threshold for full HTTP cache clearing (2 hours). */
const HTTP_CACHE_IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

/** Idle threshold for service worker storage clearing (6 hours). */
const SERVICE_WORKER_IDLE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/** Idle threshold for memory-pressure-triggered dehydration (30 seconds). */
const PRESSURE_IDLE_THRESHOLD_MS = 30 * 1000;

/**
 * Per-account activity timestamp registry.
 *
 * Records the last "activity" tick for each account index. Activity is signaled
 * externally (focus, blur, show, hide events from the BrowserWindow). The
 * tracker is purely passive — it stores millisecond timestamps and answers
 * idle-detection queries.
 */
export class AccountActivityTracker {
  private readonly lastActivity = new Map<AccountIndex, number>();

  /**
   * Stamp `Date.now()` as the most recent activity time for an account.
   */
  recordActivity(accountIndex: AccountIndex): void {
    this.lastActivity.set(accountIndex, Date.now());
  }

  /**
   * Get the most recent activity timestamp for an account, or undefined if
   * no activity has been recorded.
   */
  getLastActivity(accountIndex: AccountIndex): number | undefined {
    return this.lastActivity.get(accountIndex);
  }

  /**
   * Return account indices whose last activity is older than `thresholdMs`.
   *
   * Accounts in `excludeIndices` (e.g. accounts being interacted with right now)
   * are filtered out. Accounts with no recorded activity are NOT considered idle —
   * they have never been seen, so we have no signal to act on.
   */
  getIdleAccounts(thresholdMs: number, excludeIndices?: Set<AccountIndex>): AccountIndex[] {
    const now = Date.now();
    const idle: AccountIndex[] = [];
    for (const [accountIndex, lastTime] of this.lastActivity) {
      if (excludeIndices?.has(accountIndex)) {
        continue;
      }
      if (now - lastTime >= thresholdMs) {
        idle.push(accountIndex);
      }
    }
    return idle;
  }

  /**
   * Classify all tracked accounts by idle-tier in a single pass.
   *
   * Returns three index lists: indices idle past each provided threshold.
   * An account idle past `t3` is also reported in `t1` and `t2` lists.
   * Accounts in `excludeIndices` are filtered out from all tiers.
   *
   * This is a logic-efficiency helper for callers that need to evaluate the
   * same activity map against several thresholds on the same tick — it avoids
   * walking the map once per threshold.
   */
  classifyIdleAccounts(
    thresholds: { t1: number; t2: number; t3: number },
    excludeIndices?: Set<AccountIndex>
  ): { tier1: AccountIndex[]; tier2: AccountIndex[]; tier3: AccountIndex[] } {
    const now = Date.now();
    const tier1: AccountIndex[] = [];
    const tier2: AccountIndex[] = [];
    const tier3: AccountIndex[] = [];
    for (const [accountIndex, lastTime] of this.lastActivity) {
      if (excludeIndices?.has(accountIndex)) {
        continue;
      }
      const idleFor = now - lastTime;
      if (idleFor >= thresholds.t1) {
        tier1.push(accountIndex);
      }
      if (idleFor >= thresholds.t2) {
        tier2.push(accountIndex);
      }
      if (idleFor >= thresholds.t3) {
        tier3.push(accountIndex);
      }
    }
    return { tier1, tier2, tier3 };
  }

  /**
   * Drop all recorded activity. Used by the singleton destroyer.
   */
  clear(): void {
    this.lastActivity.clear();
  }
}

// ─── Maintenance scheduler ───────────────────────────────────────────────────

let maintenanceInterval: NodeJS.Timeout | null = null;
let pressureHandler: (() => void) | null = null;
let maintenanceOwner: IAccountWindowManager | null = null;

/**
 * Start the periodic maintenance scheduler.
 *
 * Every 5 minutes, every account that has been idle for >= 30 minutes (and is
 * NOT reported as a bootstrap account by `manager.getBootstrapAccounts()`) has its V8 code cache
 * cleared via `session.fromPartition('persist:account-N').clearCodeCaches()`.
 *
 * Calling this while a scheduler is already running is a no-op.
 */
export function startSessionMaintenance(
  tracker: AccountActivityTracker,
  manager: IAccountWindowManager
): void {
  if (maintenanceInterval) {
    return;
  }
  maintenanceOwner = manager;
  maintenanceInterval = createTrackedInterval(
    () => {
      // Build the active-accounts exclusion set once per tick. Bootstrap
      // accounts must never have their caches touched mid-auth.
      const bootstrapAccounts = new Set<AccountIndex>(manager.getBootstrapAccounts());

      // Single-pass classification of all idle accounts across the three tiers.
      // Bootstrap accounts are excluded by the set, so per-tier `isBootstrap`
      // re-checks are unnecessary inside the loops below.
      const {
        tier1: idleAccounts,
        tier2: twoHourIdle,
        tier3: sixHourIdle,
      } = tracker.classifyIdleAccounts(
        {
          t1: IDLE_THRESHOLD_MS,
          t2: HTTP_CACHE_IDLE_THRESHOLD_MS,
          t3: SERVICE_WORKER_IDLE_THRESHOLD_MS,
        },
        bootstrapAccounts
      );

      // ── Tier 1 — V8 code cache (idle >= 30 min) ─────────────────────
      for (const accountIndex of idleAccounts) {
        try {
          const partition = toPartition(accountIndex);
          void session.fromPartition(partition).clearCodeCaches({ urls: [] });
          log.debug(
            `[AccountSessionMaintenance] Cleared code cache for idle account ${accountIndex}`
          );
        } catch (error: unknown) {
          log.debug(
            `[AccountSessionMaintenance] clearCodeCaches failed for account ${accountIndex}: ${toErrorMessage(error)}`,
            error
          );
        }
      }

      // ── Tier 2 — Full HTTP cache (idle >= 2 hours) ────────
      for (const accountIndex of twoHourIdle) {
        try {
          const partition = toPartition(accountIndex);
          void session
            .fromPartition(partition)
            .clearCache()
            .then(() => {
              log.debug(
                `[AccountSessionMaintenance] Cleared HTTP cache for idle account ${accountIndex}`
              );
            })
            .catch((err: unknown) => {
              log.warn(
                `[AccountSessionMaintenance] clearCache failed for account ${accountIndex}: ${toErrorMessage(err)}`
              );
            });
        } catch (error: unknown) {
          log.warn(
            `[AccountSessionMaintenance] clearCache failed for account ${accountIndex}: ${toErrorMessage(error)}`
          );
        }
      }

      // ── Tier 3 — Service worker storage (idle >= 6 hours) ─
      for (const accountIndex of sixHourIdle) {
        try {
          const partition = toPartition(accountIndex);
          void session
            .fromPartition(partition)
            .clearStorageData({ storages: ['serviceworkers'] })
            .then(() => {
              log.info(
                `[AccountSessionMaintenance] Cleared service workers for idle account ${accountIndex}`
              );
            })
            .catch((err: unknown) => {
              log.warn(
                `[AccountSessionMaintenance] clearStorageData(serviceworkers) failed for account ${accountIndex}: ${toErrorMessage(err)}`
              );
            });
        } catch (error: unknown) {
          log.warn(
            `[AccountSessionMaintenance] clearStorageData(serviceworkers) failed for account ${accountIndex}: ${toErrorMessage(error)}`
          );
        }
      }
    },
    MAINTENANCE_INTERVAL_MS,
    'accountSessionMaintenance'
  );

  // Register memory pressure handler to shed idle renderers.
  // macOS sends 'memory-pressure' when the system is low on RAM. We dehydrate
  // idle non-primary accounts only — account-0 stays live for badge/notification
  // reliability (Open Q2 / KD3).
  pressureHandler = () => {
    const pressureIdle = tracker.getIdleAccounts(PRESSURE_IDLE_THRESHOLD_MS);
    let dehydratedCount = 0;
    for (const idx of pressureIdle) {
      // Never dehydrate account-0 under pressure (aligns with blur timer + WCV).
      if (Number(idx) === 0) {
        continue;
      }
      // Bootstrap accounts must never be dehydrated — they are mid-auth.
      if (manager.isBootstrap(idx)) {
        continue;
      }
      // Only dehydrate if the account is not already dehydrated.
      if (!manager.isDehydrated(idx)) {
        manager.dehydrateAccount(idx);
        dehydratedCount++;
      }
    }
    if (dehydratedCount > 0) {
      log.info(
        `[AccountSessionMaintenance] Memory pressure: dehydrated ${dehydratedCount} idle account(s)`
      );
    }
  };
  // Guard: in unit-test environments where `electron` is partially mocked,
  // `app` may be missing. Wrap registration so a missing export does not throw.
  try {
    asType<NodeJS.EventEmitter>(app).on('memory-pressure', pressureHandler);
  } catch (error: unknown) {
    log.debug(
      `[AccountSessionMaintenance] memory-pressure handler not registered: ${toErrorMessage(error)}`
    );
  }

  log.info(
    '[AccountSessionMaintenance] Scheduler started (5-min tick; thresholds: 30-min code cache, 2-hr HTTP cache, 6-hr service workers; memory-pressure handler armed)'
  );
}

/**
 * Stop the maintenance scheduler. Safe to call when not running.
 *
 * When `owner` is provided, no-op unless that instance started the scheduler.
 * Callers that must tear the process scheduler down (shutdown, tracker
 * destroy) omit `owner`.
 */
export function stopSessionMaintenance(owner?: IAccountWindowManager): void {
  if (owner !== undefined && maintenanceOwner !== null && owner !== maintenanceOwner) {
    return;
  }
  if (maintenanceInterval) {
    cancelTrackedInterval(maintenanceInterval);
    maintenanceInterval = null;
    log.info('[AccountSessionMaintenance] Scheduler stopped');
  }
  if (pressureHandler) {
    try {
      asType<NodeJS.EventEmitter>(app).removeListener('memory-pressure', pressureHandler);
    } catch {
      // app missing in test environments — ignore
    }
    pressureHandler = null;
  }
  maintenanceOwner = null;
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let tracker: AccountActivityTracker | null = null;

/**
 * Get or create the global activity tracker singleton.
 */
export function getAccountActivityTracker(): AccountActivityTracker {
  if (!tracker) {
    tracker = new AccountActivityTracker();
  }
  return tracker;
}

/**
 * Destroy the global activity tracker singleton and stop maintenance.
 */
export function destroyAccountActivityTracker(): void {
  stopSessionMaintenance();
  if (tracker) {
    tracker.clear();
    tracker = null;
  }
}
