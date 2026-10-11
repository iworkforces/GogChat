/**
 * Tests for `scripts/featurePlanPlugin.js`.
 *
 * Two flavors of coverage:
 *   1. Snapshot test against the checked-in `src/main/generated/featurePlan.ts`
 *      to guarantee byte-identical output for the current valid specs.
 *   2. Edge-case tests that feed inline spec sources to `parseSpecSource`
 *      and `buildPlanFromSources`, exercising fail-closed grammar, nested
 *      braces, comments, template literals, optional fields, dependency
 *      batching, cycle detection, and atomic write safety.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSpecSource, buildPlanFromSources, generateFeaturePlan } from './featurePlanPlugin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

describe('featurePlanPlugin – snapshot vs checked-in featurePlan.ts', () => {
  it('produces byte-identical output to src/main/generated/featurePlan.ts', async () => {
    const expected = fs.readFileSync(
      path.join(PROJECT_ROOT, 'src/main/generated/featurePlan.ts'),
      'utf-8'
    );
    const { source } = await generateFeaturePlan({ projectRoot: PROJECT_ROOT, write: false });
    expect(source).toBe(expected);
  });

  it('reads the real spec files via buildPlanFromSources and matches the same output', async () => {
    const specsDir = path.join(PROJECT_ROOT, 'src/main/initializers');
    const inputs = fs
      .readdirSync(specsDir)
      .filter((f) => f.endsWith('.spec.ts'))
      .map((f) => ({ file: f, source: fs.readFileSync(path.join(specsDir, f), 'utf-8') }));

    const { source } = await buildPlanFromSources(inputs);
    const expected = fs.readFileSync(
      path.join(PROJECT_ROOT, 'src/main/generated/featurePlan.ts'),
      'utf-8'
    );
    expect(source).toBe(expected);
  });

  it('omits the certificate override from the real security feature plan', async () => {
    // Given the repository's declarative feature specs
    // When the real generator builds the runtime plan without writing it
    const { source } = await generateFeaturePlan({ projectRoot: PROJECT_ROOT, write: false });

    // Then no certificate-error override feature is reachable at startup
    expect(source).not.toContain('certificatePinning');
  });

  it('schedules badge and hide-on-close without a tray-icon feature', async () => {
    const { source } = await generateFeaturePlan({ projectRoot: PROJECT_ROOT, write: false });
    expect(source).not.toContain("get('trayIcon')");
    expect(source).toContain("get('badgeIcons')");
    expect(source).toContain("get('closeToTray')");
  });
});

describe('parseSpecSource – AST-based parser', () => {
  it('extracts name/phase/required/dependencies from a minimal spec', () => {
    const src = `
      import type { FeatureSpec } from '../utils/lifecycle/featureConfigTypes.js';
      export const SAMPLE_FEATURES = [
        {
          name: 'alpha',
          phase: 'security',
          required: true,
          description: 'first',
          init: () => {},
        },
        {
          name: 'beta',
          phase: 'security',
          dependencies: ['alpha'],
          description: 'second',
          init: async () => { await Promise.resolve(); },
        },
      ] as const satisfies readonly FeatureSpec[];
    `;
    const { exportName, entries } = parseSpecSource(src, 'sample.spec.ts');
    expect(exportName).toBe('SAMPLE_FEATURES');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      name: 'alpha',
      phase: 'security',
      required: true,
      description: 'first',
    });
    expect(entries[1]).toMatchObject({
      name: 'beta',
      phase: 'security',
      dependencies: ['alpha'],
      description: 'second',
    });
  });

  it('is not confused by nested braces or template literals inside init bodies', () => {
    const src = `
      export const X = [
        {
          name: 'gamma',
          phase: 'ui',
          init: async () => {
            const cfg = { a: { b: { c: 1 } }, msg: \`hello \${'}'}\\n\` };
            if (cfg.a) { /* } */ }
            return cfg;
          },
        },
      ] as const;
    `;
    const { entries } = parseSpecSource(src, 'nested.spec.ts');
    expect(entries).toEqual([{ name: 'gamma', phase: 'ui' }]);
  });

  it('rejects entries missing name or phase', () => {
    const missingPhase = `
      export const Y = [
        { name: 'has-name-only' },
        { name: 'ok', phase: 'security' },
      ] as const;
    `;
    expect(() => parseSpecSource(missingPhase, 'partial.spec.ts')).toThrow(
      /partial\.spec\.ts\[0\]\.phase/
    );

    const missingName = `
      export const Y = [
        { phase: 'security' },
      ] as const;
    `;
    expect(() => parseSpecSource(missingName, 'partial.spec.ts')).toThrow(
      /partial\.spec\.ts\[0\]\.name/
    );
  });

  it('throws when no exported array is found', () => {
    expect(() => parseSpecSource(`const X = [];`, 'bad.spec.ts')).toThrow(
      /No 'export const NAME =/
    );
  });

  it('handles dependencies without satisfies/as wrappers', () => {
    const src = `
      export const Z = [
        { name: 'a', phase: 'deferred' },
        { name: 'b', phase: 'deferred', dependencies: ['a'] },
      ];
    `;
    const { exportName, entries } = parseSpecSource(src, 'plain.spec.ts');
    expect(exportName).toBe('Z');
    expect(entries[1].dependencies).toEqual(['a']);
  });

  it('ignores platform metadata while preserving dependency metadata', () => {
    const src = `
      export const PLATFORM_FEATURES = [
        { name: 'mac-only', phase: 'deferred', platforms: ['darwin'], init: () => {} },
        { name: 'after', phase: 'deferred', dependencies: ['mac-only'], platforms: ['win32'], init: () => {} },
      ] as const;
    `;
    const { entries } = parseSpecSource(src, 'platform.spec.ts');
    expect(entries).toEqual([
      { name: 'mac-only', phase: 'deferred' },
      { name: 'after', phase: 'deferred', dependencies: ['mac-only'] },
    ]);
  });

  it('allows static string keys and operational init/cleanup', () => {
    const src = `
      export const STRING_KEYS = [
        {
          'name': 'quoted',
          "phase": 'ui',
          "description": 'string keys',
          init: () => {
            const nested = { braces: { ok: true }, tpl: \`}\${'}'}\` };
            return nested;
          },
          cleanup: async () => {
            await Promise.resolve({ done: true });
          },
        },
      ] as const;
    `;
    const { entries } = parseSpecSource(src, 'string-keys.spec.ts');
    expect(entries).toEqual([{ name: 'quoted', phase: 'ui', description: 'string keys' }]);
  });
});

