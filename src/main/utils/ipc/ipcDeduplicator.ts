/**
 * IPC Deduplicator Utility
 * Prevents duplicate IPC requests from being processed in quick succession
 * Useful for debouncing rapid state changes and preventing redundant work
 */

import { logger } from '../lifecycle/logger.js';
import { cancelTrackedTimeout, createTrackedTimeout } from '../lifecycle/resourceCleanup.js';
import { asType } from '../../../shared/typeUtils.js';

/**
 * Deduplication configuration
 */
export interface DeduplicationConfig {
  /** Time window in milliseconds to consider requests as duplicates */
  windowMs?: number;
  /** Maximum number of cached keys before cleanup */
  maxCacheSize?: number;
  /** Whether to log deduplications */
  debug?: boolean;
}

/**
 * Request cache entry
 */
interface CacheEntry<T> {
  promise: Promise<T>;
  timestamp: number;
}

type CacheEntryAny = CacheEntry<unknown>;

/**
 * IPC Request Deduplicator
 * Groups multiple identical requests into a single execution
 */
export class IPCDeduplicator {
  private cache = new Map<string, CacheEntryAny>();
  private cleanupTimeout: NodeJS.Timeout | null = null;
  private config: Required<DeduplicationConfig>;
  private stats = {
    deduplicatedCount: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };

  constructor(config: DeduplicationConfig = {}) {
    this.config = {
      windowMs: config.windowMs ?? 100, // Default 100ms window
      maxCacheSize: config.maxCacheSize ?? 100,
      debug: config.debug ?? false,
    };

    // Cleanup is scheduled on-demand when entries are added
  }

  /**
   * Deduplicate a request by key
   * Multiple calls with the same key within the time window will share the same promise
   */
  async deduplicate<T>(key: string, fn: () => Promise<T>, windowMs?: number): Promise<T> {
    const effectiveWindow = windowMs ?? this.config.windowMs;
    const now = Date.now();

    // Check for existing pending request
    const existing = this.cache.get(key);

    if (existing && now - existing.timestamp <= effectiveWindow) {
      // Request is still within the deduplication window
      this.stats.cacheHits++;
      this.stats.deduplicatedCount++;

      if (this.config.debug) {
        logger.ipc.debug(`Deduplicating request: ${key}`);
      }

      // Return the existing promise
      return asType<Promise<T>>(existing.promise);
    }

    // No existing request or window expired, execute new request
    this.stats.cacheMisses++;

    if (this.config.debug) {
      logger.ipc.debug(`Executing new request: ${key}`);
    }

    // Clean cache if too large
    if (this.cache.size >= this.config.maxCacheSize) {
      this.cleanOldEntries();
    }

    if (existing) {
      // Refresh expired keys at the end of insertion order for cleanup scheduling.
      this.cache.delete(key);
    }

    // Create new promise
    const promise = fn();
    // Store in cache
    this.cache.set(key, {
      promise,
      timestamp: now,
    });

    // Schedule cleanup for this entry's expiration
    this.scheduleNextCleanup();

    return promise;
  }

  /**
   * Deduplicate with custom key generation
   */
  async deduplicateWithKey<T, A extends unknown[]>(
    keyFn: (...args: A) => string,
    fn: (...args: A) => Promise<T>,
    ...args: A
  ): Promise<T> {
    const key = keyFn(...args);
    return this.deduplicate(key, () => fn(...args));
  }

  /**
   * Create a deduplicated version of a function
   */
  createDeduplicated<T, A extends unknown[]>(
    fn: (...args: A) => Promise<T>,
    keyFn: (...args: A) => string,
    windowMs?: number
  ): (...args: A) => Promise<T> {
    return (...args: A) => {
      const key = keyFn(...args);
      return this.deduplicate(key, () => fn(...args), windowMs);
    };
  }

  /**
   * Clear a specific key from cache
   */
  clear(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Clear all cached entries
   */
  clearAll(): void {
    this.cache.clear();
    this.stats.deduplicatedCount = 0;
    this.stats.cacheHits = 0;
    this.stats.cacheMisses = 0;
    this.cancelScheduledCleanup();
  }

  /**
   * Get deduplication statistics
   */
  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  /**
   * Get cache size
   */
  getCacheSize(): number {
    return this.cache.size;
  }

  /**
   * Cancel any pending cleanup timer
   */
  private cancelScheduledCleanup(): void {
    if (this.cleanupTimeout) {
      cancelTrackedTimeout(this.cleanupTimeout);
      this.cleanupTimeout = null;
    }
  }

  /**
   * Schedule a cleanup timer if none is currently pending.
   *
   * Timestamps are monotonic and Map iteration is insertion-ordered, so the
   * first entry is always the oldest. Any later insert has an expiry no
   * earlier than the pending timer's deadline, so the pending timer is
   * always sufficient: when it fires it cleans whatever has expired and
   * reschedules itself if entries remain. There is no need to rescan the
   * full cache on every insert.
   */
  private scheduleNextCleanup(): void {
    if (this.cache.size === 0) {
      this.cancelScheduledCleanup();
      return;
    }

    // A pending timer already covers the soonest expiry — leave it alone.
    if (this.cleanupTimeout !== null) {
      return;
    }

    // Use the oldest entry (first inserted) to compute the next deadline.
    const oldest = this.cache.values().next().value;
    if (!oldest) {
      return;
    }
    const expirationMs = this.config.windowMs * 2;
    const earliestExpiry = oldest.timestamp + expirationMs;
    const delay = Math.max(0, earliestExpiry - Date.now());
    this.cleanupTimeout = createTrackedTimeout(
      () => {
        this.cleanupTimeout = null;
        this.cleanOldEntries();
        // Reschedule if entries remain
        if (this.cache.size > 0) {
          this.scheduleNextCleanup();
        }
      },
      delay,
      'ipc-deduplicator-cleanup'
    );
  }

  /**
   * Clean entries older than the deduplication window
   */
  private cleanOldEntries(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.config.windowMs * 2) {
        expiredKeys.push(key);
      }
    }

    if (expiredKeys.length > 0) {
      expiredKeys.forEach((key) => this.cache.delete(key));

      if (this.config.debug && expiredKeys.length > 0) {
        logger.ipc.debug(`Cleaned ${expiredKeys.length} expired cache entries`);
      }
    }
  }

  /**
   * Destroy the deduplicator and clean up resources
   */
  destroy(): void {
    this.cancelScheduledCleanup();
    this.clearAll();
  }
}

/**
 * Global deduplicator instance
 */
let globalDeduplicator: IPCDeduplicator | null = null;

/**
 * Get or create the global deduplicator instance
 */
export function getDeduplicator(): IPCDeduplicator {
  if (!globalDeduplicator) {
    globalDeduplicator = new IPCDeduplicator({
      windowMs: 100,
      maxCacheSize: 100,
      debug: process.env['NODE_ENV'] === 'development',
    });
  }
  return globalDeduplicator;
}

/**
 * Destroy the global deduplicator
 */
export function destroyDeduplicator(): void {
  if (globalDeduplicator) {
    globalDeduplicator.destroy();
    globalDeduplicator = null;
  }
}
