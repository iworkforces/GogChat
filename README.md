# GogChat

GogChat is an unofficial macOS desktop wrapper for Google Chat, built with Electron and TypeScript. It loads `https://chat.google.com` in isolated Electron sessions (`persist:account-N`), adds native desktop integrations, and keeps the main-process startup path small through build-time feature planning.

> **Platform:** macOS — production CI packages separate Apple Silicon (`arm64`) and Intel (`x64`) DMGs. Primary development and CI runners target Apple Silicon. Dual-arch packaging is a delivery fact, not a claim of verified Intel runtime support.

## Features

### Desktop integration

- Closing the window hides the app and leaves it in the Dock (no menu-bar tray icon)
- Native OS notifications (Google Chat web notifications bridged to macOS banners; grant notification permission when prompted, and enable desktop notifications in Chat settings)
- Multi-account banners always show an account subtitle (`Account 1`, `Account 2`, …, or a custom label) and group per account; click opens the matching account
- Preferences → Account Labels to set names like Work / Personal for notification subtitles
- Optional fallback: Preferences → Notify on Unread Badge Increase (off by default) shows a generic banner when that account’s unread count rises while unfocused
- Dock badge shows total unreads across accounts (capped at 99)
- Preferences → Notification Settings… opens macOS Notifications for GogChat
- Native About and Check for Updates dialogs (sandboxed `data:` windows)
- Application menu and search shortcut integration
- Auto-launch at login
- Window state persistence
- Context menu support
- Deep-link handling and single-instance enforcement
- Update notifications

### Multi-account runtime

- Per-account `persist:account-N` Electron session partitions for cookie isolation
- Dual backends behind `IAccountWindowManager`: BrowserWindow is the default; WebContentsView is opt-in via `app.useWebContentsView`
- WebContents-first navigation (`loadAccountURL`); the WebContentsView host window is never navigated
- Bootstrap login window promotion after authentication
- Idle account session maintenance for cache cleanup; memory-pressure dehydration never targets account 0

### Security

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, and `webSecurity: true`
- TLS trust is Chromium’s (no app-level custom certificate-pinning feature)
- Encrypted `electron-store` configuration; macOS safeStorage / Keychain for security-sensitive flags
- URL whitelist validation for navigation and external links (`validateExternalURL` + `shellWrapper`)
- IPC channel constants, validators, rate limiting, and structured error handling
- Targeted Content Security Policy header handling for embedded Google Chat pages (not a wholesale CSP rewrite)

### Performance and observability

- Rsbuild/Rspack bundling with a single main-process entry and async-only deferred chunks (`lib/main/index.js` gated at 100 KB)
- Non-blocking deferred feature phase after the first window is ready (`setImmediate` cache warmer)
- Icon cache warmup and tiered icon loading (off the pre-window critical path)
- Optional DNS/TCP/TLS preconnect for Google Chat-related hosts (`GOGCHAT_DISABLE_PRECONNECT=1` skips it)
- Main-process V8 heap cap via `GOGCHAT_V8_HEAP_CAP_MB` (default: 512 MB)
- Local-only CDP RUM telemetry, killable via secure flag
- CI performance budget gate using headless startup metrics (memory units are MB)

## Architecture

GogChat is not structured like a default Electron starter app. There is no `src/renderer`: the UI is remote Google Chat plus `src/offline/` and sandboxed About/Update `data:` dialogs. The app uses separate main, preload, and offline build passes and a declarative feature lifecycle.

```text
src/
├── main/              # Electron main process (thin index.ts)
│   ├── features/      # Feature modules
│   ├── initializers/  # App lifecycle + declarative feature specs
│   ├── generated/     # Build-generated feature plan; do not edit by hand
│   └── utils/         # Window/session/config/IPC/performance utilities
├── preload/           # Sandbox-compatible CommonJS preload → window.gogchat
├── shared/            # Cross-process constants, validators, and types
└── offline/           # Classic retry script + HTML/CSS/logo shipped in lib/offline
```

### Feature lifecycle

Feature registration is declarative:

1. Feature specs live in `src/main/initializers/{security,ui,deferred}.spec.ts`.
2. `scripts/featurePlanPlugin.js` parses those specs during the build.
3. The plugin topologically sorts dependencies into batches (`security < critical < ui < deferred`) and emits `src/main/generated/featurePlan.ts`.
4. `src/main/utils/lifecycle/featureRunner.ts` walks the generated plan at runtime.

`userAgent` is authored in `ui.spec.ts` with `phase: 'critical'` — the phase field, not the filename, decides when it runs. `*.spec.ts` under initializers is feature-plan input, not a test suite.

New features should be added as feature modules under `src/main/features/` and declared in the appropriate spec file. Do not register features in `src/main/index.ts`, and do not hand-edit generated files. Feature-to-feature imports are forbidden except `menuActionRegistry.ts`.

### Build system

`scripts/build-rsbuild.js` runs three Rsbuild passes:

1. **Main process:** ESM, `electron-main` target, single entry at `src/main/index.ts` → `lib/main/index.js`.
2. **Preload scripts:** CommonJS, `electron-renderer` target, one entry per `src/preload/*.ts` file.
3. **Offline retry:** Self-contained classic browser script, `web` target, `src/offline/index.ts` → `lib/offline/index.js`, without chunk loading or typecheck emit. HTML, CSS, and the SVG logo ship alongside it with sibling-relative references; the non-watch build verifies all local page references stay inside shipped `lib/`.

The preload build must remain CommonJS because Electron sandboxed preload scripts cannot load ESM. The preload pass also keeps `cleanDistPath: false` so it does not wipe the main-process output.

