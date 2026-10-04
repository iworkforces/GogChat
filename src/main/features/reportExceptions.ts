import log from 'electron-log';
import unhandled from 'electron-unhandled';
import { sanitizeLogError } from '../../shared/logSanitizer.js';
import { openNewGitHubIssue, debugInfo } from '../utils/platform/platformHelpers.js';
import { getPackageInfo } from '../utils/platform/packageInfo.js';

export default (): void => {
  const packageJson = getPackageInfo();

  unhandled({
    logger: (...args) =>
      log.error(...args.map((arg) => (arg instanceof Error ? sanitizeLogError(arg) : arg))),
    reportButton: (error: Error) => {
      openNewGitHubIssue({
        repoUrl: packageJson.repository,
        body: `\`\`\`\n${error.stack}\n\`\`\`\n\n---\n\n${debugInfo()}`,
      });
    },
  });
};
