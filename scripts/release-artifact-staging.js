import fs from 'node:fs';
import path from 'node:path';

function pathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function resolveOutputPath(outputDir) {
  let parent = path.dirname(outputDir);
  const suffix = [path.basename(outputDir)];
  while (!pathExists(parent)) {
    suffix.unshift(path.basename(parent));
    parent = path.dirname(parent);
  }
  const existingParent = fs.realpathSync(parent);
  return { outputPath: path.join(existingParent, ...suffix), existingParent };
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

function requireAbsentOutput(outputDir) {
  if (pathExists(outputDir)) throw new Error(`Release output already exists: ${outputDir}`);
}

export function copyVerifiedArtifacts({ inputDir, outputDir, files, validateStagedArtifacts }) {
  requireAbsentOutput(outputDir);
  const canonicalInput = fs.realpathSync(inputDir);
  const { outputPath, existingParent } = resolveOutputPath(outputDir);
  if (containsPath(canonicalInput, outputPath) || containsPath(outputPath, canonicalInput)) {
    throw new Error('Release input and output must be disjoint');
  }
  const stagingDir = fs.mkdtempSync(path.join(existingParent, '.release-staging-'));
  let published = false;
  try {
    const stagedFiles = files
      .map((file) => ({ ...file, basename: path.basename(file.relativePath) }))
      .sort((left, right) =>
        left.basename < right.basename ? -1 : left.basename > right.basename ? 1 : 0
      );
    for (const file of stagedFiles) {
      fs.copyFileSync(
        path.join(canonicalInput, file.relativePath),
        path.join(stagingDir, file.basename)
      );
    }
    const stagedEvidence = validateStagedArtifacts(stagingDir);
    if (stagedEvidence.violations.length > 0) throw new Error(stagedEvidence.violations.join('\n'));
    const stagedDigests = new Map(
      stagedEvidence.files.map((file) => [file.relativePath, file.sha256])
    );
    for (const file of stagedFiles) {
      if (stagedDigests.get(file.basename) !== file.sha256) {
        throw new Error(`Release bytes changed after inspection: ${file.relativePath}`);
      }
    }
    const checksumLines = stagedFiles.map((file) => `${file.sha256}  ${file.basename}`);
    fs.writeFileSync(path.join(stagingDir, 'SHA256SUMS.txt'), `${checksumLines.join('\n')}\n`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    requireAbsentOutput(outputPath);
    fs.renameSync(stagingDir, outputPath);
    published = true;
  } finally {
    if (!published) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}
