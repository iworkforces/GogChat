import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RELEASE_ARTIFACT_SIDECAR_SCHEMA_VERSION,
  buildReleaseArtifactSidecar,
  compareReleaseArtifactSidecar,
  collectReleaseArtifactSidecarEvidence,
  inspectReleaseArtifactFile,
  parseReleaseArtifactSidecar,
  serializeReleaseArtifactSidecar,
} from './release-artifact-sidecar.js';

function validSidecar(overrides = {}) {
  return {
    schemaVersion: RELEASE_ARTIFACT_SIDECAR_SCHEMA_VERSION,
    sourceSha: SOURCE_SHA,
    packageVersion: '3.21.4',
    platform: 'macos',
    arch: 'arm64',
    basename: 'GogChat-3.21.4-arm64.dmg',
    size: 7,
    sha256: 'a'.repeat(64),
    ...overrides,
  };
}

const SOURCE_SHA = 'f'.repeat(40);

describe('release-artifact-sidecar', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gogchat-sidecar-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('binds binary size and both digests to the bytes read during validation', () => {
    const basename = 'GogChat-3.21.4-arm64.dmg';
    const binaryPath = path.join(tmpRoot, basename);
    const digest = crypto.createHash('sha256').update('payload').digest('hex');
    const raw = serializeReleaseArtifactSidecar(validSidecar({ sha256: digest }));
    fs.writeFileSync(binaryPath, 'payload');
    fs.writeFileSync(`${binaryPath}.json`, raw);
    const read = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, ...args) => {
      const bytes = read(filePath, ...args);
      if (filePath === binaryPath) fs.writeFileSync(binaryPath, 'changed payload');
      if (filePath === `${binaryPath}.json`) fs.appendFileSync(filePath, ' ');
      return bytes;
    });

    const evidence = collectReleaseArtifactSidecarEvidence({
      inputDir: tmpRoot,
      artifacts: [{ relativePath: basename, arch: 'arm64', platform: 'macos' }],
      expectedSourceSha: SOURCE_SHA,
      expectedPackageVersion: '3.21.4',
    });

    expect(evidence).toEqual({
      violations: [],
      pairs: [{ binaryRelativePath: basename, sidecarRelativePath: `${basename}.json` }],
      files: [
        { relativePath: basename, sha256: digest },
        {
          relativePath: `${basename}.json`,
          sha256: crypto.createHash('sha256').update(raw).digest('hex'),
        },
      ],
    });
  });

  it('builds a deterministic sidecar from the producer file and release identity', () => {
    const filePath = path.join(tmpRoot, 'GogChat-3.21.4-arm64.dmg');
    fs.writeFileSync(filePath, 'payload');

    const sidecar = buildReleaseArtifactSidecar({
      sourceSha: SOURCE_SHA.toUpperCase(),
      packageVersion: '3.21.4',
      platform: 'macos',
      arch: 'arm64',
      filePath,
    });

    expect(sidecar).toMatchObject({
      schemaVersion: RELEASE_ARTIFACT_SIDECAR_SCHEMA_VERSION,
      sourceSha: SOURCE_SHA,
      packageVersion: '3.21.4',
      platform: 'macos',
      arch: 'arm64',
      basename: 'GogChat-3.21.4-arm64.dmg',
      size: 7,
    });
    expect(serializeReleaseArtifactSidecar(sidecar).startsWith('{\n  "schemaVersion":')).toBe(true);
  });

  it('treats invalid JSON, missing fields, and extra fields as malformed', () => {
    expect(parseReleaseArtifactSidecar('{', 'broken.json').violations).toEqual([
      'Malformed sidecar broken.json: invalid JSON',
    ]);
    expect(parseReleaseArtifactSidecar('[]', 'array.json').violations).toEqual([
      'Malformed sidecar array.json: expected an object',
    ]);
    expect(
      parseReleaseArtifactSidecar(
        JSON.stringify({
          schemaVersion: 1,
          extra: true,
        }),
        'partial.json'
      ).violations
    ).toEqual([
      'Malformed sidecar partial.json: unexpected fields extra',
      'Malformed sidecar partial.json: missing fields sourceSha, packageVersion, platform, arch, basename, size, sha256',
    ]);
    expect(
      parseReleaseArtifactSidecar(
        JSON.stringify(validSidecar({ constructor: 'nope', toString: 'nope' })),
        'proto.json'
      ).violations
    ).toEqual(['Malformed sidecar proto.json: unexpected fields constructor, toString']);
  });

  it('rejects unsupported schema, empty identity, path basenames, and invalid size or digest', () => {
    expect(
      parseReleaseArtifactSidecar(JSON.stringify(validSidecar({ schemaVersion: 2 })), 'v.json')
    ).toMatchObject({
      ok: false,
      violations: ['Malformed sidecar v.json: unsupported schemaVersion 2'],
    });
    expect(
      parseReleaseArtifactSidecar(
        JSON.stringify(validSidecar({ sourceSha: 'not-a-sha' })),
        's.json'
      ).violations
    ).toEqual(['Malformed sidecar s.json: sourceSha must be a 40-character hex object id']);
    expect(
      parseReleaseArtifactSidecar(JSON.stringify(validSidecar({ packageVersion: '   ' })), 'p.json')
        .violations
    ).toEqual(['Malformed sidecar p.json: packageVersion must be a non-empty string']);
    expect(
      parseReleaseArtifactSidecar(
        JSON.stringify(validSidecar({ basename: 'nested/GogChat-3.21.4-arm64.dmg' })),
        'b.json'
      ).violations
    ).toEqual(['Malformed sidecar b.json: basename must be a file name']);
    expect(
      parseReleaseArtifactSidecar(JSON.stringify(validSidecar({ size: 0 })), 'z.json').violations
    ).toEqual(['Malformed sidecar z.json: size must be a positive integer']);
    expect(
      parseReleaseArtifactSidecar(JSON.stringify(validSidecar({ size: 1.5 })), 'f.json').violations
    ).toEqual(['Malformed sidecar f.json: size must be a positive integer']);
    expect(
      parseReleaseArtifactSidecar(JSON.stringify(validSidecar({ sha256: 'deadbeef' })), 'h.json')
        .violations
    ).toEqual(['Malformed sidecar h.json: sha256 must be a 64-character hex digest']);
  });

  it('rejects empty producer files before a sidecar is written', () => {
    const filePath = path.join(tmpRoot, 'GogChat-3.21.4-arm64.dmg');
    fs.writeFileSync(filePath, '');
    expect(inspectReleaseArtifactFile(filePath, 'GogChat-3.21.4-arm64.dmg')).toEqual({
      ok: false,
      violation: 'Empty artifact GogChat-3.21.4-arm64.dmg',
    });
    expect(() =>
      buildReleaseArtifactSidecar({
        sourceSha: SOURCE_SHA,
        packageVersion: '3.21.4',
        platform: 'macos',
        arch: 'arm64',
        filePath,
      })
    ).toThrow('Empty artifact GogChat-3.21.4-arm64.dmg');
  });

  it('reports field mismatches against the expected producer sidecar', () => {
    const expected = {
      schemaVersion: 1,
      sourceSha: SOURCE_SHA,
      packageVersion: '3.21.4',
      platform: 'macos',
      arch: 'arm64',
      basename: 'GogChat-3.21.4-arm64.dmg',
      size: 7,
      sha256: 'a'.repeat(64),
    };
    const actual = {
      ...expected,
      platform: 'windows',
      arch: 'x64',
      sourceSha: 'e'.repeat(40),
      packageVersion: '0.0.1',
      size: 8,
      sha256: 'b'.repeat(64),
    };

    expect(compareReleaseArtifactSidecar(actual, expected, 'file.json')).toEqual([
      'Platform-mismatched sidecar file.json: expected macos, got windows',
      'Architecture-mismatched sidecar file.json: expected arm64, got x64',
      `Cross-source sidecar file.json: expected ${SOURCE_SHA}, got ${'e'.repeat(40)}`,
      'Cross-version sidecar file.json: expected 3.21.4, got 0.0.1',
      'Size-mismatched sidecar file.json: expected 7, got 8',
      `Digest-mismatched sidecar file.json: expected ${'a'.repeat(64)}, got ${'b'.repeat(64)}`,
    ]);
  });
});
