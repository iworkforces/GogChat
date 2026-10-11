# Platform Utilities Guide

**Parent:** `../AGENTS.md`

This directory owns platform integration: dock/app badges, native notifications presentation, account notification identity/labels, app menu helpers, help menu actions, icon cache, window defaults, and native About/Update dialog chrome (since v3.19.0). Startup does not create a menu-bar tray.

## Conventions

- Public product remains macOS with dual packaging arches (`arm64` and `x64` separate DMGs). Guarded Windows release-engineering/runtime preparation may live here when capability-gated and explicitly not documented as public support.
- Capability gates live in `platformDetection.ts` (`SUPPORTED_PLATFORM_NAMES`, overlay/dock/tray/autolaunch flags). Feature specs use `platforms: [SUPPORTED_PLATFORM_NAMES.macOS]` for `openAtLogin` and `enforceMacOSAppLocation`.
- `platformHelpers.enforceMacOSAppLocation()` is the deferred feature body (not under `features/`). Packaged apps not under `/Applications/` call `app.quit()`.
- Dock badge sum is `app.setBadgeCount`, capped at `BADGE.DISPLAY_MAX` (99). Unread presentation does not construct a `Tray` or call `setImage`.
- `nativeNotification.ts` owns Electron `Notification` show, tag de-dupe, auto-dismiss, subtitle/groupId options, and bridge vs unread-delta source marking.
- `notificationFocus.ts` resolves click focus via IPC sender → `IAccountWindowManager.focusAccount` (BW + WCV).
- Unread-delta OS banners in `badgeHelpers` suppress only when the host/window is focused **and** `manager.isAccountVisible(accountIndex)` (WCV: hidden-live secondary must still notify while another account is frontmost).
- `accountNotificationIdentity.ts` builds label/tag/groupId and maps IPC sender → account. Title/body stay caller-supplied; `nativeNotification.buildAccountAwareNotificationPayload` assembles the payload. Identity never comes from payload free text.
- `accountLabelStore.ts` / `accountLabelDialog.ts` persist optional custom labels (`app.accountLabels`) for notification subtitles (Preferences → Account Labels). Store helpers are config readers/writers, not process singletons with destroyers.
- `helpMenuBuilder.ts` consumes feature actions through `features/menuActionRegistry.ts` (`aboutPanel`, `checkForUpdates`, troubleshooting actions); it should not import feature modules directly.
- Window defaults live in `windowUtils.ts` (`getWindowDefaults`) used by account managers and `windowWrapper`.
- Auxiliary dialog chrome: `dialogChrome.ts` (About / Update solid canvas `#0d1117`, macOS `hiddenInset` + traffic-light inset). `dialogChrome.test.ts` locks darwin vs off-darwin options.
- Native update dialog: `updateWindow.ts` (data: HTML, brand aurora, hide-cache, checking/result phases; used by `features/appUpdates` for the manual check and for a background prompt when a newer stable release exists). Checking-phase `loadURL` races `UPDATE_CHECKING_LOAD_TIMEOUT_MS` via `createTrackedTimeout` so a hung data: document cannot stall the GitHub poll. `updateWindow.test.ts` covers action/close sentinels, waiter supersede, icon SVG/PNG/fallback, destroyed-window load completions, and the checking load deadline. Background checks do not open the checking phase.
- `helpMenuBuilder.test.ts` covers registered/missing menu actions, Reset confirm/cancel, and off-darwin log path.
- Brand-icon aurora CSS/HTML: `src/shared/appIconAurora.ts` (shared pure strings; About-tier fancy motion for About/Update).
- About/Update app mark loads `resources/icons/normal/scalable.svg` (PNG fallback) as a data URI — CSS aurora is the glow, not the static `aura/` PNGs.
- Icon assets are shared across mac packaging arches; see `resources/AGENTS.md`.

## Icon cache

`iconCache.ts` intentionally warms assets in tiers. Account-0 window icon (`resources/icons/normal/256.png`) loads on demand in `windowWrapper`; bulk warm runs after the UI phase on `setImmediate` (same path as deferred features):

1. INITIAL: first warm set via `cacheWarmer.warmInitialIcons` (not on the pre-window critical path).
2. SOON_DEFERRED: short-delay follow-up (`warmSoonDeferredIcons` on `setImmediate` inside the warmer).
3. IDLE / ADDITIONAL: later idle warmup (`cacheWarmer` ADDITIONAL set; disjoint from INITIAL and SOON_DEFERRED).

Do not move icon warming back onto the pre-window critical path; it affects app-ready latency. Keep the triple-set partition disjoint (no overlap between INITIAL, SOON_DEFERRED, and ADDITIONAL).

## Anti-patterns

- No direct feature imports from menu/platform utilities except the menu action registry.
- No platform checks that imply public Windows/Linux support; Windows branches must be capability-gated preparation with tests and guarded docs.
- No badge or tray state writes from unrelated modules; route through platform helpers.
- Do not call `shell.openExternal` — use `shellWrapper`.
- `nativeNotification` trusts caller for icons; new callers must `validateNotificationIconURL` first.
- Presentation vs permission: this directory shows notifications. The OS permission dialog lives in `security/notificationAccess.ts`; call sites are `windowWrapper` + WCV host on `ready-to-show` with `{ parentWindow }`. Do not own the dialog here.
- `badgeHelpers` may call `ensureNotificationPermission()` without parent (probe-only) — do not copy that for first-run UX.
