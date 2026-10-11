/**
 * Unit tests for input validators
 * Tests all validation functions for security and correctness
 */

import { describe, it, expect, vi } from 'vitest';
import {
  validateUnreadCount,
  validateBoolean,
  validateString,
  sanitizeHTML,
  isSafeObject,
  validatePasskeyFailureData,
  validateNotificationData,
} from './dataValidators';
import {
  validateFaviconURL,
  validateExternalURL,
  validateAppleSystemPreferencesURL,
  isWhitelistedHost,
  validateDeepLinkURL,
  isAuthenticatedChatUrl,
  isGoogleAuthUrl,
} from './urlValidators';
describe('validateUnreadCount', () => {
  it('should accept valid counts within range', () => {
    expect(validateUnreadCount(0)).toBe(0);
    expect(validateUnreadCount(1)).toBe(1);
    expect(validateUnreadCount(50)).toBe(50);
    expect(validateUnreadCount(9999)).toBe(9999);
  });

  it('should accept string numbers and convert to integers', () => {
    expect(validateUnreadCount('42')).toBe(42);
    expect(validateUnreadCount('0')).toBe(0);
    expect(validateUnreadCount('9999')).toBe(9999);
  });

  it('should floor decimal numbers', () => {
    expect(validateUnreadCount(42.7)).toBe(42);
    expect(validateUnreadCount(1.1)).toBe(1);
    expect(validateUnreadCount(99.99)).toBe(99);
  });

  it('should handle very large finite numbers within max', () => {
    expect(validateUnreadCount(9998.9)).toBe(9998);
    expect(validateUnreadCount(5000.5)).toBe(5000);
  });

  it('should reject negative numbers', () => {
    expect(() => validateUnreadCount(-1)).toThrow('Unread count cannot be negative');
    expect(() => validateUnreadCount(-100)).toThrow('Unread count cannot be negative');
  });

  it('should reject numbers above max count', () => {
    expect(() => validateUnreadCount(10000)).toThrow('Unread count exceeds maximum');
    expect(() => validateUnreadCount(99999)).toThrow('Unread count exceeds maximum');
  });

  it('should reject NaN', () => {
    expect(() => validateUnreadCount(NaN)).toThrow('Unread count is not a valid number');
    expect(() => validateUnreadCount('abc')).toThrow('Unread count is not a valid number');
  });

  it('should reject null and undefined', () => {
    expect(() => validateUnreadCount(null)).toThrow('Unread count must be a number or string');
    expect(() => validateUnreadCount(undefined)).toThrow('Unread count must be a number or string');
  });
});

describe('validateFaviconURL', () => {
  it('should accept valid HTTP URLs', () => {
    const url = 'http://example.com/favicon.ico';
    expect(validateFaviconURL(url)).toBe(url);
  });

  it('should accept valid HTTPS URLs', () => {
    const url = 'https://example.com/favicon.ico';
    expect(validateFaviconURL(url)).toBe(url);
  });

  it('should accept data URLs', () => {
    const url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA';
    expect(validateFaviconURL(url)).toBe(url);
  });

  it('should reject URLs with unsafe protocols', () => {
    expect(() => validateFaviconURL('javascript:alert(1)')).toThrow(
      'Favicon URL must use http, https, or data protocol'
    );
    expect(() => validateFaviconURL('file:///etc/passwd')).toThrow(
      'Favicon URL must use http, https, or data protocol'
    );
    expect(() => validateFaviconURL('vbscript:msgbox(1)')).toThrow(
      'Favicon URL must use http, https, or data protocol'
    );
  });

  it('should reject invalid URLs', () => {
    expect(() => validateFaviconURL('not a url')).toThrow('Invalid favicon URL format');
    expect(() => validateFaviconURL('')).toThrow('Favicon URL cannot be empty');
    expect(() => validateFaviconURL('    ')).toThrow('Favicon URL cannot be empty');
  });

  it('should reject non-string inputs', () => {
    expect(() => validateFaviconURL(null)).toThrow('Favicon URL must be a string');
    expect(() => validateFaviconURL(undefined)).toThrow('Favicon URL must be a string');
    expect(() => validateFaviconURL(123)).toThrow('Favicon URL must be a string');
  });

  it('should reject URLs exceeding max length', () => {
    const longURL = 'https://example.com/' + 'a'.repeat(5000);
    expect(() => validateFaviconURL(longURL)).toThrow('Favicon URL too long');
  });
});

