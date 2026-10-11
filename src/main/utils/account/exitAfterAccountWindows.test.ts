/**
 * Quit and relaunch call app.exit(), which skips before-quit.
 * The helper must read watched windows and flush before the process ends.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  capture: vi.fn(),
  flush: vi.fn(async () => undefined),
  exit: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    exit: h.exit,
  },
}));

vi.mock('./accountWindowsStore.js', () => ({
  captureWatchedAccountWindows: () => {
    h.capture();
  },
  flushAccountWindowsWrites: () => h.flush(),
}));

import { app } from 'electron';
import { exitAppAfterSavingWindows } from './exitAfterAccountWindows.js';

describe('exitAfterAccountWindows', () => {
  afterEach(() => {
    vi.useRealTimers();
    h.capture.mockReset();
    h.flush.mockReset();
    h.flush.mockResolvedValue(undefined);
    h.exit.mockReset();
  });

  it('captures, flushes, then exits', async () => {
    const order: string[] = [];
    h.capture.mockImplementation(() => {
      order.push('capture');
    });
    h.flush.mockImplementation(async () => {
      order.push('flush');
    });
    h.exit.mockImplementation(() => {
      order.push('exit');
    });

    await exitAppAfterSavingWindows();

    expect(order).toEqual(['capture', 'flush', 'exit']);
    expect(app.exit).toHaveBeenCalledOnce();
  });

  it('still exits when the flush rejects', async () => {
    h.flush.mockRejectedValue(new Error('disk full'));
    await exitAppAfterSavingWindows();
    expect(h.capture).toHaveBeenCalledOnce();
    expect(h.exit).toHaveBeenCalledOnce();
  });

  it('exits after 2000ms when the flush never settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    h.flush.mockImplementation(() => new Promise(() => undefined));
    const pending = exitAppAfterSavingWindows();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(h.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(h.capture).toHaveBeenCalledOnce();
    expect(h.exit).toHaveBeenCalledOnce();
  });
});
