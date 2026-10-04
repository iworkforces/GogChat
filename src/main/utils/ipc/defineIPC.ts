/**
 * Unified IPC handler factory.
 *
 * `defineIPC(config)` is the standardized entry point that replaces the trio
 * of `createSecureIPCHandler` / `createSecureReplyHandler` /
 * `createSecureInvokeHandler` from `ipcHelper.ts`.
 *
 * The shared concerns (rate-limit → validate → log → optional dedup → handle
 * → catch) are implemented once, and the handler shape is selected by a
 * discriminated `kind` field:
 *
 *   - kind: 'on'      one-way IPC (renderer → main, no reply)
 *   - kind: 'reply'   one-way IPC that responds via `event.reply()`
 *   - kind: 'invoke'  request/response via `ipcRenderer.invoke()`
 *
 * The legacy `createSecure*Handler` exports remain in `ipcHelper.ts` (now
 * deprecated) and continue to work unchanged. New handlers should prefer
 * `defineIPC`. Existing handlers may be migrated incrementally.
 */

import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import type { IPCLatencySample } from '../lifecycle/performanceTypes.js';
import { getPerformanceMonitor } from '../lifecycle/performanceMonitor.js';
import { getSharedFeatureContext } from '../lifecycle/featureContextStore.js';
import { asWebContentsId } from '../../../shared/types/branded.js';

import type { IPCChannelName } from '../../../shared/constants.js';
import type { IPCResponse } from '../../../shared/types/ipc.js';
import { asType } from '../../../shared/typeUtils.js';
import { toError } from '../lifecycle/errorUtils.js';
import { IPCError } from '../lifecycle/errors.js';
import { logger } from '../lifecycle/logger.js';
import { getDeduplicator } from './ipcDeduplicator.js';
import { getRateLimiter } from './rateLimiter.js';

type HandlerSpan = {
  readonly channel: IPCChannelName;
  readonly kind: NonNullable<IPCLatencySample['kind']>;
  readonly event: IpcMainEvent | IpcMainInvokeEvent;
};

export function startIPCHandlerSpan(span: HandlerSpan): (() => void) | undefined {
  const monitor = getPerformanceMonitor();
  if (!monitor.isEnabled()) return undefined;
  const sender = span.event.sender;
  const accountIndex =
    !sender || sender.isDestroyed()
      ? null
      : getSharedFeatureContext().accountWindowManager?.getAccountForWebContents(
          asWebContentsId(sender.id)
        );
  const options = { kind: span.kind, ...(accountIndex == null ? {} : { accountIndex }) };
  const started = performance.now();
  // Keep the entry instance: a late completion cannot populate its replacement after shutdown.
  return () => monitor.recordIpcLatency(span.channel, performance.now() - started, options);
}

export function runIPCHandler<T>(span: HandlerSpan, handler: () => T | Promise<T>): T | Promise<T> {
  const finish = startIPCHandlerSpan(span);
  if (!finish) return handler();
  let pending = false;
  try {
    const result = handler();
    const thenable = asType<PromiseLike<T>>(result);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Rereads change accessor thenables' await semantics; call restores this.
    const then = result == null ? undefined : thenable.then;
    if (typeof then === 'function') {
      pending = true;
      return new Promise<T>((resolve, reject) => {
        then.call(thenable, resolve, reject);
      }).finally(finish);
    }
    return result;
  } finally {
    if (!pending) finish();
  }
}

if (process.env['TESTING'] === 'true') {
  const testGlobal = asType<
    typeof globalThis & { __gogchatIPCPerformance?: typeof getPerformanceMonitor }
  >(globalThis);
  testGlobal.__gogchatIPCPerformance = getPerformanceMonitor;
}

