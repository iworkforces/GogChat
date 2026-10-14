# Performance Utilities Documentation

This document describes performance-related utilities under `src/main/utils/` (icon cache, package info helpers, config profiling notes). It is **historical/supplementary**.

## Authoritative contracts

For versioned startup metrics, MB units, required markers, and final export ownership, prefer:

- `src/main/utils/lifecycle/AGENTS.md`
- `src/main/utils/lifecycle/performanceTypes.ts` / `performanceFinalizer.ts`
- `docs/plans/performance-remediation.md`
- Evidence under `.omo/evidence/performance-remediation/` (when present)

Do **not** treat unmeasured “ms faster” claims in older sections of this file as product truth. Package-byte reductions are not startup wins without a measured path.

## Overview

Utilities here focus on caching and monitoring helpers (icons, package metadata, optional config profiling). Paths in older examples may refer to pre-`platform/` layouts — current icons live under `src/main/utils/platform/iconCache.ts`.

---

## iconCache.ts

### Purpose
Centralizes icon loading and caching to eliminate redundant file I/O operations.

### Key Exports

```typescript
class IconCacheManager {
  getIcon(relativePath: string): NativeImage
  warmCache(): number
  getCacheSize(): number
  getStats(): {size: number; icons: string[]}
  clear(): void
}

export function getIconCache(): IconCacheManager
export function destroyIconCache(): void
```

### Usage

**Basic usage:**
```typescript
import {getIconCache} from './utils/iconCache';

// Get icon (cached automatically)
const icon = getIconCache().getIcon('resources/icons/normal/256.png');
window.setIcon(icon);
```

**Warming cache at startup:**
```typescript
// In main/index.ts - load common icons upfront
getIconCache().warmCache();
// Loads 7 common icons: normal (256, 64, 32, 16), offline (32, 16), badge (16)
```

**Cache statistics:**
```typescript
const stats = getIconCache().getStats();
console.log(`Cached ${stats.size} icons`);
console.log(`Icon paths:`, stats.icons);
```

### How It Works

1. **First access**: `getIcon()` loads from disk via `nativeImage.createFromPath()`
2. **Cache**: Stores NativeImage in Map<string, NativeImage>
3. **Subsequent access**: Returns cached NativeImage (no file I/O)

### Performance

- **First load**: ~2-3ms per icon (file I/O)
- **Cached load**: ~0.001ms (Map lookup)
- **Memory**: ~14KB per icon (7 icons ≈ 100KB total)

**Improvement**: Eliminates 6+ redundant file reads during startup = ~10-20ms saved

### Integration

Used by:
- `windowWrapper.ts` - Main window icon
- `inOnline.ts` - Offline notification icon
- (About/Update dialogs load `normal/scalable.svg` via fs data URI + CSS aurora; not iconCache)

---

## packageInfo.ts

### Purpose
Loads package.json once and provides typed access to package metadata, eliminating duplicate file reads.

### Key Exports

```typescript
interface PackageInfo {
  name: string
  productName: string
  version: string
  description: string
  repository: string
  homepage: string
  author: string
  license?: string
  main?: string
  [key: string]: unknown
}

export function getPackageInfo(): Readonly<PackageInfo>
export function clearPackageInfoCache(): void
export function isPackageInfoLoaded(): boolean
```

### Usage

**Basic usage:**
```typescript
import {getPackageInfo} from './utils/packageInfo';

const pkg = getPackageInfo();
console.log(`App version: ${pkg.version}`);
console.log(`Repository: ${pkg.repository}`);
```

**Type safety:**
```typescript
// TypeScript knows all fields
const pkg = getPackageInfo();
pkg.name;         // ✅ string
pkg.version;      // ✅ string
pkg.description;  // ✅ string
```

**Immutability:**
```typescript
const pkg = getPackageInfo();
pkg.version = '999';  // ❌ Error: Cannot assign to 'version' (frozen object)
```

### How It Works

