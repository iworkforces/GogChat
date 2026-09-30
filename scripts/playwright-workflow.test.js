import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const PLAYWRIGHT_WORKFLOW_PATH = path.join(PROJECT_ROOT, '.github/workflows/playwright.yml');
const PLAYWRIGHT_PROJECTS = ['e2e', 'integration', 'performance', 'preload-artifact'];
const PINNED_ACTIONS = [
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
];

function readPlaywrightWorkflow() {
  expect(fs.existsSync(PLAYWRIGHT_WORKFLOW_PATH), 'missing standalone Playwright workflow').toBe(
    true
  );
  return fs.readFileSync(PLAYWRIGHT_WORKFLOW_PATH, 'utf-8');
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

function workflowStep(job, command) {
  const step = job.split(/(?=^ {6}- )/m).find((body) => body.includes(command));
  expect(step, `missing step: ${command}`).toBeDefined();
  return step;
}

describe('independent Playwright workflow contract', () => {
  it('routes pull requests, branch pushes and version tags without upstream workflows', () => {
    const workflow = readPlaywrightWorkflow();
    const pullRequest = workflow.match(/^ {2}pull_request:\n((?: +[^\n]*\n)*)/m)?.[1];
    const push = workflow.match(/^ {2}push:\n((?: +[^\n]*\n)*)/m)?.[1];

    expect(pullRequest).toContain('branches: [develop, main]');
    expect(push).toContain('branches: [develop, main]');
    expect(push).toMatch(/tags: \[['"]v\*['"]\]/);
    expect(workflow).not.toMatch(/workflow_run:|workflow_call:|\bneeds:/);
    expect(workflow).toContain('group: ${{ github.workflow }}-${{ github.ref }}');
    expect(workflow).toContain('cancel-in-progress: true');
  });

  it('uses a read-only macOS job and pinned tools with normal event checkout', () => {
    const workflow = readPlaywrightWorkflow();
    const job = workflowJob(workflow, 'playwright');
    const checkout = workflowStep(job, 'actions/checkout@');
    const prWorkflow = fs.readFileSync(
      path.join(PROJECT_ROOT, '.github/workflows/pr-check.yml'),
      'utf-8'
    );

    expect(job).toContain('runs-on: macos-latest');
    expect(job).toContain('timeout-minutes: 60');
    expect(workflow).toMatch(/permissions:\n +contents: read/);
    expect(workflow).not.toContain('contents: write');
    expect(checkout).not.toMatch(/\bref:|github\.event\.workflow_run/);
    for (const action of PINNED_ACTIONS) {
      expect(job).toContain(action);
      expect(prWorkflow).toContain(action);
    }
    expect(workflowStep(job, 'oven-sh/setup-bun@')).toContain('bun-version-file: package.json');
    expect(workflowStep(job, 'actions/setup-node@')).toContain("node-version: '24.16.0'");
  });

  it('installs frozen dependencies and Electron then builds before the four isolated projects', () => {
    const job = workflowJob(readPlaywrightWorkflow(), 'playwright');
    const order = [
      'bun install --frozen-lockfile',
      'node scripts/install-electron-binary.js',
      'bun scripts/build-rsbuild.js',
      ...PLAYWRIGHT_PROJECTS.map((project) => `bunx playwright test --project=${project}`),
    ];

    let previous = -1;
    for (const command of order) {
      const index = indexOfCommand(job, command);
      expect(index, `out of order: ${command}`).toBeGreaterThan(previous);
      previous = index;
    }
    expect(
      [...job.matchAll(/bunx playwright test --project=([\w-]+)/g)].map((match) => match[1])
    ).toEqual(PLAYWRIGHT_PROJECTS);
    expect(job).not.toMatch(
      /vitest|headless-startup|check-perf-budget|GOOGLE|gogchat-auth|client_secret|refresh_token/i
    );
  });

  it.each([
    ['e2e', 'tests/e2e/user-workflows.test.ts'],
    ['integration', 'tests/integration/app-launch.test.ts'],
    ['performance', 'tests/performance/performance-regression.test.ts'],
  ])('tees Playwright %s output and annotates the last failure excerpt', (project, testFile) => {
    const job = workflowJob(readPlaywrightWorkflow(), 'playwright');
    const command = `bunx playwright test --project=${project}`;
    const step = workflowStep(job, command);
    const annotation = `::error file=${testFile}::`;

    expect(step).toContain('set -o pipefail');
    expect(step).toContain(`tee playwright-${project}.log`);
    expect(step).toContain('status=${PIPESTATUS[0]}');
    expect(step).toContain(`tail -n 15 playwright-${project}.log`);
    expect(step).toContain(annotation);
    expect(step).toContain('exit "$status"');
    expect(indexOfCommand(step, command)).toBeLessThan(step.indexOf(annotation));
  });

  it('uploads Playwright traces and reports only on failure with seven-day retention', () => {
    const job = workflowJob(readPlaywrightWorkflow(), 'playwright');
    const upload = workflowStep(job, 'playwright-report/');

    expect(job.indexOf(upload)).toBeGreaterThan(
      indexOfCommand(job, 'bunx playwright test --project=preload-artifact')
    );
    expect(upload).toContain('if: failure()');
    expect(upload).toContain(PINNED_ACTIONS[3]);
    expect(upload).toContain('test-results/');
    expect(upload).toContain('retention-days: 7');
  });

  it('always uploads the three Playwright logs with fourteen-day retention', () => {
    const job = workflowJob(readPlaywrightWorkflow(), 'playwright');
    const upload = workflowStep(job, 'if: always()');

    expect(job.indexOf(upload)).toBeGreaterThan(
      indexOfCommand(job, 'bunx playwright test --project=preload-artifact')
    );
    expect(upload).toContain(PINNED_ACTIONS[3]);
    expect(upload).toContain('playwright-e2e.log');
    expect(upload).toContain('playwright-integration.log');
    expect(upload).toContain('playwright-performance.log');
    expect(upload).toContain('retention-days: 14');
  });

  it('lists every Playwright project once and no extra project names', () => {
    const output = execFileSync('bunx', ['playwright', 'test', '--list'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
    });

    for (const project of PLAYWRIGHT_PROJECTS) {
      expect(output).toContain(`[${project}]`);
    }

    const entries = [...output.matchAll(/\[([^\]]+)\] › ([^\n]+)/g)].map((match) => ({
      project: match[1],
      rest: match[2],
    }));
    const uniqueProjects = [...new Set(entries.map((entry) => entry.project))].sort();
    expect(uniqueProjects).toEqual([...PLAYWRIGHT_PROJECTS].sort());
    expect(entries.length).toBeGreaterThan(uniqueProjects.length);

    const owner = new Map();
    for (const entry of entries) {
      const file = entry.rest.split(':')[0] ?? entry.rest;
      const previous = owner.get(file);
      if (previous && previous !== entry.project) {
        throw new Error(
          `duplicate project ownership for ${file}: ${previous} and ${entry.project}`
        );
      }
      owner.set(file, entry.project);
    }
  });
});
