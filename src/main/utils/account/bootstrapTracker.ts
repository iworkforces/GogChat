/**
 * Bootstrap Tracker - Bootstrap window state management
 *
 * Tracks which account indices are currently bootstrap (pre-auth) windows.
 * A bootstrap window is a temporary login window created before the
 * account has completed first authentication. It should be promoted
 * (kept and re-labelled as a real account) or closed after login.
 *
 * @module bootstrapTracker
 */

import log from 'electron-log';
import type { AccountIndex } from '../../../shared/types/branded.js';

/**
 * Internal set tracking which account indices are currently bootstrap windows.
 */
const bootstrapAccounts = new Set<AccountIndex>();
const stateListeners = new Set<() => void>();

export function onBootstrapStateChanged(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

function notifyBootstrapStateChanged(): void {
  for (const listener of stateListeners) {
    try {
      listener();
    } catch {
      log.error('[BootstrapTracker] State listener failed');
    }
  }
}

/**
 * Mark an account index as a bootstrap (pre-auth) window.
 * @param accountIndex - The account index to mark
 */
export function markAsBootstrap(accountIndex: AccountIndex): void {
  const wasBootstrap = bootstrapAccounts.has(accountIndex);
  bootstrapAccounts.add(accountIndex);
  if (!wasBootstrap) notifyBootstrapStateChanged();
  log.debug(`[BootstrapTracker] Account ${accountIndex} marked as bootstrap window`);
}

/**
 * Query whether an account index is currently in bootstrap state.
 * @param accountIndex - The account index to query
 * @returns True if the account is a bootstrap window
 */
export function isBootstrap(accountIndex: AccountIndex): boolean {
  return bootstrapAccounts.has(accountIndex);
}

/**
 * Promote a bootstrap window to a real authenticated account window.
 * Clears the bootstrap flag; the window remains registered and open.
 * @param accountIndex - The account index to promote
 * @returns True if the account was previously marked as bootstrap
 */
export function promoteBootstrap(accountIndex: AccountIndex): boolean {
  const wasBootstrap = bootstrapAccounts.delete(accountIndex);
  if (wasBootstrap) {
    notifyBootstrapStateChanged();
    log.info(`[BootstrapTracker] Account ${accountIndex} promoted from bootstrap to authenticated`);
  }
  return wasBootstrap;
}

/**
 * Clear the bootstrap flag for an account without promoting it.
 * Use this when the bootstrap window should be discarded rather than kept.
 * @param accountIndex - The account index to clear
 */
export function clearBootstrap(accountIndex: AccountIndex): void {
  if (bootstrapAccounts.delete(accountIndex)) notifyBootstrapStateChanged();
  log.debug(`[BootstrapTracker] Bootstrap flag cleared for account ${accountIndex}`);
}

/**
 * Return all account indices currently in bootstrap state.
 */
export function getBootstrapAccounts(): AccountIndex[] {
  return Array.from(bootstrapAccounts);
}

/**
 * Clear all bootstrap tracking state.
 * Used during manager destruction.
 */
export function clearAllBootstrap(): void {
  bootstrapAccounts.clear();
}
