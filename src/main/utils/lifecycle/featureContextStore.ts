/**
 * Feature Context Store
 *
 * Holds a singleton reference to the live FeatureContext established by
 * `registerAppReady`. The shutdown handler reads it to pass the same context
 * (mainWindow, callbacks, accountWindowManager) into each spec's
 * cleanup function — preserving the symmetry of the previous FeatureManager.
 *
 * Kept as a tiny module to avoid coupling registerAppReady ↔ registerShutdown.
 */

import type { FeatureContext } from './featureConfigTypes.js';

let shared: FeatureContext = {};

export function setSharedFeatureContext(ctx: FeatureContext): void {
  shared = ctx;
}

export function getSharedFeatureContext(): FeatureContext {
  return shared;
}
