/**
 * Capture boundary for log-redaction tests: inspects every argument of every call made on the
 * four `electron-log` default-export level spies (message strings, Error message/stack/cause,
 * nested containers) for secret sentinels. Tests mock `electron-log` themselves.
 */
import { expect, type Mock } from 'vitest';

export const LOG_LEVELS = ['info', 'warn', 'error', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogSpies = Record<LogLevel, Mock>;

export const SENTINELS = [
  'P2_USERINFO',
  'P2_QUERY',
  'P2_FRAGMENT',
  'P2_CONTINUE',
  'P2_PATH',
] as const;

/** Secret-bearing Google sign-in URL carrying all five sentinels. */
export const SECRET_AUTH_URL =
  'https://P2_USERINFO:P2_USERINFO@accounts.google.com/P2_PATH/signin?token=P2_QUERY' +
  '&continue=https%3A%2F%2Fchat.google.com%2Fchat%2FP2_CONTINUE#P2_FRAGMENT';

/** Secret-bearing Chat URL (also usable as an external/redirect target). */
export const SECRET_CHAT_URL =
  'https://P2_USERINFO:P2_USERINFO@chat.google.com/P2_PATH/u/0/?token=P2_QUERY' +
  '&continue=https%3A%2F%2Fchat.google.com%2Fchat%2FP2_CONTINUE#P2_FRAGMENT';

export function spiesOf(log: unknown): LogSpies {
  return log as LogSpies;
}

export function clearSpies(spies: LogSpies): void {
  for (const level of LOG_LEVELS) {
    spies[level].mockClear();
  }
}

export interface RecordedCall {
  level: LogLevel;
  args: unknown[];
}

export function recordedCalls(spies: LogSpies): RecordedCall[] {
  return LOG_LEVELS.flatMap((level) =>
    spies[level].mock.calls.map((args): RecordedCall => ({ level, args: args as unknown[] }))
  );
}

/** Every string reachable from `value`, cycle-safe; Error fields are read directly. */
export function collectStrings(value: unknown, seen = new WeakSet<object>()): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return typeof value === 'function' || typeof value === 'symbol' ? [String(value)] : [];
  }
  seen.add(value);
  const out: string[] = [];
  if (value instanceof Error) {
    out.push(value.name, value.message, value.stack ?? '');
    out.push(...collectStrings(value.cause, seen));
    if (value instanceof AggregateError) {
      out.push(...collectStrings(value.errors, seen));
    }
  }
  const nested: unknown[] =
    value instanceof Map
      ? [...value.keys(), ...value.values()]
      : value instanceof Set
        ? [...value]
        : Object.getOwnPropertyNames(value).map((key) => Reflect.get(value, key));
  for (const item of nested) {
    out.push(...collectStrings(item, seen));
  }
  return out;
}

function leaks(text: string): string[] {
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    // keep the raw text
  }
  return SENTINELS.filter((sentinel) => text.includes(sentinel) || decoded.includes(sentinel));
}

/** Sentinels found in any argument of any call at any level. */
export function leakedSentinels(spies: LogSpies): string[] {
  return recordedCalls(spies).flatMap(({ args }) =>
    args.flatMap((a) => collectStrings(a)).flatMap(leaks)
  );
}

/** Non-vacuous: requires at least `minCalls` captured calls and no sentinel in any of them. */
export function expectNoSentinels(spies: LogSpies, minCalls = 1): void {
  expect(recordedCalls(spies).length).toBeGreaterThanOrEqual(minCalls);
  expect(leakedSentinels(spies)).toEqual([]);
}

/** Message (first argument) of every call at `level`, optionally only those starting with `prefix`. */
export function messagesAt(spies: LogSpies, level: LogLevel, prefix = ''): string[] {
  return spies[level].mock.calls
    .map(([message]) => String(message))
    .filter((message) => message.startsWith(prefix));
}

/** Error carrying all sentinels in message, stack, cause and custom fields. */
export function makeSecretError(url: string = SECRET_AUTH_URL): Error {
  const error = new Error(`ERR_ABORTED (-3) loading '${url}'`, {
    cause: new Error(`inner ${url}`),
  });
  error.stack = `Error: loading '${url}'\n    at https://P2_USERINFO@evil.example/P2_PATH`;
  return Object.assign(error, { url, code: 'P2_QUERY' });
}
