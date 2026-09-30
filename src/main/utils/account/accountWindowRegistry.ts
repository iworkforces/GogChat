/**
 * Account Window Registry - Window registration, lookup, and lifecycle tracking
 *
 * Manages the internal data structures for per-account BrowserWindow instances:
 * - Window ↔ accountIndex bidirectional mapping
 * - WebContents.id → accountIndex reverse index
 * - Event listener attachment/cleanup
 * - Most-recent-window tracking
 *
 * @module accountWindowRegistry
 */

import type { BrowserWindow } from 'electron';
import log from 'electron-log';
import { clearBootstrap as _clearBootstrap, clearAllBootstrap } from './bootstrapTracker.js';
import type { AccountIndex, WebContentsId } from '../../../shared/types/branded.js';
import { asWebContentsId } from '../../../shared/types/branded.js';

/**
 * Account window registration entry
 */
export interface AccountWindowEntry {
  window: BrowserWindow;
  webContentsId: WebContentsId;
  accountIndex: AccountIndex;
  createdAt: number;
}

/**
 * Account Window Registry - Manages per-account BrowserWindow lookups and lifecycle
 */
export class AccountWindowRegistry {
  private readonly preserveBootstrap: boolean;
  private readonly onAccountClosed: ((accountIndex: AccountIndex) => void) | undefined;
  private windows = new Map<AccountIndex, AccountWindowEntry>();
  private reverseLookup = new Map<BrowserWindow, AccountIndex>();
  private mostRecentAccountIndex: AccountIndex | null = null;

  constructor(options?: {
    preserveBootstrap?: boolean;
    onAccountClosed?: (accountIndex: AccountIndex) => void;
  }) {
    this.preserveBootstrap = options?.preserveBootstrap === true;
    this.onAccountClosed = options?.onAccountClosed;
  }
  /**
   * Tracks event listeners attached to windows so they can be removed on re-register.
   * Prevents stale closures from firing with wrong accountIndex on focus/show events.
   */
  private windowListeners = new Map<
    BrowserWindow,
    { focus: () => void; show: () => void; closed: () => void }
  >();
  /**
   * Reverse index for O(1) webContents.id → accountIndex lookup.
   * Used by getAccountForWebContents() to avoid O(n) iteration.
   */
  private webContentsToAccountIndex = new Map<WebContentsId, AccountIndex>();

  /**
   * Register a BrowserWindow for a specific account index
   * @param window - The BrowserWindow to register
   * @param accountIndex - The account index (0, 1, 2, ...)
   */
  registerWindow(window: BrowserWindow, accountIndex: AccountIndex): void {
    const previous = this.windows.get(accountIndex);
    if (previous && previous.window !== window) {
      this.unregisterAccount(accountIndex);
    }
    // Clean up existing entry if re-registering
    if (this.reverseLookup.has(window)) {
      const existingIndex = this.reverseLookup.get(window);
      if (existingIndex !== undefined && existingIndex !== accountIndex) {
        this.windows.delete(existingIndex);
      }
    }

    const entry: AccountWindowEntry = {
      window,
      webContentsId: asWebContentsId(window.webContents.id),
      accountIndex,
      createdAt: Date.now(),
    };

    this.windows.set(accountIndex, entry);
    this.reverseLookup.set(window, accountIndex);
    // Remove old listeners if re-registering (prevents listener leak)
    const existingListeners = this.windowListeners.get(window);
    if (existingListeners) {
      window.removeListener('focus', existingListeners.focus);
      window.removeListener('show', existingListeners.show);
      window.removeListener('closed', existingListeners.closed);
    }

    const focusHandler = () => {
      this.mostRecentAccountIndex = accountIndex;
    };
    const showHandler = () => {
      this.mostRecentAccountIndex = accountIndex;
    };
    const closedHandler = () => {
      if (this.windows.get(accountIndex)?.window !== window) return;
      this.unregisterAccount(accountIndex);
      this.onAccountClosed?.(accountIndex);
    };

    window.on('focus', focusHandler);
    window.on('show', showHandler);
    window.on('closed', closedHandler);

    this.windowListeners.set(window, {
      focus: focusHandler,
      show: showHandler,
      closed: closedHandler,
    });
    this.webContentsToAccountIndex.set(entry.webContentsId, accountIndex);
    log.info(`[AccountWindowRegistry] Registered window for account ${accountIndex}`);
  }

  /**
   * Get the account index for a given BrowserWindow
   * @param window - The BrowserWindow to look up
   * @returns The account index or null if not found
   */
  getAccountIndex(window: BrowserWindow): AccountIndex | null {
    const index = this.reverseLookup.get(window);
    return index !== undefined ? index : null;
  }