describe('validateExternalURL', () => {
  it('should accept valid HTTP URLs', () => {
    const url = 'http://example.com/path';
    expect(validateExternalURL(url)).toBe(url);
  });

  it('should accept valid HTTPS URLs', () => {
    const url = 'https://example.com/path';
    expect(validateExternalURL(url)).toBe(url);
  });

  it('should strip credentials from URLs', () => {
    expect(validateExternalURL('https://user:pass@example.com/path')).toBe(
      'https://example.com/path'
    );
    expect(validateExternalURL('http://admin:secret@site.com')).toBe('http://site.com/');
  });

  it('should reject unsafe protocols', () => {
    expect(() => validateExternalURL('javascript:alert(1)')).toThrow('Unsafe protocol');
    expect(() => validateExternalURL('data:text/html,<script>alert(1)</script>')).toThrow(
      'Unsafe protocol'
    );
    expect(() => validateExternalURL('file:///etc/passwd')).toThrow('Unsafe protocol');
    expect(() => validateExternalURL('vbscript:msgbox(1)')).toThrow('Unsafe protocol');
  });

  it('should reject URLs containing dangerous patterns in path', () => {
    expect(() => validateExternalURL('https://example.com/javascript:alert(1)')).toThrow(
      'dangerous pattern'
    );
    expect(() => validateExternalURL('https://example.com/path?data:text')).toThrow(
      'dangerous pattern'
    );
    expect(() => validateExternalURL('https://example.com/vbscript:void')).toThrow(
      'dangerous pattern'
    );
    expect(() => validateExternalURL('https://example.com/file:///path')).toThrow(
      'dangerous pattern'
    );
    expect(() => validateExternalURL('https://example.com/about:blank')).toThrow(
      'dangerous pattern'
    );
  });

  it('should reject invalid URL formats', () => {
    expect(() => validateExternalURL('not a url')).toThrow('Invalid URL format');
    expect(() => validateExternalURL('')).toThrow('Invalid URL format');
    expect(() => validateExternalURL('ftp://example.com')).toThrow('Unsafe protocol');
  });

  it('should reject non-string inputs', () => {
    expect(() => validateExternalURL(null)).toThrow('URL must be a string');
    expect(() => validateExternalURL(undefined)).toThrow('URL must be a string');
    expect(() => validateExternalURL({})).toThrow('URL must be a string');
  });

  it('should handle URLs with query parameters', () => {
    const url = 'https://example.com/path?foo=bar&baz=qux';
    expect(validateExternalURL(url)).toBe(url);
  });

  it('should handle URLs with hash fragments', () => {
    const url = 'https://example.com/path#section';
    expect(validateExternalURL(url)).toBe(url);
  });

  it('should reject URLs exceeding max length', () => {
    const longURL = 'https://example.com/' + 'a'.repeat(5000);
    expect(() => validateExternalURL(longURL)).toThrow('URL too long');
  });
});

