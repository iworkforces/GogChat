/**
 * Feature Configuration Types
 *
 * Shared types consumed by `.spec.ts` data files and the `featureRunner` runtime.
 * The legacy FeatureManager class was removed; only the spec/runner shape lives here.
 *
 * @module featureConfigTypes
 */

import type { BrowserWindow } from 'electron';
import type { IAccountWindowManager } from '../../../shared/types/window.js';
import type { IPCChannelName } from '../../../shared/constants.js';
import type { PlatformName } from '../platform/platformDetection.js';

/**
 * Feature initialization priority/phase
 * - security: Initialized first, before BrowserWindow creation
 * - critical: Core features inside app.whenReady (sequential)
 * - ui: UI features inside app.whenReady (parallel within batches)
 * - deferred: Non-critical features after window ready (parallel within batches)
 */
export type FeaturePriority = 'security' | 'critical' | 'ui' | 'deferred';

/**
 * Side-effect callbacks that features may invoke. Wired by app entry.
 */
export interface FeatureCallbacks {
  registerCleanupTask: (name: string, cleanup: () => void | Promise<void>) => void;
  updateContext: (patch: Partial<FeatureContext>) => void;
}

/**
 * Feature initialization context provided to every spec init function.
 */
export interface FeatureContext {
  mainWindow?: BrowserWindow | null;
  accountWindowManager?: IAccountWindowManager;
  callbacks?: FeatureCallbacks;
}

/**
 * A single feature declaration. `.spec.ts` files export readonly arrays of these.
 *
 * The build-time codegen plugin reads `name`, `phase`, `dependencies`, and
 * `required` to compute `FEATURE_PLAN` (phase → dependency-batched arrays).
 * `init` and `cleanup` are executed at runtime by `featureRunner`.
 */
export interface FeatureSpec {
  /** Globally unique identifier */
  readonly name: string;
  /** Initialization phase */
  readonly phase: FeaturePriority;
  /** Whether failure is fatal (true) or merely logged (false). Defaults to false. */
  readonly required?: boolean;
  /** Names of features that must be initialized first */
  readonly dependencies?: readonly string[];
  /** Platforms where this feature is allowed to initialize. Defaults to all platforms. */
  readonly platforms?: readonly PlatformName[];
  /** Optional human-readable description for logs */
  readonly description?: string;
  /** Init function — receives the live FeatureContext */
  readonly init: (context: FeatureContext) => Promise<void> | void;
  /** Optional cleanup, called in reverse init order on shutdown */
  readonly cleanup?: (context: FeatureContext) => Promise<void> | void;
  /**
   * Optional typed IPC "port" declaration — documents which IPC channels this
   * feature listens on (`listen`) and which it emits/replies on (`emit`).
   *
   * This is a TYPE-LEVEL DOCUMENTATION mechanism only. It is not enforced at
   * runtime — `featureRunner` ignores this field. Use it to make the IPC
   * surface auditable; `scripts/check-doc-claims.js` validates that declared
   * channels exist in `IPC_CHANNELS`.
   */
  readonly ipcChannels?: {
    readonly listen?: readonly IPCChannelName[];
    readonly emit?: readonly IPCChannelName[];
  };
}
