/**
 * Unit tests for reportExceptions feature.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron-log', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('electron-unhandled', () => ({
  default: vi.fn(),
}));

vi.mock('../utils/platform/platformHelpers', () => ({
  openNewGitHubIssue: vi.fn(),
  debugInfo: vi.fn().mockReturnValue('platform: darwin'),
}));

vi.mock('../utils/platform/packageInfo', () => ({
  getPackageInfo: vi.fn().mockReturnValue({
    productName: 'GogChat',
    version: '1.0.0',
    author: 'test',
    repository: 'https://github.com/test/repo',
  }),
}));

import reportExceptions from './reportExceptions';
import log from 'electron-log';
import { openNewGitHubIssue } from '../utils/platform/platformHelpers';
import { getPackageInfo } from '../utils/platform/packageInfo';
import unhandled from 'electron-unhandled';
import {
  SECRET_AUTH_URL,
  expectNoSentinels,
  makeSecretError,
  spiesOf,
} from '../../../tests/mocks/logCapture';

describe('reportExceptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers unhandled error handler', () => {
    reportExceptions();
    expect(unhandled).toHaveBeenCalledWith(
      expect.objectContaining({
        logger: expect.any(Function),
        reportButton: expect.any(Function),
      })
    );
  });

  it('logger function passes args to electron-log error', () => {
    reportExceptions();
    const callArgs = vi.mocked(unhandled).mock.calls[0][0];
    callArgs.logger('error message', 'detail');
    expect(log.error).toHaveBeenCalledWith('error message', 'detail');
  });

  it('replaces Error arguments with the fixed placeholder and forwards the rest', () => {
    reportExceptions();
    const callArgs = vi.mocked(unhandled).mock.calls[0][0];

    callArgs.logger('Unhandled Rejection', makeSecretError(), { note: 'kept' });

    const [title, logged, extra] = vi.mocked(log.error).mock.calls[0] as [string, Error, unknown];
    expect(title).toBe('Unhandled Rejection');
    expect(logged).toBeInstanceOf(Error);
    expect(logged.message).toBe('[redacted]');
    expect(logged.stack).toBe('[redacted]');
    expect(logged.cause).toBeUndefined();
    expect(extra).toEqual({ note: 'kept' });
    expectNoSentinels(spiesOf(log));
  });

  it('keeps a sentinel-free Error out of the log even when its prose embeds a URL', () => {
    reportExceptions();
    const callArgs = vi.mocked(unhandled).mock.calls[0][0];

    callArgs.logger(new Error(`Failed to load URL: ${SECRET_AUTH_URL}`));

    expectNoSentinels(spiesOf(log));
  });

  it('reportButton function opens GitHub issue', () => {
    reportExceptions();
    const callArgs = vi.mocked(unhandled).mock.calls[0][0];

    const fakeError = { stack: 'Error: test\n  at line 1' };
    callArgs.reportButton(fakeError);

    expect(openNewGitHubIssue).toHaveBeenCalledWith({
      repoUrl: getPackageInfo().repository,
      body: expect.stringContaining('Error: test'),
    });
  });
});
