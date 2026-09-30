# Scripts Guide

**Parent:** `../AGENTS.md`

Scripts drive the dual Rsbuild pipeline, feature-plan generation, packaging, notarization, icon assets, hooks, and performance gates. **bun only**. Do not hand-edit `src/main/generated/featurePlan.ts`.

## Key scripts

### Build and feature plan

- `build-rsbuild.js` - builds ESM main and CJS preload, copies offline assets, preserves preload `cleanDistPath: false`, records `buildTimeMs` and `lib/chunks/*.js` counts in `.build-history.json`. With `ANALYZE=true`, writes machine-readable stats under the evidence root.
- `featurePlanPlugin.js` / `featureSpecParser.js` - parse initializer specs with the installed TypeScript 6.x compiler API (`createSourceFile`; typecheck still uses `@typescript/native` / TS 7), unwrap `as const satisfies` / parens, fail closed on unsupported array elements, topologically batch dependencies, reject forward-phase deps (`security < critical < ui < deferred`), and write `src/main/generated/featurePlan.ts` only after the full source is built. Unsupported expressions are rejected with file, element index, and property.
- `install-electron-binary.js` - repo-controlled Electron zip extract for macOS CI (ditto); respects `npm_config_arch` and Rosetta detection. Pin target arch when packaging non-host arches.

### Performance (CI unauthenticated path)

- `headless-startup.js` - launches Electron with a temp userData dir, waits for versioned `performance-metrics.json`, validates schema/completeness per run, refuses medians from incomplete data. Supports `GOGCHAT_PERF_RUNS`. Multi-run `rendererSnapshots` are the complete list from the upper-median complete+valid run: unique identity is `(pid, creationTime)` when `creationTime` exists, otherwise PID; candidates are stable-sorted by that count then original index; pick `floor(validRunCount / 2)`. Incomplete runs never supply representative snapshots and still fail aggregate completeness. Do not copy the last run or synthesize snapshot fields.
- `check-perf-budget.js` - gated budgets fail on absence or exceedance; warn-only may SKIP/WARN. Memory is MB (not bytes). `mainBundleSize` (`lib/main/index.js` ≤ 100KB) is gated. `rendererCount` uses the same `(pid, creationTime)` / PID identity on the representative snapshots and cannot false-pass from a final low-count run. Renamed metrics: `nativeWindowReady`, `contentDocumentLoaded`. Baseline updates only with `PERF_UPDATE_BASELINE=1` and compatible schema/units.
- `account-backend-benchmark.js` - BrowserWindow / WebContentsView matrix contract (1/2/4 accounts, lifecycle states). Does **not** select a backend policy or declare a resource winner.
- `performance-candidate-benchmark.js` - threshold-gated candidate decisions (unread, cdp, timers, split-chunks, preconnect). Product changes only when 20-pair / 10% median / 5% p95 rules pass; otherwise `NO CHANGE`.
- `release-auth-readiness-benchmark.js` - secured authenticated first-interaction path. Without credentials records `[blocked: credentials unavailable]` (conditional core remediation only, never release-readiness approval).

### Packaging and release