describe('parseSpecSource – fail-closed unsupported elements', () => {
  const expectElementRejected = (source, fileName, index, kind) => {
    expect(() => parseSpecSource(source, fileName)).toThrow(
      new RegExp(`${fileName.replace('.', '\\.')}\\[${index}\\]:.*${kind}`)
    );
  };

  it('rejects spread elements with file and element index', () => {
    expectElementRejected(
      `
        export const S = [
          { name: 'ok', phase: 'security' },
          ...otherFeatures,
        ] as const;
      `,
      'spread.spec.ts',
      1,
      'spread'
    );
  });

  it('rejects call expressions with file and element index', () => {
    expectElementRejected(
      `
        export const S = [
          makeFeature('called', 'security'),
        ] as const;
      `,
      'call.spec.ts',
      0,
      'call'
    );
  });

  it('rejects identifiers with file and element index', () => {
    expectElementRejected(
      `
        const shared = { name: 'shared', phase: 'security' };
        export const S = [
          shared,
        ] as const;
      `,
      'identifier.spec.ts',
      0,
      'identifier'
    );
  });

  it('rejects conditionals with file and element index', () => {
    expectElementRejected(
      `
        export const S = [
          flag
            ? { name: 'yes', phase: 'security' }
            : { name: 'no', phase: 'security' },
        ] as const;
      `,
      'conditional.spec.ts',
      0,
      'conditional'
    );
  });

  it('rejects holes with file and element index', () => {
    expectElementRejected(
      `
        export const S = [
          { name: 'first', phase: 'security' },
          ,
          { name: 'third', phase: 'security' },
        ] as const;
      `,
      'hole.spec.ts',
      1,
      'hole'
    );
  });

  it('rejects computed property names with file, element index, and property', () => {
    expect(() =>
      parseSpecSource(
        `
          export const S = [
            { ['name']: 'computed', phase: 'security' },
          ] as const;
        `,
        'computed.spec.ts'
      )
    ).toThrow(/computed\.spec\.ts\[0\]\.name:.*computed/);
  });

  it('rejects malformed known metadata with file, element index, and property', () => {
    expect(() =>
      parseSpecSource(
        `
          export const S = [
            { name: 123, phase: 'security' },
          ] as const;
        `,
        'malformed.spec.ts'
      )
    ).toThrow(/malformed\.spec\.ts\[0\]\.name/);

    expect(() =>
      parseSpecSource(
        `
          export const S = [
            { name: 'x', phase: 'not-a-phase' },
          ] as const;
        `,
        'malformed.spec.ts'
      )
    ).toThrow(/malformed\.spec\.ts\[0\]\.phase/);

    expect(() =>
      parseSpecSource(
        `
          export const S = [
            { name: 'x', phase: 'security', required: 1 },
          ] as const;
        `,
        'malformed.spec.ts'
      )
    ).toThrow(/malformed\.spec\.ts\[0\]\.required/);

    expect(() =>
      parseSpecSource(
        `
          export const S = [
            { name: 'x', phase: 'security', description: title },
          ] as const;
        `,
        'malformed.spec.ts'
      )
    ).toThrow(/malformed\.spec\.ts\[0\]\.description/);

    expect(() =>
      parseSpecSource(
        `
          export const S = [
            { name: 'x', phase: 'security', dependencies: [ghost] },
          ] as const;
        `,
        'malformed.spec.ts'
      )
    ).toThrow(/malformed\.spec\.ts\[0\]\.dependencies/);
  });
});

