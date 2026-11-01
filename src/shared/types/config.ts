/**
 * Application configuration and persistent store schema.
 */

import type { WindowState, AccountWindowsMap } from './window.js';

/**
 * Periodic account-session maintenance policy. `conservative` skips only the
 * periodic HTTP-cache and service-worker clearing; code-cache trimming and
 * memory-pressure dehydration are unchanged.
 */
export type SessionMaintenanceMode = 'default' | 'conservative';

/**
 * Application configuration
 */
export interface AppConfig {
  autoCheckForUpdates: boolean;
  /**
   * Unix-millisecond wall-clock deadline until which automatic update prompts
   * are snoozed. 0 means inactive; independent of `autoCheckForUpdates`.
   */
  updateSnoozedUntil: number;
  /** Periodic session-maintenance policy, read on every maintenance tick. */
  sessionMaintenanceMode: SessionMaintenanceMode;
  autoLaunchAtLogin: boolean;
  startHidden: boolean;
  hideMenuBar: boolean;
  disableSpellChecker: boolean;
  suppressPasskeyDialog: boolean;
  notificationPermissionRequested: boolean;
  /**
   * When true, emit a generic OS banner when the unread badge count increases
   * while the focus window is not focused. Default false — Chat web
   * Notification bridge remains the primary path; enable after smoke if Chat
   * does not fire Web Notifications when unfocused.
   */
  unreadDeltaNotifications: boolean;
  /**
   * Optional human labels for notification subtitles, keyed by account index
   * string (e.g. `"0"` → `"Work"`). Empty / missing keys fall back to
   * `Account N` (1-based). Max length enforced when writing.
   */
  accountLabels: Record<string, string>;
  /**
   * Hidden experimental flag — when true, the app uses a single host
   * BrowserWindow with one WebContentsView per account (Electron 30+ API)
   * instead of one BrowserWindow per account. Saves ~15-25 MB/account and
   * makes account switching effectively instantaneous via setBounds().
   * Default: false (BrowserWindow-per-account fallback path).
   */
  useWebContentsView?: boolean;
}

/**
 * Store metadata for cache versioning and tracking
 * ⚡ OPTIMIZATION: Used for cache invalidation on app updates
 */
export interface StoreMetadata {
  cacheVersion?: string;
  lastAppVersion?: string;
  lastUpdated?: number;
}

/**
 * Memory optimization configuration (hidden prefs, not in UI).
 */
export interface MemoryConfig {
  /** Dehydration idle threshold in ms (default 90000 = 90s). Range: 60000-600000. */
  dehydrationThresholdMs?: number;
  /** V8 heap cap per renderer in MB (applied via --js-flags before app.ready). Default: 512. */
  v8HeapCapMB?: number;
  /** Disk cache max size per account in MB (0 = clear, undefined = unlimited). Not yet enforced. */
  diskCacheMaxMB?: number;
}

/**
 * Complete electron-store type definition
 */
export interface StoreType extends Record<string, unknown> {
  window: WindowState;
  app: AppConfig;
  _meta?: StoreMetadata;
  accountWindows?: AccountWindowsMap;
  /** Hidden memory optimization preferences (not exposed in UI). */
  memory?: MemoryConfig;
}

/**
 * Recursive dot-notation key paths for a nested object type.
 * Enables type-safe access to nested config keys (e.g. 'app.autoCheckForUpdates').
 *
 * Depth-limited to 3 levels to avoid infinite recursion on circular or very deep types.
 *
 * @example
 *   type Keys = StoreKeyPaths<StoreType>
 *   // 'window' | 'app' | '_meta' | 'window.bounds' | 'window.isMaximized'
 *   // | 'window.bounds.x' | 'window.bounds.y' | 'window.bounds.width' | ...
 *   // | 'app.autoCheckForUpdates' | 'app.startHidden' | ...
 */
export type StoreKeyPaths<T extends Record<string, unknown>> = {
  [K in keyof T & string]:
    | K
    | (NonNullable<T[K]> extends Record<string, unknown>
        ? `${K}.${StoreKeyPaths<NonNullable<T[K]>>}`
        : never);
}[keyof T & string];
