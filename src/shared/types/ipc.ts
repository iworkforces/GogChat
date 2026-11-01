/**
 * IPC transport types: handlers, validated messages, rate limits, responses, payload map.
 */

import type {
  NotificationCloseRequest,
  NotificationData,
  NotificationLifecycleEvent,
  OnlineCheckRequest,
  OnlineStatusData,
  PasskeyFailureData,
} from './domain.js';
import type { IPCChannelName, IPC_CHANNELS } from '../constants.js';

/**
 * IPC event handler type
 */
export type IPCHandler<T> = (event: Electron.IpcMainEvent, data: T) => void | Promise<void>;

/**
 * Validated IPC message wrapper
 */
export interface ValidatedIPCMessage<T> {
  channel: IPCChannelName;
  data: T;
  timestamp: number;
  valid: boolean;
  error?: string;
}

/**
 * Rate limit tracking data
 */
export interface RateLimitEntry {
  count: number;
  windowStart: number;
  blocked: number;
}

/**
 * Typed response wrapper for IPC reply/invoke handlers.
 * Discriminated union — check `success` before accessing `data` or `error`.
 *
 * @example
 *   const response: IPCResponse<number> = { success: true, data: 42 };
 *   if (response.success) { console.log(response.data); } // number
 *   else { console.error(response.error); } // string
 */
export type IPCResponse<T> = { success: true; data: T } | { success: false; error: string };

/**
 * Maps each IPC channel string to its expected payload type.
 * Use this to enforce handler signature alignment with channel contracts.
 *
 * @example
 *   type Payload = IPCChannelPayloadMap[typeof IPC_CHANNELS.UNREAD_COUNT]; // number
 */
export interface IPCChannelPayloadMap {
  // renderer → main
  [IPC_CHANNELS.UNREAD_COUNT]: number;
  [IPC_CHANNELS.FAVICON_CHANGED]: string;
  [IPC_CHANNELS.NOTIFICATION_SHOW]: NotificationData;
  [IPC_CHANNELS.NOTIFICATION_CLICKED]: void;
  [IPC_CHANNELS.NOTIFICATION_CLOSE]: NotificationCloseRequest;
  [IPC_CHANNELS.CHECK_IF_ONLINE]: OnlineCheckRequest;
  [IPC_CHANNELS.PASSKEY_AUTH_FAILED]: PasskeyFailureData;
  // main → renderer
  [IPC_CHANNELS.SEARCH_SHORTCUT]: void;
  [IPC_CHANNELS.ONLINE_STATUS]: OnlineStatusData;
  [IPC_CHANNELS.NOTIFICATION_EVENT]: NotificationLifecycleEvent;
}

/**
 * Maps each IPC channel to its expected response payload type.
 * Complete request→response contract — every channel must be paired.
 *
 * All current channels are fire-and-forget (`void` response); this map
 * establishes the pattern for future bidirectional channels.
 *
 * @example
 *   type Response = IPCResponsePayloadMap[typeof IPC_CHANNELS.UNREAD_COUNT]; // void
 */
export interface IPCResponsePayloadMap {
  [IPC_CHANNELS.UNREAD_COUNT]: void; // fire-and-forget
  [IPC_CHANNELS.FAVICON_CHANGED]: void; // fire-and-forget
  [IPC_CHANNELS.NOTIFICATION_SHOW]: void; // fire-and-forget
  [IPC_CHANNELS.NOTIFICATION_CLICKED]: void; // fire-and-forget
  [IPC_CHANNELS.NOTIFICATION_CLOSE]: void; // fire-and-forget
  [IPC_CHANNELS.CHECK_IF_ONLINE]: void; // fire-and-forget
  [IPC_CHANNELS.PASSKEY_AUTH_FAILED]: void; // fire-and-forget
  [IPC_CHANNELS.SEARCH_SHORTCUT]: void; // fire-and-forget
  [IPC_CHANNELS.ONLINE_STATUS]: void; // fire-and-forget
  [IPC_CHANNELS.NOTIFICATION_EVENT]: void; // fire-and-forget
}

/** Maps an IPC channel name to its request type (e.g. "config:get" → RequestConfigPayload) */
export type ChannelRequest<K extends IPCChannelName> = IPCChannelPayloadMap[K];

/** Maps an IPC channel name to its response type (e.g. "config:get" → ConfigResponse) */
export type ChannelResponse<K extends IPCChannelName> = IPCResponsePayloadMap[K];
