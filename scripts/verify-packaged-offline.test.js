import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyPackagedOffline } from './verify-packaged-offline.js';

describe('packaged offline asset closure', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gogchat-offline-'));
    fs.mkdirSync(path.join(root, 'lib/offline'), { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function page(html) {
    fs.writeFileSync(path.join(root, 'lib/offline/index.html'), html);
  }

  it('rejects an absent page', () => {
    expect(verifyPackagedOffline(root).ok).toBe(false);
  });
  it('resolves every local src and href including queries and fragments', () => {
    page(
      '<script src="index.js?v=1"></script><link href="index.css#style"><img src=logo.svg><a href="https://example.com">Remote</a><a href="#retry">Retry</a>'
    );
    for (const asset of ['index.js', 'index.css', 'logo.svg']) {
      fs.writeFileSync(path.join(root, 'lib/offline', asset), 'asset');
    }
    expect(verifyPackagedOffline(root)).toMatchObject({ ok: true, checked: 4, missing: [] });
  });
  it('rejects dangling references even when other assets exist', () => {
    page('<script src="index.js"></script><img src="missing.svg">');
    fs.writeFileSync(path.join(root, 'lib/offline/index.js'), 'script');
    expect(verifyPackagedOffline(root).missing).toEqual(['missing.svg']);
  });
  it('rejects outside-lib references even when the target exists', () => {
    page('<img src="../../resources/logo.svg">');
    fs.mkdirSync(path.join(root, 'resources'));
    fs.writeFileSync(path.join(root, 'resources/logo.svg'), 'logo');
    expect(verifyPackagedOffline(root).missing).toEqual(['../../resources/logo.svg']);
  });
  it('rejects protocol-relative references instead of throwing', () => {
    page('<script src="//cdn.example.com/index.js"></script>');
    expect(verifyPackagedOffline(root)).toMatchObject({
      ok: false,
      checked: 1,
      missing: ['//cdn.example.com/index.js'],
    });
  });
  it('rejects symlinks escaping lib and directories masquerading as files', () => {
    page('<img src="escape.svg"><script src="directory"></script>');
    fs.writeFileSync(path.join(root, 'outside.svg'), 'logo');
    fs.symlinkSync(path.join(root, 'outside.svg'), path.join(root, 'lib/offline/escape.svg'));
    fs.mkdirSync(path.join(root, 'lib/offline/directory'));
    expect(verifyPackagedOffline(root).missing).toEqual(['escape.svg', 'directory']);
  });
});
