// @vitest-environment jsdom

/**
 * Offline page script: restore retry UI after failed checks without reload.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('offline page recovery UI', () => {
  let btn: HTMLButtonElement & { disabled: boolean; innerText: string; click: () => void };
  let status: HTMLElement;

  const fail = (detail?: unknown) => {
    window.dispatchEvent(new window.CustomEvent('app:onlineCheckFailed', { detail }));
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="retry-status"></div><button id="retry-btn">Retry</button>';
    btn = document.getElementById('retry-btn') as typeof btn;
    status = document.getElementById('retry-status') as HTMLElement;
    vi.resetModules();
    await import('./index.js');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('stops automatic checks at exactly 100 dispatches', () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    for (let i = 0; i < 100; i++) {
      vi.advanceTimersByTime(60_000);
      fail();
    }
    expect(
      dispatch.mock.calls.filter(([event]) => event.type === 'app:checkIfOnline')
    ).toHaveLength(100);
    vi.advanceTimersByTime(10 * 60_000);
    expect(
      dispatch.mock.calls.filter(([event]) => event.type === 'app:checkIfOnline')
    ).toHaveLength(100);
    dispatch.mockRestore();
  });

  it('keeps the automatic budget independent of manual clicks', () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    for (let i = 0; i < 100; i++) {
      window.dispatchEvent(new Event('app:onlineCheckFailed'));
      btn.click();
      fail();
      vi.advanceTimersByTime(60_000);
    }
    expect(
      dispatch.mock.calls.filter(([event]) => event.type === 'app:checkIfOnline')
    ).toHaveLength(200);
    dispatch.mockRestore();
  });

  it('allows a manual check after the automatic budget is exhausted', () => {
    for (let i = 0; i < 100; i++) {
      vi.advanceTimersByTime(60_000);
      fail();
    }
    window.dispatchEvent(new Event('app:onlineCheckFailed'));
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    btn.click();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(false);
    expect(btn.innerText).toBe('Cancel');
    window.dispatchEvent(new Event('app:onlineCheckFailed'));
    expect(btn.disabled).toBe(false);
    expect(btn.innerText).toBe('Retry');
    dispatch.mockRestore();
  });

  it('offers cancellation while checking and restores retry on failure', () => {
    btn.click();
    expect(btn.disabled).toBe(false);
    expect(btn.innerText).toBe('Cancel');

    window.dispatchEvent(new Event('app:onlineCheckFailed'));
    expect(btn.disabled).toBe(false);
    expect(btn.innerText).toBe('Retry');
  });

  it('dispatches app:checkIfOnline on click', () => {
    const seen: string[] = [];
    window.addEventListener('app:checkIfOnline', () => {
      seen.push('check');
    });
    btn.click();
    expect(seen).toEqual(['check']);
  });

  it('restores retry after multiple failed checks', () => {
    for (let i = 0; i < 3; i++) {
      btn.click();
      expect(btn.innerText).toBe('Cancel');
      window.dispatchEvent(new Event('app:onlineCheckFailed'));
      expect(btn.disabled).toBe(false);
      expect(btn.innerText).toBe('Retry');
    }
  });

  it('shows distinct retryable feedback for each failure category', () => {
    const messages = new Set<string>();
    for (const detail of [
      { outcome: 'http-error', httpStatus: 503 },
      { outcome: 'network-error' },
      { outcome: 'timeout' },
    ]) {
      btn.click();
      fail(detail);
      expect(btn.disabled).toBe(false);
      expect(btn.innerText).toBe('Retry');
      expect(status.textContent).not.toBe('');
      messages.add(status.textContent ?? '');
    }
    expect(messages.size).toBe(3);
  });

  it('names the HTTP status only for an http-error', () => {
    fail({ outcome: 'http-error', httpStatus: 503 });
    expect(status.textContent).toContain('HTTP 503');
    fail({ outcome: 'network-error' });
    expect(status.textContent).not.toMatch(/\d{3}/);
    fail({ outcome: 'timeout', httpStatus: 503 });
    expect(status.textContent).not.toContain('503');
  });

  it.each([undefined, null, 'timeout', 7, {}, { outcome: 'offline' }, { outcome: 7 }])(
    'falls back to generic feedback for unusable detail %o',
    (detail) => {
      btn.click();
      fail(detail);
      expect(btn.disabled).toBe(false);
      expect(btn.innerText).toBe('Retry');
      expect(status.textContent).toBe(
        'Could not reach GogChat. Retry when your connection improves.'
      );
    }
  );

  it.each([undefined, '503', 503.5, 200, 600, '<b>1</b>'])(
    'omits an unusable http-error status %o and never renders markup',
    (httpStatus) => {
      fail({ outcome: 'http-error', httpStatus });
      expect(status.textContent).toBe('The server responded with an error. Try again shortly.');
      expect(status.children).toHaveLength(0);
    }
  );

  it('clears stale feedback when a manual or automatic check starts', () => {
    fail({ outcome: 'timeout' });
    expect(status.textContent).not.toBe('');
    btn.click();
    expect(status.textContent).toBe('');
    expect(btn.innerText).toBe('Cancel');

    fail({ outcome: 'network-error' });
    expect(status.textContent).not.toBe('');
    vi.advanceTimersByTime(60_000);
    expect(status.textContent).toBe('');
    expect(btn.innerText).toBe('Cancel');
  });

  it('keeps the same document and controls through a failure', () => {
    const marker = document.body.appendChild(document.createElement('i'));
    btn.click();
    fail({ outcome: 'http-error', httpStatus: 500 });
    expect(document.getElementById('retry-btn')).toBe(btn);
    expect(document.getElementById('retry-status')).toBe(status);
    expect(marker.isConnected).toBe(true);
  });

  it('still restores retry when the page has no status element', async () => {
    document.body.innerHTML = '<button id="retry-btn">Retry</button>';
    btn = document.getElementById('retry-btn') as typeof btn;
    vi.resetModules();
    await import('./index.js');
    btn.click();
    expect(btn.innerText).toBe('Cancel');
    fail({ outcome: 'timeout' });
    expect(btn.disabled).toBe(false);
    expect(btn.innerText).toBe('Retry');
  });

  it('cancels only on a click, not on an automatic tick during a pending check', () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const marker = document.body.appendChild(document.createElement('i'));
    btn.click();
    vi.advanceTimersByTime(60_000);
    expect(
      dispatch.mock.calls.filter(([event]) => event.type === 'app:checkIfOnline')
    ).toHaveLength(1);
    expect(
      dispatch.mock.calls.filter(([event]) => event.type === 'app:cancelOnlineCheck')
    ).toHaveLength(0);
    btn.click();
    expect(
      dispatch.mock.calls.filter(([event]) => event.type === 'app:cancelOnlineCheck')
    ).toHaveLength(1);
    expect(btn.innerText).toBe('Retry');
    expect(btn.disabled).toBe(false);
    expect(status.textContent).not.toBe('');
    expect(marker.isConnected).toBe(true);
  });
});