describe('validateAppleSystemPreferencesURL', () => {
  it('should accept approved System Settings privacy URL', () => {
    const url = 'x-apple.systempreferences:com.apple.preference.security?Privacy';
    expect(validateAppleSystemPreferencesURL(url)).toBe(url);
  });

  it('should accept approved System Settings security URL', () => {
    const url = 'x-apple.systempreferences:com.apple.preference.security';
    expect(validateAppleSystemPreferencesURL(url)).toBe(url);
  });

  it('should reject unapproved System Settings URLs', () => {
    expect(() =>
      validateAppleSystemPreferencesURL('x-apple.systempreferences:com.apple.preference.network')
    ).toThrow('Unapproved System Settings URL');
  });

  it('should reject non-string values', () => {
    expect(() => validateAppleSystemPreferencesURL(null)).toThrow(
      'System Settings URL must be a string'
    );
    expect(() => validateAppleSystemPreferencesURL(undefined)).toThrow(
      'System Settings URL must be a string'
    );
  });

  it('should accept Privacy_Camera System Settings URL', () => {
    const url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera';
    expect(validateAppleSystemPreferencesURL(url)).toBe(url);
  });

  it('should accept Privacy_Microphone System Settings URL', () => {
    const url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
    expect(validateAppleSystemPreferencesURL(url)).toBe(url);
  });

  it('should accept Notifications System Settings URLs', () => {
    expect(
      validateAppleSystemPreferencesURL(
        'x-apple.systempreferences:com.apple.Notifications-Settings.extension'
      )
    ).toBe('x-apple.systempreferences:com.apple.Notifications-Settings.extension');
    expect(
      validateAppleSystemPreferencesURL(
        'x-apple.systempreferences:com.apple.preference.notifications'
      )
    ).toBe('x-apple.systempreferences:com.apple.preference.notifications');
  });
});

describe('validateBoolean', () => {
  it('should accept true', () => {
    expect(validateBoolean(true)).toBe(true);
  });

  it('should accept false', () => {
    expect(validateBoolean(false)).toBe(false);
  });

  it('should convert string "true" to boolean true', () => {
    expect(validateBoolean('true')).toBe(true);
  });

  it('should convert string "false" to boolean false', () => {
    expect(validateBoolean('false')).toBe(false);
  });

  it('should convert 1 to true and 0 to false', () => {
    expect(validateBoolean(1)).toBe(true);
    expect(validateBoolean(0)).toBe(false);
  });

  it('should reject other numbers', () => {
    expect(() => validateBoolean(42)).toThrow('Value is not a valid boolean');
    expect(() => validateBoolean(-1)).toThrow('Value is not a valid boolean');
    expect(() => validateBoolean(2)).toThrow('Value is not a valid boolean');
  });

  it('should reject null', () => {
    expect(() => validateBoolean(null)).toThrow('Value is not a valid boolean');
  });

  it('should reject undefined', () => {
    expect(() => validateBoolean(undefined)).toThrow('Value is not a valid boolean');
  });

  it('should reject objects', () => {
    expect(() => validateBoolean({})).toThrow('Value is not a valid boolean');
    expect(() => validateBoolean([])).toThrow('Value is not a valid boolean');
  });
});

describe('validateString', () => {
  it('should accept valid strings', () => {
    expect(validateString('hello')).toBe('hello');
    expect(validateString('test string')).toBe('test string');
    expect(validateString('123')).toBe('123');
  });

  it('should accept empty string', () => {
    expect(validateString('')).toBe('');
  });

  it('should not trim whitespace by default', () => {
    expect(validateString('  hello  ')).toBe('  hello  ');
    expect(validateString('\ttest\n')).toBe('\ttest\n');
  });

  it('should reject strings exceeding max length', () => {
    const longString = 'a'.repeat(2000);
    expect(() => validateString(longString)).toThrow('String exceeds maximum length');
  });

  it('should accept strings at max length', () => {
    const maxString = 'a'.repeat(1000);
    expect(validateString(maxString)).toBe(maxString);
  });

  it('should reject non-string inputs', () => {
    expect(() => validateString(null)).toThrow('Value must be a string');
    expect(() => validateString(undefined)).toThrow('Value must be a string');
    expect(() => validateString(123)).toThrow('Value must be a string');
    expect(() => validateString({})).toThrow('Value must be a string');
  });

  it('should handle custom max lengths', () => {
    expect(validateString('hello', 10)).toBe('hello');
    expect(() => validateString('hello world', 5)).toThrow('String exceeds maximum length');
  });
});

