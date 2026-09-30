import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const PR_WORKFLOW_PATH = path.join(PROJECT_ROOT, '.github/workflows/pr-check.yml');

const LITERAL = {
  install: 'bun install --frozen-lockfile',
  electron: 'node scripts/install-electron-binary.js',
  typecheck: 'node ./node_modules/@typescript/native/bin/tsc -b',
  docClaims: 'bun scripts/check-doc-claims.js',
  lint: 'bash ./scripts/lint.sh',
  coverage:
    'node --require ./tests/polyfill-crypto.cjs ./node_modules/vitest/vitest.mjs run --coverage',
  madge: 'bunx madge --circular --extensions ts src/',
  build: 'bun scripts/build-rsbuild.js',
  headless: 'node scripts/headless-startup.js',
  budget: 'node scripts/check-perf-budget.js performance-metrics.json',
};

function readPrWorkflow() {
  return fs.readFileSync(PR_WORKFLOW_PATH, 'utf-8');
}

function workflowJob(workflow, jobName) {
  const lines = workflow.split('\n');
  const startIndex = lines.findIndex((line) => line === `  ${jobName}:`);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const nextJobIndex = lines.findIndex(
    (line, index) => index > startIndex && /^ {2}[a-zA-Z0-9_-]+:$/.test(line)
  );
  const endIndex = nextJobIndex === -1 ? lines.length : nextJobIndex;
  return lines.slice(startIndex, endIndex).join('\n');
}

function indexOfCommand(job, command) {
  const index = job.indexOf(command);
  expect(index, `missing command: ${command}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe('PR check workflow contract', () => {
  it('installs a frozen lockfile and the Electron binary before any gate', () => {
    const job = workflowJob(readPrWorkflow(), 'check');
    const installAt = indexOfCommand(job, LITERAL.install);
    const electronAt = indexOfCommand(job, LITERAL.electron);
    const typecheckAt = indexOfCommand(job, LITERAL.typecheck);

    expect(installAt).toBeLessThan(electronAt);
    expect(electronAt).toBeLessThan(typecheckAt);
  });

  it('runs the required gates in order with literal commands, not package aliases', () => {
    const job = workflowJob(readPrWorkflow(), 'check');

    const order = [
      LITERAL.typecheck,
      LITERAL.docClaims,
      LITERAL.lint,
      LITERAL.coverage,
      LITERAL.madge,
      LITERAL.build,
      LITERAL.headless,
      LITERAL.budget,
    ];

    let previous = -1;
    for (const command of order) {
      const index = indexOfCommand(job, command);
      expect(index, `out of order: ${command}`).toBeGreaterThan(previous);
      previous = index;
    }

    expect(job).not.toContain('bun run typecheck');
    expect(job).not.toContain('bun run check:doc-claims');
    expect(job).not.toContain('bun run lint');
    expect(job).not.toContain('bun run lint:all');
    expect(job).not.toContain('bun run test:coverage');
    expect(job).not.toContain('bun run build:prod');
    expect(job).not.toContain('bun run test\n');
    expect(job).not.toMatch(/bun run test$/m);
  });

  it('does not duplicate unit execution and names the exact headless/budget commands', () => {
    const job = workflowJob(readPrWorkflow(), 'check');

    expect(job.match(/vitest\.mjs run --coverage/g) ?? []).toHaveLength(1);
    expect(job.match(/vitest\.mjs/g) ?? []).toHaveLength(1);
    expect(job).toContain("GOGCHAT_PERF_RUNS: '5'");
    expect(job).toContain("HEADLESS_TIMEOUT_MS: '90000'");
    expect(job).toContain(LITERAL.headless);
    expect(job).toContain(LITERAL.budget);
    expect(job).not.toMatch(/GOOGLE|gogchat-auth|client_secret|refresh_token/i);
  });

  it('uploads metrics and log evidence even when a later gate fails', () => {
    const job = workflowJob(readPrWorkflow(), 'check');
    const uploadAt = job.indexOf('if: always()');
    expect(uploadAt).toBeGreaterThan(indexOfCommand(job, LITERAL.budget));
    expect(job).toContain('actions/upload-artifact@');
    expect(job).toContain('performance-metrics.json');
    expect(job).toContain('.perf-history.json');
    expect(job).toContain('coverage-output.txt');
  });

  it('leaves Playwright commands and artifacts to the independent workflow', () => {
    const workflow = readPrWorkflow();

    expect(workflow).not.toMatch(/playwright/i);
    expect(workflow).not.toContain('test-results/');
  });
});
