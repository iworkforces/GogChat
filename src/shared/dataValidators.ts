/**
 * Data validation utilities for IPC messages and user input
 * These validators ensure data integrity for non-URL values
 */

import { BADGE } from './constants.js';
import { validateNotificationIconURL } from './urlValidators.js';
import type { OnlineCheckRequest, OnlineStatusData, PasskeyErrorType } from './types/domain.js';

/** Opaque attempt tokens stay short; UUIDs and similar ids fit well under this. */
const ATTEMPT_ID_MAX_LENGTH = 128;

/**
 * Validates and sanitizes unread count values
 * @param count - Raw count value from renderer
 * @returns Sanitized count number
 * @throws Error if count is invalid
 */
export function validateUnreadCount(count: unknown): number {
  // Type check
  if (typeof count !== 'number' && typeof count !== 'string') {
    throw new Error('Unread count must be a number or string');
  }

  // Convert to number
  const num = Number(count);

  // Validate
  if (isNaN(num)) {
    throw new Error('Unread count is not a valid number');
  }

  if (num < 0) {
    throw new Error('Unread count cannot be negative');
  }

  if (num > BADGE.MAX_COUNT) {
    throw new Error(`Unread count exceeds maximum (${BADGE.MAX_COUNT})`);
  }

  if (!Number.isFinite(num)) {
    throw new Error('Unread count must be finite');
  }

  // Return safe integer
  return Math.floor(num);
}

/**
 * Validates boolean values from IPC
 * @param value - Value to validate
 * @returns boolean
 * @throws Error if not a valid boolean
 */
export function validateBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }

  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }

  throw new Error('Value is not a valid boolean');
}

/**
 * Validates string values with length limits
 * @param value - Value to validate
 * @param maxLength - Maximum allowed length
 * @returns Sanitized string
 * @throws Error if invalid
 */
export function validateString(value: unknown, maxLength = 1000): string {
  if (typeof value !== 'string') {
    throw new Error('Value must be a string');
  }

  if (value.length > maxLength) {
    throw new Error(`String exceeds maximum length (${maxLength})`);
  }

  return value;
}

/**
 * Validates that a value is a safe object (not null, not array)
 * @param value - Value to validate
 * @returns true if safe object
 */
export function isSafeObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Sanitizes HTML to prevent XSS
 * @param html - HTML string to sanitize
 * @returns Sanitized HTML
 */
export function sanitizeHTML(html: string): string {
  // Basic HTML entity encoding
  return html
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

/**
 * Validates passkey authentication failure data
 * @param errorType - Error type from WebAuthn API
 * @returns Validated PasskeyFailureData object
 * @throws Error if data is invalid
 */
export function validatePasskeyFailureData(errorType: unknown): {
  errorType: PasskeyErrorType | (string & {});
  timestamp: number;
} {
  // Validate error type
  const validatedErrorType = validateString(errorType, 100);

  // Whitelist of known WebAuthn error types
  const allowedErrors = [
    'NotAllowedError',
    'NotSupportedError',
    'SecurityError',
    'AbortError',
    'ConstraintError',
    'InvalidStateError',
    'UnknownError',
    'TimeoutError',
  ];

  // Allow any error type but log if unexpected
  if (!allowedErrors.includes(validatedErrorType)) {
    console.warn('[validators]', `Unexpected passkey error type: ${validatedErrorType}`);
  }

  return {
    errorType: validatedErrorType,
    timestamp: Date.now(),
  };
}

/**
 * Validates notification data before creating native notification
 * @param data - Notification data from renderer
 * @returns Validated NotificationData object
 * @throws Error if data is invalid
 */
export function validateNotificationData(data: unknown): {
  title: string;
  body?: string;
  icon?: string;
  tag?: string;
  timestamp: number;
} {
  // Type check
  if (!isSafeObject(data)) {
    throw new Error('Notification data must be a plain object');
  }

  // Validate required fields
  const title = validateString(data['title'], 500);

  // Validate optional fields
  const result: {
    title: string;
    body?: string;
    icon?: string;
    tag?: string;
    timestamp: number;
  } = {
    title,
    timestamp: Date.now(),
  };

  if (data['body'] !== undefined && data['body'] !== null && data['body'] !== '') {
    result.body = validateString(data['body'], 5000);
  }

  if (data['icon'] !== undefined && data['icon'] !== null && data['icon'] !== '') {
    // Allowlist: data:image/* or Google static HTTPS hosts only
    result.icon = validateNotificationIconURL(data['icon']);
  }

  if (data['tag'] !== undefined && data['tag'] !== null && data['tag'] !== '') {
    result.tag = validateString(data['tag'], 200);
  }

  return result;
}

/**
 * Validates an opaque connectivity-check attempt id.
 * @throws Error if the value is missing, empty, or too long
 */
export function validateAttemptId(value: unknown): string {
  const attemptId = validateString(value, ATTEMPT_ID_MAX_LENGTH);
  if (attemptId.trim().length === 0) {
    throw new Error('attemptId cannot be empty');
  }
  return attemptId;
}

/**
 * Validates a CHECK_IF_ONLINE request payload.
 * @throws Error if the payload is not a plain object with a valid attemptId
 */
export function validateOnlineCheckRequest(data: unknown): OnlineCheckRequest {
  if (!isSafeObject(data)) {
    throw new Error('Online check request must be a plain object');
  }
  return { attemptId: validateAttemptId(data['attemptId']) };
}

/** Non-2xx statuses a `response.ok === false` fetch can surface. */
const HTTP_ERROR_STATUS_MIN = 300;
const HTTP_ERROR_STATUS_MAX = 599;

function validateHttpErrorStatus(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < HTTP_ERROR_STATUS_MIN ||
    value > HTTP_ERROR_STATUS_MAX
  ) {
    throw new Error('httpStatus must be an integer HTTP error status');
  }
  return value;
}

/**
 * Validates an ONLINE_STATUS response payload into a fresh discriminated
 * result. Unknown keys (including raw error text) are never copied.
 * @throws Error on a non-object, bad attemptId, unknown outcome, or a status
 *   that is missing from `http-error` or present on any other outcome
 */
export function validateOnlineStatusData(data: unknown): OnlineStatusData {
  if (!isSafeObject(data)) {
    throw new Error('Online status must be a plain object');
  }
  const attemptId = validateAttemptId(data['attemptId']);
  const outcome = data['outcome'];
  switch (outcome) {
    case 'http-error':
      return { attemptId, outcome, httpStatus: validateHttpErrorStatus(data['httpStatus']) };
    case 'online':
    case 'network-error':
    case 'timeout':
      if (data['httpStatus'] !== undefined) {
        throw new Error('httpStatus is only valid for http-error');
      }
      return { attemptId, outcome };
    default:
      throw new Error('Unknown online status outcome');
  }
}