describe('sanitizeHTML', () => {
  it('should escape < and >', () => {
    expect(sanitizeHTML('<script>')).toBe('&lt;script&gt;');
    expect(sanitizeHTML('<div>')).toBe('&lt;div&gt;');
  });

  it('should escape & symbol', () => {
    expect(sanitizeHTML('Tom & Jerry')).toBe('Tom &amp; Jerry');
    expect(sanitizeHTML('&')).toBe('&amp;');
  });

  it('should escape quotes', () => {
    expect(sanitizeHTML('"hello"')).toBe('&quot;hello&quot;');
    expect(sanitizeHTML("'world'")).toBe('&#x27;world&#x27;');
  });

  it('should escape forward slashes', () => {
    expect(sanitizeHTML('</script>')).toBe('&lt;&#x2F;script&gt;');
  });

  it('should handle mixed content', () => {
    expect(sanitizeHTML('<a href="javascript:alert(\'XSS\')">Click</a>')).toBe(
      '&lt;a href=&quot;javascript:alert(&#x27;XSS&#x27;)&quot;&gt;Click&lt;&#x2F;a&gt;'
    );
  });

  it('should handle empty string', () => {
    expect(sanitizeHTML('')).toBe('');
  });

  it('should handle strings without special characters', () => {
    expect(sanitizeHTML('Hello World')).toBe('Hello World');
    expect(sanitizeHTML('12345')).toBe('12345');
  });

  it('should handle all HTML entities together', () => {
    expect(sanitizeHTML('<>&"\'/')).toBe('&lt;&gt;&amp;&quot;&#x27;&#x2F;');
  });
});

describe('isWhitelistedHost', () => {
  it('should return true for current host', () => {
    expect(isWhitelistedHost('https://example.com/path', 'example.com')).toBe(true);
  });

  it('should return true for whitelisted Google hosts', () => {
    expect(isWhitelistedHost('https://mail.google.com/chat', 'other.com')).toBe(true);
    expect(isWhitelistedHost('https://accounts.google.com/signin', 'other.com')).toBe(true);
  });

  it('should return false for non-whitelisted hosts', () => {
    expect(isWhitelistedHost('https://evil.com', 'example.com')).toBe(false);
  });

  it('should return false for invalid URLs', () => {
    expect(isWhitelistedHost('not a url', 'example.com')).toBe(false);
    expect(isWhitelistedHost('', 'example.com')).toBe(false);
  });
});

describe('isSafeObject', () => {
  it('should return true for plain objects', () => {
    expect(isSafeObject({})).toBe(true);
    expect(isSafeObject({ key: 'value' })).toBe(true);
  });

  it('should return false for null', () => {
    expect(isSafeObject(null)).toBe(false);
  });

  it('should return false for arrays', () => {
    expect(isSafeObject([])).toBe(false);
    expect(isSafeObject([1, 2, 3])).toBe(false);
  });

  it('should return false for non-objects', () => {
    expect(isSafeObject('string')).toBe(false);
    expect(isSafeObject(123)).toBe(false);
    expect(isSafeObject(true)).toBe(false);
    expect(isSafeObject(undefined)).toBe(false);
  });

  it('should return false for objects with custom prototypes', () => {
    class CustomClass {}
    expect(isSafeObject(new CustomClass())).toBe(false);
  });
});

describe('Security integration tests', () => {
  it('should reject Infinity in unread count', () => {
    expect(() => validateUnreadCount(Infinity)).toThrow();
    expect(() => validateUnreadCount(-Infinity)).toThrow();
  });

  it('should protect against XSS in unread count', () => {
    expect(() => validateUnreadCount('<script>alert(1)</script>')).toThrow();
  });

  it('should protect against javascript: URLs in favicon', () => {
    expect(() => validateFaviconURL('javascript:void(0)')).toThrow(
      'Favicon URL must use http, https, or data protocol'
    );
  });

  it('should protect against credential theft in external URLs', () => {
    const result = validateExternalURL('https://user:pass@evil.com');
    expect(result).not.toContain('user');
    expect(result).not.toContain('pass');
  });

  it('should prevent HTML injection via sanitizeHTML', () => {
    const malicious = '<img src=x onerror=alert(1)>';
    const escaped = sanitizeHTML(malicious);
    expect(escaped).not.toContain('<img');
    expect(escaped).toContain('&lt;img');
    // The word 'onerror' will still be present but safe (no angle brackets)
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
  });
});

