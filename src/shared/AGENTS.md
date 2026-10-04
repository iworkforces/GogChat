# Shared Code Guide

**Parent:** `../AGENTS.md`

`src/shared` is the only code shared by main and preload. Keep it dependency-light, deterministic, and free of Electron runtime side effects. Shared contracts do not encode packaging arch (arm64/x64).

## Ownership

- `constants.ts` owns channel names, selectors, timings, icon/badge constants (`BADGE.DISPLAY_MAX` = 99), notification timing/cooldowns, account-label max length, URL patterns, allowlisted hosts, and deep-link constants.
- `appIdentity.ts` owns fixed product/bundle identity (`com.ocworkforces.gogchat`); packaging lockstep via `scripts/app-identity.cjs` + electron-builder `appId`.
- `urlValidators.ts` owns parse-once URL validation for navigation, external links, deep links, Google auth detection, Apple System Preferences notification deep links, and **notification icon** allowlist (`validateNotificationIconURL`: `data:image/*` or Google static HTTPS hosts).
- `dataValidators.ts` owns non-URL payload validation (including notification payload shapes used by preload/main; icons go through `validateNotificationIconURL`; online checks use `validateOnlineCheckRequest` / `validateOnlineStatusData`).
- `typeUtils.ts` owns `assertNever`, `asType<T>()`, and documented unsafe-cast helpers.
- `escapeHtml.ts` owns pure HTML-escape for data: HTML dialogs (About / Update). Safe for main-process templates.
- `logSanitizer.ts` owns `sanitizeLogUrl()` (explicit http/https only, at most 2048 code units, no whitespace/control/backslash; emits `scheme://host` or `[redacted]`, never the raw input) and `sanitizeLogError()` (fresh `[redacted]` Error, input untouched). Electron-free; main-process logging imports it.
- `appIconAurora.ts` owns brand-icon aurora CSS + HTML strings (`APP_ICON_AURORA_CSS`, `appIconWithAuroraHtml`); About-tier (`.app-icon-aurora--about`) fancy motion for About/Update; reduced-motion / reduced-transparency / contrast queries; no DOM/Electron.
- `types/` owns contracts used across process boundaries; see `types/AGENTS.md` (`IAccountWindowManager`, `AccountWebContentsInfo`, bridge API, `AppConfig`/`MemoryConfig`, errors, IPC maps). `CERTIFICATE_PINNING_FAILED` remains in `ErrorCode` after pinning removal.

## IPC/channel workflow

When adding a channel:

1. Add the name to `IPC_CHANNELS` in `constants.ts`.
2. Add payload/response/domain types under `types/`.
3. Add or reuse validators in `dataValidators.ts` / `urlValidators.ts`.
4. Update `IPCChannelPayloadMap` and bridge types.
5. Wire main handler and preload method separately.

## URL rules

- Parse once and pass branded/validated values across boundaries.
- Strip credentials where relevant.
- Keep Google auth detection centralized; account managers rely on it to avoid interrupting auth pages.
- Do not call Electron APIs here.

## Type rules

- Use `as const satisfies` for exported constant maps.
- Prefer branded helpers from `types/branded.ts` over bare casts.
- `asUnsafe<T>(value, reason)` requires a real reason and should stay rare.
- No imports from `src/main` or `src/preload`.

## Anti-patterns

- No runtime Electron logic in shared code.
- No string-literal IPC channels.
- No barrel files.
- No mutable singleton state that differs by process.