/** Common config fields shared by all `defineIPC` variants. */
interface DefineIPCBase<T> {
  /** IPC channel name (must be a registered channel). */
  channel: IPCChannelName;
  /**
   * Validates and narrows the raw payload. Throw to reject; the thrown error
   * is funneled through `onError` and (for `reply`/`invoke`) surfaced to the
   * renderer via the standard `IPCResponse` envelope.
   */
  validator: (data: unknown) => T;
  /** Optional per-channel rate limit (messages/second). */
  rateLimit?: number;
  /** Optional error sink. Invoked after logging, before any reply/throw. */
  onError?: (error: Error, event: IpcMainEvent | IpcMainInvokeEvent) => void;
  /** Suppress info/debug/error logging when true. */
  silent?: boolean;
  /** Optional human-readable description for logs. */
  description?: string;
  /**
   * When true, the handler body is wrapped with the IPC deduplicator using
   * the channel name as the dedup key (default 100ms window).
   *
   * Mutually exclusive with `withDeduplication` — if both are set,
   * `withDeduplication` wins.
   */
  deduplicate?: boolean;
  /**
   * Fine-grained, payload-aware deduplication. Wraps the handler body with
   * the deduplicator after rate-limit and validation, preserving the
   * canonical chain: rate-limit → validate → dedup → handle → catch.
   */
  withDeduplication?: {
    keyFn: (channel: IPCChannelName, validated: NoInfer<T>) => string;
    windowMs: number;
  };
}

/** One-way handler (renderer → main, no reply). */
export interface DefineIPCOnConfig<T> extends DefineIPCBase<T> {
  kind: 'on';
  handler: (data: NoInfer<T>, event: IpcMainEvent) => void | Promise<void>;
}

/** Reply-style handler (one-way with `event.reply()` envelope). */
export interface DefineIPCReplyConfig<T, R> extends DefineIPCBase<T> {
  kind: 'reply';
  handler: (data: NoInfer<T>, event: IpcMainEvent) => R | Promise<R>;
  /** Override the default `${channel}-reply` response channel. */
  replyChannel?: string;
}

/** Invoke-style handler (request/response via `ipcRenderer.invoke`). */
export interface DefineIPCInvokeConfig<T, R> extends DefineIPCBase<T> {
  kind: 'invoke';
  handler: (data: NoInfer<T>, event: IpcMainInvokeEvent) => R | Promise<R>;
}

/** Discriminated union accepted by `defineIPC`. */
export type DefineIPCConfig<T, R = void> =
  DefineIPCOnConfig<T> | DefineIPCReplyConfig<T, R> | DefineIPCInvokeConfig<T, R>;

/** Cleanup function returned by `defineIPC` — removes the registered listener. */
export type DefineIPCCleanup = () => void;

/**
 * Internal: runs the canonical pipeline.
 * rate-limit → validate → log → (optional dedup) → execute → catch.
 *
 * Returns the executed result, or `undefined` if rate-limited / errored.
 * The caller decides how to surface those outcomes (no-op, reply envelope,
 * or rethrow).
 */
async function runPipeline<T, R>(
  config: DefineIPCBase<T>,
  data: unknown,
  event: IpcMainEvent | IpcMainInvokeEvent,
  execute: (validated: T) => R | Promise<R>,
  hooks: {
    debugLabel: string;
    errorLabel: string;
    onRateLimited?: () => void;
    beforeOnError?: (err: Error) => void;
    afterOnError?: (err: Error) => void;
  }
): Promise<R | undefined> {
  const {
    channel,
    validator,
    rateLimit,
    onError,
    silent = false,
    description,
    deduplicate = false,
    withDeduplication,
  } = config;
  const log = logger.ipc;

  try {
    const senderId = event.sender?.id;
    if (rateLimit !== undefined && !getRateLimiter().isAllowed(channel, rateLimit, senderId)) {
      if (!silent) {
        log.warn(`Rate limited: ${channel}`);
      }
      hooks.onRateLimited?.();
      return undefined;
    }

    const validated = validator(data);

    if (!silent) {
      log.debug(`${hooks.debugLabel}${channel}${description ? ` (${description})` : ''}`);
    }

    if (withDeduplication) {
      const key = withDeduplication.keyFn(channel, validated);
      return await getDeduplicator().deduplicate(
        key,
        () => Promise.resolve(execute(validated)),
        withDeduplication.windowMs
      );
    }
    if (deduplicate) {
      return await getDeduplicator().deduplicate(channel, () =>
        Promise.resolve(execute(validated))
      );
    }
    return await execute(validated);
  } catch (error: unknown) {
    const raw = toError(error);
    const err =
      raw instanceof IPCError
        ? raw
        : new IPCError(raw.message, 'IPC_INVALID_PAYLOAD', { cause: raw });

    if (!silent) {
      log.error(`${hooks.errorLabel}${channel}`, err.message);
    }

    hooks.beforeOnError?.(err);
    onError?.(err, event);
    hooks.afterOnError?.(err);
    return undefined;
  }
}

