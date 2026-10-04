const REDACTED = '[redacted]';

/** Logged form of a URL: `scheme://host` only, or a fixed placeholder (never the raw input). */
export function sanitizeLogUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !/^https?:\/\//i.test(value) ||
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    /[\s\u0000-\u001f\u007f-\u009f\\]/.test(value)
  ) {
    return REDACTED;
  }
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return REDACTED;
  }
}

/** Fresh Error for logging; inspects nothing of the input (message, stack, cause may hold URLs). */
export function sanitizeLogError(_value: unknown): Error {
  const error = new Error(REDACTED);
  error.stack = REDACTED;
  return error;
}
