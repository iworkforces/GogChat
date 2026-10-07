# Main Features Guide

**Parent:** `../AGENTS.md`

Features are self-contained startup/runtime units registered through initializer specs. This directory holds the feature implementations; startup order lives outside this directory.

## Contract

- Export focused `init`/setup functions consumed by specs in `src/main/initializers/`.
- Keep feature modules independent. Feature-to-feature imports are forbidden except `menuActionRegistry.ts`.
- Do not reintroduce runtime feature registration.
- Do not hand-edit `src/main/generated/featurePlan.ts`.
- Keep feature names aligned with spec IDs and generated plan output.
- `FeatureSpec.ipcChannels` is documentation for `check:doc-claims` only; runtime does not enforce those lists. `platforms` and `required` are runtime.
- Pre-ready `index.ts` imports of `singleInstance` / `deepLinkHandler` are allowed (not runtime registration).
- Named `cleanupX` exports are NOT auto-wired; only `FeatureSpec.cleanup` or `registerCleanupTask`.
- Most feature files are coverage-excluded; do not claim only `cdpTelemetry` is excluded.

## Registration workflow

1. Add or update the feature implementation here.
2. Register it in one of:
   - `src/main/initializers/security.spec.ts`
   - `src/main/initializers/ui.spec.ts`
   - `src/main/initializers/deferred.spec.ts`
3. Declare dependencies explicitly with `dependencies`.
4. Run a build to regenerate `src/main/generated/featurePlan.ts`.

Known dependencies (from current specs) include `trayIcon -> aboutPanel`, `badgeIcons -> trayIcon`, `windowState -> singleInstance/deepLinkHandler/bootstrapPromotion`, `appMenu -> openAtLogin/externalLinks/appUpdates/aboutPanel`, `externalLinks -> bootstrapPromotion`, `closeToTray -> trayIcon`, and **`cdpTelemetry -> appMenu`** (CDP after shell UI batch).

Security phase features (no deps): `reportExceptions`, `mediaPermissions` (fire-and-forget TCC; does not block the phase). Critical `userAgent` is declared in `ui.spec.ts` with `phase: 'critical'` — the phase field, not the filename, decides when it runs. UI: `singleInstance` (restore handler), `deepLinkHandler`. Deferred also includes `aboutPanel`, `trayIcon`, `badgeIcons`, `windowState`, `bootstrapPromotion`, `openAtLogin`, `appUpdates`, `firstLaunch`, `enforceMacOSAppLocation` (body is `platformHelpers.enforceMacOSAppLocation`, not a file here), `passkeySupport`, `handleNotification`, `contextMenu`, `inOnline`, `cdpTelemetry` (optional, `required: false`, account-0 only, 30s `Performance.getMetrics`, detaches if DevTools takes the debugger, kill switch `disableCdpTelemetry`). `cdpTelemetry.ts` has no colocated test. `listenerCleanup.test.ts` is an orphan helper test with no `listenerCleanup.ts`.

### About + Check for Updates (since v3.19.0; current product v3.21.4)

- **`aboutPanel`**: deferred `FeatureSpec` whose init side-effect-imports the module (registers `aboutPanel` menu action). Platform-native BrowserWindow: sandboxed `data:` HTML, CSP `script-src 'none'`, solid canvas `#0d1117`, macOS `hiddenInset`, brand aurora (About-tier) behind `resources/icons/normal/scalable.svg`, hide-cached (Esc / traffic lights). Tray and Help open via registry — not `app.showAboutPanel()`.
- **`appUpdates`**: background and manual checks share one session gate and the validated GitHub release pipeline (`AbortSignal.timeout(10_000)`, `selectFirstStableGithubRelease`, `isVersionNewer`). The list is parsed from `unknown` (`parseStableGithubRelease`): first entry with a non-empty tag, `draft === false`, `prerelease === false`, and `html_url` exactly `https://github.com/<fetched-owner>/<repo>/releases/tag/<tag>` (one tag segment, the tag text or its `encodeURIComponent` form; no userinfo, query, hash, encoded slash, or encoded dot-segment; `www.github.com` is stored as `github.com`). Download checks that shape again before `validateExternalURL`. The gate is taken before `beginUpdateDialogSession()` and held through Download, then released in `finally`. A second in-flight manual check is a no-op. A scheduled tick that finds the gate held skips. A manual request during a background session waits without `beginUpdateDialogSession` or `presentUpdateDialog`, then runs after that session releases the gate; another click while that manual request is already waiting is a no-op. Background checks run from a tracked `createTrackedTimeout` at 5s (`appUpdates-initial-check`) and `createTrackedInterval` every 24h (`appUpdates-daily-check`). A later `appUpdates()` start cancels both the pending initial timeout and the previous daily interval. Each tick re-reads `app.autoCheckForUpdates`. The background path is packaged-only unless `TESTING=true`. It latches on `before-quit` and on the `appUpdates-suppress-prompts` cleanup task, and presents nothing after that latch. The `before-quit` listener is untracked so resource cleanup does not remove it before an in-flight check observes the latch. It discards an in-flight result if the preference was turned off or shutdown latched during the fetch. It opens no checking, up-to-date, or error window, and does not reject. It prompts only when that first stable entry is newer than `app.getVersion()`, then Download opens only that entry's `html_url` via `validateExternalURL` + `shellWrapper`. Failures are logged through `sanitizeLogError` or a static message, never the raw error. Manual **Help → Check For Updates** still runs `checkForUpdatesManual()` → `utils/platform/updateWindow.ts` (checking → result). Timeout, HTTP failure, missing repo metadata, and **no stable release** are manual error dialogs — never “up to date”. Only a fetched stable tag that is not newer than the installed version is “up to date”. Unpackaged manual checks get an explain-only dialog unless `TESTING=true`. That seam also installs `__gogchatCheckForUpdatesManual`, `__gogchatRunBackgroundUpdateCheck`, and `__gogchatSetAutoCheckForUpdates`. `__gogchatBackgroundCheckScheduledAt` is `Date.now()` when the 5s timeout is armed. `electron-update-notifier` is not imported. Checking-phase `loadURL` is deadline-bounded (`UPDATE_CHECKING_LOAD_TIMEOUT_MS`).
- Force-destroy both dialogs from `initializers/singletonDestroyers.ts` on shutdown (`destroyAboutWindow` / `destroyUpdateWindow`).

