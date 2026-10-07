# Tests Guide

**Parent:** `../AGENTS.md`

Tests cover unit, integration, e2e, performance, and packaging-contract behavior for an Electron app. Use `bun` commands only.

## Commands

```bash
bun run test
bun run test:run
bun run test:coverage
bun run typecheck
bun run build:prod
bun run check:doc-claims
```

## Test tiers

- Unit: Vitest, colocated `*.test.ts` and `scripts/**/*.test.js` (included by `vitest.config.ts`).
- Integration/e2e/performance: Playwright/Electron helpers under `tests/`. `*.spec.ts` under `initializers/` are **feature-plan input**, not tests.
- Playwright config: `testDir: './tests'`, `workers: 1`, timeout 60000 (e2e project 120000 for cold macos CI document load), retries 0, four isolated projects — `e2e`, `integration`, `performance`, `preload-artifact`. Contract: `scripts/playwright-config.test.js`. `preload-artifact` executes `tests/artifact/preload/preload-entry.test.ts` against built `lib/preload/index.js`.
- Coverage (`vitest.config.ts`): 94/92/94/94 on `src/**/*.ts` only. Includes remediates seams (`src/preload/**` except `overrideNotifications.ts`, `registerAppReady.ts`, `inOnline.ts`, `appUpdates.ts`, `defineIPC.ts`). CDP product files and `src/main/generated/**` stay excluded.
- Evidence classes (source-unit, built-CJS execution, packaged-presence, packaged-runtime, headless, workflow) are defined in root `AGENTS.md`. Do not substitute one for another.
- `tests/helpers/accountRoutingConformance.ts` is Vitest-only (imported by colocated account manager tests); Playwright integration has its own `account-routing-conformance.test.ts`.

## Electron test helpers

- Import fixtures from `tests/helpers/electron-test.ts`, not directly from `@playwright/test`.
- Use `tests/mocks/electron.ts` for Electron mocks.
- Reset with `electronMock.reset()` and `vi.clearAllMocks()` between cases.
- Keep `tests/polyfill-crypto.cjs` loaded for crypto-dependent unit tests.
- Electron 44 evaluate is ESM: do not call `require()` or `import()` inside `electronApp.evaluate`. Use `BrowserWindow` APIs, `evaluateWithRequire` (binds CJS `require` via `process.getBuiltinModule`), or `TESTING` hooks such as `__gogchatGetAccountWindowManager`. `Page.isVisible()` needs a selector — `isMainWindowVisible()` / `waitForMainWindowVisible()`. Skip authenticated Chat UI when no session exists. Accept `workspace.google.com` as a Chat landing URL. Do not wait on unbounded `networkidle` — use `waitForLoadStateBounded`. Do not assert exact `setSize` pixels on macOS CI; product mins are 480×570. Unauthenticated CI may land on `accounts.google.com` (`isGoogleSurfaceUrl`). Shared-fixture force-show is best-effort (`showMainWindowBestEffort`). Playwright `evaluate` can throw `Resulting promise was garbage collected` after many sequential launches — wrap with `wrapEvaluateWithGcRetry` and do not fail the fixture for a single GC. Do not `await evaluate(app.quit())` — race the child `exit` event. Bound `sendIPCFromMain` and never `await app.close()` without `closeElectronApp`. After `app.quit()`, `app.process()` throws `reading '_object'`; `peekElectronChildProcess` / `closeElectronApp` must swallow that. Never await unbounded `app.close()` in fixture teardown — race it (`ELECTRON_CLOSE_TIMEOUT_MS`) and `SIGKILL` a leftover child. After SIGKILL wait for `exitCode` (do not treat `killed` as gone). Launch via `launchElectronAppWithWindow` (bounded `firstWindow`, one retry, unique userData). Do not call bare `app.firstWindow()`. Playwright performance cases must not treat Chat DOM size or `page.evaluate` RTT as product IPC budgets (`IPC_AVERAGE` 50ms / `DOM_NODES` 15000). Default launches set `GOGCHAT_TEST_APP_URL` to `tests/fixtures/electron-harness.html`; `environment.resolveAppUrl` honors that only when `TESTING=true` and only for `file:` / loopback `http:`. Opt into Chat with `GOGCHAT_TEST_APP_URL=''`.
- `GOGCHAT_TEST_HANG_SHUTDOWN` is opt-in via `test.use({ extraElectronEnv: { GOGCHAT_TEST_HANG_SHUTDOWN: 'feature' } })`. The default Electron fixture strips that env so other integration files cannot inherit a hung shutdown.
- Do not leave `expect(true).toBe(true)` or “window still exists” as the only assertion when the case claims to exercise IPC or the account manager.

