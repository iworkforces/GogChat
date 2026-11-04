import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asAccountIndex } from '../../../shared/types/branded.js';

const state = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock('../../config.js', () => ({ configGet: () => state.values }));

import { isAccountNotificationMuted } from './accountNotificationMute.js';

describe('account notification mute deadlines', () => {
  beforeEach(() => {
    state.values = {};
  });

  it.each([undefined, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '2000', 999, 1000])(
    'admits a missing, invalid or expired deadline %s',
    (deadline) => {
      state.values = { '7': deadline, '0': 2000 };
      expect(isAccountNotificationMuted(asAccountIndex(7), 1000)).toBe(false);
    }
  );

  it('compares the stored absolute deadline with the supplied clock on every call', () => {
    state.values = { '7': 2000 };
    expect(isAccountNotificationMuted(asAccountIndex(7), 1999)).toBe(true);
    expect(isAccountNotificationMuted(asAccountIndex(7), 2000)).toBe(false);
    expect(isAccountNotificationMuted(asAccountIndex(7), 2001)).toBe(false);
    expect(isAccountNotificationMuted(asAccountIndex(7), 1000)).toBe(true);
    expect(isAccountNotificationMuted(asAccountIndex(0), 1000)).toBe(false);
  });
});