1. **First call**: Loads package.json via `require()`, freezes object
2. **Subsequent calls**: Returns frozen cached object (no file I/O)

### Performance

- **First load**: ~1-2ms (require + JSON parse)
- **Cached load**: ~0.001ms (return cached reference)
- **Memory**: ~1KB

**Improvement**: Eliminates 2 duplicate package.json reads = ~2-5ms saved

### Integration

Used by:
- `appMenu.ts` - Version display in menu
- `reportExceptions.ts` - Error reporting with version info
- `aboutPanel.ts` / `appUpdates.ts` - About and update dialog package/repo metadata

---

## performanceMonitor.ts

### Purpose
Tracks timing markers throughout app lifecycle to measure and optimize performance.

### Key Exports

```typescript
class PerformanceMonitor {
  mark(name: string, logMessage?: string): void
  measure(startMarker: string, endMarker: string): number | null
  getMetrics(): Record<string, number>
  getTotalElapsed(): number
  logSummary(): void
  setEnabled(enabled: boolean): void
  reset(): void
}

export function getPerformanceMonitor(): PerformanceMonitor
export function destroyPerformanceMonitor(): void
export const perfMonitor: PerformanceMonitor  // Convenience singleton
```

### Usage

**Basic markers:**
```typescript
import {perfMonitor} from './utils/performanceMonitor';

perfMonitor.mark('app-start', 'Application started');
// ... some work ...
perfMonitor.mark('feature-loaded', 'Features initialized');
```

**Measuring between markers:**
```typescript
perfMonitor.mark('cache-start');
warmCache();
perfMonitor.mark('cache-end');

const duration = perfMonitor.measure('cache-start', 'cache-end');
console.log(`Cache warming took ${duration}ms`);
```

**Summary report:**
```typescript
perfMonitor.logSummary();
// Outputs a marker timeline — exact markers are owned by performanceTypes /
// the finalizer (see lifecycle AGENTS). Custom certificate pinning was removed;
// there is no product `cert-pinning-done` marker.
```

### Required unauthenticated startup markers (see performanceTypes)

| Marker | Description |
|--------|-------------|
| `app-start` | App initialization started |
| `app-ready` | Electron app ready event |
| `account-0-ready` | Account-0 native window readiness |
| `account-0-content-loaded` | Account-0 document load (not first paint/interaction) |
| `features-loaded` | Critical features initialized |
| `all-features-loaded` | Deferred phase features loaded |

### Performance

- **Overhead per mark**: ~0.01ms (negligible)
- **Memory**: ~5KB for typical session

### Integration

Markers added in `main/index.ts` at key points in startup sequence.

---

## configProfiler.ts

### Purpose
Measures electron-store read performance to determine if caching is beneficial.

### Key Exports

```typescript
export function profileConfigStoreReads(iterations?: number): number
export function profileSingleKeyRead(key: string, iterations?: number): number
export function compareStorePerformance(): {
  noCacheTime: number
  potentialSavings: number
  recommendation: string
}
```

### Usage

**Full performance analysis:**
```typescript
import {compareStorePerformance} from './utils/configProfiler';

// Profiles 100 iterations across 7 common keys
const result = compareStorePerformance();

// Outputs:
// [ConfigProfiler] Profiled 100 iterations
// [ConfigProfiler] Average per iteration: 0.123ms
// [ConfigProfiler] RECOMMENDED: Average read time exceeds threshold (0.1ms)
```

**Profile specific key:**
```typescript
import {profileSingleKeyRead} from './utils/configProfiler';

const avgTime = profileSingleKeyRead('app.autoCheckForUpdates', 1000);
console.log(`Average read time: ${avgTime.toFixed(3)}ms`);
```

### How It Works

1. Reads 7 common config keys 100 times each
2. Calculates average read time
3. Compares against threshold (0.1ms)
4. Recommends enabling cache if beneficial