describe('validateDeepLinkURL', () => {
  it('should convert gogchat:// URL to https://chat.google.com/', () => {
    const result = validateDeepLinkURL('gogchat://room/AAAA9BixgjY/EypiKwiqrS0?cls=10');
    expect(result).toBe('https://chat.google.com/room/AAAA9BixgjY/EypiKwiqrS0?cls=10');
  });

  it('should accept direct https://chat.google.com URLs', () => {
    const result = validateDeepLinkURL('https://chat.google.com/room/AAAA9BixgjY');
    expect(result).toBe('https://chat.google.com/room/AAAA9BixgjY');
  });

  it('should accept /dm/ path', () => {
    const result = validateDeepLinkURL('gogchat://dm/abc123');
    expect(result).toBe('https://chat.google.com/dm/abc123');
  });

  it('should accept /space/ path', () => {
    const result = validateDeepLinkURL('gogchat://space/abc123');
    expect(result).toBe('https://chat.google.com/space/abc123');
  });

  it('should accept root path', () => {
    const result = validateDeepLinkURL('gogchat://');
    expect(result).toBe('https://chat.google.com/');
  });

  it('should strip credentials from URL', () => {
    const result = validateDeepLinkURL('https://user:pass@chat.google.com/room/abc');
    expect(result).not.toContain('user');
    expect(result).not.toContain('pass');
    expect(result).toBe('https://chat.google.com/room/abc');
  });

  it('should throw on non-string input', () => {
    expect(() => validateDeepLinkURL(123)).toThrow('Deep link URL must be a string');
    expect(() => validateDeepLinkURL(null)).toThrow('Deep link URL must be a string');
    expect(() => validateDeepLinkURL(undefined)).toThrow('Deep link URL must be a string');
  });

  it('should throw on empty string', () => {
    expect(() => validateDeepLinkURL('')).toThrow('Deep link URL cannot be empty');
    expect(() => validateDeepLinkURL('   ')).toThrow('Deep link URL cannot be empty');
  });

  it('should throw on URL exceeding max length', () => {
    const longUrl = 'gogchat://room/' + 'a'.repeat(2100);
    expect(() => validateDeepLinkURL(longUrl)).toThrow('Deep link URL too long');
  });

  it('should throw on wrong host', () => {
    expect(() => validateDeepLinkURL('https://evil.com/room/abc')).toThrow(
      'host must be chat.google.com'
    );
  });

  it('should throw on non-HTTPS direct URL', () => {
    expect(() => validateDeepLinkURL('http://chat.google.com/room/abc')).toThrow(
      'Unsupported deep link scheme'
    );
  });

  it('should throw on unsupported scheme', () => {
    expect(() => validateDeepLinkURL('ftp://chat.google.com/room/abc')).toThrow(
      'Unsupported deep link scheme'
    );
    expect(() => validateDeepLinkURL('javascript:alert(1)')).toThrow(
      'Unsupported deep link scheme'
    );
  });

  it('should throw on disallowed path prefix', () => {
    expect(() => validateDeepLinkURL('gogchat://admin/settings')).toThrow('path not allowed');
    expect(() => validateDeepLinkURL('gogchat://api/v1/data')).toThrow('path not allowed');
  });

  it('should accept account-scoped /u/N room paths', () => {
    expect(validateDeepLinkURL('gogchat://u/2/room/abc')).toBe(
      'https://chat.google.com/u/2/room/abc'
    );
  });

  it('should reject /u/N with an unknown tail', () => {
    expect(() => validateDeepLinkURL('gogchat://u/2/admin')).toThrow('path not allowed');
  });
});

