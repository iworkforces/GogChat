# IPC Utilities Guide

**Parent:** `../AGENTS.md`

This directory owns the main-side IPC safety pipeline. Channel contracts and validation rules are packaging-arch independent.

## Pipeline

Every handler should follow:

1. Rate limit.
2. Validate payload.
3. Deduplicate only if safe.
4. Handle.
5. Catch/log typed failures.

Use `defineIPC({ kind: 'on' | 'reply' | 'invoke' })` for handlers. Live features (`handleNotification`, `inOnline`, `passkeySupport`) use `defineIPC`. Do not add ad-hoc `ipcMain.handle` / `ipcMain.on` calls.

## Components

- `defineIPC.ts` - handler factory for `on`, `reply`, and `invoke`.
- `rateLimiter.ts` - per-channel token bucket with 1s windows and stale cleanup. Keys are `${channel}:sender:${id}` when `event.sender.id` is present so multi-account senders are isolated.
- `ipcDeduplicator.ts` - short promise sharing, default 100ms.
- `ipcDeduplicationPatterns.ts` - key functions for safe dedup cases.
- `ipcFastPath.ts` - sync one-way hot `send` channels only; never for `invoke`.
- `ipcCommonValidators.ts` - reusable payload validation.
- `benignLogFilter.ts` - suppresses expected noisy renderer/subframe errors.

## Latency sampling

- `defineIPC` and `registerFastHandler` record one monotonic handler-execution sample per executed call through spans in `defineIPC.ts` (async chunks only). Throws and rejections are sampled; rate-limit drops, validation failures and dedup joiners are not. Reply timing ends before `event.reply`.
- Samples use the entry monitor from `getPerformanceMonitor()`, skip clocks when disabled, and resolve optional account identity through the non-constructing registry accessor, never the sender id. A late completion cannot populate a replacement monitor after destruction.
- IPC samples remain optional export fields; `ipcLatencyP50` stays **warn-only**, budget 5 ms. These are not renderer/transport round trips. The TESTING-only main hook reads the real monitor for built-app tests.
- Do not make IPC latency a gated CI metric without that baseline.

## Channel contract

- Channel names live in `src/shared/constants.ts` under `IPC_CHANNELS`.
- Payload/response types live in `src/shared/types/ipc.ts` and related domain types.
- Preload exposes narrow methods from `src/shared/types/bridge.ts`.
- Never hardcode a channel string.

## Existing channel groups

- Renderer → main (`IPC_CHANNELS`): `UNREAD_COUNT`, `FAVICON_CHANGED`, `NOTIFICATION_SHOW`, `NOTIFICATION_CLICKED`, `CHECK_IF_ONLINE`, `PASSKEY_AUTH_FAILED`.
- Main → renderer: `SEARCH_SHORTCUT`, `ONLINE_STATUS`.
- Notification show handlers must validate payloads (including icon allowlist via shared validators), then use `nativeNotification` / `notificationFocus`. Known exceptions: `notificationAccess` permission probe and `inOnline.showOfflineNotification`. Unread/favicon use `registerFastHandler`, not `defineIPC`.

## Anti-patterns

- No raw `ipcMain` registrations without validation and catch handling.
- No dedup for mutating or non-idempotent operations. Online checks must not use `deduplicate: true` — two senders need isolated probes. Do not put a `defineIPC` `rateLimit` on `CHECK_IF_ONLINE`; a 1/s cap would reject a same-sender replacement before supersession can abort the older probe. `inOnline` keeps one abortable probe per sender and applies `ONLINE_FETCH_MIN_INTERVAL_MS` after the handler runs so a tight loop cannot start unbounded `generate_204` fetches.
- No raw `ipcRenderer` exposure from preload.
- Fast-path (`registerFastHandler`) is sync send-only and passes `event.sender.id` to the existing limiter for independent per-sender buckets.
- `defineIPC.ts` is included in Vitest coverage. `defineIPC.test.ts` covers on/reply/invoke, sender-scoped rate limits, silent drops, channel and payload dedup, and IPCError rethrow from invoke.
