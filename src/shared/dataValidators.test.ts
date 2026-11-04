/**
 * Unit tests for data validators (src/shared/dataValidators.ts)
 * SECURITY CRITICAL — XSS prevention, type validation for IPC payloads.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./urlValidators.js', () => ({
  validateFaviconURL: vi.fn((value: unknown) => {
    if (typeof value !== 'string') {
      throw new Error('Favicon URL must be a string');
    }
    return value;
  }),
  validateNotificationIconURL: vi.fn((value: unknown) => {
    if (typeof value !== 'string') {
      throw new Error('Notification icon must be a string');
    }
    return value;
  }),
}));

import {
  validateUnreadCount,
  validateBoolean,
  validateString,
  isSafeObject,
  sanitizeHTML,
  validatePasskeyFailureData,
  validateNotificationData,
  validateNotificationCloseRequest,
  validateNotificationLifecycleEvent,
  validateAttemptId,
  validateOnlineCheckRequest,
  validateOnlineStatusData,
} from './dataValidators.js';
import { BADGE } from './constants.js';
import { validateNotificationIconURL } from './urlValidators.js';

describe('validateUnreadCount', () => {
  it('floors a valid positive number', () => {
    expect(validateUnreadCount(5.7)).toBe(5);
    expect(validateUnreadCount(5)).toBe(5);
  });

  it('returns 0 for zero input', () => {
    expect(validateUnreadCount(0)).toBe(0);
  });

  it('converts a numeric string', () => {
    expect(validateUnreadCount('42')).toBe(42);
  });

  it('throws for negative numbers', () => {
    expect(() => validateUnreadCount(-1)).toThrow('cannot be negative');
  });

  it('throws for NaN', () => {
    expect(() => validateUnreadCount(NaN)).toThrow('not a valid number');
  });

  it('throws for Infinity (exceeds max)', () => {
    // Infinity is > MAX_COUNT so it trips the max-count guard before the finite guard
    expect(() => validateUnreadCount(Infinity)).toThrow();
  });

  it('throws for negative Infinity', () => {
    expect(() => validateUnreadCount(-Infinity)).toThrow('cannot be negative');
  });

  it('throws for non-numeric strings', () => {
    expect(() => validateUnreadCount('abc')).toThrow('not a valid number');
  });

  it('throws for null', () => {
    expect(() => validateUnreadCount(null)).toThrow('must be a number or string');
  });

  it('throws for undefined', () => {
    expect(() => validateUnreadCount(undefined)).toThrow('must be a number or string');
  });

  it('throws for object', () => {
    expect(() => validateUnreadCount({})).toThrow('must be a number or string');
  });

  it('accepts BADGE.MAX_COUNT', () => {
    expect(validateUnreadCount(BADGE.MAX_COUNT)).toBe(BADGE.MAX_COUNT);
  });

  it('throws for values above BADGE.MAX_COUNT', () => {
    expect(() => validateUnreadCount(BADGE.MAX_COUNT + 1)).toThrow('exceeds maximum');
  });
});

describe('validateBoolean', () => {
  it('passes boolean true/false through', () => {
    expect(validateBoolean(true)).toBe(true);
    expect(validateBoolean(false)).toBe(false);
  });

  it('accepts "true"/"false" strings (case-insensitive)', () => {
    expect(validateBoolean('true')).toBe(true);
    expect(validateBoolean('TRUE')).toBe(true);
    expect(validateBoolean('True')).toBe(true);
    expect(validateBoolean('false')).toBe(false);
    expect(validateBoolean('FALSE')).toBe(false);
  });

  it('accepts 1 and 0', () => {
    expect(validateBoolean(1)).toBe(true);
    expect(validateBoolean(0)).toBe(false);
  });

  it('throws for other strings', () => {
    expect(() => validateBoolean('yes')).toThrow('not a valid boolean');
    expect(() => validateBoolean('')).toThrow('not a valid boolean');
  });

  it('throws for other numbers', () => {
    expect(() => validateBoolean(2)).toThrow('not a valid boolean');
    expect(() => validateBoolean(-1)).toThrow('not a valid boolean');
  });

  it('throws for null/undefined/object', () => {
    expect(() => validateBoolean(null)).toThrow('not a valid boolean');
    expect(() => validateBoolean(undefined)).toThrow('not a valid boolean');
    expect(() => validateBoolean({})).toThrow('not a valid boolean');
  });
});

describe('validateString', () => {
  it('returns the string when valid', () => {
    expect(validateString('hello')).toBe('hello');
  });

  it('accepts empty strings', () => {
    expect(validateString('')).toBe('');
  });

  it('accepts a string of exactly maxLength', () => {
    const s = 'a'.repeat(1000);
    expect(validateString(s)).toBe(s);
  });

  it('throws when exceeding default maxLength', () => {
    const s = 'a'.repeat(1001);
    expect(() => validateString(s)).toThrow('exceeds maximum length');
  });

  it('respects custom maxLength', () => {
    expect(validateString('abc', 3)).toBe('abc');
    expect(() => validateString('abcd', 3)).toThrow('exceeds maximum length (3)');
  });

  it('throws for non-string values', () => {
    expect(() => validateString(123)).toThrow('must be a string');
    expect(() => validateString(null)).toThrow('must be a string');
    expect(() => validateString(undefined)).toThrow('must be a string');
    expect(() => validateString({})).toThrow('must be a string');
    expect(() => validateString([])).toThrow('must be a string');
  });
});

describe('isSafeObject', () => {
  it('returns true for plain objects', () => {
    expect(isSafeObject({})).toBe(true);
    expect(isSafeObject({ a: 1, b: 'x' })).toBe(true);
    expect(isSafeObject(Object.create(Object.prototype))).toBe(true);
  });

  it('returns false for null', () => {
    expect(isSafeObject(null)).toBe(false);
  });

  it('returns false for arrays', () => {
    expect(isSafeObject([])).toBe(false);
    expect(isSafeObject([1, 2, 3])).toBe(false);
  });

  it('returns false for Date (wrong prototype)', () => {
    expect(isSafeObject(new Date())).toBe(false);
  });

  it('returns false for class instances', () => {
    class Foo {
      x = 1;
    }
    expect(isSafeObject(new Foo())).toBe(false);
  });

  it('returns false for Map and Set', () => {
    expect(isSafeObject(new Map())).toBe(false);
    expect(isSafeObject(new Set())).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isSafeObject(undefined)).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isSafeObject(42)).toBe(false);
    expect(isSafeObject('str')).toBe(false);
    expect(isSafeObject(true)).toBe(false);
  });

  it('returns false for Object.create(null) (no prototype)', () => {
    expect(isSafeObject(Object.create(null))).toBe(false);
  });
});

describe('sanitizeHTML', () => {
  it('escapes ampersand', () => {
    expect(sanitizeHTML('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than and greater-than', () => {
    expect(sanitizeHTML('<div>')).toBe('&lt;div&gt;');
  });

  it('escapes double quotes', () => {
    expect(sanitizeHTML('say "hi"')).toBe('say &quot;hi&quot;');
  });

  it('escapes single quotes', () => {
    expect(sanitizeHTML("it's")).toBe('it&#x27;s');
  });

  it('escapes forward slashes', () => {
    expect(sanitizeHTML('a/b/c')).toBe('a&#x2F;b&#x2F;c');
  });

  it('escapes all six special chars together', () => {
    expect(sanitizeHTML(`&<>"'/`)).toBe('&amp;&lt;&gt;&quot;&#x27;&#x2F;');
  });

  it('fully escapes a script injection', () => {
    const input = `<script>alert('xss')</script>`;
    const out = sanitizeHTML(input);
    expect(out).not.toContain('<script>');
    expect(out).not.toContain("'");
    expect(out).toBe('&lt;script&gt;alert(&#x27;xss&#x27;)&lt;&#x2F;script&gt;');
  });

  it('fully escapes event handler injections', () => {
    const input = `<img onerror="alert(1)">`;
    const out = sanitizeHTML(input);
    expect(out).not.toContain('<');
    expect(out).not.toContain('"');
    expect(out).toBe('&lt;img onerror=&quot;alert(1)&quot;&gt;');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeHTML('')).toBe('');
  });

  it('leaves text without special chars unchanged', () => {
    expect(sanitizeHTML('hello world 123')).toBe('hello world 123');
  });

  it('escapes multiple occurrences of the same char', () => {
    expect(sanitizeHTML('&&&')).toBe('&amp;&amp;&amp;');
  });
});

describe('validatePasskeyFailureData', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns object with errorType + timestamp for known error', () => {
    const before = Date.now();
    const result = validatePasskeyFailureData('NotAllowedError');
    const after = Date.now();
    expect(result.errorType).toBe('NotAllowedError');
    expect(typeof result.timestamp).toBe('number');
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after);
  });

  it('accepts all whitelisted error types without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const known = [
      'NotAllowedError',
      'NotSupportedError',
      'SecurityError',
      'AbortError',
      'ConstraintError',
      'InvalidStateError',
      'UnknownError',
      'TimeoutError',
    ];
    for (const t of known) {
      const r = validatePasskeyFailureData(t);
      expect(r.errorType).toBe(t);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns on unknown error type but still returns result', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = validatePasskeyFailureData('WeirdCustomError');
    expect(result.errorType).toBe('WeirdCustomError');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toContain('WeirdCustomError');
  });

  it('throws for non-string inputs', () => {
    expect(() => validatePasskeyFailureData(123)).toThrow('must be a string');
    expect(() => validatePasskeyFailureData(null)).toThrow('must be a string');
    expect(() => validatePasskeyFailureData(undefined)).toThrow('must be a string');
    expect(() => validatePasskeyFailureData({})).toThrow('must be a string');
  });

  it('accepts empty string (passes validateString, warns as unknown)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = validatePasskeyFailureData('');
    expect(result.errorType).toBe('');
    expect(warn).toHaveBeenCalled();
  });

  it('throws when string exceeds 100 chars', () => {
    const tooLong = 'a'.repeat(101);
    expect(() => validatePasskeyFailureData(tooLong)).toThrow('exceeds maximum length');
  });
});

describe('validateNotificationData', () => {
  it('retains both lifecycle ids without accepting payload account ownership', () => {
    const input = { title: 'Message', documentId: 'doc-1', instanceId: 'n0', accountIndex: 99 };
    expect(validateNotificationData(input)).toMatchObject({
      title: 'Message',
      documentId: 'doc-1',
      instanceId: 'n0',
    });
    expect(validateNotificationData(input)).not.toHaveProperty('accountIndex');
  });

  it.each([
    { documentId: 'doc-1' },
    { instanceId: 'n0' },
    { documentId: '', instanceId: 'n0' },
    { documentId: 'doc-1', instanceId: '   ' },
    { documentId: 'x'.repeat(129), instanceId: 'n0' },
    { documentId: 'doc-1', instanceId: 1 },
  ])('rejects incomplete or malformed lifecycle ids: %j', (ref) => {
    expect(() => validateNotificationData({ title: 'Message', ...ref })).toThrow();
  });
  beforeEach(() => {
    vi.mocked(validateNotificationIconURL).mockClear();
    vi.mocked(validateNotificationIconURL).mockImplementation((value: unknown) => {
      if (typeof value !== 'string') {
        throw new Error('Notification icon must be a string');
      }
      return value;
    });
  });

  it('returns title + timestamp for minimal valid input', () => {
    const before = Date.now();
    const result = validateNotificationData({ title: 'Hello' });
    const after = Date.now();
    expect(result.title).toBe('Hello');
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after);
    expect(result.body).toBeUndefined();
    expect(result.icon).toBeUndefined();
    expect(result.tag).toBeUndefined();
  });

  it('includes all optional fields when provided', () => {
    const result = validateNotificationData({
      title: 'T',
      body: 'B',
      icon: 'data:image/png;base64,abc',
      tag: 'tag-1',
    });
    expect(result.title).toBe('T');
    expect(result.body).toBe('B');
    expect(result.icon).toBe('data:image/png;base64,abc');
    expect(result.tag).toBe('tag-1');
    expect(validateNotificationIconURL).toHaveBeenCalledWith('data:image/png;base64,abc');
  });

  it('throws for non-object inputs', () => {
    expect(() => validateNotificationData(null)).toThrow('must be a plain object');
    expect(() => validateNotificationData(undefined)).toThrow('must be a plain object');
    expect(() => validateNotificationData('title')).toThrow('must be a plain object');
    expect(() => validateNotificationData(42)).toThrow('must be a plain object');
    expect(() => validateNotificationData([])).toThrow('must be a plain object');
    expect(() => validateNotificationData(new Date())).toThrow('must be a plain object');
  });

  it('throws when title is missing', () => {
    expect(() => validateNotificationData({})).toThrow('must be a string');
  });

  it('throws when title is not a string', () => {
    expect(() => validateNotificationData({ title: 123 })).toThrow('must be a string');
  });

  it('throws when title exceeds 500 chars', () => {
    const longTitle = 'a'.repeat(501);
    expect(() => validateNotificationData({ title: longTitle })).toThrow('exceeds maximum length');
  });

  it('omits body/icon/tag when they are empty string', () => {
    const result = validateNotificationData({
      title: 'T',
      body: '',
      icon: '',
      tag: '',
    });
    expect(result.body).toBeUndefined();
    expect(result.icon).toBeUndefined();
    expect(result.tag).toBeUndefined();
    expect(validateNotificationIconURL).not.toHaveBeenCalled();
  });

  it('omits body/icon/tag when they are null', () => {
    const result = validateNotificationData({
      title: 'T',
      body: null,
      icon: null,
      tag: null,
    });
    expect(result.body).toBeUndefined();
    expect(result.icon).toBeUndefined();
    expect(result.tag).toBeUndefined();
  });

  it('omits body/icon/tag when they are undefined', () => {
    const result = validateNotificationData({
      title: 'T',
      body: undefined,
      icon: undefined,
      tag: undefined,
    });
    expect(result.body).toBeUndefined();
    expect(result.icon).toBeUndefined();
    expect(result.tag).toBeUndefined();
  });

  it('propagates errors from validateNotificationIconURL', () => {
    vi.mocked(validateNotificationIconURL).mockImplementationOnce(() => {
      throw new Error('bad favicon');
    });
    expect(() => validateNotificationData({ title: 'T', icon: 'javascript:alert(1)' })).toThrow(
      'bad favicon'
    );
  });

  it('throws when body is not a string', () => {
    expect(() => validateNotificationData({ title: 'T', body: 123 })).toThrow('must be a string');
  });

  it('throws when body exceeds 5000 chars', () => {
    const longBody = 'b'.repeat(5001);
    expect(() => validateNotificationData({ title: 'T', body: longBody })).toThrow(
      'exceeds maximum length'
    );
  });

  it('throws when tag exceeds 200 chars', () => {
    const longTag = 't'.repeat(201);
    expect(() => validateNotificationData({ title: 'T', tag: longTag })).toThrow(
      'exceeds maximum length'
    );
  });
});

describe('notification lifecycle validation', () => {
  it('retains only the sender-independent instance reference in a close request', () => {
    expect(
      validateNotificationCloseRequest({
        documentId: 'doc-1',
        instanceId: 'n0',
        accountIndex: 9,
        tag: 'room',
      })
    ).toEqual({ documentId: 'doc-1', instanceId: 'n0' });
  });

  it.each(['click', 'close'] as const)('accepts the lifecycle event %s', (type) => {
    const event = { documentId: 'doc-1', instanceId: 'n0', type };
    expect(validateNotificationLifecycleEvent(event)).toEqual(event);
  });

  it.each([null, [], {}, { documentId: 'doc-1' }, { documentId: 'doc-1', instanceId: '' }])(
    'rejects malformed references at both lifecycle boundaries: %j',
    (input) => {
      expect(() => validateNotificationCloseRequest(input)).toThrow();
      expect(() => validateNotificationLifecycleEvent(input)).toThrow();
    }
  );

  it.each(['show', '', undefined, 1])('rejects an unknown event variant: %j', (type) => {
    expect(() =>
      validateNotificationLifecycleEvent({
        documentId: 'doc-1',
        instanceId: 'n0',
        type,
      })
    ).toThrow();
  });
});

describe('validateAttemptId', () => {
  it('accepts a non-empty opaque id', () => {
    expect(validateAttemptId('attempt-1')).toBe('attempt-1');
  });

  it('rejects empty or whitespace-only ids', () => {
    expect(() => validateAttemptId('')).toThrow('attemptId cannot be empty');
    expect(() => validateAttemptId('   ')).toThrow('attemptId cannot be empty');
  });

  it('rejects oversized ids', () => {
    expect(() => validateAttemptId('a'.repeat(129))).toThrow('exceeds maximum length');
  });
});

describe('validateOnlineCheckRequest', () => {
  it('returns the attemptId from a plain object', () => {
    expect(validateOnlineCheckRequest({ attemptId: 'a1' })).toEqual({ attemptId: 'a1' });
  });

  it('rejects non-objects and missing ids', () => {
    expect(() => validateOnlineCheckRequest(undefined)).toThrow('must be a plain object');
    expect(() => validateOnlineCheckRequest({ online: true })).toThrow('must be a string');
  });

  it('preserves valid cancellation and rejects malformed operations and tokens', () => {
    expect(validateOnlineCheckRequest({ operation: 'cancel', attemptId: 'a1' })).toEqual({
      operation: 'cancel',
      attemptId: 'a1',
    });
    expect(validateOnlineCheckRequest({ operation: 'check', attemptId: 'a1' })).toEqual({
      operation: 'check',
      attemptId: 'a1',
    });
    for (const operation of ['invalid', null, 1]) {
      expect(() => validateOnlineCheckRequest({ operation, attemptId: 'a1' })).toThrow();
    }
    for (const attemptId of ['', '  ', 'a'.repeat(129)]) {
      expect(() => validateOnlineCheckRequest({ operation: 'cancel', attemptId })).toThrow();
    }
  });
});

describe('validateOnlineStatusData', () => {
  it.each(['online', 'network-error', 'timeout'] as const)(
    'returns a fresh %s result carrying only attemptId and outcome',
    (outcome) => {
      const input = { attemptId: 'a1', outcome, message: 'ECONNRESET to https://x.test/?t=secret' };
      const result = validateOnlineStatusData(input);
      expect(result).toEqual({ attemptId: 'a1', outcome });
      expect(result).not.toBe(input);
    }
  );

  it.each([300, 404, 503, 599])('keeps the %i status on an http-error result', (httpStatus) => {
    expect(
      validateOnlineStatusData({ attemptId: 'a1', outcome: 'http-error', httpStatus, error: 'x' })
    ).toEqual({ attemptId: 'a1', outcome: 'http-error', httpStatus });
  });

  it.each([undefined, null, '503', 503.5, NaN, Infinity, 0, 100, 204, 299, 600, -1])(
    'rejects http-error with status %s',
    (httpStatus) => {
      expect(() =>
        validateOnlineStatusData({ attemptId: 'a1', outcome: 'http-error', httpStatus })
      ).toThrow('httpStatus must be an integer HTTP error status');
    }
  );

  it.each(['online', 'network-error', 'timeout'])('rejects a status on %s', (outcome) => {
    expect(() => validateOnlineStatusData({ attemptId: 'a1', outcome, httpStatus: 503 })).toThrow(
      'httpStatus is only valid for http-error'
    );
  });

  it.each([undefined, null, true, 'offline', 'ONLINE', 'cancelled', 1, {}])(
    'rejects unknown outcome %s',
    (outcome) => {
      expect(() => validateOnlineStatusData({ attemptId: 'a1', outcome })).toThrow(
        'Unknown online status outcome'
      );
    }
  );

  it('rejects the legacy boolean shape', () => {
    expect(() => validateOnlineStatusData({ attemptId: 'a1', online: true })).toThrow(
      'Unknown online status outcome'
    );
  });

  it.each([undefined, null, '', '   ', 7, 'a'.repeat(129)])('rejects attemptId %s', (attemptId) => {
    expect(() => validateOnlineStatusData({ attemptId, outcome: 'online' })).toThrow();
  });

  it.each([null, undefined, 'online', 1, []])('rejects non-object payload %s', (payload) => {
    expect(() => validateOnlineStatusData(payload)).toThrow('must be a plain object');
  });
});