`bun run typecheck` runs `@typescript/native` (`tsc -b`). That emit writes into `lib/` and overwrites the Rsbuild bundle — measure `mainBundleSize` only after `bun run build:prod`. The on-disk `typescript` 6.x package is used only by the feature-plan parser.

## Development

### Prerequisites

- macOS (Apple Silicon preferred for local development)
- Node.js `>=24.16.0 <25.0.0`
- Bun `>=1.3.0` (repository package manager: `bun@1.4.2`)

### Setup

```bash
bun install
bun run hooks:install
```

### Common commands

```bash
# Build development output
bun run build:dev

# Build production output
bun run build:prod

# Watch development build
bun run build:watch

# Build production output and launch Electron
bun run start

# Type-check the project (@typescript/native / TS 7)
bun run typecheck

# Run Vitest
bun run test

# Run Vitest once
bun run test:run

# Run coverage (94/92/94/94 on src/**/*.ts)
bun run test:coverage

# Run ESLint + Prettier checks
bun run lint:all

# Auto-fix lint/format issues
bun run lint:all:fix

# Audit documented AGENTS.md claims
bun run check:doc-claims

# Arch-pinned macOS release packages (no publish side effect)
bun run package:mac:arm64
bun run package:mac:x64
```

## Testing and quality gates

- Default `bun run test` is Vitest only (colocated `*.test.ts` plus `scripts/**/*.test.js`).
- Playwright is four isolated projects — `e2e`, `integration`, `performance`, `preload-artifact` — and needs `bun run build:prod` first. Import Electron fixtures from `tests/helpers/electron-test.ts`.
- `bun run typecheck` runs `@typescript/native` `tsc -b`.
- `bun run lint:all` runs the combined ESLint and Prettier checks.
- `bun run check:doc-claims` validates documented claims that are covered by repository checks.
- CI also checks circular dependencies with `madge` and runs the performance budget gate from `scripts/check-perf-budget.js` against `performance-metrics.json` produced by `scripts/headless-startup.js`.
- Do not substitute evidence classes: source-unit ≠ built-CJS ≠ packaged-presence ≠ packaged-runtime ≠ headless ≠ workflow.

## Packaging and releases

```bash
# Production DMGs, macOS-specific (arm64 default; pass --arch or use aliases)
bun run build:mac
bun run build:mac:x64

# Development DMG, macOS-specific
bun run build:mac:dev

# Arch-pinned macOS release package flows, no publish side effect
bun run package:mac:arm64
bun run package:mac:x64
bun run package:mac:artifacts

# Windows release-engineering preparation only, not a public support claim
bun run package:win:x64
bun run package:win:arm64
bun run package:win:artifacts
bun run package:win:signing-policy
```

`package:mac:artifacts` / `package:win:artifacts` list and gate artifact names only. They do not pass identity flags, so they never write sidecars. Release CI calls `verify-macos-package-artifacts.js` / `verify-windows-package-artifacts.js` with `--source-sha` and `--package-version` after platform verification. Sidecars are unsigned metadata, not cryptographic attestations or packaged-runtime proof.

Release automation runs on GitHub Actions for `main` and `v*` tags. The workflow prepares an exact-SHA candidate, qualifies that SHA, packages **both** macOS DMGs (`arm64` and `x64`) and native Windows CI installers, writes one sidecar per binary, verifies the aggregated set, creates the tag from a single writer, and uses one `publish-release` job for upload.

The published set is both mac DMGs, both Windows NSIS installers, four matching `*.json` sidecars, and `SHA256SUMS.txt`. macOS assets are named `${productName}-${version}-arm64.dmg` and `${productName}-${version}-x64.dmg`. The public product remains a macOS desktop app; Windows release engineering/preparation is guarded and is not a public support claim. Support or publication claims for Windows require clean packaged smoke evidence on Windows x64 and real Windows arm64 before any user-facing wording changes.

Windows preparation uses separate NSIS installers named `${productName}-${version}-windows-x64-setup.exe` and `${productName}-${version}-windows-arm64-setup.exe`. Use `x64` in user-facing architecture labels, not `amd64`.

macOS CI packaging uses `macos-latest` with an arm64/x64 matrix (x64 is cross-packaged via electron-builder). Native Windows CI packaging uses `windows-latest` for x64 with an AMD64 runner proof and `windows-11-arm` for arm64 with an ARM64 runner proof. Windows release publication requires a Windows Authenticode signing route through `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` or explicit owner opt-in for unsigned Windows assets through the existing signing policy gate.

The Windows electron-builder overlay registers only the `gogchat` protocol. The base macOS config may still include HTTPS protocol handling for the macOS app.

Notarization is handled by the electron-builder hooks when Apple credentials are available through the release environment.

## Project conventions

- Use Bun for dependency and script execution.
- Keep preload output CommonJS and sandbox-compatible.
- Add lifecycle features through `initializers/*.spec.ts`, not `index.ts`.
- Use shared IPC constants from `src/shared/constants.ts`.
- Validate and rate-limit IPC handlers.
- Use `configGet` / `configSet` for encrypted config access.
- Store security-sensitive kill switches in `secureFlags.ts`, not regular config.
- Import type-only symbols with `import type`.
- Avoid barrel files and direct feature-to-feature imports (except `menuActionRegistry.ts`).

## Tech stack

| Layer           | Technology                                    |
| --------------- | --------------------------------------------- |
| Runtime         | Electron `^44.3.0`                            |
| Language        | TypeScript 7 typecheck (`@typescript/native`) |
| Package manager | Bun `1.4.2`                                   |
| Build           | Rsbuild / Rspack                              |
| Tests           | Vitest 5, Playwright                          |
| Packaging       | electron-builder                              |

## License

MIT
