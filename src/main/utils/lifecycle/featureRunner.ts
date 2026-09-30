/**
 * Feature Runner
 *
 * Walks the build-time `FEATURE_PLAN` (precomputed phase → dependency-batched
 * spec arrays) and drives feature lifecycle. Replaces the previous 485-line
 * `FeatureManager` class — the topological sort now runs at build time inside
 * `scripts/featurePlanPlugin.js`.
 *
 * @module featureRunner
 */

import log from 'electron-log';
import { FEATURE_PLAN } from '../../generated/featurePlan.js';
import type { FeatureContext, FeaturePriority, FeatureSpec } from './featureConfigTypes.js';
import { perfMonitor } from './performanceMonitor.js';
import { asType } from '../../../shared/typeUtils.js';
import { asFeatureName } from '../../../shared/types/branded.js';
import { platform } from '../platform/platformDetection.js';
import { isStartupAdmissionOpen } from './startupAdmission.js';

const PHASES: readonly FeaturePriority[] = ['security', 'critical', 'ui', 'deferred'];

/** Features that have been initialized, in completion order, for reverse-order cleanup. */
const initialized: FeatureSpec[] = [];
const pending = new Set<Promise<void>>();
let cleanupAvailable = true;

function isFeatureAdmissionOpen(): boolean {
  return isStartupAdmissionOpen() && cleanupAvailable;
}

/** Initialize every feature in a single phase. Batches run sequentially; specs within a batch run in parallel. */
export async function runPhase(phase: FeaturePriority, context: FeatureContext): Promise<void> {
  if (!isFeatureAdmissionOpen()) return;
  const batches = FEATURE_PLAN[phase];
  if (!batches.length) {
    log.debug(`[FeatureRunner] No features in phase: ${phase}`);
    return;
  }

  const phaseStart = Date.now();
  const total = batches.reduce((n, b) => n + b.length, 0);
  log.info(`[FeatureRunner] Phase '${phase}': ${total} feature(s) in ${batches.length} batch(es)`);

  for (let i = 0; i < batches.length; i++) {
    if (!isFeatureAdmissionOpen()) return;
    const batch = batches[i]!;
    const batchNumber = i + 1;
    log.debug(
      `[FeatureRunner] Batch ${batchNumber}/${batches.length}: ${batch.map((s) => s.name).join(', ')}`
    );
    // Emit per-batch markers only for the `deferred` phase. Naming is
    // script-extractable: `${phase}:batch:${N}:(start|end)` with N starting
    // at 1. Restricted to deferred to keep marker volume bounded and to
    // mirror the phase whose budget we want to slice. Other phases retain
    // the existing single phase-level log line.
    const emitBatchMarkers = phase === 'deferred';
    if (emitBatchMarkers) {
      perfMonitor.mark(
        `${phase}:batch:${batchNumber}:start`,
        `Deferred batch ${batchNumber}/${batches.length} starting (${batch.length} feature(s))`
      );
    }
    const results = await Promise.allSettled(batch.map((spec) => runFeature(spec, context)));
    const requiredFailure = results.find((result) => result.status === 'rejected');
    if (requiredFailure?.status === 'rejected') {
      throw requiredFailure.reason;
    }
    if (!isFeatureAdmissionOpen()) return;
    if (emitBatchMarkers) {
      perfMonitor.mark(
        `${phase}:batch:${batchNumber}:end`,
        `Deferred batch ${batchNumber}/${batches.length} completed`
      );
    }
  }

  log.info(`[FeatureRunner] Phase '${phase}' completed in ${Date.now() - phaseStart}ms`);
}

/** Run every phase in order. */
export async function runAllPhases(context: FeatureContext): Promise<void> {
  for (const phase of PHASES) await runPhase(phase, context);
}

/** Run every spec's optional cleanup sequentially in reverse-completion order. */
export async function cleanupAll(context: FeatureContext, signal: AbortSignal): Promise<void> {
  if (!cleanupAvailable) return;
  cleanupAvailable = false;
  log.info('[FeatureRunner] Starting feature cleanup');
  while ((initialized.length || pending.size) && !signal.aborted) {
    const spec = initialized.pop();
    if (!spec) {
      if (!(await settleWithinBudget(Promise.race(pending), signal))) return;
      continue;
    }
    const cleanup = spec.cleanup;
    if (!cleanup) continue;
    const work = (async () => {
      try {
        await cleanup(context);
        log.debug(`[FeatureRunner] ✓ cleaned up ${spec.name}`);
      } catch (error) {
        log.error(`[FeatureRunner] ✗ cleanup failed:`, error);
      }
    })();
    if (!(await settleWithinBudget(work, signal))) return;
  }
  log.info('[FeatureRunner] Feature cleanup completed');
}

async function settleWithinBudget(work: Promise<unknown>, signal: AbortSignal): Promise<boolean> {
  return (await import('./cleanupBudget.js')).settleWithinBudget(work, signal);
}

async function runFeature(spec: FeatureSpec, context: FeatureContext): Promise<void> {
  if (!isFeatureAdmissionOpen()) return;
  const featureName = asFeatureName(spec.name);
  const supportedPlatforms = spec.platforms;
  if (supportedPlatforms && !supportedPlatforms.includes(platform.name)) {
    log.info(`[FeatureRunner] ↷ ${featureName} skipped on ${platform.name}`);
    return;
  }

  const start = Date.now();
  const settlement = Promise.withResolvers<void>();
  pending.add(settlement.promise);
  try {
    await spec.init(context);
    initialized.push(spec);
    log.info(
      `[FeatureRunner] ✓ ${featureName} (${Date.now() - start}ms)${spec.description ? ` — ${spec.description}` : ''}`
    );
  } catch (error) {
    if (spec.required) {
      log.error(`[FeatureRunner] ✗ REQUIRED feature '${featureName}' failed:`, error);
      throw error;
    }
    log.warn(`[FeatureRunner] ✗ optional feature '${featureName}' failed:`, error);
  } finally {
    pending.delete(settlement.promise);
    settlement.resolve();
  }
}

/** Test/diagnostic accessor. */
export function _getInitializedForTest(): readonly FeatureSpec[] {
  return [...initialized];
}

/** Diagnostic summary of feature plan + runtime state. */
export function getSummary(): {
  total: number;
  initialized: number;
  byPhase: Record<FeaturePriority, number>;
} {
  const byPhase = asType<Record<FeaturePriority, number>>({});
  let total = 0;
  for (const phase of PHASES) {
    const count = FEATURE_PLAN[phase].reduce((n, b) => n + b.length, 0);
    byPhase[phase] = count;
    total += count;
  }
  return { total, initialized: initialized.length, byPhase };
}