/**
 * Unified IPC factory. Registers a handler with the canonical pipeline and
 * returns a cleanup function that removes the listener.
 *
 * @example
 *   // One-way handler
 *   const off = defineIPC({
 *     kind: 'on',
 *     channel: IPC_CHANNELS.NOTIFICATION_SHOW,
 *     validator: validateNotificationData,
 *     rateLimit: RATE_LIMITS.IPC_NOTIFICATION,
 *     handler: (data) => { ... },
 *   });
 *
 *   // Invoke handler
 *   const off = defineIPC({
 *     kind: 'invoke',
 *     channel: IPC_CHANNELS.GET_CONFIG,
 *     validator: commonValidators.noData,
 *     handler: () => loadConfig(),
 *   });
 */
export function defineIPC<T, R = void>(config: DefineIPCConfig<T, R>): DefineIPCCleanup {
  switch (config.kind) {
    case 'on': {
      const { handler } = config;
      const listener = (event: IpcMainEvent, data: unknown) => {
        void runPipeline<T, void>(
          config,
          data,
          event,
          (validated) =>
            runIPCHandler({ channel: config.channel, kind: 'on', event }, () =>
              handler(validated, event)
            ),
          {
            debugLabel: 'Handling ',
            errorLabel: 'Handler failed: ',
          }
        );
      };
      ipcMain.on(config.channel, listener);
      return () => {
        ipcMain.removeListener(config.channel, listener);
      };
    }

    case 'reply': {
      const { handler, replyChannel } = config;
      const responseChannel = replyChannel ?? `${config.channel}-reply`;
      const listener = (event: IpcMainEvent, data: unknown) => {
        void runPipeline<T, void>(
          config,
          data,
          event,
          async (validated) => {
            const response = await runIPCHandler(
              { channel: config.channel, kind: 'reply', event },
              () => handler(validated, event)
            );
            event.reply(responseChannel, {
              success: true,
              data: response,
            } satisfies IPCResponse<R>);
          },
          {
            debugLabel: 'Handling ',
            errorLabel: 'Reply handler failed: ',
            onRateLimited: () => {
              event.reply(responseChannel, {
                success: false,
                error: 'Rate limited',
              } satisfies IPCResponse<R>);
            },
            beforeOnError: (err) => {
              event.reply(responseChannel, {
                success: false,
                error: err.message,
              } satisfies IPCResponse<R>);
            },
          }
        );
      };
      ipcMain.on(config.channel, listener);
      return () => {
        ipcMain.removeListener(config.channel, listener);
      };
    }

    case 'invoke': {
      const { handler } = config;
      const listener = async (event: IpcMainInvokeEvent, data: unknown): Promise<R> => {
        const result = await runPipeline<T, R>(
          config,
          data,
          event,
          (validated) =>
            runIPCHandler({ channel: config.channel, kind: 'invoke', event }, () =>
              handler(validated, event)
            ),
          {
            debugLabel: 'Handling invoke ',
            errorLabel: 'Invoke handler failed: ',
            onRateLimited: () => {
              throw new Error('Rate limited');
            },
            afterOnError: (err) => {
              throw err;
            },
          }
        );
        return asType<R>(result);
      };
      ipcMain.handle(config.channel, listener);
      return () => {
        ipcMain.removeHandler(config.channel);
      };
    }
  }
}