  /**
   * Get the BrowserWindow for a specific account index
   * @param accountIndex - The account index to look up
   * @returns The BrowserWindow or null if not found
   */
  getAccountWindow(accountIndex: AccountIndex): BrowserWindow | null {
    const entry = this.windows.get(accountIndex);
    return entry?.window ?? null;
  }

  /**
   * Get webContents for a specific account
   * @param accountIndex - The account index
   * @returns The webContents or null if window doesn't exist
   */
  getAccountWebContents(accountIndex: AccountIndex): Electron.WebContents | null {
    const window = this.getAccountWindow(accountIndex);
    return window?.webContents ?? null;
  }

  getAccountForWebContents(webContentsId: WebContentsId): AccountIndex | null {
    const index = this.webContentsToAccountIndex.get(webContentsId);
    return index !== undefined ? index : null;
  }

  /**
   * Get all registered account windows
   * @returns Array of all BrowserWindows
   */
  getAllWindows(): BrowserWindow[] {
    return Array.from(this.windows.values()).map((entry) => entry.window);
  }

  /**
   * Live registered account indices only (not dehydrated), sorted ascending.
   */
  listAccountIndices(): AccountIndex[] {
    return Array.from(this.windows.keys()).sort((a, b) => Number(a) - Number(b));
  }

  /**
   * Get the most recently created account window
   * @returns The most recent BrowserWindow or null if none exist
   */
  getMostRecentWindow(): BrowserWindow | null {
    if (this.mostRecentAccountIndex === null) {
      return null;
    }
    return this.getAccountWindow(this.mostRecentAccountIndex);
  }

  /**
   * Update the most recently focused account index
   * @param accountIndex - The account index to set as most recent
   */
  setMostRecentAccountIndex(accountIndex: AccountIndex): void {
    this.mostRecentAccountIndex = accountIndex;
  }

  /**
   * Remove a window from management (without destroying it)
   * @param accountIndex - The account index to remove
   */
  unregisterAccount(accountIndex: AccountIndex): void {
    const entry = this.windows.get(accountIndex);
    if (entry) {
      // Clean up event listeners
      const listeners = this.windowListeners.get(entry.window);
      if (listeners && !entry.window.isDestroyed()) {
        entry.window.removeListener('focus', listeners.focus);
        entry.window.removeListener('show', listeners.show);
        entry.window.removeListener('closed', listeners.closed);
      }
      this.windowListeners.delete(entry.window);

      // Remove all webContents listeners to prevent leaks
      if (!entry.window.isDestroyed()) {
        const webContents = entry.window.webContents;
        if (webContents && !webContents.isDestroyed()) {
          webContents.removeAllListeners();
        }
      }

      // Clean up webContents reverse index
      this.webContentsToAccountIndex.delete(entry.webContentsId);

      this.reverseLookup.delete(entry.window);
      this.windows.delete(accountIndex);
      if (!this.preserveBootstrap) {
        _clearBootstrap(accountIndex);
      }

      if (this.mostRecentAccountIndex === accountIndex) {
        // Find the next most recent
        let newestIndex: AccountIndex | null = null;
        let newestTime = 0;
        for (const [idx, e] of this.windows) {
          if (e.createdAt > newestTime) {
            newestTime = e.createdAt;
            newestIndex = idx;
          }
        }
        this.mostRecentAccountIndex = newestIndex;
      }

      log.info(`[AccountWindowRegistry] Unregistered account ${accountIndex}`);
    }
  }

  /**
   * Check if an account window exists
   * @param accountIndex - The account index to check
   * @returns True if the account window exists
   */
  hasAccount(accountIndex: AccountIndex): boolean {
    return this.windows.has(accountIndex);
  }

  /**
   * Get the number of registered accounts
   * @returns The count of registered accounts
   */
  getAccountCount(): number {
    return this.windows.size;
  }

  /**
   * Cleanup and destroy all account windows
   */
  destroyAll(): void {
    log.info(`[AccountWindowRegistry] Destroying ${this.windows.size} account windows`);

    // Clear webContents reverse index first
    this.webContentsToAccountIndex.clear();

    for (const entry of this.windows.values()) {
      this.unregisterAccount(entry.accountIndex);
      if (!entry.window.isDestroyed()) {
        // Remove all webContents listeners before destroying
        const webContents = entry.window.webContents;
        if (webContents && !webContents.isDestroyed()) {
          webContents.removeAllListeners();
        }
        entry.window.destroy();
      }
    }

    this.windows.clear();
    this.reverseLookup.clear();
    if (!this.preserveBootstrap) {
      clearAllBootstrap();
    }
    this.windowListeners.clear();
    this.mostRecentAccountIndex = null;
  }
}
