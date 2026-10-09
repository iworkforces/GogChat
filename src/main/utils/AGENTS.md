# Main Utilities Guide

**Parent:** `../AGENTS.md`

`src/main/utils` contains reusable main-process mechanics. Keep orchestration in initializers/features and keep reusable infrastructure here.

## Subdirectories

| Area                 | Path         | Guide                 |
| -------------------- | ------------ | --------------------- |
| Account backends     | `account/`   | `account/AGENTS.md`   |
| Config cache/access  | `config/`    | `config/AGENTS.md`    |
| IPC pipeline         | `ipc/`       | `ipc/AGENTS.md`       |
| Lifecycle/resources  | `lifecycle/` | `lifecycle/AGENTS.md` |
| Platform/menu/badges | `platform/`  | `platform/AGENTS.md`  |
| Security wrappers    | `security/`  | `security/AGENTS.md`  |

## Utility ownership

- `account/` owns BrowserWindow and WebContentsView account backends, WC-first `accountNavigation`, shared `accountWebPreferences`, multi-account `accountWebContentsHooks`, `accountLifecycleHelpers` / `accountWindowsStore` composition, hydration ownership, `enumerateAccountWebContents()`, sparse indices/visibility, and WCV host `ready-to-show` notification permission ensure.
- `lifecycle/` owns feature execution, cleanup tracking, errors, performance monitors/export/finalizer, local CDP JSON (`cdpMetrics`), optional config profiling, and context storage.
- `ipc/` owns main-side handler wrappers (`defineIPC` for new handlers), rate limiting, dedup, fast-path send helpers, and validators.
- `security/` owns shell wrappers, SafeStorage secure flags (e.g. CDP kill switch; residual cert-pin key unused for TLS), permission/CSP helpers, media access, **notification authorization** (`notificationAccess.ts`), and encryption key utilities. Custom certificate pinning is **not** owned here (feature removed; Chromium is TLS trust).
- `platform/` owns dock/app badges (startup does not create a menu-bar tray), native notification **presentation** (`nativeNotification`, `notificationFocus`, account label/identity helpers), unread-delta visibility gate, icon cache, dock/menu helpers, window defaults, **native About/Update dialog chrome** (`dialogChrome.ts`, `updateWindow.ts`), and help-menu builders (shared across arm64/x64 packaging arches).
- `config/` owns typed electron-store schema/cache helpers only; secure flags are not config.

## Resource rules

- `cacheWarmer` is dynamically imported from `registerAppReady` (bundle budget).
- Deep performance notes live in `PERFORMANCE_UTILITIES.md` when present; always prefer `lifecycle/AGENTS.md` and `performanceTypes.ts` for the versioned export contract, MB units, and finalizer ownership.
- Main-process timers/listeners must be tracked with `createTrackedInterval`, `createTrackedTimeout`, `addTrackedListener`, `registerCleanupTask`, or `registerGlobalCleanupCallback`.
- Bare timer exceptions must be documented and rare; `errorHandler` has a circular-dependency exception.
- Cleanups should be idempotent and safe during partial startup failures.
- Metrics export must not run from ad-hoc feature code; use the finalizer path.

## Import rules

- Utilities may import from `src/shared` freely.
- Avoid feature-to-feature dependencies via utilities. If a utility starts depending on feature state, move the boundary.
- Do not add barrel files. Import each utility module by its path.
- Prefer small utility modules over large cross-domain catchalls.

## Logging scopes

Use existing logger scopes rather than ad-hoc console output. Keep scope names stable because tests and diagnostics rely on them.

## Anti-patterns

- No BrowserWindow account logic outside `account/` unless it is a narrow platform default.
- No direct `shell.openExternal()`; use `security/shellWrapper.ts`.
- No unvalidated IPC payloads or string-literal IPC channels.
- No config reads for SafeStorage-backed kill switches.
