# Offline Page Guide

**Parent:** `../AGENTS.md`

`src/offline` is a static fallback page for network loss. It is not a normal renderer app. Account backend choice does not affect this page.

## Constraints

- No preload and no IPC (and no Electron APIs).
- Communicate retry intent with DOM events such as `window.dispatchEvent(new Event('app:checkIfOnline'))`.
- Preload answers false online checks with `app:onlineCheckFailed`; this page re-enables the retry control without reloading the document.
- Keep the script self-contained/IIFE-friendly.
- `setInterval` is intentionally untracked here because this is not main-process code.
- `MAX_AUTO_ATTEMPT_COUNT` (100) caps automatic retries on a 60s `window.setInterval`, cleared on the 100th dispatch. Manual clicks never consume that budget and still work after exhaustion. The script must not import `src/shared`.

## Recovery UX contract

- Click / auto-check → disable button, show "Checking...", dispatch `app:checkIfOnline`.
- Failed check (false from main via preload) → listen for `app:onlineCheckFailed`, restore enabled Retry state. **Zero** `location.reload()` and **zero** app-URL navigation.
- Successful check is handled in preload (`location.replace(appUrl)`); this page does not navigate itself on success.
- Do not reload the offline document after a false reply; retain the fallback document through failed recovery checks.

## Build contract

- A separate web-target Rsbuild pass compiles `src/offline/index.ts` to a self-contained classic `lib/offline/index.js`, after the main pass cleans `lib/`. It has no imports, chunk loader, Node/Electron globals, or dependency on typecheck emit.
- `copyOfflineAssets` ships `index.html`, `index.css`, and `resources/icons/normal/scalable.svg` together in `lib/offline`. HTML references these siblings and `index.js`; nothing reaches outside `lib/` into `extraResources`.
- Non-watch builds run `scripts/verify-packaged-offline.js` after copying assets and fail on dangling or outside-lib local `src`/`href` references. The verifier is also a standalone CLI accepting the app root.
- Keep the existing CSP unchanged. Built-app Playwright coverage loads the real `file:` page with both account backends and exercises retry through built preload and main connectivity.
- Do not change output paths without updating `scripts/build-rsbuild.js` and packaging checks. Copied assets ship the same way in both macOS packaging arches.

## Anti-patterns

- No Electron API assumptions.
- No direct Google Chat logic beyond explaining/offering retry.
- No shared mutable state with main/preload.
- No `window.location.reload()` on failed connectivity checks.
