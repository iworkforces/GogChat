# Lifecycle Utilities Guide

**Parent:** `../AGENTS.md`

This directory owns runtime lifecycle mechanics: feature execution, shared feature context, cleanup tracking, errors, performance monitors, and global cleanup registration.

## Core files

- `featureRunner.ts` runs generated phase batches (`required !== true` is non-fatal; `platforms` is filtered; `ipcChannels` is documentation only).
- `featureConfigTypes.ts` defines feature init/cleanup contracts.
- `featureContextStore.ts` stores account manager/window context after bootstrap.
- `resourceCleanup.ts` owns tracked timers/listeners/cleanup tasks.
- `src/main/initializers/registerGlobalCleanups.ts` lazily imports cleanup owners with `Promise.all` to avoid startup cycles.
- `performanceTypes.ts` - shared schema version, MB/ms units, required startup markers, snapshot types.
- `performanceMonitor.ts` - markers, main-heap snapshots, renderer/GPU/utility sampling, IPC/memory latency rings.
- `performanceExport.ts` - versioned JSON export with capture completeness metadata.
- `performanceFinalizer.ts` - one-shot final export after deferred + document load + renderer sample. Import it by path.
- `configProfiler.ts` - optional store-read profiling used by `cacheWarmer.runDevPostDeferred`; rides the cacheWarmer async chunk (not in `lib/main/index.js`). Must not write metrics JSON. Tests use a mocked monotonic `performance.now` (100_000-iteration case asserts exact call count and elapsed).
- `cdpMetrics.ts` - local per-account FIFO JSON (`userData/cdp-metrics-account-N.json`, `MAX_RECORDS_PER_ACCOUNT = 1000`, no network). Consumed by `features/cdpTelemetry`. Best-effort; do not treat as load-bearing. Measure-first before any product edit.
- `errorHandler.ts` / `errorUtils.ts` / `logger.ts` / `errors.ts` - process error handler, pure error helpers, electron-log wrapper, typed app errors.
- `cleanupTypes.ts` exists to break import cycles; keep it lightweight.

## Performance contract

### Units and schema

- Memory is always **MB**; time is always **ms**. Embed `units` on every export.
- `PERF_EXPORT_SCHEMA_VERSION` must stay in lockstep with `scripts/headless-startup.js` and `scripts/check-perf-budget.js`. Packaging arch (arm64 vs x64) does not change the schema.
- Required unauthenticated markers include `app-start`, `app-ready`, `account-0-ready`, `account-0-content-loaded`, `features-loaded`, `all-features-loaded`.
- `account-0-ready` is native window readiness only. `account-0-content-loaded` is account-0 **document** load (`did-finish-load` on `getAccountWebContents(0)`, not WCV host-only). Neither is first paint nor first interaction.

### Final export ownership

- Development/CI export is owned by `performanceFinalizer.ts`, armed from `registerAppReady.ts`.
- Export runs exactly once when deferred phase has signaled complete **and** account-0 document load has completed (or failed/timed out), after an immediate `sampleAllRenderers`.
- Production path: account-0 WC `did-finish-load` → `notifyDocumentLoadComplete()`. Hard `did-fail-load` is logged in `registerAppReady` and is **not** treated as terminal (auth redirects). `notifyDocumentLoadFailed(reason)` remains available for tests/explicit callers and still forces an invalid export when used.
- Capture timeout or missing required markers produces `capture.complete=false` / `valid=false`, not a silent incomplete median.
- `cacheWarmer.runDevPostDeferred()` may profile config; it must **not** write metrics JSON.
- Use `getPerformanceMonitor()` inside the finalizer (not a stale module-level singleton after destroy).

### Renderer sampling

- Prefer `IAccountWindowManager.enumerateAccountWebContents()` for account ↔ PID mapping so WebContentsView child views are observed (not host-only).
- Include process identity helpers (`pid`, `creationTime`, optional `webContentsId` / `backend`) to reduce PID reuse ambiguity.
- On platforms without private memory, set `private: null` and `privateSource: 'unavailable'`. Never present unavailable private memory as measured zero.

### Buffers

- Latency/renderer rings stay FIFO-capped. Do not grow unbounded arrays.
- IPC handler execution samples come from async-chunk `ipc/defineIPC.ts`, use monotonic `performance.now()` durations and retain the monitor's `Date.now()`-based timestamp. The existing export/finalizer includes samples without changing schema version 1; `ipcLatencyP50` remains warn-only (5 ms). The IPC ring holds 1,000 samples; reset/destroy clears it, and in-flight handlers retain their entry instance rather than contaminating the next monitor.

## Cleanup contract

- Use tracked helpers for main-process timers/listeners: `createTrackedInterval`, `createTrackedTimeout`, `addTrackedListener`, `registerCleanupTask`, `registerGlobalCleanupCallback`.
- Cleanup must be idempotent and tolerate partially initialized modules.
- Shutdown order is owned by `src/main/initializers/registerShutdown.ts`.

## Feature runner rules

- Consume `src/main/generated/featurePlan.ts`; do not infer ordering at runtime.
- Preserve phase boundaries and dependency-batch semantics.
- Required-phase failures rethrow the original reason; do not invent a `{ cause }` wrapper here.

## Anti-patterns

- No bare timers in main-process lifecycle code.
- No direct account/window creation here.
- No edits to generated feature plans.
- No unbounded performance arrays or always-on metrics exports in packaged production.
- No early metrics export before document-load + renderer sample.
- No claiming paint/interaction readiness from account-ready or did-finish-load alone.