describe('isAuthenticatedChatUrl', () => {
  // --- Authenticated URLs (should return true) ---

  it('should return true for chat.google.com with /u/0/', () => {
    expect(isAuthenticatedChatUrl('https://chat.google.com/u/0/')).toBe(true);
  });

  it('should return true for chat.google.com with /u/1 (no trailing slash)', () => {
    expect(isAuthenticatedChatUrl('https://chat.google.com/u/1')).toBe(true);
  });

  it('should return true for chat.google.com with /u/0 and a deeper path', () => {
    expect(isAuthenticatedChatUrl('https://chat.google.com/u/0/room/AAAA9BixgjY')).toBe(true);
  });

  it('should return true for mail.google.com with /chat/u/0/', () => {
    expect(isAuthenticatedChatUrl('https://mail.google.com/chat/u/0/')).toBe(true);
  });

  it('should return true for mail.google.com with /chat/u/1/r/abc', () => {
    expect(isAuthenticatedChatUrl('https://mail.google.com/chat/u/1/r/abc')).toBe(true);
  });

  // --- Unauthenticated / non-Chat URLs (should return false) ---

  it('should return false for chat.google.com bare landing page (no /u/N)', () => {
    expect(isAuthenticatedChatUrl('https://chat.google.com/')).toBe(false);
    expect(isAuthenticatedChatUrl('https://chat.google.com')).toBe(false);
  });

  it('should return false for accounts.google.com login URL', () => {
    expect(isAuthenticatedChatUrl('https://accounts.google.com/signin/v2/identifier')).toBe(false);
    expect(isAuthenticatedChatUrl('https://accounts.google.com/o/oauth2/auth')).toBe(false);
  });

  it('should return false for mail.google.com non-chat path', () => {
    expect(isAuthenticatedChatUrl('https://mail.google.com/mail/u/0/')).toBe(false);
  });

  it('should return false for invalid or non-string inputs', () => {
    expect(isAuthenticatedChatUrl('')).toBe(false);
    expect(isAuthenticatedChatUrl('not a url')).toBe(false);
    expect(isAuthenticatedChatUrl(null)).toBe(false);
    expect(isAuthenticatedChatUrl(undefined)).toBe(false);
    expect(isAuthenticatedChatUrl(42)).toBe(false);
  });

  it('should return false for http (non-https) authenticated-looking URLs', () => {
    expect(isAuthenticatedChatUrl('http://chat.google.com/u/0/')).toBe(false);
  });
});

describe('isGoogleAuthUrl', () => {
  // --- Positive cases (should return true) ---

  it('should return true for accounts.google.com signin URL', () => {
    expect(isGoogleAuthUrl('https://accounts.google.com/signin/v2/identifier')).toBe(true);
  });

  it('should return true for accounts.google.com OAuth URL', () => {
    expect(isGoogleAuthUrl('https://accounts.google.com/o/oauth2/auth')).toBe(true);
  });

  it('should return true for bare accounts.google.com (with trailing slash)', () => {
    expect(isGoogleAuthUrl('https://accounts.google.com/')).toBe(true);
  });

  it('should return true for bare accounts.google.com (no trailing slash)', () => {
    expect(isGoogleAuthUrl('https://accounts.google.com')).toBe(true);
  });

  // --- Negative cases (should return false) ---

  it('should return false for http (non-https) accounts.google.com URL', () => {
    expect(isGoogleAuthUrl('http://accounts.google.com/signin')).toBe(false);
  });

  it('should return false for a subdomain of accounts.google.com', () => {
    expect(isGoogleAuthUrl('https://sub.accounts.google.com/signin')).toBe(false);
  });

  it('should return false for chat.google.com', () => {
    expect(isGoogleAuthUrl('https://chat.google.com/u/0/')).toBe(false);
  });

  it('should return false for mail.google.com', () => {
    expect(isGoogleAuthUrl('https://mail.google.com/chat/u/0/')).toBe(false);
  });

  it('should return false for invalid or non-string inputs', () => {
    expect(isGoogleAuthUrl('')).toBe(false);
    expect(isGoogleAuthUrl('not a url')).toBe(false);
    expect(isGoogleAuthUrl(null)).toBe(false);
    expect(isGoogleAuthUrl(undefined)).toBe(false);
    expect(isGoogleAuthUrl(42)).toBe(false);
  });
});

