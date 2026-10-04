import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Resolve local page references against the lib payload, never extraResources. */
export function verifyPackagedOffline(root) {
  const lib = path.resolve(root, 'lib');
  const entry = path.join(lib, 'offline/index.html');
  const missing = [];
  let checked = 0;
  if (!fs.existsSync(entry)) {
    return { ok: false, entry, checked, missing: ['offline/index.html'] };
  }
  const inside = (file, base = lib) => {
    const relative = path.relative(base, file);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const html = fs.readFileSync(entry, 'utf8');
  const attributes = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of html.matchAll(attributes)) {
    const reference = match[1] ?? match[2] ?? match[3];
    const url = new URL(reference, pathToFileURL(entry));
    if (url.protocol !== 'file:') continue;
    checked++;
    // `//host/x` on a file: page resolves to a host-bearing file URL that no archive ships.
    if (url.host) {
      missing.push(reference);
      continue;
    }
    url.search = '';
    url.hash = '';
    const file = fileURLToPath(url);
    if (
      !inside(file) ||
      !fs.existsSync(file) ||
      !inside(fs.realpathSync(file), fs.realpathSync(lib)) ||
      !fs.statSync(file).isFile()
    ) {
      missing.push(reference);
    }
  }
  return { ok: missing.length === 0, entry, checked, missing };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const result = verifyPackagedOffline(process.argv[2] || process.cwd());
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