## Multi-account feature attach

- `externalLinks` subscribes to `accountWebContentsHooks` and installs open/will-navigate guards on **each** account WebContents (backfill on subscribe). Cleanup must unsubscribe hooks.
- Cross-account Chat routing and deep links use URL `/u/N/`, `focusAccount` (hydrate) **then** `loadAccountURL` / `getAccountURL` — never host-window `loadURL` under WebContentsView. Dehydrated BrowserWindow accounts are `hasAccount=true` with no live WebContents until focus.
- `closeToTray` / sparse dehydrate use `listAccountIndices()` and skip account-0.

## Menu actions

- `menuActionRegistry.ts` is the allowed decoupling point between features and menus.
- Features such as `aboutPanel`, `checkForUpdates` (`appUpdates`), `openAtLogin`, `externalLinks`, and `deepLinkHandler` self-register menu actions at module load time.
- Consumers retrieve actions with `getMenuAction()` rather than importing feature modules directly.

## Notifications

- `handleNotification.ts` shows Electron (OS) notifications for validated `NOTIFICATION_SHOW` IPC payloads via `nativeNotification.showNativeNotification` (source `bridge`).
- Click focus uses `notificationFocus.focusNotificationSource` → `IAccountWindowManager.focusAccount` when the IPC sender maps to an account (BW + WCV); otherwise `BrowserWindow.fromWebContents` / feature main window.
- Unread-delta opt-in banners live in `badgeHelpers` (source `unread-delta`) and are suppressed for `TIMING.NOTIFICATION_BRIDGE_COOLDOWN_MS` after a bridge show; also suppress only when host focused **and** `isAccountVisible` for that account.
- Permission request UX lives in `utils/security/notificationAccess.ts`. Call sites: `windowWrapper` and WCV host on **`ready-to-show`** with `{ parentWindow }` (first-run Enable / System Settings / Not Now dialog, then silent OS probe).
- Preferences menu (`appMenu.ts`): **Notification Settings…**, **Notify on Unread Badge Increase**, and **Account Labels** (custom notification subtitles).

## Feature boundaries

- Security features must be ready before network use.
- UI features may assume account bootstrap/context store exists.
- Deferred features must tolerate late execution and app shutdown races.
- `inOnline` `CHECK_IF_ONLINE` / `ONLINE_STATUS` is attempt-aware: each payload carries `attemptId`. Keep one abortable probe per sender, identified by a monotonic `generation` (not the renderer-supplied id). A newer same-sender request aborts and replaces the older probe. Different senders stay independent. Abort on sender `destroyed` and in `cleanupConnectivityHandler`. Superseded or cleanup-aborted probes must not reply; a final liveness check covers the remaining send race. After supersession, coalesce `generate_204` starts to `ONLINE_FETCH_MIN_INTERVAL_MS` per sender. Do not add a `defineIPC` `rateLimit` or a shutdown stage for this.
- Use utility modules for shared mechanics; do not create hidden feature coupling.
- Do not write startup performance JSON from feature code. Metrics finalization lives in `utils/lifecycle/performanceFinalizer.ts`.
- Speculative optimizations (unread, CDP sampling, timers, split chunks, preconnect) stay measure-first: see `scripts/performance-candidate-benchmark.js` and `docs/plans/performance-remediation.md`.

## Gotchas

- Badge IPC/dock logic lives in `src/main/utils/platform/badgeHelpers.ts` (`setupBadgeHandlers`); `badgeIcon.ts` is only the thin feature lifecycle wrapper.
- Feature config/types live under `src/main/utils/lifecycle/` (`featureConfigTypes.ts`, not an `initializerTypes` module).
- Custom certificate pinning feature modules are gone; do not re-add a security-phase cert pin feature without an explicit security plan. Chromium remains the trust authority.
- Google Chat webview/CSP history is documented in `docs/windowWrapper-history.md`; current `windowWrapper` uses `webSecurity: true` — do not change CSP/webSecurity behavior casually.