- `package-mac-arch.sh` - shared arch-pinned macOS release package helper (`arm64` or `x64`): `build:prod`, signing preflight, single-arch electron-builder with `--publish never`.
- `mac-release-signing.js` / `verify-mac-release-signing.js` — credential pair policy + codesign/spctl/stapler on that job's `dist/`.
- `release-artifact-sidecar.js` — schema owner (`schemaVersion` 1). Fields: `schemaVersion`, `sourceSha`, `packageVersion`, `platform`, `arch`, `basename`, `size`, `sha256`. Extra/missing fields are malformed. Unsigned metadata, not an attestation or packaged-runtime proof.
- `verify-macos-package-artifacts.js` — DMG basenames, required arm64/x64, no `amd64`/`ia32`/`universal`. After those checks pass, writes or validates one sidecar per accepted DMG when `--source-sha` and `--package-version` are both set.
- `verify-packaged-dependency-closure.js` — runtime externals vs packaged fixture; classify `@rspack`/`@ast-grep`/`@rslib`. Run **before** removing payload.
- `verify-packaged-preload.js` — packaged-presence only (`lib/preload/index.js` + relative CJS chunks). Does not prove execution (built-CJS fixture).
- `app-identity.cjs` — `APP_ID` / `NOTARIZE_BUNDLE_ID` = `com.ocworkforces.gogchat`. Lockstep with `src/shared/appIdentity.ts` and `electron-builder.yml`. `notarize.cjs` uses this id only. `notarize-identity.test.js` forbids productFilename-derived / typo ids.
- `after-pack.cjs` — strip/locale for darwin **arm64 and x64** (not universal). `remove-locales.js` is standalone (prefer after-pack).
- `verify-windows-package-artifacts.js` / `verify-windows-signing-policy.js` — guarded NSIS names + `WIN_CSC_*` pair or unsigned waiver; same post-check sidecar write/validate as macOS.
- `verify-release-artifacts.js` — both mac DMGs **and** both Windows setups, each with a matching sidecar, before publish. Fails closed on missing, duplicate, orphaned, malformed, cross-source, cross-version, architecture-mismatched, size-mismatched, or digest-mismatched sidecar evidence. `SHA256SUMS.txt` is hashed from the validated output bytes.
- Contract tests: `package-scaffold.test.js`, `playwright-config.test.js` (four isolated Playwright projects), `release-workflow.test.js`, `release-artifact-sidecar.test.js`, mac/Windows artifact+signing tests.

### Evidence and claims

- `verify-remediation-evidence.js` / `verify-performance-claims.js` — core-remediation vs release-readiness receipts; package bytes ≠ startup wins.
- `check-doc-claims.js` - audits AGENTS claims (destroyers, lazy cleanups, branded helpers, feature isolation). Pure readers (`accountLabelStore` gets, `accountNavigation.getAccountURL`) stay on the destroyer allowlist. Architecture-scoped only. `hooks/pre-push` blocks lint/check failures.

## Build invariants

- Do not convert the preload build to ESM.
- Do not remove `cleanDistPath: false`; otherwise one Rsbuild pass can delete the other output.
- Do not modify offline asset output paths unless `src/offline/AGENTS.md` contracts are updated too.
- Do not replace the feature-plan plugin with runtime registration or hand-edit `generated/featurePlan.ts`.
- Count emitted async chunks as `lib/chunks/*.js` (not the stale `*.chunk.js` suffix).
- Pass real wall-clock `buildTimeMs` into build history; do not leave it absent in production builds.
- Build-only packages (`@rslib`, `@rspack`, `@ast-grep`) must not enter runtime dependencies or the packaged app without closure proof.

## Feature-plan plugin rules

- Ignores `init`/`cleanup` bodies; reads declarative spec metadata via the TypeScript compiler API. Do not evaluate arbitrary expressions.
- Every exported array element must be an object literal with static identifier or string keys. Reject spreads, calls, identifiers, conditionals, holes, computed names, and malformed known metadata.
- Same-phase and earlier-phase dependencies are allowed; forward-phase rejected. Build the complete generated source before writing; a parse/plan error must leave any existing output unchanged. Dependency sorting is greedy by batch; export `buildPlanFromSources` for tests.

## Performance scripts

- Headless startup uses env such as `NODE_ENV=development`, `GOGCHAT_EXPORT_METRICS=1`, `GOGCHAT_AUTO_QUIT_AFTER_MS=12000` (capture timeout), and `CI=1`.
- PR/release CI uses `HEADLESS_TIMEOUT_MS=90000` and `GOGCHAT_PERF_RUNS=5`.
- Optional product env: `GOGCHAT_V8_HEAP_CAP_MB` (default 512, clamp 128–4096); `GOGCHAT_DISABLE_PRECONNECT=1` for A/B cold-start.
- Metrics come from the main-process finalizer after document load + deferred + renderer sample — not early deferred-phase export.
- Schema version and `units.memory: "MB"` / `units.time: "ms"` required; incomplete/invalid runs must not feed medians or gated PASS. Multi-run renderer evidence is the upper-median complete run's full `rendererSnapshots` (same identity/pick as `headless-startup.js`). Never last-run copy, incomplete rows, or synthesized fields. Missing gated metrics → exit 1. IPC latency remains warn-only until a real producer and baseline exist.
- Do not represent `account-0-ready` or `account-0-content-loaded` as first paint or first interaction.
- Evidence classes (source-unit ≠ built-CJS ≠ packaged-presence ≠ packaged-runtime ≠ headless ≠ workflow) are defined in root `AGENTS.md`. Do not substitute one for another.
- Evidence roots: `.omo/evidence/performance-remediation/`, `.omo/evidence/macos-intel-x64-dmg/`, `.omo/evidence/deep-enhancements/`, `.omo/evidence/stability-performance-remediation/` (often gitignored).
- CDP harness: `cdp-persistence-benchmark.js` + `cdp-persistence-child.js`. Valid evidence ≥20 samples/size; receipt-only `NO CHANGE` rejected. Do not edit `cdpTelemetry.ts` / `cdpMetrics.ts` from this harness.

