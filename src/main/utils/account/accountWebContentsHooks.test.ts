/**
 * Unit tests for multi-account WebContents hooks (KD13).
 */
vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { describe, it, expect, beforeEach, vi } from 'vitest';
import log from 'electron-log';
import {
  clearSpies,
  expectNoSentinels,
  makeSecretError,
  messagesAt,
  spiesOf,
} from '../../../../tests/mocks/logCapture';
import { asAccountIndex } from '../../../shared/types/branded.js';
import {
  clearAccountWebContentsHooksForTests,
  notifyAccountWebContentsCreated,
  notifyAccountWebContentsDestroyed,
  notifyAccountRemoved,
  onAccountRemoved,
  onAccountWebContentsCreated,
  setAccountWebContentsHooksManager,
} from './accountWebContentsHooks.js';

describe('accountWebContentsHooks', () => {
  beforeEach(() => {
    clearAccountWebContentsHooksForTests();
  });

  it('notifies listeners and runs disposer on destroy', () => {
    const disposer = vi.fn();
    const listener = vi.fn(() => disposer);
    onAccountWebContentsCreated(listener);

    const wc = { id: 1, isDestroyed: () => false } as unknown as Electron.WebContents;
    notifyAccountWebContentsCreated({
      accountIndex: asAccountIndex(1),
      webContents: wc,
      backend: 'browser-window',
    });
    expect(listener).toHaveBeenCalledTimes(1);

    notifyAccountWebContentsDestroyed(asAccountIndex(1));
    expect(disposer).toHaveBeenCalledTimes(1);
  });

  it('backfills existing accounts on subscribe', () => {
    const wc = { id: 2, isDestroyed: () => false } as unknown as Electron.WebContents;
    setAccountWebContentsHooksManager({
      enumerateAccountWebContents: () => [
        {
          accountIndex: asAccountIndex(0),
          webContentsId: 2 as never,
          osProcessId: 1,
          backend: 'web-contents-view' as const,
          webContents: wc,
        },
      ],
    } as never);

    const listener = vi.fn();
    onAccountWebContentsCreated(listener);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ accountIndex: 0, backend: 'web-contents-view' })
    );
  });

  it('replaces previous disposer when re-creating the same account index', () => {
    const d1 = vi.fn();
    const d2 = vi.fn();
    let n = 0;
    onAccountWebContentsCreated(() => {
      n += 1;
      return n === 1 ? d1 : d2;
    });

    const wc = { id: 3, isDestroyed: () => false } as unknown as Electron.WebContents;
    notifyAccountWebContentsCreated({
      accountIndex: asAccountIndex(2),
      webContents: wc,
      backend: 'browser-window',
    });
    notifyAccountWebContentsCreated({
      accountIndex: asAccountIndex(2),
      webContents: wc,
      backend: 'browser-window',
    });
    expect(d1).toHaveBeenCalledTimes(1);
    expect(d2).not.toHaveBeenCalled();
    notifyAccountWebContentsDestroyed(asAccountIndex(2));
    expect(d2).toHaveBeenCalledTimes(1);
  });

  it('destroy for unknown index is a no-op', () => {
    expect(() => notifyAccountWebContentsDestroyed(asAccountIndex(99))).not.toThrow();
  });

  it('does not equate WebContents destruction with permanent account removal', () => {
    const removed = vi.fn();
    const unsubscribe = onAccountRemoved(removed);

    notifyAccountWebContentsDestroyed(asAccountIndex(2));

    expect(removed).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('unsubscribes only the owning permanent-removal listener', () => {
    const owned = vi.fn();
    const external = vi.fn();
    const unsubscribe = onAccountRemoved(owned);
    onAccountRemoved(external);
    unsubscribe();
    unsubscribe();

    notifyAccountRemoved(asAccountIndex(7));

    expect(owned).not.toHaveBeenCalled();
    expect(external).toHaveBeenCalledWith(asAccountIndex(7));
  });

  it('contains a removal-listener failure without skipping later listeners', () => {
    onAccountRemoved(() => {
      throw new Error('removal failed');
    });
    const next = vi.fn();
    onAccountRemoved(next);

    expect(() => notifyAccountRemoved(asAccountIndex(7))).not.toThrow();

    expect(next).toHaveBeenCalledWith(asAccountIndex(7));
  });

  it('clears permanent-removal subscriptions between test sessions', () => {
    const removed = vi.fn();
    onAccountRemoved(removed);
    clearAccountWebContentsHooksForTests();

    notifyAccountRemoved(asAccountIndex(2));

    expect(removed).not.toHaveBeenCalled();
  });
});

describe('accountWebContentsHooks — log redaction', () => {
  const spies = spiesOf(log);
  const wc = { id: 3, isDestroyed: () => false } as unknown as Electron.WebContents;
  const created = {
    accountIndex: asAccountIndex(1),
    webContents: wc,
    backend: 'browser-window' as const,
  };

  beforeEach(() => {
    clearAccountWebContentsHooksForTests();
    clearSpies(spies);
  });

  it('logs a failed backfill without its Error and still subscribes the listener', () => {
    setAccountWebContentsHooksManager({
      enumerateAccountWebContents: () => {
        throw makeSecretError();
      },
    } as never);
    const disposer = vi.fn();
    const listener = vi.fn(() => disposer);

    const unsubscribe = onAccountWebContentsCreated(listener);

    expect(listener).not.toHaveBeenCalled();
    expect(messagesAt(spies, 'warn')).toEqual(['[AccountWebContentsHooks] Backfill failed']);
    expectNoSentinels(spies);

    notifyAccountWebContentsCreated(created);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(disposer).toHaveBeenCalledTimes(1);
  });

  it('logs a failing create listener without its Error, keeping attach/detach behavior', () => {
    const disposer = vi.fn();
    const failing = vi.fn(() => {
      throw makeSecretError();
    });
    const healthy = vi.fn(() => disposer);
    onAccountWebContentsCreated(failing);
    onAccountWebContentsCreated(healthy);

    notifyAccountWebContentsCreated(created);

    expect(failing).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(messagesAt(spies, 'error')).toEqual(['[AccountWebContentsHooks] Listener failed']);
    expectNoSentinels(spies);

    notifyAccountWebContentsDestroyed(asAccountIndex(1));
    notifyAccountWebContentsDestroyed(asAccountIndex(1));
    expect(disposer).toHaveBeenCalledTimes(1);
  });

  it('logs a failing removal listener without its Error and still calls later listeners', () => {
    onAccountRemoved(() => {
      throw makeSecretError();
    });
    const next = vi.fn();
    onAccountRemoved(next);

    notifyAccountRemoved(asAccountIndex(4));

    expect(next).toHaveBeenCalledExactlyOnceWith(asAccountIndex(4));
    expect(messagesAt(spies, 'error')).toEqual([
      '[AccountWebContentsHooks] Removal listener failed',
    ]);
    expectNoSentinels(spies);
  });
});
