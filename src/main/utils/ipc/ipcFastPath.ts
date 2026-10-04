/**
 * IPC Fast Path — sync handlers for high-frequency fire-and-forget channels.
 *
 * Preserves: rate limiting, validation (throw-based), error containment.
 * Removes: Promise allocation per call (~50µs saved/call on hot paths).
 *
 * ONLY for renderer→main `.send()` (one-way state push), NOT `invoke()`.
 * For request/response or async work, use `createSecureIPCHandler` instead.
 */

import { ipcMain, type IpcMainEvent } from 'electron';
import type { IPCChannelName } from '../../../shared/constants.js';
import { getRateLimiter } from './rateLimiter.js';
import { logger } from '../lifecycle/logger.js';
import { toErrorMessage } from '../lifecycle/errorUtils.js';
import { startIPCHandlerSpan } from './defineIPC.js';

export interface FastHandlerConfig<T> {
  channel: IPCChannelName;
  rateLimit: number;
  /** Throw-based validator: returns validated value or throws. */
  validator: (data: unknown) => T;
  /**
   * Synchronous handler — must not return a Promise.
   * Receives the validated payload and the originating IPC event (for sender routing).
   */
  handler: (data: T, event: IpcMainEvent) => void;
}

/**
 * Register a synchronous IPC handler on `ipcMain.on` (fire-and-forget).
 * Returns a cleanup function that removes the listener.
 */
export function registerFastHandler<T>(config: FastHandlerConfig<T>): () => void {
  const { channel, rateLimit, validator, handler } = config;
  const rateLimiter = getRateLimiter();

  const listener = (event: IpcMainEvent, data: unknown): void => {
    if (!rateLimiter.isAllowed(channel, rateLimit, event.sender.id)) return;

    let validated: T;
    try {
      validated = validator(data);
    } catch (error: unknown) {
      logger.ipc.warn(`Fast-handler ${channel}: validation failed: ${toErrorMessage(error)}`);
      return;
    }

    try {
      const finish = startIPCHandlerSpan({ channel, kind: 'fast', event });
      try {
        handler(validated, event);
      } finally {
        finish?.();
      }
    } catch (error: unknown) {
      logger.ipc.error(`Fast-handler ${channel} error:`, error);
    }
  };

  ipcMain.on(channel, listener);
  return () => ipcMain.removeListener(channel, listener);
}
