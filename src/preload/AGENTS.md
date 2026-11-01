# Preload Guide

**Parent:** `../AGENTS.md`

The preload is sandboxed and built as CommonJS because Electron sandboxed preloads cannot load ESM. It exposes a narrow, validated bridge to Google Chat pages. Packaging arch and account backend (BW vs WCV) do not change the preload CJS contract.

## Build/runtime constraints

- Keep preload output CJS and imports compatible with `.js` paths. Packaging arch (arm64/x64 DMG) does not change the CJS contract.
- Do not remove the preload build `cleanDistPath: false` behavior; main and preload builds share output.
- No Node/config access from preload. Use IPC.
- No raw `ipcRenderer` exposure through `contextBridge`.
- Bare debounce timers are acceptable here; main-process tracked timer helpers are unavailable in the sandbox.
- Do not load feature preloads conditionally as part of offline recovery work; keep the existing import list stable unless a plan explicitly requires it.

## Current entry shape

`src/preload/index.ts` calls explicit installers in order: `installDisableWebAuthn` → `contextBridge.exposeInMainWorld('gogchat')` → `installFaviconChanged` → `installOffline` → `installPasskeyMonitor` → `installSearchShortcut` → `installUnreadCount` → `installNotificationBridge`. Do **not** import `overrideNotifications.ts` from `index.ts`. Do not add bare side-effect imports.

Account webPreferences attach only `lib/preload/index.js`. Rsbuild still emits every `src/preload/*.ts` file as a CJS entry, including leftover `overrideNotifications.ts` — that extra emit is **not** a live product path.

- Isolated-world code cannot see `window.gogchat`. Feature installers may use the bridge when present (unit tests) and must fall back to `ipcRenderer` in production. `offline.test.ts` and `searchShortcut.test.ts` cover that ipc fallback.
- `installDisableWebAuthn` nulls isolated `navigator.credentials` first and injects the same override into page world via `webFrame.executeJavaScript`. Swallow a rejected page-world injection with `Promise.resolve(injected).catch` — never call `.catch` on a possibly non-thenable return.
- `installPasskeyMonitor` runs after that null-out, so wrapping `navigator.credentials` is largely unreachable in production (`monitorWebAuthn` returns early when credentials is missing). If the IPC fallback still fires, it must `validatePasskeyFailureData` and send the **object** (`{ errorType, timestamp }`), never a bare string — main `parsePasskeyFailureData` requires a plain object.
- `searchShortcut.ts` focuses `SELECTORS.SEARCH_INPUT`. Built-CJS proof: `tests/artifact/preload/preload-entry.test.ts` (`--project=preload-artifact`).
- `src/preload/**` is included in Vitest coverage except leftover `overrideNotifications.ts`. Do not stack multiple `install*()` calls that leave `window` listeners if a later case deletes `window.gogchat` — old listeners will take the ipc path.

## Bridge surface

`GogChatBridgeAPI` exposes send methods for unread count, favicon changes, notification clicks, online checks, and passkey auth failures, plus subscriptions for search shortcut and online status.

- Validate outgoing data before `ipcRenderer.send`.
- Return unsubscribe functions for subscriptions.
- Do not expose generic invoke/send helpers.

## Offline recovery (`offline.ts`)

- Listens for DOM `app:checkIfOnline`, generates an opaque `attemptId`, and calls `window.gogchat.checkIfOnline(attemptId)` (ipc fallback sends `{ attemptId }`).
- Subscribes to `onOnlineStatus` with the validated discriminated `OnlineStatusData` (`{ attemptId, outcome }`, plus `httpStatus` only for `http-error`). The switch on `outcome` is exhaustive (`assertNever`). Only the current attempt may settle:
  - **`online`** → exactly one `window.location.replace(urls.appUrl)` transition.
  - **`http-error` / `network-error` / `timeout`** → dispatch DOM-only `CustomEvent` `app:onlineCheckFailed` with `detail` `{ outcome, httpStatus? }` so the offline page shows feedback and restores retry UI. **Do not** `location.reload()`.
- Older or unknown `attemptId` values, and payloads that fail `validateOnlineStatusData` (legacy `online` boolean, unknown outcome, bad status), must not clear the deadline, restore retry, or navigate.
- Each check arms a 6,000 ms deadline; a newer check clears and rearms it. Timeout dispatches `app:onlineCheckFailed` with `{ outcome: 'timeout' }` once (the same state as a main-side timeout) and invalidates that attempt so a late reply of any outcome is ignored. Clear the deadline on a current response or unload.
- `beforeunload` removes the check listener, cancels the deadline/attempt, and unsubscribes from online status.
- Keep the existing narrow bridge surface; never expose raw `ipcRenderer` to the offline page.

## DOM behavior

- DOM observation uses `MutationObserver`.
- `disableWebAuthn.ts` must remain the first feature import in `src/preload/index.ts` so `navigator.credentials` is neutralized before Google scripts. Keep that authored order when adding modules.
- Keep selectors and timing constants in shared constants where practical.

## Notification override

- `notificationBridge.ts` is the live context-isolated path used by `index.ts`: page-world `Notification` wrapper via `webFrame.executeJavaScript`, isolated custom-event listener, `validateNotificationData`, then `IPC_CHANNELS.NOTIFICATION_SHOW`.
- Main shows OS banners via `handleNotification` → `nativeNotification`; multi-account identity is resolved from the IPC sender in main, not from preload.
- Do not replace this with script-tag injection; Google CSP is intentionally preserved.
- `overrideNotifications.ts` is a leftover Rsbuild preload entry (`contextIsolation: false` era). It is **not** attached at runtime. Do not import it from `index.ts`.

## Tests

Keep coverage around `index.test.ts`, `notificationBridge.test.ts`, `offline.test.ts`, unread count, favicon changes, passkey monitoring, search shortcut, and WebAuthn disabling when touching preload behavior. Offline recovery tests must assert zero reloads on failed replies (each category's DOM `detail`), one app-URL replace on the current successful attempt, ignored older/unknown/`timeout`-then-stale `attemptId`s, unload cancellation, and ipc fallback when `window.gogchat` is absent.
