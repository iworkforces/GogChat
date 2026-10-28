import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_RECORDS_PER_ACCOUNT,
  MIN_SAMPLES,
  SIZES,
  decideMeasurement,
  teardownRun,
  validateEvidence,
} from './cdp-persistence-benchmark.js';

function sample(size, index) {
  return {
    size,
    index,
    durationMs: 1 + index,
    eventLoopDelayMs: 0.1,
    fileBytes: 80 + size * 20,
    recordCount: Math.min(size + 1, MAX_RECORDS_PER_ACCOUNT),
    jsonValid: true,
    fifoOk: true,
    monotonic: true,
    capped: size >= MAX_RECORDS_PER_ACCOUNT,
  };
}

function completeEvidence() {
  const cells = {};
  for (const size of SIZES) {
    cells[size] = {
      size,
      samples: Array.from({ length: MIN_SAMPLES }, (_, index) => sample(size, index)),
    };
  }
  return {
    environment: {
      os: 'darwin',
      arch: 'arm64',
      electron: '43.0.0',
      node: '24.16.0',
      bun: '1.4.4',
    },
    cells,
  };
}

describe('cdp-persistence-benchmark contract', () => {
  const leftovers = [];

  afterEach(() => {
    for (const leftover of leftovers.splice(0)) {
      teardownRun(leftover);
    }
  });

  it('rejects zero and 19-sample cells', () => {
    const empty = completeEvidence();
    empty.cells[1].samples = [];
    expect(validateEvidence(empty).ok).toBe(false);

    const nineteen = completeEvidence();
    nineteen.cells[100].samples = nineteen.cells[100].samples.slice(0, 19);
    expect(validateEvidence(nineteen).ok).toBe(false);
  });

  it('rejects a missing size, malformed final JSON, and FIFO/cap violations', () => {
    const missing = completeEvidence();
    delete missing.cells[1000];
    expect(validateEvidence(missing).ok).toBe(false);

    const malformed = completeEvidence();
    malformed.cells[1].samples[0].jsonValid = false;
    expect(validateEvidence(malformed).ok).toBe(false);

    const fifo = completeEvidence();
    fifo.cells[1000].samples[0].fifoOk = false;
    fifo.cells[1000].samples[0].recordCount = 1001;
    expect(validateEvidence(fifo).ok).toBe(false);
  });

  it('rejects a leaked Electron child or leftover userData', () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-leak-'));
    leftovers.push({ userDataDir: userData, child: { killed: false, exitCode: null } });
    expect(
      teardownRun({
        userDataDir: userData,
        child: { killed: false, exitCode: null, kill() {} },
      }).childLeaked
    ).toBe(true);
  });

  it('accepts a deterministic fixture with 20 raw samples per size and environment metadata', () => {
    const evidence = completeEvidence();
    const validated = validateEvidence(evidence);
    expect(validated.ok).toBe(true);
    expect(validated.sizes).toEqual(SIZES);
    expect(validated.environment.node).toBeTruthy();

    const decision = decideMeasurement(evidence);
    expect(decision.decision).toBe('NO CHANGE');
    expect(decision.reason).toMatch(/no control\/treatment/i);
    expect(decision.rawSamples).toBe(MIN_SAMPLES * SIZES.length);
  });

  it('refuses a receipt-only NO CHANGE with no raw samples', () => {
    const decision = decideMeasurement({
      decision: 'NO CHANGE',
      cells: {},
    });
    expect(decision.ok).toBe(false);
    expect(decision.decision).not.toBe('NO CHANGE');
  });
});
