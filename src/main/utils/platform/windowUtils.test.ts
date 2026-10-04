/**
 * Unit tests for windowUtils — merged coverage for:
 *   - getWindowDefaults (store-backed window configuration defaults)
 *   - attachEventLogging (lifecycle event debug logging)
 *   - attachHealthMonitoring (error/crash/navigation logging)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGet } = vi.hoisted(() => ({
  mockGet: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  default: {
    get: (...args: unknown[]) => mockGet(...args),
  },
}));

vi.mock('../lifecycle/logger.js', () => ({
  logger: {
    window: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

vi.mock('../ipc/benignLogFilter.js', () => ({
  isBenignRendererConsoleMessage: vi.fn().mockReturnValue(false),
  isBenignSubframeLoadFailure: vi.fn().mockReturnValue(false),
}));

import {
  getWindowDefaults,
  attachEventLogging,
  attachHealthMonitoring,
  type WindowDefaults,
} from './windowUtils';
import { logger } from '../lifecycle/logger';
import {
  SECRET_AUTH_URL,
  SECRET_CHAT_URL,
  clearSpies,
  expectNoSentinels,
  messagesAt,
  spiesOf,
} from '../../../../tests/mocks/logCapture';
import {
  isBenignRendererConsoleMessage,
  isBenignSubframeLoadFailure,
} from '../ipc/benignLogFilter';

// ---------------------------------------------------------------------------
// windowDefaults
// ---------------------------------------------------------------------------

describe('windowDefaults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getWindowDefaults', () => {
    it('returns all false when store has default values', () => {
      mockGet.mockReturnValue(false);

      const result = getWindowDefaults();

      expect(result).toEqual({
        hideMenuBar: false,
        startHidden: false,
        disableSpellChecker: false,
      });
    });

    it('returns all true when store has all options enabled', () => {
      mockGet.mockReturnValue(true);

      const result = getWindowDefaults();

      expect(result).toEqual({
        hideMenuBar: true,
        startHidden: true,
        disableSpellChecker: true,
      });
    });

    it('reads hideMenuBar from store with correct key', () => {
      mockGet.mockImplementation((key: string) => key === 'app.hideMenuBar');

      const result = getWindowDefaults();

      expect(result.hideMenuBar).toBe(true);
      expect(result.startHidden).toBe(false);
      expect(result.disableSpellChecker).toBe(false);
    });

    it('reads startHidden from store with correct key', () => {
      mockGet.mockImplementation((key: string) => key === 'app.startHidden');

      const result = getWindowDefaults();

      expect(result.hideMenuBar).toBe(false);
      expect(result.startHidden).toBe(true);
      expect(result.disableSpellChecker).toBe(false);
    });

    it('reads disableSpellChecker from store with correct key', () => {
      mockGet.mockImplementation((key: string) => key === 'app.disableSpellChecker');

      const result = getWindowDefaults();

      expect(result.hideMenuBar).toBe(false);
      expect(result.startHidden).toBe(false);
      expect(result.disableSpellChecker).toBe(true);
    });

    it('calls store.get exactly 3 times', () => {
      mockGet.mockReturnValue(false);

      getWindowDefaults();

      expect(mockGet).toHaveBeenCalledTimes(3);
    });

    it('calls store.get with correct keys', () => {
      mockGet.mockReturnValue(false);

      getWindowDefaults();

      expect(mockGet).toHaveBeenCalledWith('app.hideMenuBar');
      expect(mockGet).toHaveBeenCalledWith('app.startHidden');
      expect(mockGet).toHaveBeenCalledWith('app.disableSpellChecker');
    });

    it('returns a plain object with correct shape', () => {
      mockGet.mockReturnValue(false);

      const result = getWindowDefaults();

      expect(Object.keys(result)).toHaveLength(3);
      expect(result).toHaveProperty('hideMenuBar');
      expect(result).toHaveProperty('startHidden');
      expect(result).toHaveProperty('disableSpellChecker');
    });

    it('returns correct types for each property', () => {
      mockGet.mockReturnValue(true);

      const result: WindowDefaults = getWindowDefaults();

      expect(typeof result.hideMenuBar).toBe('boolean');
      expect(typeof result.startHidden).toBe('boolean');
      expect(typeof result.disableSpellChecker).toBe('boolean');
    });

    it('returns fresh object on each call (no caching)', () => {
      mockGet.mockReturnValue(false);

      const first = getWindowDefaults();
      const second = getWindowDefaults();

      expect(first).not.toBe(second);
      expect(first).toEqual(second);
    });

    it('reflects store changes between calls', () => {
      mockGet.mockReturnValue(false);
      const first = getWindowDefaults();

      mockGet.mockReturnValue(true);
      const second = getWindowDefaults();

      expect(first.hideMenuBar).toBe(false);
      expect(second.hideMenuBar).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// windowEventLogger
// ---------------------------------------------------------------------------

function createMockEventWindow() {
  const handlers = new Map<string, (() => void)[]>();
  return {
    on: vi.fn((event: string, handler: () => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    isVisible: vi.fn().mockReturnValue(true),
    isFocused: vi.fn().mockReturnValue(false),
    _fire(event: string) {
      for (const h of handlers.get(event) ?? []) h();
    },
  };
}

describe('windowEventLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers handlers for all six lifecycle events', () => {
    const win = createMockEventWindow();
    attachEventLogging(win as never);

    const registered = win.on.mock.calls.map((c: [string]) => c[0]);
    for (const event of ['show', 'hide', 'focus', 'blur', 'minimize', 'restore']) {
      expect(registered).toContain(event);
    }
  });

  it('logs debug with visible/focused state on each event', () => {
    const win = createMockEventWindow();
    attachEventLogging(win as never);

    win.isVisible.mockReturnValue(true);
    win.isFocused.mockReturnValue(false);
    win._fire('show');

    expect(logger.window.debug).toHaveBeenCalledWith('show visible=true focused=false');
  });

  it('reflects current state at the time of the event', () => {
    const win = createMockEventWindow();
    attachEventLogging(win as never);

    win.isVisible.mockReturnValue(false);
    win.isFocused.mockReturnValue(false);
    win._fire('minimize');

    expect(logger.window.debug).toHaveBeenCalledWith('minimize visible=false focused=false');
  });

  it('logs each event independently', () => {
    const win = createMockEventWindow();
    attachEventLogging(win as never);

    win._fire('focus');
    win._fire('blur');
    win._fire('restore');

    expect(logger.window.debug).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// windowHealthMonitor
// ---------------------------------------------------------------------------

type Handler = (...args: unknown[]) => void;

function createMockHealthWindow() {
  const wcHandlers = new Map<string, Handler>();
  return {
    webContents: {
      on: vi.fn((event: string, handler: Handler) => {
        wcHandlers.set(event, handler);
      }),
      getURL: vi.fn().mockReturnValue('https://chat.google.com'),
      off: vi.fn(),
      removeListener: vi.fn(),
      removeAllListeners: vi.fn(),
    },
    _fireWc(event: string, ...args: unknown[]) {
      wcHandlers.get(event)?.(...args);
    },
  };
}

describe('windowHealthMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers all expected webContents event handlers', () => {
    const win = createMockHealthWindow();
    attachHealthMonitoring(win as never);

    const registered = (win.webContents.on as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: [string]) => c[0]
    );
    for (const event of [
      'console-message',
      'did-fail-load',
      'did-finish-load',
      'did-navigate',
      'render-process-gone',
      'unresponsive',
      'responsive',
    ]) {
      expect(registered).toContain(event);
    }
  });

  describe('console-message', () => {
    it('suppresses benign messages at debug level', () => {
      vi.mocked(isBenignRendererConsoleMessage).mockReturnValue(true);
      const win = createMockHealthWindow();
      attachHealthMonitoring(win as never);

      win._fireWc('console-message', {
        message: 'benign warning',
        sourceId: 'source.js',
        lineNumber: 1,
        level: 0,
      });

      expect(logger.window.debug).toHaveBeenCalledWith(
        expect.stringContaining('[Renderer:suppressed]')
      );
      expect(logger.window.info).not.toHaveBeenCalled();
    });

    it('logs non-benign messages at info level', () => {
      vi.mocked(isBenignRendererConsoleMessage).mockReturnValue(false);
      const win = createMockHealthWindow();
      attachHealthMonitoring(win as never);

      win._fireWc('console-message', {
        message: 'real error',
        sourceId: 'app.js',
        lineNumber: 42,
        level: 2,
      });

      expect(logger.window.info).toHaveBeenCalledWith(expect.stringContaining('[Renderer:2]'));
    });
  });

  describe('did-fail-load', () => {
    it('suppresses benign subframe failures at debug level', () => {
      vi.mocked(isBenignSubframeLoadFailure).mockReturnValue(true);
      const win = createMockHealthWindow();
      attachHealthMonitoring(win as never);

      win._fireWc('did-fail-load', {}, -27, 'ERR_BLOCKED', 'https://sub.google.com', false);

      expect(logger.window.debug).toHaveBeenCalledWith(
        expect.stringContaining('Suppressed expected subframe failure')
      );
      expect(logger.window.error).not.toHaveBeenCalled();
    });

    it('logs real failures at error level', () => {
      vi.mocked(isBenignSubframeLoadFailure).mockReturnValue(false);
      const win = createMockHealthWindow();
      attachHealthMonitoring(win as never);

      win._fireWc('did-fail-load', {}, -102, 'ERR_CONN_REFUSED', 'https://chat.google.com', true);

      expect(logger.window.error).toHaveBeenCalledWith(expect.stringContaining('(main frame)'));
    });

    it('labels subframe failures correctly', () => {
      vi.mocked(isBenignSubframeLoadFailure).mockReturnValue(false);
      const win = createMockHealthWindow();
      attachHealthMonitoring(win as never);

      win._fireWc('did-fail-load', {}, -102, 'ERR_CONN_REFUSED', 'https://sub.google.com', false);

      expect(logger.window.error).toHaveBeenCalledWith(expect.stringContaining('(subframe)'));
    });
  });

  it('logs did-finish-load with current URL', () => {
    const win = createMockHealthWindow();
    attachHealthMonitoring(win as never);

    win._fireWc('did-finish-load');

    expect(logger.window.info).toHaveBeenCalledWith(
      '[Load] did-finish-load: https://chat.google.com'
    );
  });

  it('logs did-navigate with URL and HTTP code', () => {
    const win = createMockHealthWindow();
    attachHealthMonitoring(win as never);

    win._fireWc('did-navigate', {}, 'https://chat.google.com/u/0', 200);

    expect(logger.window.info).toHaveBeenCalledWith(
      '[Nav] did-navigate: https://chat.google.com (HTTP 200)'
    );
  });

  it('logs render-process-gone at error level', () => {
    const win = createMockHealthWindow();
    attachHealthMonitoring(win as never);

    win._fireWc('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });

    expect(logger.window.error).toHaveBeenCalledWith(
      '[Renderer] render-process-gone reason=crashed exitCode=1'
    );
  });

  it('logs unresponsive at warn level', () => {
    const win = createMockHealthWindow();
    attachHealthMonitoring(win as never);

    win._fireWc('unresponsive');

    expect(logger.window.warn).toHaveBeenCalledWith('[Renderer] unresponsive');
  });

  it('logs responsive at info level', () => {
    const win = createMockHealthWindow();
    attachHealthMonitoring(win as never);

    win._fireWc('responsive');

    expect(logger.window.info).toHaveBeenCalledWith('[Renderer] responsive');
  });
});

describe('windowHealthMonitor — log redaction', () => {
  const spies = spiesOf(logger.window);
  const PROSE = `Refused to load ${SECRET_AUTH_URL} (see ${SECRET_CHAT_URL})`;

  beforeEach(() => {
    vi.clearAllMocks();
    clearSpies(spies);
  });

  it('attaches the same seven handlers and never detaches any', () => {
    const win = createMockHealthWindow();
    attachHealthMonitoring(win as never);

    expect(win.webContents.on.mock.calls.map(([event]) => event)).toEqual([
      'console-message',
      'did-fail-load',
      'did-finish-load',
      'did-navigate',
      'render-process-gone',
      'unresponsive',
      'responsive',
    ]);
    expect(win.webContents.off).not.toHaveBeenCalled();
    expect(win.webContents.removeListener).not.toHaveBeenCalled();
    expect(win.webContents.removeAllListeners).not.toHaveBeenCalled();
  });

  it('logs suppressed renderer console text without it, filtering on the original input', () => {
    vi.mocked(isBenignRendererConsoleMessage).mockReturnValue(true);
    const win = createMockHealthWindow();
    attachHealthMonitoring(win as never);

    win._fireWc('console-message', {
      message: PROSE,
      sourceId: SECRET_AUTH_URL,
      lineNumber: 7,
      level: 2,
    });

    expect(isBenignRendererConsoleMessage).toHaveBeenCalledExactlyOnceWith(PROSE, SECRET_AUTH_URL);
    expect(messagesAt(spies, 'debug')).toEqual(['[Renderer:suppressed] [redacted]']);
    expect(spies.info).not.toHaveBeenCalled();
    expectNoSentinels(spies);
  });

  it('logs normal renderer console text without it, keeping the level', () => {
    vi.mocked(isBenignRendererConsoleMessage).mockReturnValue(false);
    const win = createMockHealthWindow();
    attachHealthMonitoring(win as never);

    win._fireWc('console-message', {
      message: PROSE,
      sourceId: SECRET_AUTH_URL,
      lineNumber: 7,
      level: 2,
    });

    expect(isBenignRendererConsoleMessage).toHaveBeenCalledExactlyOnceWith(PROSE, SECRET_AUTH_URL);
    expect(messagesAt(spies, 'info')).toEqual(['[Renderer:2] [redacted]']);
    expectNoSentinels(spies);
  });

  it('logs a suppressed subframe failure with host only, filtering on the original URL', () => {
    vi.mocked(isBenignSubframeLoadFailure).mockReturnValue(true);
    const win = createMockHealthWindow();
    attachHealthMonitoring(win as never);

    win._fireWc('did-fail-load', {}, -27, PROSE, SECRET_AUTH_URL, false);

    expect(isBenignSubframeLoadFailure).toHaveBeenCalledExactlyOnceWith(
      -27,
      SECRET_AUTH_URL,
      false
    );
    expect(messagesAt(spies, 'debug')).toEqual([
      '[Load] Suppressed expected subframe failure (-27) - https://accounts.google.com',
    ]);
    expect(spies.error).not.toHaveBeenCalled();
    expectNoSentinels(spies);
  });

  it.each([
    [true, '(main frame)'],
    [false, '(subframe)'],
  ])('logs a failed load (isMainFrame=%s) with host only', (isMainFrame, label) => {
    vi.mocked(isBenignSubframeLoadFailure).mockReturnValue(false);
    const win = createMockHealthWindow();
    attachHealthMonitoring(win as never);

    win._fireWc('did-fail-load', {}, -102, PROSE, SECRET_AUTH_URL, isMainFrame);

    expect(messagesAt(spies, 'error')).toEqual([
      `[Load] FAILED ${label} (-102) — https://accounts.google.com`,
    ]);
    expect(spies.debug).not.toHaveBeenCalled();
    expectNoSentinels(spies);
  });

  it('fails closed for an unparseable failed-load URL', () => {
    vi.mocked(isBenignSubframeLoadFailure).mockReturnValue(false);
    const win = createMockHealthWindow();
    attachHealthMonitoring(win as never);

    win._fireWc('did-fail-load', {}, -2, PROSE, 'not a url P2_PATH?P2_QUERY', true);

    expect(messagesAt(spies, 'error')).toEqual(['[Load] FAILED (main frame) (-2) — [redacted]']);
    expectNoSentinels(spies);
  });

  it('logs did-finish-load with the origin only', () => {
    const win = createMockHealthWindow();
    win.webContents.getURL.mockReturnValue(SECRET_CHAT_URL);
    attachHealthMonitoring(win as never);

    win._fireWc('did-finish-load');

    expect(messagesAt(spies, 'info')).toEqual(['[Load] did-finish-load: https://chat.google.com']);
    expectNoSentinels(spies);
  });

  it('logs did-navigate with the origin only and the HTTP code', () => {
    const win = createMockHealthWindow();
    attachHealthMonitoring(win as never);

    win._fireWc('did-navigate', {}, SECRET_AUTH_URL, 302);

    expect(messagesAt(spies, 'info')).toEqual([
      '[Nav] did-navigate: https://accounts.google.com (HTTP 302)',
    ]);
    expectNoSentinels(spies);
  });

  it.each([
    ['render-process-gone', [{}, { reason: 'crashed', exitCode: 1 }], 'error'],
    ['unresponsive', [], 'warn'],
    ['responsive', [], 'info'],
  ] as const)('keeps the URL-free %s message', (event, args, level) => {
    const win = createMockHealthWindow();
    attachHealthMonitoring(win as never);

    win._fireWc(event, ...args);

    expect(spies[level]).toHaveBeenCalledTimes(1);
    expectNoSentinels(spies);
  });
});