describe('buildPlanFromSources – topo-sort and batching', () => {
  it('produces dependency-ordered batches', async () => {
    const inputs = [
      {
        file: 'a.spec.ts',
        source: `
          export const A_FEATURES = [
            { name: 'first', phase: 'deferred' },
            { name: 'second', phase: 'deferred', dependencies: ['first'] },
            { name: 'third', phase: 'deferred', dependencies: ['second'] },
            { name: 'parallel', phase: 'deferred' },
          ] as const;
        `,
      },
    ];
    const { plan } = await buildPlanFromSources(inputs);
    expect(plan.deferred).toEqual([['first', 'parallel'], ['second'], ['third']]);
  });

  it('detects cycles', async () => {
    const inputs = [
      {
        file: 'cycle.spec.ts',
        source: `
          export const C = [
            { name: 'x', phase: 'ui', dependencies: ['y'] },
            { name: 'y', phase: 'ui', dependencies: ['x'] },
          ] as const;
        `,
      },
    ];
    await expect(buildPlanFromSources(inputs)).rejects.toThrow(/Circular dependency/);
  });

  it('rejects unknown dependencies', async () => {
    const inputs = [
      {
        file: 'unknown.spec.ts',
        source: `
          export const U = [
            { name: 'x', phase: 'ui', dependencies: ['ghost'] },
          ] as const;
        `,
      },
    ];
    await expect(buildPlanFromSources(inputs)).rejects.toThrow(
      /depends on unknown feature 'ghost'/
    );
  });

  it('rejects duplicate feature names across spec files', async () => {
    const inputs = [
      {
        file: 'a.spec.ts',
        source: `export const A = [{ name: 'dup', phase: 'ui' }] as const;`,
      },
      {
        file: 'b.spec.ts',
        source: `export const B = [{ name: 'dup', phase: 'security' }] as const;`,
      },
    ];
    await expect(buildPlanFromSources(inputs)).rejects.toThrow(/Duplicate feature name: 'dup'/);
  });

  it('tolerates cross-phase dependencies (depended-on feature in earlier phase)', async () => {
    const inputs = [
      {
        file: 'cross.spec.ts',
        source: `
          export const X = [
            { name: 'early', phase: 'security' },
            { name: 'late', phase: 'deferred', dependencies: ['early'] },
          ] as const;
        `,
      },
    ];
    const { plan } = await buildPlanFromSources(inputs);
    expect(plan.security).toEqual([['early']]);
    expect(plan.deferred).toEqual([['late']]);
  });

  it('allows same-phase dependencies', async () => {
    const inputs = [
      {
        file: 'same-phase.spec.ts',
        source: `
          export const X = [
            { name: 'first', phase: 'ui' },
            { name: 'second', phase: 'ui', dependencies: ['first'] },
          ] as const;
        `,
      },
    ];
    const { plan } = await buildPlanFromSources(inputs);
    expect(plan.ui).toEqual([['first'], ['second']]);
  });

  it('rejects forward-phase dependencies under security < critical < ui < deferred', async () => {
    const inputs = [
      {
        file: 'forward.spec.ts',
        source: `
          export const X = [
            { name: 'early', phase: 'security', dependencies: ['late'] },
            { name: 'late', phase: 'deferred' },
          ] as const;
        `,
      },
    ];
    await expect(buildPlanFromSources(inputs)).rejects.toThrow(
      /forward\.spec\.ts\[0\]\.dependencies/
    );
  });
});

describe('generateFeaturePlan – atomic write', () => {
  it('leaves an existing output fixture unchanged when generation fails', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gogchat-feature-plan-'));
    try {
      const specsDir = path.join(tmp, 'src/main/initializers');
      const generatedDir = path.join(tmp, 'src/main/generated');
      fs.mkdirSync(specsDir, { recursive: true });
      fs.mkdirSync(generatedDir, { recursive: true });
      const outputPath = path.join(generatedDir, 'featurePlan.ts');
      const sentinel = '// SENTINEL-DO-NOT-TOUCH\n';
      fs.writeFileSync(outputPath, sentinel);
      fs.writeFileSync(
        path.join(specsDir, 'bad.spec.ts'),
        `export const BAD = [ ...otherFeatures ] as const;\n`
      );

      await expect(generateFeaturePlan({ projectRoot: tmp, write: true })).rejects.toThrow(
        /bad\.spec\.ts\[0\]/
      );
      expect(fs.readFileSync(outputPath, 'utf-8')).toBe(sentinel);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