describe('validatePasskeyFailureData', () => {
  it('should accept known WebAuthn error types', () => {
    const knownErrors = [
      'NotAllowedError',
      'NotSupportedError',
      'SecurityError',
      'AbortError',
      'ConstraintError',
      'InvalidStateError',
      'UnknownError',
      'TimeoutError',
    ];
    for (const errorType of knownErrors) {
      const result = validatePasskeyFailureData(errorType);
      expect(result.errorType).toBe(errorType);
      expect(typeof result.timestamp).toBe('number');
      expect(result.timestamp).toBeGreaterThan(0);
    }
  });

  it('should accept unexpected error types with a console warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = validatePasskeyFailureData('CustomError');
    expect(result.errorType).toBe('CustomError');
    expect(typeof result.timestamp).toBe('number');
    expect(warnSpy).toHaveBeenCalledWith(
      '[validators]',
      'Unexpected passkey error type: CustomError'
    );
    warnSpy.mockRestore();
  });

  it('should not warn for known error types', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validatePasskeyFailureData('NotAllowedError');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('should throw for non-string error types', () => {
    expect(() => validatePasskeyFailureData(null)).toThrow('Value must be a string');
    expect(() => validatePasskeyFailureData(undefined)).toThrow('Value must be a string');
    expect(() => validatePasskeyFailureData(123)).toThrow('Value must be a string');
    expect(() => validatePasskeyFailureData({})).toThrow('Value must be a string');
  });

  it('should throw for error types exceeding max length', () => {
    const longString = 'E'.repeat(101);
    expect(() => validatePasskeyFailureData(longString)).toThrow('String exceeds maximum length');
  });

  it('should accept error types at max length boundary', () => {
    const exactLength = 'E'.repeat(100);
    const result = validatePasskeyFailureData(exactLength);
    expect(result.errorType).toBe(exactLength);
  });

  it('should accept empty string as error type with a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = validatePasskeyFailureData('');
    expect(result.errorType).toBe('');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('should return a timestamp close to current time', () => {
    const before = Date.now();
    const result = validatePasskeyFailureData('NotAllowedError');
    const after = Date.now();
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after);
  });
});

