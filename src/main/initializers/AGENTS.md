# Main Initializers Guide

**Parent:** `../AGENTS.md`

This directory is the canonical home for app startup/shutdown sequencing and build-time feature specs. Packaging arches do not change initializer contracts.

## Files

- `registerAppReady.ts` - owns `app.whenReady()` sequencing (phases, store, account-0, finalizer arming, deferred schedule).
- `registerShutdown.ts` - async shutdown path before `app.exit()`.
- `registerGlobalCleanups.ts` - lazy `import()` of cleanup owners (one leftover `require()` for session maintenance; avoid startup import cycles).
- `singletonDestroyers.ts` / `shutdownDiagnostics.ts` - ordered teardown helpers used by shutdown. About/Update destroyers and shutdown diagnostics are **dynamic-imported** (keep aurora HTML and diagnostic log strings out of the main entry); then perf/IPC/icon singletons.
- `security.spec.ts`, `ui.spec.ts`, `deferred.spec.ts` - declarative startup plan input (`FeatureSpec` from `utils/lifecycle/featureConfigTypes.ts`). `ui.spec.ts` is mixed: it owns **critical** `userAgent` plus UI `singleInstance` / `deepLinkHandler`.
- `registerAppReady.test.ts` characterizes ordering against unchanged production: security ∥ global cleanup, critical ∥ store, preconnect before account-0, account WebContents (not WCV host) owns load markers, UI before detached `setImmediate` deferred, deferred rejection does not relabel readiness, required security failure skips account/UI/deferred. Do not treat leftover production comments about “cert pinning + permissions” as current behavior — pinning is gone.

## Feature plan contract

- Specs use `as const satisfies readonly FeatureSpec[]`.
- Edit specs, not `src/main/generated/featurePlan.ts`.
- Build-time parsing happens in `scripts/featurePlanPlugin.js`.
- Runtime execution happens in `src/main/utils/lifecycle/featureRunner.ts`.
- Shared feature runtime state is in `src/main/utils/lifecycle/featureContextStore.ts`.
- Use `dependencies` for ordering. Avoid relying on lexical or array position.
- `userAgent` is the only spec with a static feature import (`ui.spec.ts`); others dynamic-import.

## Startup phases

1. Security before network (mediaPermissions is fire-and-forget TCC — does not block the phase).
2. Critical before account bootstrap completes.
3. UI after account manager/window state exists.
4. Deferred after first-window work.

Keep the phase boundary meaningful. If a feature can wait, keep it deferred.

## Performance finalizer arming

In `registerAppReady.ts`, after account-0 window construction:

1. Call `armPerformanceFinalizer({ getAccountManager })`.
2. Mark `account-0-ready` for native window readiness only.
3. On **account-0 WebContents** `did-finish-load` (`getAccountWebContents(0)`, not WCV host-only), mark `account-0-content-loaded` and `notifyDocumentLoadComplete()`.
4. On hard `did-fail-load` (not ERR_ABORTED): **log only**. Intermediate Google auth redirects often surface as fail-load events; do not treat them as terminal. Incomplete captures still fail via finalizer timeout / missing required markers. `notifyDocumentLoadFailed` exists on the finalizer for tests or explicit callers but is not wired from production `registerAppReady` today.

Before account-0 creation, optional session preconnect warms Google Chat/auth/CDN hosts unless `GOGCHAT_DISABLE_PRECONNECT=1`.

`registerAppReady` dynamically imports `cacheWarmer` on `setImmediate` (keeps cacheWarmer+configProfiler out of `lib/main/index.js`) then `runDeferredPhase` calls `notifyDeferredPhaseComplete()` after features load. Final metrics export is not owned by deferred-only paths. Icon warming (`warmInitialIcons` / `warmSoonDeferredIcons`) runs on the same `setImmediate` path as deferred — not on the critical path before first window. Deferred ordering (see `deferred.spec.ts` / generated `featurePlan.ts`): early batch includes `aboutPanel` + `appUpdates` (menu action registration) plus `badgeIcons` and `closeToTray`, which do not create a menu-bar tray; `appMenu` depends on `openAtLogin` / `externalLinks` / `appUpdates` / `aboutPanel`; `cdpTelemetry` depends on `appMenu`.

## Shutdown

Shutdown is deadline-bounded: 2,000 ms per stage and an independent 8,000 ms overall ceiling via injectable `AbortSignal.timeout` (`createProductionShutdownDeadlines`). A timed-out stage is abandoned, not cancelled; late rejection is logged; later stages still run in order; `app.exit()` is guarded once. `GOGCHAT_TEST_HANG_SHUTDOWN` may hang a named stage for process-level proof only and must be injected via the Playwright `extraElectronEnv` fixture — never as a module-level `process.env` assignment that other launches inherit. `registerShutdown.test.ts` also covers already-aborted stage/overall signals and each named hang-stage env.

Shutdown order is intentional:

1. `cleanupAll(ctx)` in reverse initialization order.
2. Global resource cleanup via `getCleanupManager()`.
3. Snapshot `peekAccountWindowManager()?.listAccountIndices()` then destroy the account window manager. Diagnostics must not call `getAccountWindowManager()` (that recreates an empty singleton).
4. Run shutdown diagnostics with the snapshotted indices (`logShutdownDiagnostics({ accountIndices })`).
5. Destroy singleton utilities.
6. `app.exit()`.

Never introduce a second shutdown owner or call `app.quit()` from cleanup code.

## Anti-patterns

- No runtime feature registration manager.
- No hand-edits to generated feature plans.
- No direct BrowserWindow/account logic inside specs.
- No bare timers in initializer code; use lifecycle tracked resources.
