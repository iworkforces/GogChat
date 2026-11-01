/**
 * Document-scoped registry of live page notifications.
 *
 * Ownership is sender → document → instance. The sender is the IPC event's WebContents, never a
 * payload field, and a tag never identifies an instance. Each sender with a live instance holds
 * three WebContents listeners (cross-document navigation start and commit, destruction) that
 * invalidate every instance it owns, so a surviving WebContents cannot leak one document's
 * notifications into the next.
 */

import type { WebContents } from 'electron';
import log from 'electron-log';
import { IPC_CHANNELS } from '../../../shared/constants.js';
import { isStartupAdmissionOpen } from '../lifecycle/startupAdmission.js';
import type {
  NotificationInstanceRef,
  NotificationLifecycleEvent,
  NotificationLifecycleEventType,
} from '../../../shared/types/domain.js';

/** Why a registered instance is being released by the registry rather than by the OS or a timer. */
export type InstanceRelease = 'page-close' | 'navigation' | 'destroyed';

type ReleaseInstance = (reason: InstanceRelease) => void;

interface SenderScope {
  readonly documents: Map<string, Map<string, ReleaseInstance>>;
  readonly detach: () => void;
}

/** Live senders keyed by WebContents id; a scope exists only while it owns at least one instance. */
const scopes = new Map<number, SenderScope>();

function releaseSender(senderId: number, reason: 'navigation' | 'destroyed'): void {
  const scope = scopes.get(senderId);
  if (!scope) {
    return;
  }
  const pending = [...scope.documents.values()].flatMap((document) => [...document.values()]);
  for (const release of pending) {
    release(reason);
  }
}

function openScope(sender: WebContents, senderId: number): SenderScope {
  const onStart = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
    if (details.isMainFrame && !details.isSameDocument) {
      releaseSender(senderId, 'navigation');
    }
  };
  const onCommit = (): void => releaseSender(senderId, 'navigation');
  const onDestroyed = (): void => releaseSender(senderId, 'destroyed');
  sender.on('did-start-navigation', onStart);
  sender.on('did-navigate', onCommit);
  sender.once('destroyed', onDestroyed);
  const scope: SenderScope = {
    documents: new Map(),
    detach: () => {
      sender.removeListener('did-start-navigation', onStart);
      sender.removeListener('did-navigate', onCommit);
      sender.removeListener('destroyed', onDestroyed);
    },
  };
  scopes.set(senderId, scope);
  return scope;
}

/**
 * Register a live instance for `sender`. Returns false when the sender is already gone or the same
 * document/instance is already live; a duplicate never replaces or releases the original.
 */
export function bindNotificationInstance(
  sender: WebContents,
  ref: NotificationInstanceRef,
  release: ReleaseInstance
): boolean {
  if (sender.isDestroyed()) {
    return false;
  }
  const senderId = sender.id;
  const scope = scopes.get(senderId) ?? openScope(sender, senderId);
  const document = scope.documents.get(ref.documentId) ?? new Map<string, ReleaseInstance>();
  if (document.has(ref.instanceId)) {
    return false;
  }
  document.set(ref.instanceId, release);
  scope.documents.set(ref.documentId, document);
  return true;
}

/** Forget one instance; the last release for a sender removes its WebContents listeners. */
export function unbindNotificationInstance(senderId: number, ref: NotificationInstanceRef): void {
  const scope = scopes.get(senderId);
  const document = scope?.documents.get(ref.documentId);
  if (!scope || !document) {
    return;
  }
  document.delete(ref.instanceId);
  if (document.size === 0) {
    scope.documents.delete(ref.documentId);
  }
  if (scope.documents.size === 0) {
    scope.detach();
    scopes.delete(senderId);
  }
}

/**
 * Page-initiated dismissal. Only an instance registered under this exact sender, document and
 * instance can be released, so another sender's or document's ids, or a tag, never match.
 */
export function releaseNotificationInstanceFromPage(
  senderId: number,
  ref: NotificationInstanceRef
): boolean {
  const release = scopes.get(senderId)?.documents.get(ref.documentId)?.get(ref.instanceId);
  if (!release) {
    return false;
  }
  release('page-close');
  return true;
}

/** Deliver a native outcome to the sender's current document; preload drops other documents' ids. */
export function sendNotificationLifecycleEvent(
  sender: WebContents,
  ref: NotificationInstanceRef,
  type: NotificationLifecycleEventType
): boolean {
  try {
    if (!isStartupAdmissionOpen() || sender.isDestroyed()) {
      return false;
    }
    const event: NotificationLifecycleEvent = { ...ref, type };
    sender.send(IPC_CHANNELS.NOTIFICATION_EVENT, event);
    return true;
  } catch (error: unknown) {
    log.error('[NotificationLifecycle] Failed to deliver lifecycle event:', error);
    return false;
  }
}

/** Drop every sender listener and registration without invoking release callbacks. */
export function resetNotificationInstances(): void {
  for (const scope of scopes.values()) {
    scope.detach();
  }
  scopes.clear();
}