describe('validateNotificationData', () => {
  it('should accept valid notification data with all fields', () => {
    const data = {
      title: 'New message',
      body: 'Hello world',
      icon: 'data:image/png;base64,iVBORw0KGgo=',
      tag: 'msg-123',
    };
    const result = validateNotificationData(data);
    expect(result.title).toBe('New message');
    expect(result.body).toBe('Hello world');
    expect(result.icon).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(result.tag).toBe('msg-123');
    expect(typeof result.timestamp).toBe('number');
  });

  it('should accept notification data with only required title', () => {
    const result = validateNotificationData({ title: 'Alert' });
    expect(result.title).toBe('Alert');
    expect(result.body).toBeUndefined();
    expect(result.icon).toBeUndefined();
    expect(result.tag).toBeUndefined();
    expect(typeof result.timestamp).toBe('number');
  });

  it('should skip body when undefined, null, or empty string', () => {
    expect(validateNotificationData({ title: 'T', body: undefined }).body).toBeUndefined();
    expect(validateNotificationData({ title: 'T', body: null }).body).toBeUndefined();
    expect(validateNotificationData({ title: 'T', body: '' }).body).toBeUndefined();
  });

  it('should skip icon when undefined, null, or empty string', () => {
    expect(validateNotificationData({ title: 'T', icon: undefined }).icon).toBeUndefined();
    expect(validateNotificationData({ title: 'T', icon: null }).icon).toBeUndefined();
    expect(validateNotificationData({ title: 'T', icon: '' }).icon).toBeUndefined();
  });

  it('should skip tag when undefined, null, or empty string', () => {
    expect(validateNotificationData({ title: 'T', tag: undefined }).tag).toBeUndefined();
    expect(validateNotificationData({ title: 'T', tag: null }).tag).toBeUndefined();
    expect(validateNotificationData({ title: 'T', tag: '' }).tag).toBeUndefined();
  });

  it('should validate body string and enforce max length', () => {
    const longBody = 'B'.repeat(5001);
    expect(() => validateNotificationData({ title: 'T', body: longBody })).toThrow(
      'String exceeds maximum length'
    );
    const maxBody = 'B'.repeat(5000);
    expect(validateNotificationData({ title: 'T', body: maxBody }).body).toBe(maxBody);
  });

  it('should validate icon as a favicon URL', () => {
    expect(() => validateNotificationData({ title: 'T', icon: 'javascript:alert(1)' })).toThrow();
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    expect(validateNotificationData({ title: 'T', icon: dataUrl }).icon).toBe(dataUrl);
  });

  it('should validate tag string and enforce max length', () => {
    const longTag = 'T'.repeat(201);
    expect(() => validateNotificationData({ title: 'T', tag: longTag })).toThrow(
      'String exceeds maximum length'
    );
    const maxTag = 'T'.repeat(200);
    expect(validateNotificationData({ title: 'T', tag: maxTag }).tag).toBe(maxTag);
  });

  it('should throw for missing title', () => {
    expect(() => validateNotificationData({ body: 'text' })).toThrow('Value must be a string');
  });

  it('should throw for title exceeding max length', () => {
    const longTitle = 'X'.repeat(501);
    expect(() => validateNotificationData({ title: longTitle })).toThrow(
      'String exceeds maximum length'
    );
  });

  it('should throw for non-object data', () => {
    expect(() => validateNotificationData(null)).toThrow(
      'Notification data must be a plain object'
    );
    expect(() => validateNotificationData(undefined)).toThrow(
      'Notification data must be a plain object'
    );
    expect(() => validateNotificationData('string')).toThrow(
      'Notification data must be a plain object'
    );
    expect(() => validateNotificationData(123)).toThrow('Notification data must be a plain object');
    expect(() => validateNotificationData([])).toThrow('Notification data must be a plain object');
  });

  it('should throw for objects with custom prototypes', () => {
    class Custom {
      title = 'test';
    }
    expect(() => validateNotificationData(new Custom())).toThrow(
      'Notification data must be a plain object'
    );
  });

  it('should return a timestamp close to current time', () => {
    const before = Date.now();
    const result = validateNotificationData({ title: 'T' });
    const after = Date.now();
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after);
  });

  it('should throw when body is a non-string truthy value', () => {
    expect(() => validateNotificationData({ title: 'T', body: 123 })).toThrow(
      'Value must be a string'
    );
    expect(() => validateNotificationData({ title: 'T', body: true })).toThrow(
      'Value must be a string'
    );
  });

  it('should throw when tag is a non-string truthy value', () => {
    expect(() => validateNotificationData({ title: 'T', tag: 42 })).toThrow(
      'Value must be a string'
    );
  });

  it('should throw when icon is a non-string truthy value', () => {
    expect(() => validateNotificationData({ title: 'T', icon: 42 })).toThrow();
  });

  it('should accept data URL icons', () => {
    const icon = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
    const result = validateNotificationData({ title: 'T', icon });
    expect(result.icon).toBe(icon);
  });

  it('should accept Google static HTTPS notification icons', () => {
    const icon = 'https://ssl.gstatic.com/ui/v1/icons/mail/rfr/logo_gmail_lockup_default_1x_r5.png';
    const result = validateNotificationData({ title: 'T', icon });
    expect(result.icon).toBe(icon);
  });

  it('should reject arbitrary remote notification icons', () => {
    expect(() =>
      validateNotificationData({ title: 'T', icon: 'https://evil.example/track.png' })
    ).toThrow(/Notification icon must be/);
  });
});
