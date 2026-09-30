import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RELEASE_ARTIFACT_SIDECAR_SCHEMA_VERSION,
  serializeReleaseArtifactSidecar,
} from './release-artifact-sidecar.js';
import { findReleaseArtifactViolations } from './verify-release-artifacts.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE_SHA = 'c'.repeat(40);
const PACKAGE_VERSION = '3.15.1';
const IDENTITY = { sourceSha: SOURCE_SHA, packageVersion: PACKAGE_VERSION };

const ARTIFACTS = {
  macArm: { name: 'GogChat-3.15.1-arm64.dmg', contents: 'arm64', platform: 'macos', arch: 'arm64' },
  macX64: { name: 'GogChat-3.15.1-x64.dmg', contents: 'x64', platform: 'macos', arch: 'x64' },
  winX64: {
    name: 'GogChat-3.15.1-windows-x64-setup.exe',
    contents: 'win-x64',
    platform: 'windows',
    arch: 'x64',
  },
  winArm: {
    name: 'GogChat-3.15.1-windows-arm64-setup.exe',
    contents: 'win-arm64',
    platform: 'windows',
    arch: 'arm64',
  },
};

function writeBinary(dir, artifact, contents = artifact.contents) {
  const filePath = path.join(dir, artifact.name);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function sidecarFor(artifact, contents, overrides = {}) {
  const body = contents ?? artifact.contents;
  return {
    schemaVersion: RELEASE_ARTIFACT_SIDECAR_SCHEMA_VERSION,
    sourceSha: SOURCE_SHA,
    packageVersion: PACKAGE_VERSION,
    platform: artifact.platform,
    arch: artifact.arch,
    basename: artifact.name,
    size: Buffer.byteLength(body),
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    ...overrides,
  };
}

function writeSidecar(dir, artifact, overrides = {}, contents = artifact.contents) {
  fs.writeFileSync(
    path.join(dir, `${artifact.name}.json`),
    serializeReleaseArtifactSidecar(sidecarFor(artifact, contents, overrides))
  );
}

function writeCompleteSet(dir) {
  for (const artifact of Object.values(ARTIFACTS)) {
    writeBinary(dir, artifact);
    writeSidecar(dir, artifact);
  }
}

describe('verify-release-artifacts aggregation helper', () => {
  let tmpRoot;
  let fixtureRoot;

  beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gogchat-release-artifacts-'));
    tmpRoot = path.join(fixtureRoot, 'input');
    fs.mkdirSync(tmpRoot);
  });

  afterEach(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function runVerifier(outputDir, preload = '') {
    const preloadPath = path.join(fixtureRoot, 'inject.cjs');
    if (preload) fs.writeFileSync(preloadPath, preload);
    return spawnSync(
      process.execPath,
      [
        ...(preload ? ['--require', preloadPath] : []),
        'scripts/verify-release-artifacts.js',
        '--input',
        tmpRoot,
        ...(outputDir ? ['--output', outputDir] : []),
        '--source-sha',
        SOURCE_SHA,
        '--package-version',
        PACKAGE_VERSION,
      ],
      { cwd: PROJECT_ROOT, encoding: 'utf-8' }
    );
  }

  it.each(['directory', 'file', 'dangling link', 'symlink'])(
    'preserves an existing output %s',
    (kind) => {
      writeCompleteSet(tmpRoot);
      const outputDir = path.join(fixtureRoot, 'verified');
      if (kind === 'directory') {
        fs.mkdirSync(outputDir);
        fs.writeFileSync(path.join(outputDir, 'sentinel'), 'keep');
      } else if (kind === 'file') {
        fs.writeFileSync(outputDir, 'keep');
      } else if (kind === 'dangling link') {
        fs.symlinkSync(path.join(fixtureRoot, 'missing'), outputDir);
      } else {
        const target = path.join(fixtureRoot, 'target');
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'sentinel'), 'keep');
        fs.symlinkSync(target, outputDir);
      }

      const result = runVerifier(outputDir);

      expect(result.status).toBe(1);
      if (kind === 'directory')
        expect(fs.readFileSync(path.join(outputDir, 'sentinel'), 'utf8')).toBe('keep');
      else if (kind === 'file') expect(fs.readFileSync(outputDir, 'utf8')).toBe('keep');
      else if (kind === 'dangling link')
        expect(fs.readlinkSync(outputDir)).toBe(path.join(fixtureRoot, 'missing'));
      else {
        expect(fs.readlinkSync(outputDir)).toBe(path.join(fixtureRoot, 'target'));
        expect(fs.readFileSync(path.join(outputDir, 'sentinel'), 'utf8')).toBe('keep');
      }
      expect(fs.readFileSync(path.join(tmpRoot, ARTIFACTS.macArm.name), 'utf8')).toBe('arm64');
    }
  );

  it.each(['equal', 'ancestor', 'descendant', 'alias equal', 'alias descendant', 'alias ancestor'])(
    'refuses %s input/output topology without changing input',
    (kind) => {
      writeCompleteSet(tmpRoot);
      const alias = path.join(fixtureRoot, 'alias');
      fs.symlinkSync(kind === 'alias ancestor' ? fixtureRoot : tmpRoot, alias);
      const outputs = {
        equal: tmpRoot,
        ancestor: fixtureRoot,
        descendant: path.join(tmpRoot, 'new', 'verified'),
        'alias equal': alias,
        'alias descendant': path.join(alias, 'new', 'verified'),
        'alias ancestor': alias,
      };

      const result = runVerifier(outputs[kind]);

      expect(result.status).toBe(1);
      expect(fs.readdirSync(tmpRoot).sort()).toEqual(
        Object.values(ARTIFACTS)
          .flatMap(({ name }) => [name, `${name}.json`])
          .sort()
      );
      expect(fs.readFileSync(path.join(tmpRoot, ARTIFACTS.macArm.name), 'utf8')).toBe('arm64');
    }
  );

  it.each([
    'copy',
    'binary mutation',
    'sidecar mutation',
    'paired mutation',
    'staged mutation',
    'staged sidecar mutation',
    'checksums',
    'rename',
    'destination appears',
    'empty destination appears',
  ])('cleans only owned staging when %s fails on the spawned CLI', (mode) => {
    writeCompleteSet(tmpRoot);
    const outputDir = path.join(fixtureRoot, 'verified');
    const receipt = path.join(fixtureRoot, 'staging.json');
    const unrelated = path.join(fixtureRoot, '.release-staging-unrelated');
    fs.mkdirSync(unrelated);
    fs.writeFileSync(path.join(unrelated, 'sentinel'), 'keep');
    const preload = `
        const fs = require('node:fs');
        const path = require('node:path');
        const crypto = require('node:crypto');
        const mode = ${JSON.stringify(mode)};
        const output = ${JSON.stringify(outputDir)};
        const receipt = ${JSON.stringify(receipt)};
        const mkdtemp = fs.mkdtempSync;
        fs.mkdtempSync = (...args) => {
          const stage = mkdtemp(...args);
          fs.writeFileSync(receipt, JSON.stringify(stage));
          return stage;
        };
        const copy = fs.copyFileSync;
        let copies = 0;
        fs.copyFileSync = (source, target, ...args) => {
          copies += 1;
          if (mode === 'copy' && copies === 3) throw new Error('injected copy failure');
          if (copies === 1) {
            if (mode === 'binary mutation' || mode === 'paired mutation') {
              fs.writeFileSync(source, 'changed');
              if (mode === 'paired mutation') {
                const sidecar = JSON.parse(fs.readFileSync(source + '.json', 'utf8'));
                sidecar.size = 7;
                sidecar.sha256 = crypto.createHash('sha256').update('changed').digest('hex');
                fs.writeFileSync(source + '.json', JSON.stringify(sidecar));
              }
            }
            if (mode === 'sidecar mutation') fs.appendFileSync(source + '.json', ' ');
          }
          const result = copy(source, target, ...args);
          if (mode === 'staged mutation' && copies === 1) fs.writeFileSync(target, 'corrupt');
          if (mode === 'staged sidecar mutation' && copies === 2) {
            const sidecar = JSON.parse(fs.readFileSync(target, 'utf8'));
            sidecar.schemaVersion = 2;
            fs.writeFileSync(target, JSON.stringify(sidecar));
          }
          return result;
        };
        const write = fs.writeFileSync;
        fs.writeFileSync = (target, ...args) => {
          if (path.basename(String(target)) === 'SHA256SUMS.txt') {
            if (mode === 'checksums') throw new Error('injected checksum failure');
            if (mode === 'destination appears' || mode === 'empty destination appears') {
              fs.mkdirSync(output);
              if (mode === 'destination appears') write(path.join(output, 'sentinel'), 'keep');
            }
          }
          return write(target, ...args);
        };
        const rename = fs.renameSync;
        fs.renameSync = (...args) => {
          if (mode === 'rename') throw new Error('injected publication failure');
          return rename(...args);
        };
      `;

    const result = runVerifier(outputDir, preload);

    expect(result.status).toBe(1);
    expect(result.stderr).not.toBe('');
    if (mode === 'destination appears') {
      expect(fs.readdirSync(outputDir)).toEqual(['sentinel']);
      expect(fs.readFileSync(path.join(outputDir, 'sentinel'), 'utf8')).toBe('keep');
    } else if (mode === 'empty destination appears') expect(fs.readdirSync(outputDir)).toEqual([]);
    else expect(fs.existsSync(outputDir)).toBe(false);
    const stage = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    expect(path.relative(fs.realpathSync(tmpRoot), stage).startsWith('..')).toBe(true);
    expect(fs.existsSync(stage)).toBe(false);
    expect(fs.readFileSync(path.join(unrelated, 'sentinel'), 'utf8')).toBe('keep');
    expect(fs.readFileSync(path.join(tmpRoot, ARTIFACTS.winX64.name), 'utf8')).toBe('win-x64');
  });

  it.each(['binary', 'sidecar'])(
    'rejects %s bytes changed immediately after initial inspection',
    (kind) => {
      writeCompleteSet(tmpRoot);
      const outputDir = path.join(fixtureRoot, 'verified');
      const target = path.join(
        tmpRoot,
        ARTIFACTS.macArm.name + (kind === 'sidecar' ? '.json' : '')
      );
      const receipt = path.join(fixtureRoot, 'reads.json');
      const preload = `
      const fs = require('node:fs');
      const read = fs.readFileSync;
      const target = ${JSON.stringify(target)};
      let reads = 0;
      fs.readFileSync = (file, ...args) => {
        const bytes = read(file, ...args);
        if (file === target) {
          reads += 1;
          fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(reads));
          if (reads === 1) fs.appendFileSync(target, ' ');
        }
        return bytes;
      };
    `;

      const result = runVerifier(outputDir, preload);

      expect(result.status).toBe(1);
      expect(fs.existsSync(outputDir)).toBe(false);
      expect(JSON.parse(fs.readFileSync(receipt, 'utf8'))).toBe(1);
      expect(
        fs.readdirSync(fixtureRoot).filter((name) => name.startsWith('.release-staging-'))
      ).toEqual([]);
    }
  );

  it('accepts aliased input and a disjoint aliased output parent with missing directories', () => {
    writeCompleteSet(tmpRoot);
    const inputAlias = path.join(fixtureRoot, 'input-alias');
    const parentAlias = path.join(fixtureRoot, 'parent-alias');
    fs.symlinkSync(tmpRoot, inputAlias);
    fs.symlinkSync(fixtureRoot, parentAlias);
    tmpRoot = inputAlias;
    const output = path.join(parentAlias, 'new', 'nested', 'verified');

    const result = runVerifier(output);

    expect(result.status).toBe(0);
    expect(fs.readdirSync(output)).toHaveLength(9);
    expect(
      fs.readdirSync(fixtureRoot).filter((name) => name.startsWith('.release-staging-'))
    ).toEqual([]);
  });

  it('keeps validation-only JSON and nested relative paths', () => {
    const nested = path.join(tmpRoot, 'nested');
    fs.mkdirSync(nested);
    writeCompleteSet(nested);

    const result = runVerifier();

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).artifacts).toEqual(
      Object.values(ARTIFACTS)
        .flatMap(({ name }) => [`nested/${name}`, `nested/${name}.json`])
        .sort()
    );
    expect(fs.readdirSync(fixtureRoot).sort()).toEqual(['input']);
  });

  it('accepts one macOS DMG, one Windows setup, and one sidecar per official architecture', () => {
    writeCompleteSet(tmpRoot);

    expect(findReleaseArtifactViolations(tmpRoot, IDENTITY)).toEqual([]);
  });

  it('reports missing macOS arch when only arm64 DMG is present', () => {
    writeBinary(tmpRoot, ARTIFACTS.macArm);
    writeSidecar(tmpRoot, ARTIFACTS.macArm);
    writeBinary(tmpRoot, ARTIFACTS.winX64);
    writeSidecar(tmpRoot, ARTIFACTS.winX64);
    writeBinary(tmpRoot, ARTIFACTS.winArm);
    writeSidecar(tmpRoot, ARTIFACTS.winArm);

    expect(findReleaseArtifactViolations(tmpRoot, IDENTITY)).toEqual([
      'Missing required macOS DMG arch: x64',
    ]);
  });

  it('reports missing macOS/Windows arches, duplicate filenames, and forbidden outputs', () => {
    const nestedDir = path.join(tmpRoot, 'nested');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'GogChat-3.15.1-windows-x64-setup.exe'), 'x64');
    fs.writeFileSync(path.join(nestedDir, 'GogChat-3.15.1-windows-x64-setup.exe'), 'duplicate');
    fs.writeFileSync(path.join(tmpRoot, 'GogChat-3.15.1-windows-ia32-setup.exe'), 'ia32');
    fs.writeFileSync(path.join(tmpRoot, 'GogChat-3.15.1-amd64.dmg'), 'bad');

    expect(findReleaseArtifactViolations(tmpRoot, IDENTITY)).toEqual([
      'Missing required macOS DMG arch: arm64',
      'Missing required macOS DMG arch: x64',
      'Missing required Windows installer arch: arm64',
      'Duplicate release artifact filename: GogChat-3.15.1-windows-x64-setup.exe',
      'Forbidden macOS artifact arch label "amd64" in GogChat-3.15.1-amd64.dmg',
      'Duplicate Windows installer outputs for x64: GogChat-3.15.1-windows-x64-setup.exe, nested/GogChat-3.15.1-windows-x64-setup.exe',
      'Forbidden Windows artifact arch label "ia32" in GogChat-3.15.1-windows-ia32-setup.exe',
      'Missing sidecar for GogChat-3.15.1-windows-x64-setup.exe',
    ]);
  });

  it('rejects missing, duplicate, and orphaned sidecars', () => {
    writeCompleteSet(tmpRoot);
    fs.unlinkSync(path.join(tmpRoot, `${ARTIFACTS.macX64.name}.json`));
    const extraDir = path.join(tmpRoot, 'extra');
    fs.mkdirSync(extraDir, { recursive: true });
    fs.copyFileSync(
      path.join(tmpRoot, `${ARTIFACTS.macArm.name}.json`),
      path.join(extraDir, `${ARTIFACTS.macArm.name}.json`)
    );
    fs.writeFileSync(
      path.join(tmpRoot, 'GogChat-3.15.1-orphan.dmg.json'),
      serializeReleaseArtifactSidecar(
        sidecarFor(ARTIFACTS.macArm, ARTIFACTS.macArm.contents, {
          basename: 'GogChat-3.15.1-orphan.dmg',
        })
      )
    );

    const violations = findReleaseArtifactViolations(tmpRoot, IDENTITY);
    expect(violations).toContain(
      'Duplicate release artifact filename: GogChat-3.15.1-arm64.dmg.json'
    );
    expect(violations).toContain('Missing sidecar for GogChat-3.15.1-x64.dmg');
    expect(violations).toContain(
      'Duplicate sidecar for GogChat-3.15.1-arm64.dmg: extra/GogChat-3.15.1-arm64.dmg.json, GogChat-3.15.1-arm64.dmg.json'
    );
    expect(violations).toContain('Orphaned sidecar: GogChat-3.15.1-orphan.dmg.json');
  });

  it('rejects malformed, cross-source, cross-version, and mismatched sidecar evidence', () => {
    writeCompleteSet(tmpRoot);
    fs.writeFileSync(path.join(tmpRoot, `${ARTIFACTS.macArm.name}.json`), '{not-json');
    writeSidecar(tmpRoot, ARTIFACTS.macX64, { sourceSha: 'd'.repeat(40) });
    writeSidecar(tmpRoot, ARTIFACTS.winX64, { packageVersion: '9.9.9' });
    writeSidecar(tmpRoot, ARTIFACTS.winArm, { arch: 'x64' });

    const violations = findReleaseArtifactViolations(tmpRoot, IDENTITY);
    expect(violations).toContain(`Malformed sidecar ${ARTIFACTS.macArm.name}.json: invalid JSON`);
    expect(violations).toContain(
      `Cross-source sidecar ${ARTIFACTS.macX64.name}.json: expected ${SOURCE_SHA}, got ${'d'.repeat(40)}`
    );
    expect(violations).toContain(
      `Cross-version sidecar ${ARTIFACTS.winX64.name}.json: expected ${PACKAGE_VERSION}, got 9.9.9`
    );
    expect(violations).toContain(
      `Architecture-mismatched sidecar ${ARTIFACTS.winArm.name}.json: expected arm64, got x64`
    );
  });

  it('rejects size and digest mismatches before copying files or writing checksums', () => {
    writeCompleteSet(tmpRoot);
    writeSidecar(tmpRoot, ARTIFACTS.macArm, { size: 999 });
    writeSidecar(tmpRoot, ARTIFACTS.macX64, { sha256: 'e'.repeat(64) });
    const outputDir = path.join(fixtureRoot, 'verified');

    const result = spawnSync(
      process.execPath,
      [
        'scripts/verify-release-artifacts.js',
        '--input',
        tmpRoot,
        '--output',
        outputDir,
        '--source-sha',
        SOURCE_SHA,
        '--package-version',
        PACKAGE_VERSION,
      ],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Size-mismatched sidecar ${ARTIFACTS.macArm.name}.json: expected 5, got 999`
    );
    expect(result.stderr).toContain(
      `Digest-mismatched sidecar ${ARTIFACTS.macX64.name}.json: expected ${crypto
        .createHash('sha256')
        .update('x64')
        .digest('hex')}, got ${'e'.repeat(64)}`
    );
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  it('copies verified release assets and writes SHA-256 checksums from the output bytes', () => {
    const outputDir = path.join(fixtureRoot, 'verified');
    writeCompleteSet(tmpRoot);

    const result = spawnSync(
      process.execPath,
      [
        'scripts/verify-release-artifacts.js',
        '--input',
        tmpRoot,
        '--output',
        outputDir,
        '--source-sha',
        SOURCE_SHA,
        '--package-version',
        PACKAGE_VERSION,
      ],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
      }
    );

    expect(result.status).toBe(0);
    expect(fs.readdirSync(outputDir).sort()).toEqual([
      'GogChat-3.15.1-arm64.dmg',
      'GogChat-3.15.1-arm64.dmg.json',
      'GogChat-3.15.1-windows-arm64-setup.exe',
      'GogChat-3.15.1-windows-arm64-setup.exe.json',
      'GogChat-3.15.1-windows-x64-setup.exe',
      'GogChat-3.15.1-windows-x64-setup.exe.json',
      'GogChat-3.15.1-x64.dmg',
      'GogChat-3.15.1-x64.dmg.json',
      'SHA256SUMS.txt',
    ]);
    const checksums = fs.readFileSync(path.join(outputDir, 'SHA256SUMS.txt'), 'utf-8');
    const dmgDigest = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(outputDir, 'GogChat-3.15.1-x64.dmg')))
      .digest('hex');
    const installerDigest = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(outputDir, 'GogChat-3.15.1-windows-x64-setup.exe')))
      .digest('hex');
    expect(checksums).toContain(`${dmgDigest}  GogChat-3.15.1-x64.dmg`);
    expect(checksums).toContain(`${installerDigest}  GogChat-3.15.1-windows-x64-setup.exe`);
    const sidecarDigest = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(outputDir, 'GogChat-3.15.1-x64.dmg.json')))
      .digest('hex');
    expect(checksums).toContain(`${sidecarDigest}  GogChat-3.15.1-x64.dmg.json`);
    const expectedLines = Object.values(ARTIFACTS)
      .flatMap((artifact) => [
        [artifact.name, artifact.contents],
        [`${artifact.name}.json`, serializeReleaseArtifactSidecar(sidecarFor(artifact))],
      ])
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(
        ([name, bytes]) => `${crypto.createHash('sha256').update(bytes).digest('hex')}  ${name}`
      );
    expect(checksums).toBe(`${expectedLines.join('\n')}\n`);
    const secondOutput = path.join(fixtureRoot, 'verified-again');
    expect(runVerifier(secondOutput).status).toBe(0);
    expect(fs.readFileSync(path.join(secondOutput, 'SHA256SUMS.txt'), 'utf8')).toBe(checksums);
  });

  it('copies a unique non-sibling sidecar from its discovered path', () => {
    const outputDir = path.join(fixtureRoot, 'verified');
    const nestedDir = path.join(tmpRoot, 'macos');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, ARTIFACTS.macArm.name), ARTIFACTS.macArm.contents);
    writeSidecar(tmpRoot, ARTIFACTS.macArm);
    writeBinary(tmpRoot, ARTIFACTS.macX64);
    writeSidecar(tmpRoot, ARTIFACTS.macX64);
    writeBinary(tmpRoot, ARTIFACTS.winX64);
    writeSidecar(tmpRoot, ARTIFACTS.winX64);
    writeBinary(tmpRoot, ARTIFACTS.winArm);
    writeSidecar(tmpRoot, ARTIFACTS.winArm);

    const result = spawnSync(
      process.execPath,
      [
        'scripts/verify-release-artifacts.js',
        '--input',
        tmpRoot,
        '--output',
        outputDir,
        '--source-sha',
        SOURCE_SHA,
        '--package-version',
        PACKAGE_VERSION,
      ],
      { cwd: PROJECT_ROOT, encoding: 'utf-8' }
    );

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(outputDir, ARTIFACTS.macArm.name))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, `${ARTIFACTS.macArm.name}.json`))).toBe(true);
  });

  it('requires source SHA and package version on the CLI', () => {
    writeCompleteSet(tmpRoot);
    const result = spawnSync(
      process.execPath,
      ['scripts/verify-release-artifacts.js', '--input', tmpRoot],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
      }
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--source-sha requires a 40-character hex object id');
  });
});
