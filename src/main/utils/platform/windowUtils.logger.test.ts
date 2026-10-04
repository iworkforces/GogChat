/**
 * Window-health redaction through the REAL ScopedLogger and benign filter: the `[Window]` scope
 * must reach the electron-log level spies and no secret may appear in any argument.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
vi.mock('electron', () => require('../../../../tests/mocks/electron'));
vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config.js', () => ({ default: { get: vi.fn() } }));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import log from 'electron-log';
import { attachHealthMonitoring } from './windowUtils';
import { logger } from '../lifecycle/logger';
import {
  SECRET_AUTH_URL,
  SECRET_CHAT_URL,
  clearSpies,
  expectNoSentinels,
  messagesAt,
  spiesOf,
} from '../../../../tests/mocks/logCapture';

type Handler = (...args: unknown[]) => void;

function makeWindow(currentUrl: string) {
  const handlers = new Map<string, Handler>();
  return {
    webContents: {
      on: vi.fn((event: string, handler: Handler) => {
        handlers.set(event, handler);
      }),
      getURL: vi.fn().mockReturnValue(currentUrl),
    },
    fire: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
  };
}

describe('attachHealthMonitoring with the real [Window] logger', () => {
  const spies = spiesOf(log);
  const PROSE = `Failed ${SECRET_AUTH_URL} then ${SECRET_CHAT_URL}`;

  beforeEach(() => {
    clearSpies(spies);
  });

  it('uses the stable Window scope', () => {
    expect(logger.window).toBeDefined();
    const win = makeWindow(SECRET_CHAT_URL);
    attachHealthMonitoring(win as never);
    win.fire('responsive');
    expect(messagesAt(spies, 'info')).toEqual(['[Window] [Renderer] responsive']);
  });

  it('forwards every redacted health event under the [Window] scope', () => {
    const win = makeWindow(SECRET_CHAT_URL);
    attachHealthMonitoring(win as never);

    // Non-benign console text -> info
    win.fire('console-message', {
      message: PROSE,
      sourceId: SECRET_AUTH_URL,
      lineNumber: 3,
      level: 3,
    });
    // Benign (real filter) console text -> suppressed debug
    win.fire('console-message', {
      message: 'Deprecated API for given entry type. ' + SECRET_AUTH_URL,
      sourceId: SECRET_AUTH_URL,
      lineNumber: 3,
      level: 1,
    });
    // Real failure -> error; benign subframe failure (ERR_BLOCKED_BY_RESPONSE) -> suppressed debug
    win.fire('did-fail-load', {}, -102, PROSE, SECRET_AUTH_URL, true);
    win.fire(
      'did-fail-load',
      {},
      -27,
      PROSE,
      'https://P2_USERINFO@accounts.google.com/P2_PATH',
      false
    );
    win.fire('did-finish-load');
    win.fire('did-navigate', {}, SECRET_AUTH_URL, 200);

    expect(messagesAt(spies, 'info')).toEqual([
      '[Window] [Renderer:3] [redacted]',
      '[Window] [Load] did-finish-load: https://chat.google.com',
      '[Window] [Nav] did-navigate: https://accounts.google.com (HTTP 200)',
    ]);
    expect(messagesAt(spies, 'debug')).toEqual([
      '[Window] [Renderer:suppressed] [redacted]',
      expect.stringMatching(/^\[Window\] \[Load\] Suppressed expected subframe failure \(-27\) - /),
    ]);
    expect(messagesAt(spies, 'error')).toEqual([
      '[Window] [Load] FAILED (main frame) (-102) — https://accounts.google.com',
    ]);
    expectNoSentinels(spies, 6);
  });
});