## Packaging

DMG/arch pinning, artifact names, and `mac.target.arch` rules live in `mac/AGENTS.md`. Scripts here own verify/signing helpers and the release DAG. Release set = both mac DMGs + both Windows NSIS + four matching sidecars; aggregate fails closed on missing arch or sidecar identity mismatch. Local `package:*:artifacts` without identity flags stays listing-only. `package:win:*` is release-engineering preparation, not a public support claim. Do not write sidecars from `package-mac-arch.sh` or treat them as signatures.

### Current CI (do not invent extra gates)

- **PR Check** (`.github/workflows/pr-check.yml`): frozen install → Electron binary → literal typecheck → `bun scripts/check-doc-claims.js` → `bash ./scripts/lint.sh` → literal Vitest coverage (no second unit run) → madge → `bun scripts/build-rsbuild.js` → five-run headless (`GOGCHAT_PERF_RUNS=5 HEADLESS_TIMEOUT_MS=90000 node scripts/headless-startup.js`) → `node scripts/check-perf-budget.js performance-metrics.json` → always-upload metrics and `coverage-output.txt`. Contract: `scripts/pr-workflow.test.js`.
- **Playwright** (`.github/workflows/playwright.yml`): independently triggered by PRs targeting `develop`/`main`, pushes to `develop`/`main`, and `v*` tag pushes; runs in parallel with PR Check/Release on `macos-latest`. Frozen install, Electron binary installation, and a production build precede the four existing projects: `e2e`, `integration`, `performance`, `preload-artifact`. Owns the moved failure annotations, failure reports (7-day retention), and always-uploaded three project logs (14-day retention). Does not gate release publication. Contract: `scripts/playwright-workflow.test.js`.
- **Release** (`.github/workflows/release.yml`): `prepare-release` is read-only exact-SHA eligibility via `scripts/release-eligibility.js`. `inspectRemoteTag` peels annotated tags (`refs/tags/vX^{}`) to the commit SHA and `sanitizeReleaseTagName` rejects anything that is not `v?[A-Za-z0-9][A-Za-z0-9._-]*`. Assert `should_release` for absent/same-SHA (`true`) and wrong-SHA/tag-trigger (`false`). `qualify-release` then runs the remaining non-Playwright PR-check gate set on that SHA; the release DAG is unchanged. mac arm64/x64 and Windows x64/arm64 package jobs need both prepare and qualify and check out the emitted SHA. Each matrix job writes a versioned JSON sidecar after platform verification and uploads it with that arch’s uniquely named artifact. Aggregate verify needs all four builds plus matching sidecars, and receives the intended `source_sha` and `package_version`. `create-release-tag` is the sole tag writer (`scripts/release-tag.js`): recheck remote, create if absent, retry if same SHA, fail if wrong SHA, never force-push/delete/move; push `refs/tags/<name>` only. Job concurrency is `create-release-tag-${tag}` with `cancel-in-progress: false`. Publish needs verified assets and the created tag; a publish failure leaves the qualified tag for a later retry. Only create-tag and publish have `contents: write`. Candidate tag is `v3.21.4` from `package.json`.
- Typecheck uses `@typescript/native` (TS 7). The `typescript` package on disk is 6.x and is **not** the typecheck binary.

- Never call packaging scripts without building first. Never remove a dependency without a green closure report and disposable package smoke. Do not log signing/notarization secrets. Missing signing/auth credentials → `[blocked: credentials unavailable]`, not silent success.
