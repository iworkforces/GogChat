#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { collectReleaseArtifactSidecarEvidence } from './release-artifact-sidecar.js';
import { copyVerifiedArtifacts } from './release-artifact-staging.js';
import {
  findMacosDmgs,
  findMacosPackageArtifactViolations,
  MACOS_DMG_ARCHES,
} from './verify-macos-package-artifacts.js';
import {
  findWindowsInstallers,
  findWindowsPackageArtifactViolations,
} from './verify-windows-package-artifacts.js';

const REQUIRED_MACOS_ARCHES = [...MACOS_DMG_ARCHES];
const REQUIRED_WINDOWS_ARCHES = ['x64', 'arm64'];

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

function usage() {
  return [
    'Usage: bun scripts/verify-release-artifacts.js --input <dir> --source-sha <sha> --package-version <version> [--output <dir>]',
    '',
    'Verifies aggregated macOS arm64/x64 DMG and Windows x64/arm64 NSIS setup artifacts',
    'and their versioned JSON sidecars before release publishing.',
  ].join('\n');
}

function normalizeRelativePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function listFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function findDuplicateArtifactFileNames(inputDir) {
  const fileNames = new Map();
  for (const filePath of listFiles(inputDir)) {
    const fileName = path.basename(filePath);
    const relativePath = normalizeRelativePath(path.relative(inputDir, filePath));
    const paths = fileNames.get(fileName) ?? [];
    paths.push(relativePath);
    fileNames.set(fileName, paths);
  }

  return [...fileNames.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([fileName]) => `Duplicate release artifact filename: ${fileName}`)
    .sort((left, right) => left.localeCompare(right));
}

function splitMissingViolations(violations, platformPrefix) {
  return {
    missing: violations.filter((violation) =>
      violation.startsWith(`Missing required ${platformPrefix}`)
    ),
    remaining: violations.filter(
      (violation) => !violation.startsWith(`Missing required ${platformPrefix}`)
    ),
  };
}

function collectAcceptedReleaseArtifacts(inputDir) {
  return [
    ...findMacosDmgs(inputDir).map((dmg) => ({ ...dmg, platform: 'macos' })),
    ...findWindowsInstallers(inputDir).map((installer) => ({
      ...installer,
      platform: 'windows',
    })),
  ];
}

function collectSidecarEvidence(inputDir, options = {}) {
  try {
    return collectReleaseArtifactSidecarEvidence({
      inputDir,
      artifacts: collectAcceptedReleaseArtifacts(inputDir),
      expectedSourceSha: options.sourceSha,
      expectedPackageVersion: options.packageVersion,
    });
  } catch (error) {
    return {
      violations: [`Failed to inspect sidecar evidence: ${error.message}`],
      pairs: [],
      files: [],
    };
  }
}

function collectReleaseEvidence(inputDir, options = {}) {
  const macViolations = splitMissingViolations(
    findMacosPackageArtifactViolations(inputDir, REQUIRED_MACOS_ARCHES),
    'macOS'
  );
  const windowsViolations = splitMissingViolations(
    findWindowsPackageArtifactViolations(inputDir, REQUIRED_WINDOWS_ARCHES),
    'Windows'
  );
  const sidecarEvidence = collectSidecarEvidence(inputDir, options);

  return {
    ...sidecarEvidence,
    violations: [
      ...macViolations.missing,
      ...windowsViolations.missing,
      ...findDuplicateArtifactFileNames(inputDir),
      ...macViolations.remaining,
      ...windowsViolations.remaining,
      ...sidecarEvidence.violations,
    ],
  };
}

export function findReleaseArtifactViolations(inputDir, options = {}) {
  return collectReleaseEvidence(inputDir, options).violations;
}

function parseArgs(argv) {
  const parsed = {
    help: false,
    inputDir: null,
    outputDir: null,
    sourceSha: null,
    packageVersion: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') {
      const value = argv[index + 1];
      if (!value) {
        throw new UsageError('--input requires a directory path');
      }
      parsed.inputDir = value;
      index += 1;
    } else if (arg === '--output') {
      const value = argv[index + 1];
      if (!value) {
        throw new UsageError('--output requires a directory path');
      }
      parsed.outputDir = value;
      index += 1;
    } else if (arg === '--source-sha') {
      const value = argv[index + 1];
      if (!value) {
        throw new UsageError('--source-sha requires a 40-character hex object id');
      }
      parsed.sourceSha = value;
      index += 1;
    } else if (arg === '--package-version') {
      const value = argv[index + 1];
      if (!value) {
        throw new UsageError('--package-version requires a version string');
      }
      parsed.packageVersion = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else {
      throw new UsageError(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function runCli(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    console.log(usage());
    return;
  }
  if (parsed.inputDir === null) {
    throw new UsageError('--input requires a directory path');
  }
  if (parsed.sourceSha === null) {
    throw new UsageError('--source-sha requires a 40-character hex object id');
  }
  if (parsed.packageVersion === null) {
    throw new UsageError('--package-version requires a version string');
  }

  const inputDir = path.resolve(process.cwd(), parsed.inputDir);
  const identity = {
    sourceSha: parsed.sourceSha,
    packageVersion: parsed.packageVersion,
  };
  const { violations, files } = collectReleaseEvidence(inputDir, identity);
  if (violations.length > 0) {
    console.error(violations.join('\n'));
    process.exit(1);
  }

  if (parsed.outputDir !== null) {
    const outputDir = path.resolve(process.cwd(), parsed.outputDir);
    copyVerifiedArtifacts({
      inputDir,
      outputDir,
      files,
      validateStagedArtifacts: (stagingDir) => collectReleaseEvidence(stagingDir, identity),
    });
    console.log(`Verified ${files.length} release artifacts into ${outputDir}`);
    return;
  }

  console.log(
    JSON.stringify(
      {
        artifacts: files
          .map((file) => file.relativePath)
          .sort((left, right) => left.localeCompare(right)),
      },
      null,
      2
    )
  );
}

const isCli = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isCli) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      console.error(usage());
      process.exit(2);
    }
    console.error(error.message);
    process.exit(1);
  }
}
