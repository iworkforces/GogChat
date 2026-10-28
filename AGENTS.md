# PROJECT KNOWLEDGE BASE

**Generated:** 2026-09-14
**Commit:** 97c0989
**Branch:** develop
**Version:** 3.21.4

## OVERVIEW

macOS-first Electron wrapper for Google Chat (`https://chat.google.com`). Dual Rsbuild: ESM main + CJS sandboxed preload. Separate arm64/x64 DMGs. Bundle id `com.ocworkforces.gogchat`. No `src/renderer` — UI is remote Chat + `offline/` + sandboxed About/Update `data:` dialogs.

## STRUCTURE

```
./
├── src/main/           # Electron main (thin index.ts)
├── src/preload/        # CJS sandbox bridge → window.gogchat
├── src/shared/         # main+preload contracts (no Electron)
├── src/offline/        # static network-loss page
├── scripts/            # build, package, perf gates, release DAG
├── tests/              # Playwright projects + leftover Vitest helpers; unit is colocated
├── resources/          # extraResources icons
├── mac/                # docs-only; packaging assets live at repo root
└── docs/plans/         # historical/work plans (not product truth)
```

## WHERE TO LOOK

| Task           | Location                                                 | Notes                                                     |
| -------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| App entry      | `src/main/index.ts`                                      | Thin: V8 heap, single-instance, deep-link, ready/shutdown |
| whenReady      | `src/main/initializers/registerAppReady.ts`              | Dynamic-imports `cacheWarmer` on `setImmediate`           |
| Feature specs  | `src/main/initializers/{security,ui,deferred}.spec.ts`   | Only registration path                                    |
| Generated plan | `src/main/generated/featurePlan.ts`                      | **Do not hand-edit**                                      |
| Feature runner | `src/main/utils/lifecycle/featureRunner.ts`              | Walks generated batches                                   |
| BW accounts    | `src/main/utils/account/accountWindowManager.ts`         | Default backend                                           |
| WCV accounts   | `src/main/utils/account/accountViewManager.ts`           | Opt-in `app.useWebContentsView`                           |
| WC navigation  | `src/main/utils/account/accountNavigation.ts`            | Never WCV host `loadURL`                                  |
| IPC names      | `src/shared/constants.ts`                                | Never string literals                                     |
| Preload        | `src/preload/index.ts`                                   | CJS; no raw `ipcRenderer` on bridge                       |
| Identity       | `src/shared/appIdentity.ts` + `scripts/app-identity.cjs` | Lockstep with electron-builder                            |
| Perf export    | `src/main/utils/lifecycle/performanceFinalizer.ts`       | One-shot; not `runDevPostDeferred`                        |
| Budget         | `scripts/check-perf-budget.js`                           | `mainBundleSize` 100KB gated                              |
| Tests          | `tests/AGENTS.md`                                        | Four Playwright projects                                  |
| Packaging      | `mac/AGENTS.md` + `scripts/AGENTS.md`                    | Dual DMG + guarded Windows + unsigned JSON sidecars       |
| Sidecar schema | `scripts/release-artifact-sidecar.js`                    | `schemaVersion` 1; not an attestation                     |

Child guides: `src/`, `src/main/` (+ features/initializers/utils/{account,config,ipc,lifecycle,platform,security}), `src/shared/` (+ types), `src/preload/`, `src/offline/`, `scripts/`, `tests/`, `mac/`, `resources/`. Skip `docs/`, `.github/workflows/`, `src/main/generated/`, `resources/icons/*` — parent + `scripts/` cover them.

## CODE MAP

Centrality is **grep-estimated** (no LSP/codegraph in this workspace).

| Symbol                    | Type  | Location                      | Refs (prod files) | Role                      |
| ------------------------- | ----- | ----------------------------- | ----------------- | ------------------------- |
| `IPC_CHANNELS`            | const | `src/shared/constants.ts`     | ~29               | Channel name hub          |
| `asType`                  | fn    | `src/shared/typeUtils.ts`     | ~24               | Allowed cast helper       |
| `asAccountIndex`          | fn    | `src/shared/types/branded.ts` | ~12               | Brand constructor         |
| `getAccountWindowManager` | fn    | `accountWindowManager.ts`     | ~12               | Account singleton factory |
| `loadAccountURL`          | fn    | `accountNavigation.ts`        | ~8                | WC-first navigation       |
| `perfMonitor`             | const | `performanceMonitor.ts`       | ~6                | Startup markers           |
| `runPhase`                | fn    | `featureRunner.ts`            | ~4                | Phase execution           |
| `registerAppReady`        | fn    | `registerAppReady.ts`         | ~8                | whenReady owner           |

