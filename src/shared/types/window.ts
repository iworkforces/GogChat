/**
 * Window and account-window state shapes.
 */

import type { AccountIndex, WebContentsId } from './branded.js';

/**
 * Window bounds for state persistence
 */
export interface WindowBounds {
  x: number | null;
  y: number | null;
  width: number;
  height: number;
}

/**
 * Window state configuration
 */
export interface WindowState {
  bounds: WindowBounds;
  isMaximized: boolean;
}

/**
 * Account-scoped window bounds for multi-account sessions
 */
export interface AccountWindowBounds {
  x: number | null;
  y: number | null;
  width: number;
  height: number;
}

/**
 * Account-scoped window state for per-account BrowserWindows
 */
export interface AccountWindowState {
  bounds: AccountWindowBounds;
  isMaximized: boolean;
  /** Set only while macOS fullscreen is active. Omitted when false. */
  isFullScreen?: boolean;
}

/**
 * Maps account index to account window state
 */
export type AccountWindowsMap = Record<AccountIndex, AccountWindowState>;

/**
 * Factory interface for creating account BrowserWindows.
 * Breaks the concrete coupling between accountWindowManager and windowWrapper.
 */
export interface WindowFactory {
  createWindow(url: string, partition: string): Electron.BrowserWindow;
}

/**
 * Construction options for account managers.
 *
 * `isolated` is TESTING-only: skip process-wide bootstrap reset, session
 * maintenance, WebContents hook notify, and shared-session permission
 * handlers so extra constructors cannot steal the live app's singletons.
 */
export interface AccountManagerOptions {
  isolated?: boolean;
}

/**
 * Backend that owns live account WebContents for multi-account rendering.
 * BrowserWindow is the default; WebContentsView remains opt-in.
 */
export type AccountBackendKind = 'browser-window' | 'web-contents-view';

/**
 * Narrow enumeration entry for a live account renderer WebContents.
 * Used by performance sampling to map account ↔ process identity without
 * conflating host-window WebContents with child views.
 */
export interface AccountWebContentsInfo {
  accountIndex: AccountIndex;
  webContentsId: WebContentsId;
  /** OS process id when available; 0 if not yet assigned or destroyed. */
  osProcessId: number;
  backend: AccountBackendKind;
  webContents: Electron.WebContents;
}

/**
 * Account window manager interface — public API surface for multi-account
 * BrowserWindow management. Consumers should depend on this abstraction
 * rather than the concrete `AccountWindowManager` class.
 */
export interface IAccountWindowManager {
  registerWindow(window: Electron.BrowserWindow, accountIndex: AccountIndex): void;
  getAccountIndex(window: Electron.BrowserWindow): AccountIndex | null;
  getAccountWindow(accountIndex: AccountIndex): Electron.BrowserWindow | null;
  getAccountWebContents(accountIndex: AccountIndex): Electron.WebContents | null;
  getAccountForWebContents(webContentsId: WebContentsId): AccountIndex | null;
  /**
   * Bring the given account's UI forward: BrowserWindow backend shows/focuses
   * that account window; WebContentsView backend switches the visible view and
   * focuses the host. No-op if the account is unknown.
   */
  focusAccount(accountIndex: AccountIndex): void;
  getAllWindows(): Electron.BrowserWindow[];
  getMostRecentWindow(): Electron.BrowserWindow | null;
  hasAccount(accountIndex: AccountIndex): boolean;
  /**
   * All known account indices (live + dehydrated-parked), sorted ascending.
   * Sparse-safe — do not assume contiguous 0..getAccountCount()-1.
   */
  listAccountIndices(): AccountIndex[];
  /**
   * Whether this account is the frontmost UI (visible / on-screen account).
   * BrowserWindow: live window with `isVisible()`. WebContentsView: frontmost view.
   * Dehydrated-parked and switched-away accounts return false.
   */
  isAccountVisible(accountIndex: AccountIndex): boolean;
  unregisterAccount(accountIndex: AccountIndex): void;
  getAccountCount(): number;
  destroyAll(): void;
  createAccountWindow(url: string, accountIndex: AccountIndex): Electron.BrowserWindow;
  markAsBootstrap(accountIndex: AccountIndex): void;
  promoteBootstrap(accountIndex: AccountIndex): boolean;
  isBootstrap(accountIndex: AccountIndex): boolean;
  clearBootstrap(accountIndex: AccountIndex): void;
  getBootstrapAccounts(): AccountIndex[];
  saveAccountWindowState(accountIndex: AccountIndex): void;
  getAccountWindowState(accountIndex: AccountIndex): AccountWindowState | null;
  /**
   * Dehydrate the account: destroy the BrowserWindow and persist
   * URL/bounds/maximized state for later rehydration. The
   * `persist:account-N` partition is preserved (cookies/localStorage/IDB
   * survive). No-op for bootstrap accounts, unknown indices, or accounts
   * that are already dehydrated.
   */
  dehydrateAccount(accountIndex: AccountIndex): void;
  /**
   * Hydrate the account: recreate the BrowserWindow against the same
   * `persist:account-N` partition and restore URL/bounds/maximized state.
   * Returns the hydrated window, or `null` if the account is unknown.
   * Returns the existing window if the account is already alive.
   * Throws if hydration is required but no `WindowFactory` is configured.
   */
  hydrateAccount(accountIndex: AccountIndex): Electron.BrowserWindow | null;
  /**
   * Whether the given account is currently in the dehydrated state.
   */
  isDehydrated(accountIndex: AccountIndex): boolean;
  /**
   * Enumerate every live account renderer WebContents.
   * BrowserWindow backend: each live account window's webContents.
   * WebContentsView backend: each live child view webContents (not host-only).
   * Destroyed views/windows are omitted.
   */
  enumerateAccountWebContents(): AccountWebContentsInfo[];
}
