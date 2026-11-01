/**
 * Shared constants for IPC channels, selectors, and configuration values
 * This prevents typos and makes refactoring easier
 */

import { asType } from './typeUtils.js';

/**
 * IPC Channel names for communication between main and renderer processes
 */
export const IPC_CHANNELS = {
  // From renderer to main
  UNREAD_COUNT: 'unreadCount',
  FAVICON_CHANGED: 'faviconChanged',
  NOTIFICATION_SHOW: 'notificationShow',
  NOTIFICATION_CLICKED: 'notificationClicked',
  NOTIFICATION_CLOSE: 'notificationClose',
  CHECK_IF_ONLINE: 'checkIfOnline',
  PASSKEY_AUTH_FAILED: 'passkeyAuthFailed',

  // From main to renderer
  SEARCH_SHORTCUT: 'searchShortcut',
  ONLINE_STATUS: 'onlineStatus',
  NOTIFICATION_EVENT: 'notificationEvent',
} as const satisfies Record<string, string>;

/**
 * DOM selectors for GogChat elements
 * These may need updating if Google changes their HTML structure
 */
export const SELECTORS = {
  // Unread count groups
  CHAT_GROUP: 'div[data-tooltip="Chat"][role="group"]',
  SPACES_GROUP: 'div[data-tooltip="Spaces"][role="group"]',
  UNREAD_HEADING: 'span[role="heading"]',
  UNREAD_BADGE_CONTAINER: '.RuSDjb',
  UNREAD_BADGE: '.OK1FOb',
  UNREAD_BADGE_ALT: '.zY9JEf',

  // Search functionality
  SEARCH_INPUT: 'input[name="q"]',

  // Favicon tracking
  FAVICON_ICON: 'link[rel="icon"]',
  FAVICON_SHORTCUT: 'link[rel="shortcut icon"]',
} as const satisfies Record<string, string>;

/**
 * Timing constants for polling and throttling
 */
export const TIMING = {
  // Polling intervals (in milliseconds)
  FAVICON_POLL: 1000,
  UNREAD_COUNT_POLL: 1000,

  // Debounce/throttle delays
  WINDOW_STATE_SAVE: 500,

  // Timeouts
  CONNECTIVITY_CHECK: 5000,
  CONNECTIVITY_CHECK_FAST: 3000,
  NOTIFICATION_AUTO_DISMISS: 10000, // 10 seconds
  /**
   * After a Chat Web Notification bridge show, suppress unread-delta
   * synthetic banners for this long to avoid double banners.
   */
  NOTIFICATION_BRIDGE_COOLDOWN_MS: 8000,

  // Re-guard timer for external links
  EXTERNAL_LINKS_REGUARD: 5 * 60 * 1000, // 5 minutes
} as const satisfies Record<string, number>;

/**
 * Icon types based on favicon state
 */
export const ICON_TYPES = {
  OFFLINE: 'offline',
  NORMAL: 'normal',
  BADGE: 'badge',
} as const satisfies Record<string, string>;

/**
 * Favicon URL patterns for detecting GogChat state
 */
export const FAVICON_PATTERNS = {
  NORMAL: /favicon_chat_r2|favicon_chat_new_non_notif_r2/,
  BADGE: /favicon_chat_new_notif_r2/,
} as const satisfies Record<string, RegExp>;

/**
 * Rate limiting configuration
 */
export const RATE_LIMITS = {
  IPC_DEFAULT: 10, // messages per second
  IPC_UNREAD_COUNT: 5,
  IPC_FAVICON: 5,
  IPC_NOTIFICATION: 5, // Limit notification creation
} as const satisfies Record<string, number>;

/**
 * Badge icon limits
 */
export const BADGE = {
  /** Max accepted unread count over IPC (validator). */
  MAX_COUNT: 9999,
  /**
   * Max count shown on the dock badge and in unread-delta notification copy.
   * Values above this display as 99 (badge) / "99+" (banner body).
   */
  DISPLAY_MAX: 99,
  CACHE_LIMIT: 99, // Cache icons for counts 0-99
} as const satisfies Record<string, number>;

/**
 * Multi-account notification label limits
 */
export const ACCOUNT_LABEL = {
  /** Max characters stored / shown in notification subtitle */
  MAX_LENGTH: 40,
} as const satisfies Record<string, number>;

/**
 * Whitelisted hosts for navigation
 */
export const WHITELISTED_HOSTS = [
  'accounts.google.com',
  'accounts.youtube.com',
  'chat.google.com',
  'mail.google.com',
] as const satisfies readonly string[];

/**
 * URL patterns for special handling
 */
export const URL_PATTERNS = {
  DOWNLOAD: 'https://chat.google.com/u/0/api/get_attachment_url',
  GMAIL_PREFIX: 'https://mail.google.com/',
  CHAT_PREFIX: 'https://mail.google.com/chat',
} as const satisfies Record<string, string>;

/**
 * Deep link protocol configuration
 */
export const DEEP_LINK = {
  /** Custom protocol scheme (without colon) */
  PROTOCOL: 'gogchat',
  /** Full protocol prefix for URL matching */
  PREFIX: 'gogchat://',
  /** Target host for deep link navigation */
  TARGET_HOST: 'chat.google.com',
  /** Target origin for constructed URLs */
  TARGET_ORIGIN: 'https://chat.google.com',
  /** Maximum URL length for deep links */
  MAX_URL_LENGTH: 2048,
  /** Allowed path prefixes for deep link navigation (`/u/N` + these is also allowed) */
  ALLOWED_PATH_PREFIXES: asType<readonly string[]>(['/room/', '/dm/', '/space/']),
} as const satisfies Record<string, string | number | readonly string[]>;

/**
 * Union of all IPC channel name string literals, derived from IPC_CHANNELS.
 * Use instead of `string` when a variable must be a known channel name.
 */
export type IPCChannelName = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