**Threshold Logic:**
- **< 0.1ms**: electron-store is fast enough, cache not needed
- **≥ 0.1ms**: Cache layer would provide measurable benefit

### Integration

Runs automatically in development mode after all features load (see `main/index.ts`).

---

## configCache.ts

### Purpose
Adds in-memory caching layer to electron-store to reduce encryption/decryption overhead.

### Key Exports

```typescript
interface CacheStats {
  hits: number
  misses: number
  writes: number
}

export function addCacheLayer<T>(store: Store<T>): Store<T>
export function logCacheStats(store: any): void
```

### Usage

**Enable caching:**
```typescript
import Store from 'electron-store';
import {addCacheLayer} from './utils/configCache';

let store = new Store({schema, encryptionKey});
store = addCacheLayer(store);  // Add cache layer

// Now store.get() checks cache first
const value = store.get('app.autoCheckForUpdates');
```

**Cache statistics:**
```typescript
import {logCacheStats} from './utils/configCache';

logCacheStats(store);
// Outputs:
// [ConfigCache] ========== Cache Statistics ==========
// [ConfigCache] Cache hits: 45
// [ConfigCache] Cache misses: 12
// [ConfigCache] Hit rate: 78.9%
```

**Manual cache stats:**
```typescript
if (typeof store.getCacheStats === 'function') {
  const stats = store.getCacheStats();
  console.log(`Hit rate: ${stats.hitRate}`);
  console.log(`Total hits: ${stats.hits}`);
  console.log(`Total misses: ${stats.misses}`);
}
```

### How It Works

**Read Path:**
1. `store.get(key)` called
2. Check cache: `cache.has(key)` → if yes, return cached value (HIT)
3. If not cached, read from store (MISS)
4. Store value in cache
5. Return value

**Write Path:**
1. `store.set(key, value)` called
2. Invalidate cache for `key` and all parent keys
3. Write to underlying store
4. Future reads will be cache misses (ensuring fresh data)

**Example Invalidation:**
```typescript
store.set('app.hideMenuBar', true);
// Invalidates:
// - 'app.hideMenuBar' (exact key)
// - 'app' (parent key)
```

### Performance

- **Cache hit**: ~0.001ms (Map lookup)
- **Cache miss**: ~0.1-0.5ms (decrypt + cache)
- **Memory**: ~5KB for typical usage

**Improvement**: 50-80% hit rate = ~2-5ms saved during startup

### Cache Safety

✅ **Automatic invalidation** on writes
✅ **Parent key invalidation** (nested paths handled correctly)
✅ **Test-aware** (disabled in test environment to preserve spies)
✅ **No stale data** (writes always invalidate)

### Integration

**Enabled by default** in `main/config.ts`:
```typescript
import {addCacheLayer} from './utils/configCache';

// Enabled in production/dev, disabled in tests
if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
  store = addCacheLayer(store);
}
```

**Statistics logged** in `main/index.ts` on app exit:
```typescript
app.on('before-quit', () => {
  if (typeof store.getCacheStats === 'function') {
    logCacheStats(store);
  }
});
```

---

## Platform-Specific Utilities

### platform.ts

Provides platform detection and OS-specific utilities.

**Key exports:**
```typescript
export const platform = {
  isMac: boolean
  isWindows: boolean
  isLinux: boolean
}

export function enforceMacOSAppLocation(): void
export function openNewGitHubIssue(options): void
export function debugInfo(): string
```

**Usage:**
```typescript
import {platform} from './utils/platform';

if (platform.isMac) {
  // macOS-specific code
  const size = 16;  // Retina-optimized icon size
} else if (platform.isWindows) {
  // Windows-specific code
  const size = 32;  // Standard icon size
}
```

---

## Common Patterns

### Caching Pattern

**When to use caching:**
1. Static resources (icons, package.json)
2. Frequently accessed data (config values)
3. Expensive operations (file I/O, encryption)

**When NOT to cache:**
1. Dynamic data (user input, live updates)
2. Large resources (videos, large images)
3. Security-sensitive data (credentials, tokens)