Hotspots (>400 prod lines): `accountViewManager.ts` (805), `accountWindowManager.ts` (799), `updateWindow.ts` (628), `appIconAurora.ts` (546), `performanceMonitor.ts` (467).

## CONVENTIONS

- **bun only** (`packageManager: bun@1.4.4`). Node `>=24.16.0 <25.0.0`. Electron `^44.3.0`.
- Typecheck is `@typescript/native` (TS 7), not the `typescript` 6.x package (used by feature-plan parser).
- NodeNext `.js` specifiers. `import type`. `asType` / branded helpers — no `as any` / `@ts-ignore`.
- Feature-to-feature imports forbidden except `menuActionRegistry.ts`.
- No `shell.openExternal` — `validateExternalURL` + `shellWrapper`.
- Dual Rsbuild: one ESM `src/main/index.ts` → `lib/main/index.js`; every `src/preload/*.ts` → CJS; preload `cleanDistPath: false`.
- Prod minify + **async-only** split (`lib/chunks/`). `mainBundleSize` = `lib/main/index.js` ≤ 100KB (1024).
- Vitest: colocated `*.test.ts` + `scripts/**/*.test.js`. Playwright dirs excluded. Coverage 94/92/94/94.
- Playwright projects: `e2e`, `integration`, `performance`, `preload-artifact`. Workers 1, retries 0.
- `*.spec.ts` under initializers = feature-plan input, **not tests**.
- Prettier: 100 cols, single quotes, semicolons, trailing commas ES5, LF.

## ANTI-PATTERNS (THIS PROJECT)

- Feature logic / `whenReady` body in `index.ts`.
- Hand-edit or stage `generated/featurePlan.ts`. Runtime feature registration.
- Flip default account backend without measured evidence + explicit decision.
- WCV `hostWindow.loadURL`. `loadURL` over Google auth. `peekAccountWindowManager()` constructing a singleton.
- Pressure-dehydrate account-0. Dense `0..count-1` instead of `listAccountIndices()`.
- Sample WCV host-only WebContents. Call document-load / `account-0-ready` first paint or first interaction.
- Export metrics from `runDevPostDeferred`. Memory units other than **MB**.
- Raise `mainBundleSize` to “fix” CI. Package bytes ≠ startup win.
- `certificate-error` listeners. Raw `ipcRenderer` on the bridge. String-literal IPC channels.
- Convert preload to ESM. List both arches under `mac.target.arch`.
- Claim Windows / Intel support without packaged-runtime smoke. Universal / `amd64` artifacts.
- Edit `package.json` unless the user owns it. Omnibus commits across preload/account/perf/CI/release.
- Substitute evidence classes (source-unit ≠ built-CJS ≠ packaged-presence ≠ packaged-runtime ≠ headless ≠ workflow).

## UNIQUE STYLES

- Build-time `FeatureSpec[]` → topo-batched `FEATURE_PLAN`. Dynamic `import()` in specs (except `userAgent` static in `ui.spec.ts`).
- Dual backends behind `IAccountWindowManager`. Partitions `persist:account-N`.
- Notification stack: preload bridge → IPC validate → `nativeNotification`; OS permission in `notificationAccess` on `ready-to-show`.
- Shutdown: 2s/stage, 8s overall; diagnostics + About/Update destroyers are dynamic imports (bundle budget).
- Release set = both mac DMGs **and** both Windows NSIS installers, each with one unsigned JSON sidecar. Candidate tag `v3.21.4`. Sidecars are metadata, not attestations or packaged-runtime proof.

## COMMANDS

```bash
bun install
bun run build:dev
bun run build:prod
bun run typecheck
bun run test:run
bun run test:coverage
bun run lint:all
bun run check:doc-claims
bun run start
bun run package:mac:arm64
bun run package:mac:x64
# CI perf:
GOGCHAT_PERF_RUNS=5 HEADLESS_TIMEOUT_MS=90000 node scripts/headless-startup.js
node scripts/check-perf-budget.js performance-metrics.json
```

## NOTES

- `tsc -b` emits into `lib/` and **overwrites** the Rsbuild bundle — measure `mainBundleSize` only after `build:prod`.
- CI is unauthenticated. Authenticated first-interaction is `scripts/release-auth-readiness-benchmark.js`.
- `mac/` is docs-only. Plans under `docs/plans/` have stale checkboxes; product is 3.21.4 on `develop`.
- Evidence classes (do not substitute): source-unit ≠ built-CJS ≠ packaged-presence ≠ packaged-runtime ≠ headless ≠ workflow.
- Do not commit `.omo/evidence/`, `lib/`, `dist/`, coverage HTML.
