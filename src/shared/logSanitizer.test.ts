import { describe, expect, it } from 'vitest';

import { sanitizeLogError, sanitizeLogUrl } from './logSanitizer.js';

const REDACTED = '[redacted]';

describe('sanitizeLogUrl', () => {
  it.each([
    ['HTTPS://user:password@Example.COM:8443/private?q=secret#secret', 'https://example.com'],
    ['https://accounts.google.com@evil.example/private', 'https://evil.example'],
    ['https://bücher.example/private', 'https://xn--bcher-kva.example'],
    ['http://[2001:db8::1]:8080/private', 'http://[2001:db8::1]'],
    ['https://chat.google.com/u/0/?authuser=1#P2_FRAGMENT', 'https://chat.google.com'],
    [
      'https://accounts.google.com/signin?continue=https%3A%2F%2Fchat.google.com%2FP2_CONTINUE',
      'https://accounts.google.com',
    ],
    ['hTTp://MiXeD.Example/', 'http://mixed.example'],
  ])('keeps only scheme and host of %s', (input, expected) => {
    expect(sanitizeLogUrl(input)).toBe(expected);
  });

  it.each([
    'gogchat://open/P2_PATH',
    'file:///etc/passwd',
    'about:blank',
    'javascript:alert(1)',
    'data:text/html,P2_QUERY',
    'blob:https://chat.google.com/uuid',
    'mailto:a@b.example',
    '/relative/P2_PATH',
    '//chat.google.com/P2_PATH',
    '',
    'https://',
    'https://[::1/P2_PATH',
    'not a url P2_QUERY',
    'P2_USERINFO',
    ' https://chat.google.com/',
    'https://chat.google.com/ P2_PATH',
    'https://chat.google.com/\nP2_PATH',
    'https://chat.google.com/\rP2_PATH',
    'https://chat.google.com/\u0000P2_PATH',
    'https://chat.google.com/\u007fP2_PATH',
    'https://chat.google.com/\u0085P2_PATH',
    'https://chat.google.com/\u00a0P2_PATH',
    'https://chat.google.com/\u2003P2_PATH',
    'https://chat.google.com/\u2028P2_PATH',
    'https://chat.google.com\\P2_PATH',
    `https://example.com/${'a'.repeat(2049)}`,
  ])('fails closed for %j', (input) => {
    expect(sanitizeLogUrl(input)).toBe(REDACTED);
  });

  it('accepts exactly 2048 code units and rejects 2049', () => {
    const prefix = 'https://example.com/';
    expect(sanitizeLogUrl(prefix + 'a'.repeat(2048 - prefix.length))).toBe('https://example.com');
    expect(sanitizeLogUrl(prefix + 'a'.repeat(2049 - prefix.length))).toBe(REDACTED);
  });

  it('never coerces non-string inputs', () => {
    const hostile = {
      toString: (): string => {
        throw new Error('P2_QUERY coerced');
      },
    };
    for (const input of [
      null,
      undefined,
      0,
      42,
      true,
      Symbol('https://example.com'),
      new String('https://example.com/'),
      new globalThis.URL('https://example.com/P2_PATH'),
      {},
      [],
      hostile,
    ]) {
      expect(sanitizeLogUrl(input)).toBe(REDACTED);
    }
  });
});

describe('sanitizeLogError', () => {
  const expectClosed = (result: Error): void => {
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe(REDACTED);
    expect(result.stack).toBe(REDACTED);
    expect(result.cause).toBeUndefined();
    expect(Object.keys(result)).toEqual([]);
  };

  it('returns a fresh fixed Error without inspecting the input', () => {
    const input = new Error('https://u:P2_USERINFO@example.com/P2_PATH?q=P2_QUERY#P2_FRAGMENT');
    input.stack = `Error: P2_PATH\n at https://example.com/P2_CONTINUE`;
    const before = { message: input.message, stack: input.stack };
    const result = sanitizeLogError(input);
    expectClosed(result);
    expect(result).not.toBe(input);
    expect({ message: input.message, stack: input.stack }).toEqual(before);
  });

  it('drops secrets carried in cause, aggregate members and custom properties', () => {
    const input = Object.assign(new Error('boom', { cause: new Error('P2_QUERY') }), {
      url: 'https://example.com/P2_PATH',
      code: 'P2_USERINFO',
      errno: -3,
      name: 'P2_FRAGMENT',
      toJSON: () => ({ secret: 'P2_CONTINUE' }),
    });
    const aggregate = new AggregateError([input, new Error('P2_PATH')], 'P2_QUERY');
    for (const value of [input, aggregate]) {
      const result = sanitizeLogError(value);
      expectClosed(result);
      expect(result.name).toBe('Error');
      expect('errors' in result).toBe(false);
      expect(JSON.stringify(result)).not.toContain('P2_');
    }
  });

  it('handles cyclic causes and hostile getters without reading them', () => {
    const cyclic = new Error('P2_QUERY');
    cyclic.cause = cyclic;
    const hostile = {
      get message(): string {
        throw new Error('getter read');
      },
      get stack(): string {
        throw new Error('getter read');
      },
    };
    expectClosed(sanitizeLogError(cyclic));
    expectClosed(sanitizeLogError(hostile));
  });

  it.each([null, undefined, 'https://x.example/P2_PATH', 42, Symbol('s'), {}, []])(
    'wraps non-Error throw %#',
    (value) => {
      expectClosed(sanitizeLogError(value));
    }
  );
});
