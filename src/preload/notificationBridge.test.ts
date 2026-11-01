// @vitest-environment jsdom

import { runInThisContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type LifecycleListener = (event: unknown, data: unknown) => void;

const mockSend = vi.fn();
const mockExecuteJavaScript = vi.fn().mockResolvedValue(undefined);
const lifecycleListeners: LifecycleListener[] = [];

vi.mock('electron', () => ({
  ipcRenderer: {
    send: mockSend,
    on: (channel: string, listener: LifecycleListener) => {
      if (channel === 'notificationEvent') lifecycleListeners.push(listener);
    },
  },
  webFrame: {
    executeJavaScript: mockExecuteJavaScript,
  },
}));

class StubNativeNotification {
  static permission = 'default';
  static requestPermission = vi.fn();
}

const reportError = vi.fn();

function resetPageWorld() {
  Reflect.deleteProperty(window, '__gogchatNotificationBridgeInstalled');
  Object.assign(window, { Notification: StubNativeNotification, reportError });
}

/** One document: a fresh preload module instance plus the page-world script it injected. */
async function loadDocument() {
  vi.resetModules();
  resetPageWorld();
  const { installNotificationBridge } = await import('./notificationBridge.js');
  installNotificationBridge();
  const script = mockExecuteJavaScript.mock.calls.at(-1)?.[0];
  if (typeof script !== 'string') throw new Error('page script was not injected');
  runInThisContext(script);
  const lifecycle = lifecycleListeners.at(-1);
  if (!lifecycle) throw new Error('lifecycle listener was not registered');
  return {
    script,
    deliver: (data: unknown) => lifecycle({}, data),
    notify: (title = 'Alice', options: ConstructorParameters<typeof window.Notification>[1] = {}) =>
      new window.Notification(title, options),
  };
}

function sentRefs(channel: string) {
  return mockSend.mock.calls
    .filter(([sent]) => sent === channel)
    .map(([, payload]) => payload as { documentId: string; instanceId: string });
}

function documentIdOf(channel = 'notificationShow'): string {
  const [first] = sentRefs(channel);
  if (!first) throw new Error(`nothing sent on ${channel}`);
  return first.documentId;
}

describe('notificationBridge', () => {
  beforeEach(() => {
    mockSend.mockClear();
    mockExecuteJavaScript.mockClear();
    reportError.mockClear();
    lifecycleListeners.length = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('forwards a page Notification with the document id the preload minted and the page instance id', async () => {
    const { notify } = await loadDocument();

    const created = notify('Alice', {
      body: 'New message',
      icon: 'https://ssl.gstatic.com/icon.png',
      tag: 'chat-message-1',
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith('notificationShow', {
      title: 'Alice',
      body: 'New message',
      icon: 'https://ssl.gstatic.com/icon.png',
      tag: 'chat-message-1',
      documentId: expect.stringMatching(/^[0-9a-f]{32}$/),
      instanceId: 'n0',
    });
    expect(created.tag).toBe('chat-message-1');
  });

  it('defaults the tag and gives each instance its own id', async () => {
    const { notify } = await loadDocument();

    notify('First');
    notify('Second');

    expect(mockSend.mock.calls.map(([, payload]) => payload)).toMatchObject([
      { tag: 'notification-0', instanceId: 'n0' },
      { tag: 'notification-1', instanceId: 'n1' },
    ]);
  });

  it('overrides a document id forged inside a show event', async () => {
    const { script } = await loadDocument();
    const showEvent = /SHOW_EVENT = "([^"]+)"/.exec(script)?.[1];
    if (!showEvent) throw new Error('show event name not found');

    window.dispatchEvent(
      new window.CustomEvent(showEvent, {
        detail: { title: 'Forged', instanceId: 'n9', documentId: 'forged-document' },
      })
    );

    const [forwarded] = sentRefs('notificationShow');
    expect(forwarded?.documentId).toMatch(/^[0-9a-f]{32}$/);
    expect(forwarded?.instanceId).toBe('n9');
  });

  it('keeps the roundtrip off window.gogchat, ipcRenderer and script tags', async () => {
    const { script } = await loadDocument();

    expect(mockExecuteJavaScript).toHaveBeenCalledTimes(1);
    expect(script).not.toContain('ipcRenderer');
    expect(script).not.toContain('window.gogchat');
    expect(document.querySelectorAll('script')).toHaveLength(0);
  });

  it('settles a payload that fails validation once without claiming a display', async () => {
    const { notify } = await loadDocument();
    const closed = vi.fn();
    const created = notify('Alice', { icon: 'https://evil.example/icon.png' });
    created.addEventListener('close', closed);

    await Promise.resolve();
    created.close();

    expect(mockSend).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('close() asks main once, fires close once, and isolates a throwing handler', async () => {
    const { notify } = await loadDocument();
    const created = notify('Alice');
    const listener = vi.fn();
    created.addEventListener('close', listener);
    created.onclose = vi.fn(() => {
      throw new Error('handler failure');
    });

    created.close();
    created.close();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(created.onclose).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(sentRefs('notificationClose')).toEqual([
      { documentId: documentIdOf(), instanceId: 'n0' },
    ]);
  });

  it('delivers a main click once while the instance is live', async () => {
    const { notify, deliver } = await loadDocument();
    const created = notify('Alice');
    created.onclick = vi.fn();
    const click = { documentId: documentIdOf(), instanceId: 'n0', type: 'click' };

    deliver(click);
    deliver(click);

    expect(created.onclick).toHaveBeenCalledTimes(1);
  });

  it('settles on a main close without echoing it, and ignores later events', async () => {
    const { notify, deliver } = await loadDocument();
    const created = notify('Alice');
    created.onclose = vi.fn();
    created.onclick = vi.fn();
    const ref = { documentId: documentIdOf(), instanceId: 'n0' };

    deliver({ ...ref, type: 'close' });
    deliver({ ...ref, type: 'close' });
    deliver({ ...ref, type: 'click' });
    created.close();

    expect(created.onclose).toHaveBeenCalledTimes(1);
    expect(created.onclick).not.toHaveBeenCalled();
    expect(sentRefs('notificationClose')).toEqual([]);
  });

  it('ignores events for another document, unknown instances and malformed payloads', async () => {
    const { notify, deliver } = await loadDocument();
    const created = notify('Alice');
    created.onclick = vi.fn();
    created.onclose = vi.fn();
    const documentId = documentIdOf();

    deliver({ documentId: 'another-document', instanceId: 'n0', type: 'click' });
    deliver({ documentId, instanceId: 'n99', type: 'click' });
    deliver({ documentId, instanceId: 'n0', type: 'bogus' });
    deliver('not an object');

    expect(created.onclick).not.toHaveBeenCalled();
    expect(created.onclose).not.toHaveBeenCalled();
  });

  it('keeps a replacement with the same tag untouched by events for the instance it replaced', async () => {
    const { notify, deliver } = await loadDocument();
    const replaced = notify('Old', { tag: 'room' });
    const replacement = notify('New', { tag: 'room' });
    replaced.onclick = vi.fn();
    replacement.onclick = vi.fn();
    replacement.onclose = vi.fn();
    const documentId = documentIdOf();

    deliver({ documentId, instanceId: 'n0', type: 'close' });
    deliver({ documentId, instanceId: 'n0', type: 'close' });
    deliver({ documentId, instanceId: 'n0', type: 'click' });

    expect(replaced.onclick).not.toHaveBeenCalled();
    expect(replacement.onclose).not.toHaveBeenCalled();
    deliver({ documentId, instanceId: 'n1', type: 'click' });
    expect(replacement.onclick).toHaveBeenCalledTimes(1);
  });

  it('drops a previous document\u2019s events even when instance ids repeat', async () => {
    const first = await loadDocument();
    first.notify('Old document');
    const oldDocumentId = documentIdOf();
    mockSend.mockClear();

    const second = await loadDocument();
    const survivor = second.notify('New document');
    survivor.onclick = vi.fn();
    survivor.onclose = vi.fn();
    second.deliver({ documentId: oldDocumentId, instanceId: 'n0', type: 'click' });
    second.deliver({ documentId: oldDocumentId, instanceId: 'n0', type: 'close' });

    expect(documentIdOf()).not.toBe(oldDocumentId);
    expect(survivor.onclick).not.toHaveBeenCalled();
    expect(survivor.onclose).not.toHaveBeenCalled();
  });

  it('evicts the oldest live instance with one close request once 64 are live', async () => {
    const { notify } = await loadDocument();
    const instances = Array.from({ length: 64 }, (_, index) => notify(`Message ${index}`));
    const evicted = vi.fn();
    instances[0]?.addEventListener('close', evicted);
    expect(sentRefs('notificationClose')).toEqual([]);

    notify('Message 64');

    expect(evicted).toHaveBeenCalledTimes(1);
    expect(sentRefs('notificationClose')).toEqual([
      { documentId: documentIdOf(), instanceId: 'n0' },
    ]);
    instances[0]?.close();
    instances[1]?.close();
    expect(sentRefs('notificationClose').map(({ instanceId }) => instanceId)).toEqual(['n0', 'n1']);
  });

  it('preserves the asynchronous show contract without claiming native display', async () => {
    vi.useFakeTimers();
    const { notify } = await loadDocument();
    const shown = notify('Shown');
    const closedFirst = notify('Closed first');
    shown.onshow = vi.fn();
    closedFirst.onshow = vi.fn();

    closedFirst.close();
    expect(shown.onshow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);

    expect(shown.onshow).toHaveBeenCalledTimes(1);
    expect(closedFirst.onshow).toHaveBeenCalledTimes(1);
  });

  it('releases a silently throttled show at the dismissal deadline', async () => {
    vi.useFakeTimers();
    const { notify, deliver } = await loadDocument();
    const created = notify('Throttled');
    created.onclose = vi.fn();
    created.onclick = vi.fn();
    const ref = { documentId: documentIdOf(), instanceId: 'n0' };

    vi.advanceTimersByTime(10000);
    deliver({ ...ref, type: 'click' });
    deliver({ ...ref, type: 'close' });
    created.close();

    expect(created.onclose).toHaveBeenCalledTimes(1);
    expect(created.onclick).not.toHaveBeenCalled();
    expect(sentRefs('notificationClose')).toEqual([ref]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('delegates permission to the native Notification', async () => {
    const { notify } = await loadDocument();

    expect(window.Notification.permission).toBe('default');
    window.Notification.requestPermission();

    expect(StubNativeNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(notify('Alice')).toBeInstanceOf(window.Notification);
  });
});
