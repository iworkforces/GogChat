# Resources Guide

**Parent:** `../AGENTS.md`

`resources/` contains all packaged static assets: icon variants, app icons, and offline fallback graphics. Runtime access is always via `process.resourcesPath` (packaged) or `app.getAppPath()` (dev), through `iconCache.ts` and `platform/` helpers. Assets are packaging-arch independent (same tree in arm64 and x64 DMGs). There is one icon tree — no arch-specific variants.

## Icon tree

```
resources/icons/
  aura/      - Legacy static glow variants (16/32/48/64/256); About/Update use CSS aurora + normal mark
  badge/     - Unread badge overlays, 16/32/48/64/256 px
  normal/    - App/dock icons, 16/32/48/64/256 px + mac.icns + win.ico + scalable.svg
  offline/   - Offline page graphic, 16/32/48/64/256 px
  tray/      - Menu bar Template icons, 22/44 px + unread variants
```

About and Check for Updates dialogs render `normal/scalable.svg` (or `normal/256.png` fallback) inside the shared aurora stage (`src/shared/appIconAurora.ts`). Do not reintroduce pre-baked aura PNGs as the About hero without an explicit design change.

## Generation

Use `bun scripts/generate-google-chat-icons.mjs`. Do not hand-edit individual generated PNG, ICNS, ICO, or SVG variants. The script creates all five variant directories, tray Template icons at 22/44 px, app-size icons per `APP_SIZES`, generates `mac.icns` via macOS `iconutil`, and writes `normal/win.ico` from the generated normal PNG set. Run the generator after any icon design change.

## Naming conventions

- Tray Template icons must have a `Template` suffix: `iconTemplate.png`, `iconUnreadTemplate.png`.
- Retina variants use `@2x` suffix: `iconTemplate@2x.png`.
- Offline, badge, aura, and normal icons use plain numeric sizes.

## Runtime paths

Icon cache loads paths relative to `resources/`:

- Packaged: `process.resourcesPath` + `resources/icons/normal/256.png`
- Dev: `app.getAppPath()` + `resources/icons/normal/256.png`

`iconCache.ts` manages initial and deferred warmup. `cacheWarmer.ts` schedules idle-tier warming. The three path sets (`INITIAL_ICON_PATHS`, `SOON_DEFERRED_ICON_PATHS`, `ADDITIONAL_ICON_PATHS`) must remain disjoint; update tests if path sets change.

## Packaging

`electron-builder.yml` copies `resources/` as `extraResources` outside the ASAR archive. Both macOS packaging arches (`arm64` and `x64` separate DMGs) use the same `resources/icons/normal/mac.icns`. Guarded Windows release-engineering preparation references `resources/icons/normal/win.ico`. That Windows icon path is not a public support claim. The build copies `resources/icons/normal/scalable.svg` to `lib/offline/scalable.svg`; the offline page references that sibling inside the ASAR archive. Builder also excludes proven build-only tool packages; runtime icons must remain in `extraResources` regardless of dependency pruning.

Windows packaging, when used in CI preparation, emits separate NSIS setup files for x64 and arm64. Keep icon generation cross-platform, but do not add Windows support wording to resource docs until clean packaged smoke evidence exists on Windows x64 and real Windows arm64.

## Anti-patterns

- No ad-hoc rename or hand-edit of generated icon files.
- No moving icons into startup paths without updating `iconCache.ts` warmup tiers and tests.
- No changing resource output paths without updating `electron-builder.yml` extraResources and build invariants. Offline logo changes must also update `copyOfflineAssets`, its sibling HTML reference, and the packaged-offline verifier.
- No arch-specific icon trees for macOS arm64 vs x64; one `mac.icns` serves both DMGs.
