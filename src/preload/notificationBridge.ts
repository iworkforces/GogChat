/**
 * Page `Notification` wrapper and its private roundtrip to the native banner.
 *
 * The wrapper runs in the page world and talks to this isolated-world module over three DOM events
 * whose names embed a per-document id, so nothing is exposed on `window.gogchat` and no raw
 * `ipcRenderer` reaches the page. Preload attaches the document id itself; the page only supplies
 * instance ids. Main derives account ownership from the IPC sender and echoes lifecycle events
 * back addressed by document + instance, which this module drops unless they name this document.
 */

import { ipcRenderer, webFrame } from 'electron';
import { IPC_CHANNELS, TIMING } from '../shared/constants.js';
import {
  isSafeObject,
  validateNotificationCloseRequest,
  validateNotificationData,
  validateNotificationLifecycleEvent,
} from '../shared/dataValidators.js';

const EVENT_PREFIX = '__gogchatNotification';

/**
 * Bound bursts as well as silent IPC throttling; each entry also expires at the native deadline.
 */
const MAX_LIVE_INSTANCES = 64;

function eventNames(documentId: string) {
  return {
    show: `${EVENT_PREFIX}Show:${documentId}`,
    close: `${EVENT_PREFIX}Close:${documentId}`,
    deliver: `${EVENT_PREFIX}Deliver:${documentId}`,
  } as const;
}

type EventNames = ReturnType<typeof eventNames>;

function buildPageWorldBridge(names: EventNames): string {
  return `(() => {
  const NativeNotification = window.Notification;
  if (!NativeNotification || window.__gogchatNotificationBridgeInstalled === true) return;
  window.__gogchatNotificationBridgeInstalled = true;

  const SHOW_EVENT = ${JSON.stringify(names.show)};
  const CLOSE_EVENT = ${JSON.stringify(names.close)};
  const DELIVER_EVENT = ${JSON.stringify(names.deliver)};
  const MAX_LIVE = ${MAX_LIVE_INSTANCES};
  const states = new WeakMap();
  const live = new Map();
  let notificationIdCounter = 0;
  let instanceCounter = 0;

  const report = (error) => (typeof reportError === 'function' ? reportError(error) : console.error(error));
  const fire = (target, type) => {
    const event = new Event(type);
    target.dispatchEvent(event);
    const handler = target['on' + type];
    if (typeof handler !== 'function') return;
    try {
      handler.call(target, event);
    } catch (error) {
      report(error);
    }
  };
  const settle = (notification, requestClose) => {
    const state = states.get(notification);
    if (state === undefined || state.settled) return;
    state.settled = true;
    clearTimeout(state.deadline);
    live.delete(state.id);
    if (requestClose) {
      window.dispatchEvent(new CustomEvent(CLOSE_EVENT, { detail: { instanceId: state.id } }));
    }
    fire(notification, 'close');
  };

  window.addEventListener(DELIVER_EVENT, (event) => {
    const detail = event.detail;
    const notification = detail && live.get(detail.instanceId);
    if (!notification) return;
    if (detail.type === 'click') {
      const state = states.get(notification);
      if (state.clicked) return;
      state.clicked = true;
      fire(notification, 'click');
    } else if (detail.type === 'close') {
      settle(notification, false);
    }
  });

  class GogChatNotification extends EventTarget {
    constructor(title, options = {}) {
      super();
      this.title = String(title);
      this.body = options.body || '';
      this.icon = options.icon || '';
      this.tag = options.tag || 'notification-' + notificationIdCounter++;
      this.data = options.data;
      this.dir = options.dir || 'auto';
      this.lang = options.lang || '';
      this.badge = options.badge || '';
      this.requireInteraction = options.requireInteraction || false;
      this.silent = options.silent || null;
      this.onclick = null;
      this.onclose = null;
      this.onerror = null;
      this.onshow = null;

      const id = 'n' + instanceCounter++;
      const deadline = setTimeout(() => settle(this, true), ${TIMING.NOTIFICATION_AUTO_DISMISS});
      states.set(this, { id, settled: false, clicked: false, deadline });
      live.set(id, this);
      if (live.size > MAX_LIVE) settle(live.values().next().value, true);

      const accepted = window.dispatchEvent(new CustomEvent(SHOW_EVENT, {
        cancelable: true,
        detail: {
          title: this.title,
          body: this.body,
          icon: this.icon,
          tag: this.tag,
          instanceId: id,
        },
      }));
      if (!accepted) queueMicrotask(() => settle(this, false));

      setTimeout(() => fire(this, 'show'), 0);
    }

    close() {
      settle(this, true);
    }

    static requestPermission(callback) {
      return NativeNotification.requestPermission(callback);
    }

    static get permission() {
      return NativeNotification.permission;
    }
  }

  window.Notification = GogChatNotification;
})();`;
}

function withDocumentId(detail: unknown, documentId: string): unknown {
  return isSafeObject(detail) ? { ...detail, documentId } : detail;
}

function forwardShow(documentId: string, event: CustomEvent<unknown>): void {
  try {
    const validated = validateNotificationData(withDocumentId(event.detail, documentId));
    ipcRenderer.send(IPC_CHANNELS.NOTIFICATION_SHOW, {
      title: validated.title,
      ...(validated.body !== undefined && { body: validated.body }),
      ...(validated.icon !== undefined && { icon: validated.icon }),
      ...(validated.tag !== undefined && { tag: validated.tag }),
      ...(validated.documentId !== undefined && { documentId: validated.documentId }),
      ...(validated.instanceId !== undefined && { instanceId: validated.instanceId }),
    });
  } catch (error: unknown) {
    console.error('[notificationBridge] Invalid notification data:', error);
    event.preventDefault();
  }
}

function forwardClose(documentId: string, detail: unknown): void {
  try {
    const request = validateNotificationCloseRequest(withDocumentId(detail, documentId));
    ipcRenderer.send(IPC_CHANNELS.NOTIFICATION_CLOSE, request);
  } catch (error: unknown) {
    console.error('[notificationBridge] Invalid notification close request:', error);
  }
}

function deliverLifecycleEvent(documentId: string, names: EventNames, data: unknown): void {
  try {
    const event = validateNotificationLifecycleEvent(data);
    if (event.documentId !== documentId) {
      return;
    }
    window.dispatchEvent(
      new CustomEvent(names.deliver, { detail: { instanceId: event.instanceId, type: event.type } })
    );
  } catch (error: unknown) {
    console.error('[notificationBridge] Invalid notification lifecycle event:', error);
  }
}

/** `getRandomValues` works in every context; `randomUUID` exists only in secure ones. */
function createDocumentId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function installNotificationBridge(): void {
  const documentId = createDocumentId();
  const names = eventNames(documentId);

  window.addEventListener(names.show, (event) => {
    if (event instanceof CustomEvent) {
      forwardShow(documentId, event);
    }
  });
  window.addEventListener(names.close, (event) => {
    if (event instanceof CustomEvent) {
      forwardClose(documentId, event.detail);
    }
  });
  ipcRenderer.on(IPC_CHANNELS.NOTIFICATION_EVENT, (_event, data: unknown) => {
    deliverLifecycleEvent(documentId, names, data);
  });

  void webFrame.executeJavaScript(buildPageWorldBridge(names)).catch((error: unknown) => {
    console.error('[notificationBridge] Failed to install page notification bridge:', error);
  });
}
