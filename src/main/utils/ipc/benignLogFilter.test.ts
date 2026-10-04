/**
 * Unit tests for benignLogFilter — suppresses known-benign console noise.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import log from 'electron-log';
import {
  SECRET_AUTH_URL,
  clearSpies,
  expectNoSentinels,
  messagesAt,
  spiesOf,
} from '../../../../tests/mocks/logCapture';
import {
  isBenignRendererConsoleMessage,
  isBenignSubframeLoadFailure,
  isBenignElectronUrlWarning,
  installBenignWarningFilter,
} from './benignLogFilter';

describe('benignLogFilter', () => {
  describe('isBenignRendererConsoleMessage', () => {
    it('filters Electron Security Warning (Disabled webSecurity)', () => {
      expect(
        isBenignRendererConsoleMessage(
          'Electron Security Warning (Disabled webSecurity) some text',
          ''
        )
      ).toBe(true);
    });

    it('filters Deprecated API for given entry type', () => {
      expect(isBenignRendererConsoleMessage('Deprecated API for given entry type.', '')).toBe(true);
    });

    it('filters WARNING! console self-XSS messages', () => {
      expect(isBenignRendererConsoleMessage('WARNING! Be careful.', '')).toBe(true);
      expect(
        isBenignRendererConsoleMessage(
          'Using this console may allow attackers to impersonate you',
          ''
        )
      ).toBe(true);
    });

    it('filters invalid X-Frame-Options header warnings', () => {
      const msg =
        "Invalid 'X-Frame-Options' header encountered when loading 'https://foo.com': " +
        "'ALLOW-FROM https://bar.com' is not a recognized directive.";
      expect(isBenignRendererConsoleMessage(msg, '')).toBe(true);
    });

    it('filters sandbox escape warning from studio.workspace.google.com', () => {
      const msg =
        'An iframe which has both allow-scripts and allow-same-origin for its sandbox attribute can escape its sandboxing.';
      expect(isBenignRendererConsoleMessage(msg, 'https://studio.workspace.google.com/page')).toBe(
        true
      );
    });

    it('does NOT filter sandbox escape warning from other sources', () => {
      const msg =
        'An iframe which has both allow-scripts and allow-same-origin for its sandbox attribute can escape its sandboxing.';
      expect(isBenignRendererConsoleMessage(msg, 'https://evil.com/page')).toBe(false);
    });

    it('filters CSP frame-ancestors violation for accounts.google.com', () => {
      const msg =
        "Framing 'https://accounts.google.com/path' violates the following Content Security Policy directive: frame-ancestors 'self'";
      expect(isBenignRendererConsoleMessage(msg, '')).toBe(true);
    });

    it('filters CSP frame-ancestors violation for ogs.google.com', () => {
      const msg =
        "Framing 'https://ogs.google.com/widget' violates the following report-only Content Security Policy directive: frame-ancestors 'none'";
      expect(isBenignRendererConsoleMessage(msg, '')).toBe(true);
    });

    it('does NOT filter CSP violation for unknown hosts', () => {
      const msg =
        "Framing 'https://evil.example.com/page' violates the following Content Security Policy directive: frame-ancestors 'none'";
      expect(isBenignRendererConsoleMessage(msg, '')).toBe(false);
    });

    it('does NOT filter CSP violation with malformed URL', () => {
      const msg =
        "Framing 'not-a-url' violates the following Content Security Policy directive: frame-ancestors 'none'";
      expect(isBenignRendererConsoleMessage(msg, '')).toBe(false);
    });

    it('returns false for unrecognized messages', () => {
      expect(isBenignRendererConsoleMessage('Hello world', '')).toBe(false);
    });
  });

  describe('isBenignSubframeLoadFailure', () => {
    it('returns true for error code -27 on benign host subframe', () => {
      expect(isBenignSubframeLoadFailure(-27, 'https://accounts.google.com/login', false)).toBe(
        true
      );
    });

    it('returns true for ogs.google.com subframe', () => {
      expect(isBenignSubframeLoadFailure(-27, 'https://ogs.google.com/widget', false)).toBe(true);
    });

    it('returns false for main frame even with benign host', () => {
      expect(isBenignSubframeLoadFailure(-27, 'https://accounts.google.com/login', true)).toBe(
        false
      );
    });

    it('returns false for non -27 error code', () => {
      expect(isBenignSubframeLoadFailure(-3, 'https://accounts.google.com/login', false)).toBe(
        false
      );
    });

    it('returns false for unknown host', () => {
      expect(isBenignSubframeLoadFailure(-27, 'https://evil.com/page', false)).toBe(false);
    });

    it('returns false for malformed URL', () => {
      expect(isBenignSubframeLoadFailure(-27, 'not-a-url', false)).toBe(false);
    });
  });

  describe('isBenignElectronUrlWarning', () => {
    it('returns true for ERR_BLOCKED_BY_RESPONSE on benign host', () => {
      expect(
        isBenignElectronUrlWarning(
          'Failed to load URL: https://accounts.google.com/page with error: ERR_BLOCKED_BY_RESPONSE'
        )
      ).toBe(true);
    });

    it('returns true for ogs.google.com', () => {
      expect(
        isBenignElectronUrlWarning(
          'Failed to load URL: https://ogs.google.com/widget with error: ERR_BLOCKED_BY_RESPONSE'
        )
      ).toBe(true);
    });

    it('returns false for unknown host', () => {
      expect(
        isBenignElectronUrlWarning(
          'Failed to load URL: https://evil.com/page with error: ERR_BLOCKED_BY_RESPONSE'
        )
      ).toBe(false);
    });

    it('returns false for unrelated warning message', () => {
      expect(isBenignElectronUrlWarning('Some unrelated warning')).toBe(false);
    });

    it('returns false for malformed URL in warning', () => {
      expect(
        isBenignElectronUrlWarning(
          'Failed to load URL: not-a-url with error: ERR_BLOCKED_BY_RESPONSE'
        )
      ).toBe(false);
    });
  });

  describe('installBenignWarningFilter', () => {
    let warningListeners: ((warning: Error) => void)[];
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warningListeners = [];
      vi.spyOn(process, 'on').mockImplementation(((
        event: string,
        listener: (warning: Error) => void
      ) => {
        if (event === 'warning') warningListeners.push(listener);
        return process;
      }) as typeof process.on);
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    it('suppresses benign Electron URL warnings', () => {
      installBenignWarningFilter();
      expect(warningListeners).toHaveLength(1);

      const warning = new Error(
        'Failed to load URL: https://accounts.google.com/page with error: ERR_BLOCKED_BY_RESPONSE'
      );
      warning.name = 'Warning';
      warningListeners[0]!(warning);

      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it('logs a suppressed benign warning without the URL it carries', () => {
      const spies = spiesOf(log);
      clearSpies(spies);
      installBenignWarningFilter();

      const warning = new Error(
        `Failed to load URL: ${SECRET_AUTH_URL} with error: ERR_BLOCKED_BY_RESPONSE\n    at P2_PATH`
      );
      warning.name = 'Warning';
      warningListeners[0]!(warning);

      expect(messagesAt(spies, 'debug')).toEqual(['[Load] Suppressed Electron process warning']);
      expectNoSentinels(spies);
    });

    it('re-prints non-benign warnings to stderr', () => {
      installBenignWarningFilter();

      const warning = new Error('Something unexpected happened');
      warning.name = 'DeprecationWarning';
      warningListeners[0]!(warning);

      expect(stderrSpy).toHaveBeenCalledWith('DeprecationWarning: Something unexpected happened\n');
    });
  });
});