## What to test

- Startup/spec changes: generated feature plan and phase ordering. App-ready orchestration: `src/main/initializers/registerAppReady.test.ts` (preconnect before account-0, account WC load markers, UI before deferred).
- IPC changes: validation, rate limiting, dedup behavior, success and failure paths.
- Account changes: partition persistence, auth-page protection, switching, dehydration, single hydration navigation, `enumerateAccountWebContents` (both backends), sparse `listAccountIndices` / `hasAccount` (includes dehydrated), WCV three-state, hooks re-fire on BW dehydrate→hydrate, WC-first `loadAccountURL` (never WCV host loadURL).
- Preload/offline changes: false online replies produce zero reloads; true reply for the current `attemptId` produces one app-URL replace; older/unknown ids and post-timeout replies are ignored; bridge cleanup on unload.
- Security changes: URL validation (including `validateNotificationIconURL`), shell wrapper usage, CSP exceptions, media TCC, empty/unknown-only `mediaTypes` deny, requesting-origin trust (no embeddingOrigin allow), notification permission (`notificationAccess` first-run dialog + probe, CI skip, flag only on `show`), and no custom `certificate-error` listeners after security phase init.
- Notification presentation: `nativeNotification`, `notificationFocus`, `accountNotificationIdentity`, `accountLabelStore`, bridge vs unread-delta sources, multi-account subtitle/tag namespacing, unread-delta suppress only when host focused **and** `isAccountVisible`.
- Update checks: `src/main/features/appUpdates.test.ts` covers the pure stable-release parser, manual 10s hung-fetch abort, the shared session gate, and background silence (prerelease-first, draft-only, out-of-order lists, bad `html_url`, timeout, HTTP failure, preference, shutdown, concurrent manual). Surface: `tests/integration/manual-update.test.ts` and `tests/integration/background-update.test.ts` launch Electron (temp `user-data-dir`) so `electronApp.evaluate` can replace main-process `globalThis.fetch` with `tests/helpers/githubReleaseFixtures.ts`. The background test lets the real 5s timer fire once, then uses the `TESTING` hook for failure fixtures. Close the app with `closeElectronApp` (never unbounded `app.close()`) and remove that temp userData in `finally`.
- Timing tests in `configProfiler.test.ts` and `performanceMonitor.test.ts` must stay on mocked clocks; do not reintroduce `Date.now()` busy-waits or `<N ms` wall-clock assertions.
- Performance / packaging contracts (TDD): finalizer complete+valid only; headless invalid runs retained (no medians from incomplete sets); missing gated metric → FAIL; warn-only → SKIP/WARN; MB once; package closure + candidate `NO CHANGE`; claim validators reject overclaim. Packaging contracts live with the scripts (`package-scaffold`, `release-workflow`, mac/Windows artifact+signing tests).

## Live harnesses (not Vitest)

```bash
bun run build:prod
GOGCHAT_PERF_RUNS=5 HEADLESS_TIMEOUT_MS=90000 node scripts/headless-startup.js
node scripts/check-perf-budget.js performance-metrics.json
bun scripts/verify-packaged-dependency-closure.js
bun scripts/account-backend-benchmark.js --verify-contract
bun scripts/release-auth-readiness-benchmark.js --record-blocked
# Local dual-arch package smoke (unsigned when credentials absent):
bun run package:mac:x64
bun run package:mac:arm64
bun run package:mac:artifacts
```

CI remains unauthenticated. Authenticated first-interaction is credential-isolated; without credentials expect `[blocked: credentials unavailable]`.

PR Check sequence lives in `scripts/AGENTS.md`. Default `bun run test` is Vitest only. Electron Playwright cases need a production build first and import from `tests/helpers/electron-test.ts`.

## Anti-patterns

- Do not delete failing tests to pass.
- Do not bypass app helpers with raw Playwright fixtures in Electron tests.
- Do not hardcode generated feature-plan output when a spec-level assertion works.
- Do not make e2e tests order-dependent; workers are one today but tests should remain isolated.
- Do not invent measured medians or claim backend winners without valid benchmark cells.
- Do not treat package-byte reductions as startup improvements in assertions or fixtures.
- Do not accept a single macOS DMG as a complete release set. Publish gate is both mac DMGs + both Windows NSIS + four matching unsigned sidecars (`verify-release-artifacts.test.js`). Sidecars are not packaged-runtime proof.