### Performance Monitoring Pattern

**Add markers at:**
1. Start of expensive operations
2. End of expensive operations
3. Key milestones in startup
4. Feature initialization complete

**Example:**
```typescript
perfMonitor.mark('operation-start');
await expensiveOperation();
perfMonitor.mark('operation-end');

const duration = perfMonitor.measure('operation-start', 'operation-end');
if (duration > 100) {
  log.warn(`Slow operation: ${duration}ms`);
}
```

---

## Best Practices

### Icon Caching

✅ **DO:**
- Use `getIconCache().getIcon()` for all icon loading
- Call `warmCache()` early in startup
- Cache static icons only

❌ **DON'T:**
- Call `nativeImage.createFromPath()` directly
- Load icons in loops without caching
- Cache dynamically generated images

### Config Caching

✅ **DO:**
- Let the cache handle reads automatically
- Trust the automatic invalidation on writes
- Check cache stats to verify effectiveness

❌ **DON'T:**
- Manually clear cache unless necessary
- Bypass cache with direct store access
- Assume cached values are always fresh (writes invalidate)

### Performance Monitoring

✅ **DO:**
- Add markers at key milestones
- Use descriptive marker names
- Log summary in development mode
- Measure critical paths

❌ **DON'T:**
- Add markers in hot loops (overhead)
- Leave monitoring enabled in production (unless analyzing performance)
- Add too many markers (noise)

---

## Testing

### Icon Cache Tests

**File**: `iconCache.test.ts`
**Coverage**: 11 tests (4 pass in test env, 7 require Electron runtime)

```bash
npm test iconCache.test.ts
```

### Package Info Tests

**File**: `packageInfo.test.ts`
**Coverage**: 10 tests (all pass)

```bash
npm test packageInfo.test.ts
```

### Config Cache Testing

Cache is automatically disabled in test environment to preserve test spies:
```typescript
// In config.ts
if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
  store = addCacheLayer(store);
}
```

---

## Troubleshooting

### Icons Not Loading

**Symptom**: Icons appear as empty/broken
**Cause**: Icon path incorrect or file missing
**Solution**: Check logs for `[IconCache] Failed to load icon` errors

### Cache Not Working

**Symptom**: No performance improvement
**Cause**: Cache layer not enabled
**Solution**: Check `[ConfigCache] Cache layer enabled` log at startup

### Low Cache Hit Rate

**Symptom**: Hit rate < 30%
**Cause**: Too many unique keys being read
**Solution**: Normal for startup; improves during runtime

### Performance Regression

**Symptom**: App slower after optimizations
**Cause**: Unlikely (caching reduces overhead)
**Solution**: Check performance logs, compare before/after metrics

---

## Metrics & Monitoring

### Expected Metrics

**Icon Cache:**
- Size: 7 icons cached
- Memory: ~100KB

**Package Info:**
- Loads: 1 (on first access)
- Memory: ~1KB

**Config Cache:**
- Hit rate: 50-80% (after startup)
- Misses: 10-20 (first reads)
- Memory: ~5KB

**Performance:**
- Measure startup via the versioned headless harness + budget gate (MB units), not ad-hoc estimates in this file
- Cache memory overhead is small relative to Chat renderers; do not claim runtime wins from package size alone

### Monitoring in Production

1. Prefer development/CI `performance-metrics.json` from the finalizer
2. Check logs on app exit for cache stats when debugging
3. Track gated budgets with `scripts/check-perf-budget.js`

---

## Future Enhancements

Potential improvements:

1. **Lazy icon loading** - Load icons on-demand, not upfront
2. **LRU cache eviction** - For config cache (currently unbounded)
3. **Cache persistence** - Save cache to disk between sessions
4. **Performance regression tests** - Automated performance tracking
5. **Advanced profiling** - V8 profiler integration

See `PERFORMANCE_OPTIMIZATIONS.md` for complete roadmap.
