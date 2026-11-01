/**
 * Menu Action Registry
 *
 * Decouples features from appMenu by providing a registry for menu actions.
 * Features register their actions here during initialization, and appMenu
 * consumes them via the registry instead of direct feature→feature imports.
 *
 * This eliminates boundary violations where appMenu.ts imported from
 * openAtLogin.ts, aboutPanel.ts, and externalLinks.ts.
 */

import { asType } from '../../shared/typeUtils.js';

/**
 * Typed map of all known menu action IDs to their handler signatures.
 * Add an entry here whenever a new menu action is registered.
 */
export interface MenuActionMap {
  aboutPanel: (window: Electron.BrowserWindow) => void;
  checkForUpdates: () => void;
  /** Persist a 24-hour snooze; false when the write failed and nothing changed. */
  snoozeUpdatePrompts: () => boolean;
  /** Persist the end of a snooze; false when the write failed and nothing changed. */
  resumeUpdatePrompts: () => boolean;
  refreshApplicationMenu: () => void;
  autoLaunch: () => { enable: () => Promise<void>; disable: () => Promise<void> };
  toggleExternalLinksGuard: (window: Electron.BrowserWindow) => void;
  processDeepLink: (url: string) => void;
}

export type MenuActionId = keyof MenuActionMap;

/**
 * Menu action descriptor
 */
export interface MenuAction<K extends MenuActionId = MenuActionId> {
  /** Human-readable label for logging */
  label: string;
  /** The action handler */
  handler: MenuActionMap[K];
}

/**
 * Global registry of menu actions, keyed by action id.
 * Actions are registered by features during their init phase and
 * consumed by appMenu when building the menu template.
 */
const actions = new Map<MenuActionId, MenuAction>();

/**
 * Register a menu action.
 * Called by features during their initialization phase.
 */
export function registerMenuAction<K extends MenuActionId>(id: K, action: MenuAction<K>): void {
  actions.set(id, action);
}

/**
 * Retrieve a registered menu action by id.
 * Called by appMenu when building the menu template.
 * Returns undefined if no action registered (defensive — feature may not have loaded).
 */
export function getMenuAction<K extends MenuActionId>(id: K): MenuAction<K> | undefined {
  return asType<MenuAction<K> | undefined>(actions.get(id));
}

/**
 * Clear all registered actions (for testing / cleanup).
 */
export function clearMenuActions(): void {
  actions.clear();
}
