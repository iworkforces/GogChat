# Shared Types Guide

**Parent:** `../AGENTS.md`

This directory defines contracts crossing main, preload, tests, and shared validators. Types stay packaging-arch neutral.

## Important files

- `branded.ts` - allowed branded casts and helpers such as `asValidatedURL`, `asAccountIndex`, `toPartition`, and `asWebContentsId`.
- `bridge.ts` - preload-exposed API surface.
- `config.ts` - shared config shape (`AppConfig`, `MemoryConfig`, notification/WCV/label keys). `memory.v8HeapCapMB` is schema-only; startup heap uses env/`js-flags`.
- `domain.ts` - app domain payload types (`OnlineCheckRequest` / `OnlineStatusData` carry `attemptId`; `OnlineStatusData` is a discriminated `outcome` union of `online`, `http-error` with `httpStatus`, `network-error`, and `timeout`, with no free-text field). Do not treat leftover `PerformanceMetrics` here as the CI export contract (`performanceTypes.ts` in main owns that).
- `errors.ts` - typed error codes and app error shapes. `CERTIFICATE_PINNING_FAILED` remains in the union after pinning removal; do not reintroduce `certificate-error` listeners.
- `ipc.ts` - IPC payload/response maps.
- `window.ts` - `IAccountWindowManager`, `AccountWebContentsInfo`, `AccountBackendKind`, and account window contracts.

## Account window contract notes

- Both backends implement `IAccountWindowManager`, including `enumerateAccountWebContents()`, `listAccountIndices()`, `hasAccount()` (live **and** dehydrated-parked), `isAccountVisible()`, and `focusAccount()`. Dehydrate/hydrate JSDoc still reads “destroy/recreate BrowserWindow”; WCV parks instead — keep the interface backend-neutral.
- `WindowFactory` is BrowserWindow-only. The WCV path must not call it.
- `AccountWebContentsInfo` carries `accountIndex`, `webContentsId`, `osProcessId`, `backend`, and live `webContents`.
- Performance sampling and multi-account diagnostics depend on this enumeration; do not drop it from the interface.
- Prefer `src/main/utils/account/accountNavigation.ts` free helpers for load/getURL/send instead of growing the interface with loadURL methods.
- Backend policy (BrowserWindow default vs WebContentsView opt-in) is not a type-level decision; keep types backend-neutral.

## Rules

- Keep files type-only unless a runtime helper is explicitly needed for branding/validation.
- Use `import type` where possible.
- Do not import from `src/main` or `src/preload`.
- Do not add a barrel export.
- Keep `ErrorCode` exhaustive when adding app error cases.

## Adding a branded type

1. Define the brand here.
2. Add one narrow constructor/helper that validates or documents the boundary.
3. Use the helper at system boundaries; do not scatter bare `value as Brand` casts.

## Adding IPC types

1. Add payload and response types.
2. Extend `IPCChannelPayloadMap` / response maps.
3. Update bridge types in `bridge.ts` if renderer-facing.
4. Keep validators in shared validator files, not in type-only modules.
