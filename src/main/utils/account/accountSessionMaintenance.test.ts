/**
 * Unit tests for accountSessionMaintenance — activity tracker + 5-min scheduler.
 *
 * Covers:
 *   - AccountActivityTracker: recordActivity, getLastActivity, getIdleAccounts,
 *     excludeIndices filtering, clear semantics
 *   - startSessionMaintenance: 5-min tick scheduling, idle threshold (30 min),
 *     bootstrap exclusion, partition resolution
 *   - stopSessionMaintenance: idempotent
 *   - destroyAccountActivityTracker: clears interval + singleton
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const {
  mockClearCodeCaches,
  mockClearCache,
  mockClearStorageData,
  mockFromPartition,
  mockAppOn,
  mockAppRemoveListener,
  appListeners,
  maintenanceConfig,
} = vi.hoisted(() => {
  const maintenanceConfig = { mode: undefined as unknown, throwOnRead: false };
  const mockClearCodeCaches = vi.fn().mockResolvedValue(undefined);
  const mockClearCache = vi.fn().mockResolvedValue(undefined);
  const mockClearStorageData = vi.fn().mockResolvedValue(undefined);
  const mockFromPartition = vi.fn(() => ({
    clearCodeCaches: mockClearCodeCaches,
    clearCache: mockClearCache,
    clearStorageData: mockClearStorageData,
  }));
  const appListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const mockAppOn = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (!appListeners.has(event)) {
      appListeners.set(event, new Set());
    }
    appListeners.get(event)!.add(handler);
  });
  const mockAppRemoveListener = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    appListeners.get(event)?.delete(handler);
  });
  return {
    mockClearCodeCaches,
    mockClearCache,
    mockClearStorageData,
    mockFromPartition,
    mockAppOn,
    mockAppRemoveListener,
    appListeners,
    maintenanceConfig,
  };
});

vi.mock('electron', () => ({
  session: {
    fromPartition: mockFromPartition,
  },
  app: {
    on: mockAppOn,
    removeListener: mockAppRemoveListener,
  },
}));

vi.mock('../../config.js', () => ({
  configGet: vi.fn((key: string) => {
    if (maintenanceConfig.throwOnRead) {
      throw new Error('Store not initialized');
    }
    return key === 'app.sessionMaintenanceMode' ? maintenanceConfig.mode : undefined;
  }),
}));

vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import log from 'electron-log';
import {
  AccountActivityTracker,
  installSessionMaintenanceTestHooks,
  startSessionMaintenance,
  stopSessionMaintenance,
  getAccountActivityTracker,
  destroyAccountActivityTracker,
} from './accountSessionMaintenance';
import type { IAccountWindowManager } from '../../../shared/types/window.js';

const FIVE_MIN = 5 * 60 * 1000;
const THIRTY_MIN = 30 * 60 * 1000;
const TWO_HOURS = 2 * 60 * 60 * 1000;
const SIX_HOURS = 6 * 60 * 60 * 1000;

function makeManager(overrides: Partial<IAccountWindowManager> = {}): IAccountWindowManager {
  return {
    isBootstrap: vi.fn().mockReturnValue(false),
    registerWindow: vi.fn(),
    getAccountIndex: vi.fn().mockReturnValue(null),
    getAccountWindow: vi.fn().mockReturnValue(null),
    getAccountWebContents: vi.fn().mockReturnValue(null),
    getAccountForWebContents: vi.fn().mockReturnValue(null),
    focusAccount: vi.fn(),
    getAllWindows: vi.fn().mockReturnValue([]),
    getMostRecentWindow: vi.fn().mockReturnValue(null),
    hasAccount: vi.fn().mockReturnValue(false),
    unregisterAccount: vi.fn(),
    getAccountCount: vi.fn().mockReturnValue(0),
    destroyAll: vi.fn(),
    createAccountWindow: vi.fn(),
    markAsBootstrap: vi.fn(),
    promoteBootstrap: vi.fn().mockReturnValue(true),
    clearBootstrap: vi.fn(),
    getBootstrapAccounts: vi.fn().mockReturnValue([]),
    saveAccountWindowState: vi.fn(),
    getAccountWindowState: vi.fn().mockReturnValue(null),
    dehydrateAccount: vi.fn(),
    hydrateAccount: vi.fn().mockReturnValue(null),
    isDehydrated: vi.fn().mockReturnValue(false),
    enumerateAccountWebContents: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

describe('AccountActivityTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('recordActivity / getLastActivity', () => {
    it('returns undefined for accounts with no recorded activity', () => {
      const t = new AccountActivityTracker();
      expect(t.getLastActivity(0)).toBeUndefined();
    });

    it('records the current Date.now() on activity', () => {
      const t = new AccountActivityTracker();
      t.recordActivity(0);
      expect(t.getLastActivity(0)).toBe(Date.now());
    });

    it('overwrites the previous timestamp on subsequent activity', () => {
      const t = new AccountActivityTracker();
      t.recordActivity(0);
      const first = t.getLastActivity(0);
      vi.advanceTimersByTime(60_000);
      t.recordActivity(0);
      expect(t.getLastActivity(0)).toBe((first ?? 0) + 60_000);
    });

    it('tracks multiple accounts independently', () => {
      const t = new AccountActivityTracker();
      t.recordActivity(0);
      vi.advanceTimersByTime(1000);
      t.recordActivity(1);
      expect(t.getLastActivity(1)).toBe((t.getLastActivity(0) ?? 0) + 1000);
    });
  });

  describe('getIdleAccounts', () => {
    it('returns empty array when no accounts are tracked', () => {
      const t = new AccountActivityTracker();
      expect(t.getIdleAccounts(THIRTY_MIN)).toEqual([]);
    });

    it('does not consider accounts idle before threshold elapses', () => {
      const t = new AccountActivityTracker();
      t.recordActivity(0);
      vi.advanceTimersByTime(THIRTY_MIN - 1);
      expect(t.getIdleAccounts(THIRTY_MIN)).toEqual([]);
    });

    it('returns accounts idle beyond threshold', () => {
      const t = new AccountActivityTracker();
      t.recordActivity(0);
      t.recordActivity(1);
      vi.advanceTimersByTime(THIRTY_MIN);
      expect(t.getIdleAccounts(THIRTY_MIN).sort()).toEqual([0, 1]);
    });

    it('excludes accounts in excludeIndices set', () => {
      const t = new AccountActivityTracker();
      t.recordActivity(0);
      t.recordActivity(1);
      t.recordActivity(2);
      vi.advanceTimersByTime(THIRTY_MIN);
      expect(t.getIdleAccounts(THIRTY_MIN, new Set([1])).sort()).toEqual([0, 2]);
    });

    it('returns only the accounts past threshold when activity is mixed', () => {
      const t = new AccountActivityTracker();
      t.recordActivity(0);
      vi.advanceTimersByTime(THIRTY_MIN);
      t.recordActivity(1); // recent
      expect(t.getIdleAccounts(THIRTY_MIN)).toEqual([0]);
    });
  });

  describe('clear', () => {
    it('removes all recorded activity', () => {
      const t = new AccountActivityTracker();
      t.recordActivity(0);
      t.recordActivity(1);
      t.clear();
      expect(t.getLastActivity(0)).toBeUndefined();
      expect(t.getLastActivity(1)).toBeUndefined();
      expect(t.getIdleAccounts(0)).toEqual([]);
    });
  });

  describe('classifyIdleAccounts', () => {
    it('returns three empty tiers when no accounts are tracked', () => {
      const t = new AccountActivityTracker();
      const r = t.classifyIdleAccounts({ t1: 1, t2: 2, t3: 3 });
      expect(r).toEqual({ tier1: [], tier2: [], tier3: [] });
    });

    it('places each account in every tier whose threshold it has crossed', () => {
      const t = new AccountActivityTracker();
      t.recordActivity(0); // will be idle SIX_HOURS → all three tiers
      vi.advanceTimersByTime(SIX_HOURS - TWO_HOURS);
      t.recordActivity(1); // will be idle TWO_HOURS → tier1 + tier2
      vi.advanceTimersByTime(TWO_HOURS - THIRTY_MIN);
      t.recordActivity(2); // will be idle THIRTY_MIN → tier1 only
      vi.advanceTimersByTime(THIRTY_MIN);

      const r = t.classifyIdleAccounts({
        t1: THIRTY_MIN,
        t2: TWO_HOURS,
        t3: SIX_HOURS,
      });
      expect(r.tier1.sort()).toEqual([0, 1, 2]);
      expect(r.tier2.sort()).toEqual([0, 1]);
      expect(r.tier3.sort()).toEqual([0]);
    });

    it('excludes excludeIndices from all tiers', () => {
      const t = new AccountActivityTracker();
      t.recordActivity(0);
      t.recordActivity(1);
      t.recordActivity(2);
      vi.advanceTimersByTime(SIX_HOURS);

      const r = t.classifyIdleAccounts(
        { t1: THIRTY_MIN, t2: TWO_HOURS, t3: SIX_HOURS },
        new Set([1])
      );
      expect(r.tier1.sort()).toEqual([0, 2]);
      expect(r.tier2.sort()).toEqual([0, 2]);
      expect(r.tier3.sort()).toEqual([0, 2]);
    });

    it('omits accounts that have not crossed any threshold', () => {
      const t = new AccountActivityTracker();
      t.recordActivity(0);
      vi.advanceTimersByTime(THIRTY_MIN - 1);
      const r = t.classifyIdleAccounts({
        t1: THIRTY_MIN,
        t2: TWO_HOURS,
        t3: SIX_HOURS,
      });
      expect(r).toEqual({ tier1: [], tier2: [], tier3: [] });
    });
  });
});

describe('startSessionMaintenance / stopSessionMaintenance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    mockClearCodeCaches.mockClear();
    mockClearCache.mockClear();
    mockClearStorageData.mockClear();
    mockFromPartition.mockClear();
    destroyAccountActivityTracker();
  });

  afterEach(() => {
    stopSessionMaintenance();
    destroyAccountActivityTracker();
    vi.useRealTimers();
  });

  it('schedules an interval that fires every 5 minutes', () => {
    const tracker = new AccountActivityTracker();
    const manager = makeManager();
    startSessionMaintenance(tracker, manager);

    // Before first tick — no clears
    vi.advanceTimersByTime(FIVE_MIN - 1);
    expect(mockFromPartition).not.toHaveBeenCalled();

    // First tick — no idle accounts to clear
    vi.advanceTimersByTime(1);
    expect(mockFromPartition).not.toHaveBeenCalled();
  });

  it('does NOT clear code cache for accounts within idle threshold', () => {
    const tracker = new AccountActivityTracker();
    const manager = makeManager();
    tracker.recordActivity(0);
    startSessionMaintenance(tracker, manager);

    // Advance one tick — only 5 min idle, threshold is 30 min
    vi.advanceTimersByTime(FIVE_MIN);
    expect(mockClearCodeCaches).not.toHaveBeenCalled();
  });

  it('clears code cache for accounts idle >= 30 minutes', () => {
    const tracker = new AccountActivityTracker();
    const manager = makeManager();
    tracker.recordActivity(0);
    startSessionMaintenance(tracker, manager);

    // 30 min later (6 ticks of 5 min)
    vi.advanceTimersByTime(THIRTY_MIN);
    expect(mockFromPartition).toHaveBeenCalledWith('persist:account-0');
    expect(mockClearCodeCaches).toHaveBeenCalledTimes(1);
  });

  it('skips bootstrap accounts via the exclusion set without per-tier isBootstrap re-checks', () => {
    const tracker = new AccountActivityTracker();
    const isBootstrap = vi.fn((idx: number) => idx === 1);
    const getBootstrapAccounts = vi.fn().mockReturnValue([1]);
    const manager = makeManager({ isBootstrap, getBootstrapAccounts });
    tracker.recordActivity(0);
    tracker.recordActivity(1);
    startSessionMaintenance(tracker, manager);

    vi.advanceTimersByTime(THIRTY_MIN);

    expect(mockFromPartition).toHaveBeenCalledWith('persist:account-0');
    expect(mockFromPartition).not.toHaveBeenCalledWith('persist:account-1');
    expect(mockClearCodeCaches).toHaveBeenCalledTimes(1);
    // Exclusion comes from getBootstrapAccounts — not from per-tier isBootstrap checks.
    expect(getBootstrapAccounts).toHaveBeenCalled();
    expect(isBootstrap).not.toHaveBeenCalled();
  });

  it('clears caches for multiple idle accounts on a single tick', () => {
    const tracker = new AccountActivityTracker();
    const manager = makeManager();
    tracker.recordActivity(0);
    tracker.recordActivity(2);
    startSessionMaintenance(tracker, manager);

    vi.advanceTimersByTime(THIRTY_MIN);

    expect(mockFromPartition).toHaveBeenCalledWith('persist:account-0');
    expect(mockFromPartition).toHaveBeenCalledWith('persist:account-2');
    expect(mockClearCodeCaches).toHaveBeenCalledTimes(2);
  });

  it('continues processing other accounts when clearCodeCaches throws', () => {
    const tracker = new AccountActivityTracker();
    const manager = makeManager();
    mockFromPartition.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    tracker.recordActivity(0);
    tracker.recordActivity(1);
    startSessionMaintenance(tracker, manager);

    expect(() => vi.advanceTimersByTime(THIRTY_MIN)).not.toThrow();
    // 2 partitions attempted: first throws, second succeeds
    expect(mockFromPartition).toHaveBeenCalledTimes(2);
    expect(mockClearCodeCaches).toHaveBeenCalledTimes(1);
  });

  it('starting twice is a no-op (does not double-schedule)', () => {
    const tracker = new AccountActivityTracker();
    const manager = makeManager();
    tracker.recordActivity(0);
    startSessionMaintenance(tracker, manager);
    startSessionMaintenance(tracker, manager);

    vi.advanceTimersByTime(THIRTY_MIN);
    expect(mockClearCodeCaches).toHaveBeenCalledTimes(1);
  });

  it('stopSessionMaintenance prevents further ticks', () => {
    const tracker = new AccountActivityTracker();
    const manager = makeManager();
    tracker.recordActivity(0);
    startSessionMaintenance(tracker, manager);

    stopSessionMaintenance();

    vi.advanceTimersByTime(THIRTY_MIN * 2);
    expect(mockClearCodeCaches).not.toHaveBeenCalled();
  });

  it('stopSessionMaintenance is safe to call when not running', () => {
    expect(() => stopSessionMaintenance()).not.toThrow();
    expect(() => {
      stopSessionMaintenance();
      stopSessionMaintenance();
    }).not.toThrow();
  });

  it('stopSessionMaintenance(owner) is a no-op for a non-owner instance', () => {
    const tracker = new AccountActivityTracker();
    const owner = makeManager();
    const other = makeManager();
    tracker.recordActivity(0);
    startSessionMaintenance(tracker, owner);

    stopSessionMaintenance(other);
    vi.advanceTimersByTime(THIRTY_MIN);
    expect(mockClearCodeCaches).toHaveBeenCalled();

    stopSessionMaintenance(owner);
    mockClearCodeCaches.mockClear();
    vi.advanceTimersByTime(THIRTY_MIN);
    expect(mockClearCodeCaches).not.toHaveBeenCalled();
  });

  // ── Tier 2 (HTTP cache @ 2 hours) ───────────────────────
  it('does NOT clear HTTP cache for accounts idle < 2 hours', () => {
    const tracker = new AccountActivityTracker();
    const manager = makeManager();
    tracker.recordActivity(0);
    startSessionMaintenance(tracker, manager);

    // 30 min in: code cache cleared, but HTTP cache NOT yet.
    vi.advanceTimersByTime(THIRTY_MIN);
    expect(mockClearCodeCaches).toHaveBeenCalledTimes(1);
    expect(mockClearCache).not.toHaveBeenCalled();
  });

  it('clears HTTP cache for accounts idle >= 2 hours', () => {
    const tracker = new AccountActivityTracker();
    const manager = makeManager();
    tracker.recordActivity(0);
    startSessionMaintenance(tracker, manager);

    vi.advanceTimersByTime(TWO_HOURS);
    expect(mockFromPartition).toHaveBeenCalledWith('persist:account-0');
    expect(mockClearCache).toHaveBeenCalledTimes(1);
  });

  it('skips HTTP cache clear for bootstrap accounts', () => {
    const tracker = new AccountActivityTracker();
    const isBootstrap = vi.fn((idx: number) => idx === 1);
    const getBootstrapAccounts = vi.fn().mockReturnValue([1]);
    const manager = makeManager({ isBootstrap, getBootstrapAccounts });
    tracker.recordActivity(0);
    tracker.recordActivity(1);
    startSessionMaintenance(tracker, manager);

    vi.advanceTimersByTime(TWO_HOURS);
    expect(mockFromPartition).not.toHaveBeenCalledWith('persist:account-1');
    // Account 0 still cleared.
    expect(mockClearCache).toHaveBeenCalledTimes(1);
  });

  // ── Tier 3 (Service workers @ 6 hours) ────────────────
  it('does NOT clear service worker storage for accounts idle < 6 hours', () => {
    const tracker = new AccountActivityTracker();
    const manager = makeManager();
    tracker.recordActivity(0);
    startSessionMaintenance(tracker, manager);

    vi.advanceTimersByTime(TWO_HOURS);
    expect(mockClearStorageData).not.toHaveBeenCalled();
  });

  it('clears service worker storage for accounts idle >= 6 hours', () => {
    const tracker = new AccountActivityTracker();
    const manager = makeManager();
    tracker.recordActivity(0);
    startSessionMaintenance(tracker, manager);

    vi.advanceTimersByTime(SIX_HOURS);
    expect(mockClearStorageData).toHaveBeenCalledWith({ storages: ['serviceworkers'] });
  });

  it('skips service worker clear for bootstrap accounts', () => {
    const tracker = new AccountActivityTracker();
    const isBootstrap = vi.fn((idx: number) => idx === 2);
    const getBootstrapAccounts = vi.fn().mockReturnValue([2]);
    const manager = makeManager({ isBootstrap, getBootstrapAccounts });
    tracker.recordActivity(0);
    tracker.recordActivity(2);
    startSessionMaintenance(tracker, manager);

    vi.advanceTimersByTime(SIX_HOURS);
    expect(mockFromPartition).not.toHaveBeenCalledWith('persist:account-2');
    expect(mockClearStorageData).toHaveBeenCalledTimes(1);
  });
});

describe('Singleton getAccountActivityTracker / destroyAccountActivityTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    destroyAccountActivityTracker();
    mockClearCodeCaches.mockClear();
    mockClearCache.mockClear();
    mockClearStorageData.mockClear();
    mockFromPartition.mockClear();
  });

  afterEach(() => {
    destroyAccountActivityTracker();
    vi.useRealTimers();
  });

  it('returns the same instance across calls', () => {
    const a = getAccountActivityTracker();
    const b = getAccountActivityTracker();
    expect(a).toBe(b);
  });

  it('returns a fresh instance after destroy', () => {
    const a = getAccountActivityTracker();
    a.recordActivity(0);
    destroyAccountActivityTracker();
    const b = getAccountActivityTracker();
    expect(b).not.toBe(a);
    expect(b.getLastActivity(0)).toBeUndefined();
  });

  it('destroy stops the maintenance interval', () => {
    const tracker = getAccountActivityTracker();
    const manager = makeManager();
    tracker.recordActivity(0);
    startSessionMaintenance(tracker, manager);

    destroyAccountActivityTracker();

    vi.advanceTimersByTime(THIRTY_MIN * 2);
    expect(mockClearCodeCaches).not.toHaveBeenCalled();
  });
});

describe('startSessionMaintenance — memory pressure handler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    mockAppOn.mockClear();
    mockAppRemoveListener.mockClear();
    appListeners.clear();
    destroyAccountActivityTracker();
  });

  afterEach(() => {
    stopSessionMaintenance();
    destroyAccountActivityTracker();
    vi.useRealTimers();
  });

  function firePressure(): void {
    const handlers = appListeners.get('memory-pressure');
    if (handlers) {
      for (const h of handlers) {
        h();
      }
    }
  }

  it('registers a memory-pressure handler on startSessionMaintenance', () => {
    const tracker = new AccountActivityTracker();
    const manager = makeManager();
    startSessionMaintenance(tracker, manager);
    expect(mockAppOn).toHaveBeenCalledWith('memory-pressure', expect.any(Function));
    expect(appListeners.get('memory-pressure')?.size).toBe(1);
  });

  it('dehydrates idle non-zero accounts (>= 30s) on memory pressure', () => {
    const tracker = new AccountActivityTracker();
    const dehydrateAccount = vi.fn();
    const manager = makeManager({ dehydrateAccount });
    tracker.recordActivity(0);
    tracker.recordActivity(1);
    startSessionMaintenance(tracker, manager);

    // Advance past the 30-second pressure threshold
    vi.advanceTimersByTime(30 * 1000);
    firePressure();

    // Account-0 is never dehydrated under pressure (badge/notification reliability).
    expect(dehydrateAccount).toHaveBeenCalledTimes(1);
    expect(dehydrateAccount).not.toHaveBeenCalledWith(0);
    expect(dehydrateAccount).toHaveBeenCalledWith(1);
  });

  it('does NOT dehydrate accounts that are still active (< 30s idle)', () => {
    const tracker = new AccountActivityTracker();
    const dehydrateAccount = vi.fn();
    const manager = makeManager({ dehydrateAccount });
    tracker.recordActivity(0);
    startSessionMaintenance(tracker, manager);

    vi.advanceTimersByTime(30 * 1000 - 1);
    firePressure();

    expect(dehydrateAccount).not.toHaveBeenCalled();
  });

  it('skips bootstrap accounts on memory pressure', () => {
    const tracker = new AccountActivityTracker();
    const dehydrateAccount = vi.fn();
    const isBootstrap = vi.fn((idx: number) => idx === 1);
    const manager = makeManager({ dehydrateAccount, isBootstrap });
    tracker.recordActivity(0);
    tracker.recordActivity(1);
    tracker.recordActivity(2);
    startSessionMaintenance(tracker, manager);

    vi.advanceTimersByTime(30 * 1000);
    firePressure();

    // 0 skipped (primary), 1 skipped (bootstrap), 2 dehydrated
    expect(dehydrateAccount).toHaveBeenCalledTimes(1);
    expect(dehydrateAccount).toHaveBeenCalledWith(2);
    expect(dehydrateAccount).not.toHaveBeenCalledWith(0);
    expect(dehydrateAccount).not.toHaveBeenCalledWith(1);
  });

  it('skips already-dehydrated accounts on memory pressure', () => {
    const tracker = new AccountActivityTracker();
    const dehydrateAccount = vi.fn();
    const isDehydrated = vi.fn((idx: number) => idx === 1);
    const manager = makeManager({ dehydrateAccount, isDehydrated });
    tracker.recordActivity(0);
    tracker.recordActivity(1);
    tracker.recordActivity(2);
    startSessionMaintenance(tracker, manager);

    vi.advanceTimersByTime(30 * 1000);
    firePressure();

    expect(dehydrateAccount).toHaveBeenCalledTimes(1);
    expect(dehydrateAccount).toHaveBeenCalledWith(2);
    expect(dehydrateAccount).not.toHaveBeenCalledWith(0);
    expect(dehydrateAccount).not.toHaveBeenCalledWith(1);
  });

  it('removes the memory-pressure listener on stopSessionMaintenance', () => {
    const tracker = new AccountActivityTracker();
    const manager = makeManager();
    startSessionMaintenance(tracker, manager);
    expect(appListeners.get('memory-pressure')?.size).toBe(1);

    stopSessionMaintenance();

    expect(mockAppRemoveListener).toHaveBeenCalledWith('memory-pressure', expect.any(Function));
    expect(appListeners.get('memory-pressure')?.size).toBe(0);
  });

  it('does NOT dehydrate when no accounts are idle', () => {
    const tracker = new AccountActivityTracker();
    const dehydrateAccount = vi.fn();
    const manager = makeManager({ dehydrateAccount });
    startSessionMaintenance(tracker, manager);

    firePressure();

    expect(dehydrateAccount).not.toHaveBeenCalled();
  });
});

describe('session maintenance mode policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    maintenanceConfig.mode = undefined;
    maintenanceConfig.throwOnRead = false;
    mockClearCodeCaches.mockClear();
    mockClearCache.mockClear();
    mockClearStorageData.mockClear();
    mockFromPartition.mockClear();
    mockAppOn.mockClear();
    mockAppRemoveListener.mockClear();
    appListeners.clear();
    vi.mocked(log.debug).mockClear();
    vi.mocked(log.warn).mockClear();
    destroyAccountActivityTracker();
  });

  afterEach(() => {
    stopSessionMaintenance();
    destroyAccountActivityTracker();
    vi.useRealTimers();
  });

  function startOne(
    overrides: Partial<IAccountWindowManager> = {},
    ...accounts: number[]
  ): { tracker: AccountActivityTracker; manager: IAccountWindowManager } {
    const tracker = new AccountActivityTracker();
    const manager = makeManager(overrides);
    for (const account of accounts) {
      tracker.recordActivity(account);
    }
    startSessionMaintenance(tracker, manager);
    return { tracker, manager };
  }

  function firePressure(): void {
    for (const handler of appListeners.get('memory-pressure') ?? []) {
      handler();
    }
  }

  it.each([
    ['a fresh or older store without the key', undefined],
    ['an unrecognised value', 'aggressive'],
    ['the default value', 'default'],
  ])("keeps today's behavior for %s", (_label, mode) => {
    maintenanceConfig.mode = mode;
    startOne({}, 0);

    vi.advanceTimersByTime(TWO_HOURS - 1);
    expect(mockClearCache).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(mockClearCache).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(SIX_HOURS - TWO_HOURS);
    expect(mockClearStorageData).toHaveBeenCalledWith({ storages: ['serviceworkers'] });
  });

  it("keeps today's behavior when the preference cannot be read", () => {
    maintenanceConfig.throwOnRead = true;
    startOne({}, 0);

    vi.advanceTimersByTime(TWO_HOURS);

    expect(mockClearCodeCaches).toHaveBeenCalled();
    expect(mockClearCache).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('maintenance mode unreadable'));
  });

  it('starts no periodic HTTP-cache or service-worker clearing in conservative mode', () => {
    maintenanceConfig.mode = 'conservative';
    startOne({}, 0, 1);

    vi.advanceTimersByTime(SIX_HOURS);

    expect(mockClearCache).not.toHaveBeenCalled();
    expect(mockClearStorageData).not.toHaveBeenCalled();
    expect(mockFromPartition).toHaveBeenCalledWith('persist:account-0');
    expect(mockFromPartition).toHaveBeenCalledWith('persist:account-1');
    expect(mockClearCodeCaches).toHaveBeenCalledTimes(2 * (SIX_HOURS / FIVE_MIN - 5));
  });

  it('keeps the 30-minute code-cache tier and bootstrap exclusions in conservative mode', () => {
    maintenanceConfig.mode = 'conservative';
    const getBootstrapAccounts = vi.fn().mockReturnValue([1]);
    startOne({ getBootstrapAccounts }, 0, 1);

    vi.advanceTimersByTime(THIRTY_MIN - FIVE_MIN);
    expect(mockClearCodeCaches).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FIVE_MIN);

    expect(mockClearCodeCaches).toHaveBeenCalledTimes(1);
    expect(mockFromPartition).toHaveBeenCalledTimes(1);
    expect(mockFromPartition).toHaveBeenCalledWith('persist:account-0');
    expect(mockFromPartition).not.toHaveBeenCalledWith('persist:account-1');
  });

  it('applies a switch to conservative on the next tick without restarting the scheduler', () => {
    startOne({}, 0);

    vi.advanceTimersByTime(TWO_HOURS - FIVE_MIN);
    expect(mockClearCache).not.toHaveBeenCalled();
    maintenanceConfig.mode = 'conservative';
    vi.advanceTimersByTime(FIVE_MIN);
    expect(mockClearCache).not.toHaveBeenCalled();

    maintenanceConfig.mode = 'default';
    vi.advanceTimersByTime(FIVE_MIN - 1);
    expect(mockClearCache).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(mockClearCache).toHaveBeenCalledTimes(1);
  });

  it('applies a switch to conservative at the exact service-worker boundary', () => {
    startOne({}, 0);

    vi.advanceTimersByTime(SIX_HOURS - FIVE_MIN);
    const httpClearsBeforeSwitch = mockClearCache.mock.calls.length;
    expect(httpClearsBeforeSwitch).toBeGreaterThan(0);
    expect(mockClearStorageData).not.toHaveBeenCalled();

    maintenanceConfig.mode = 'conservative';
    vi.advanceTimersByTime(FIVE_MIN);

    expect(mockClearStorageData).not.toHaveBeenCalled();
    expect(mockClearCache).toHaveBeenCalledTimes(httpClearsBeforeSwitch);
    expect(mockClearCodeCaches).toHaveBeenCalledTimes(SIX_HOURS / FIVE_MIN - 5);
  });

  it('lets an already-issued clear finish after the mode changes without issuing more', () => {
    let finishClear!: () => void;
    mockClearCache.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClear = resolve;
        })
    );
    startOne({}, 0);

    vi.advanceTimersByTime(TWO_HOURS);
    expect(mockClearCache).toHaveBeenCalledTimes(1);

    maintenanceConfig.mode = 'conservative';
    vi.advanceTimersByTime(FIVE_MIN * 3);
    expect(mockClearCache).toHaveBeenCalledTimes(1);

    finishClear();
    return Promise.resolve().then(() => {
      expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('Cleared HTTP cache'));
      expect(log.warn).not.toHaveBeenCalled();
      expect(mockClearCache).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps memory-pressure dehydration armed in conservative mode', () => {
    maintenanceConfig.mode = 'conservative';
    const dehydrateAccount = vi.fn();
    const isBootstrap = vi.fn((idx: number) => idx === 1);
    startOne({ dehydrateAccount, isBootstrap }, 0, 1, 2);

    vi.advanceTimersByTime(30 * 1000);
    firePressure();

    expect(dehydrateAccount).toHaveBeenCalledTimes(1);
    expect(dehydrateAccount).toHaveBeenCalledWith(2);
    expect(mockClearCache).not.toHaveBeenCalled();
    expect(mockClearStorageData).not.toHaveBeenCalled();
  });

  it('keeps single-owner start and stop semantics in conservative mode', () => {
    maintenanceConfig.mode = 'conservative';
    const tracker = new AccountActivityTracker();
    const owner = makeManager();
    const other = makeManager();
    tracker.recordActivity(0);
    startSessionMaintenance(tracker, owner);
    startSessionMaintenance(tracker, other);
    expect(appListeners.get('memory-pressure')?.size).toBe(1);

    stopSessionMaintenance(other);
    vi.advanceTimersByTime(THIRTY_MIN);
    expect(mockClearCodeCaches).toHaveBeenCalledTimes(1);
    expect(appListeners.get('memory-pressure')?.size).toBe(1);

    stopSessionMaintenance(owner);
    stopSessionMaintenance(owner);
    stopSessionMaintenance();
    mockClearCodeCaches.mockClear();
    vi.advanceTimersByTime(SIX_HOURS);
    expect(mockClearCodeCaches).not.toHaveBeenCalled();
    expect(appListeners.get('memory-pressure')?.size).toBe(0);
  });

  it('final teardown stops ticks and pressure handling regardless of mode', () => {
    maintenanceConfig.mode = 'conservative';
    const dehydrateAccount = vi.fn();
    const tracker = getAccountActivityTracker();
    tracker.recordActivity(1);
    startSessionMaintenance(tracker, makeManager({ dehydrateAccount }));

    destroyAccountActivityTracker();
    vi.advanceTimersByTime(SIX_HOURS);
    firePressure();

    expect(mockClearCodeCaches).not.toHaveBeenCalled();
    expect(dehydrateAccount).not.toHaveBeenCalled();
    expect(appListeners.get('memory-pressure')?.size).toBe(0);
  });

  describe('Playwright tick hook', () => {
    const globals = globalThis as typeof globalThis & {
      __gogchatRunSessionMaintenanceTick?: () => void;
    };
    let previousTesting: string | undefined;

    beforeEach(() => {
      previousTesting = process.env['TESTING'];
      delete globals.__gogchatRunSessionMaintenanceTick;
    });

    afterEach(() => {
      delete globals.__gogchatRunSessionMaintenanceTick;
      if (previousTesting === undefined) {
        delete process.env['TESTING'];
      } else {
        process.env['TESTING'] = previousTesting;
      }
    });

    it('is absent outside TESTING', () => {
      delete process.env['TESTING'];
      installSessionMaintenanceTestHooks();
      expect(globals.__gogchatRunSessionMaintenanceTick).toBeUndefined();
    });

    it('runs one policy-aware tick against the started owner and singleton tracker', () => {
      process.env['TESTING'] = 'true';
      installSessionMaintenanceTestHooks();
      const run = globals.__gogchatRunSessionMaintenanceTick;
      expect(run).toEqual(expect.any(Function));

      expect(() => run?.()).not.toThrow();
      expect(mockFromPartition).not.toHaveBeenCalled();

      const tracker = getAccountActivityTracker();
      tracker.recordActivity(0);
      startSessionMaintenance(tracker, makeManager());
      vi.setSystemTime(Date.now() + SIX_HOURS);

      maintenanceConfig.mode = 'conservative';
      run?.();
      expect(mockClearCodeCaches).toHaveBeenCalledTimes(1);
      expect(mockClearCache).not.toHaveBeenCalled();
      expect(mockClearStorageData).not.toHaveBeenCalled();

      maintenanceConfig.mode = 'default';
      run?.();
      expect(mockClearCache).toHaveBeenCalledTimes(1);
      expect(mockClearStorageData).toHaveBeenCalledTimes(1);
    });
  });
});
