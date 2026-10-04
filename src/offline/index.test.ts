// @vitest-environment jsdom

/**
 * Offline page script: restore retry UI after failed checks without reload.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('offline page recovery UI', () => {
  let btn: HTMLButtonElement & { disabled: boolean; innerText: string; click: () => void };

  beforeEach(async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="retry-btn">Retry</button>';
    btn = document.getElementById('retry-btn') as typeof btn;
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
    vi.advanceTimersByTime(100 * 60_000);
    expect(dispatch).toHaveBeenCalledTimes(100);
    vi.advanceTimersByTime(10 * 60_000);
    expect(dispatch).toHaveBeenCalledTimes(100);
    dispatch.mockRestore();
  });

  it('keeps the automatic budget independent of manual clicks', () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    for (let i = 0; i < 100; i++) {
      window.dispatchEvent(new Event('app:onlineCheckFailed'));
      btn.click();
      vi.advanceTimersByTime(60_000);
    }
    expect(
      dispatch.mock.calls.filter(([event]) => event.type === 'app:checkIfOnline')
    ).toHaveLength(200);
    dispatch.mockRestore();
  });

  it('allows a manual check after the automatic budget is exhausted', () => {
    vi.advanceTimersByTime(110 * 60_000);
    window.dispatchEvent(new Event('app:onlineCheckFailed'));
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    btn.click();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(true);
    expect(btn.innerText).toBe('Checking...');
    window.dispatchEvent(new Event('app:onlineCheckFailed'));
    expect(btn.disabled).toBe(false);
    expect(btn.innerText).toBe('Retry');
    dispatch.mockRestore();
  });

  it('disables button while checking and re-enables on app:onlineCheckFailed', () => {
    btn.click();
    expect(btn.disabled).toBe(true);
    expect(btn.innerText).toBe('Checking...');

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
      expect(btn.disabled).toBe(true);
      window.dispatchEvent(new Event('app:onlineCheckFailed'));
      expect(btn.disabled).toBe(false);
      expect(btn.innerText).toBe('Retry');
    }
  });
});
