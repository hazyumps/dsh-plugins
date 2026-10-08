import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** Resolve a manifest path relative to the package root. */
function resolve(relative) {
  return path.join(ROOT, relative);
}

test('every path the manifest promises exists on disk', () => {
  const declared = [
    manifest.icon,
    ...Object.values(manifest.exports),
    ...manifest.files.flatMap((entry) => (entry.includes('*')
      ? fs.readdirSync(ROOT).filter((name) => name.startsWith(entry.replace('*', '')))
      : [entry])),
  ];

  for (const entry of declared) {
    assert.ok(fs.existsSync(resolve(entry)), `${entry} is declared but missing`);
  }
});

test('the bundle patch declares this package under an id the profile can address', () => {
  const patch = fs.readFileSync(path.join(ROOT, manifest.dsh.bundle.patch), 'utf8');

  // A deliberately shallow read: the test runner maps no YAML parser, and the
  // patch is one insert row whose id is what `pluginManager` writes toggles to.
  const row = patch.match(/^\s*-\s*id:\s*(\S+)\s*\n\s*name:\s*(\S+)\s*$/m);
  assert.ok(row, 'cordis.patch.yml must declare one insert row');
  assert.equal(row[2], manifest.name, 'the row must name this package, or the loader never resolves it');
  assert.match(row[1], /^[a-z][a-z0-9-]*$/, 'the row id must be a stable, addressable id');
});

test('the browser half is declared the way the client module system loads it', () => {
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.exports['./client'], './client.js');
  assert.equal(manifest.exports['./typert'], manifest.dsh.bundle ? './lib/typert.host.js' : undefined);
});

test('the host half and the typert entry are separate exports', () => {
  assert.equal(manifest.exports['.'], './index.js');
  assert.notEqual(manifest.exports['.'], manifest.exports['./typert']);
  assert.ok(manifest.files.includes('lib'), 'lib/ ships with the package');
});

test('the plugin has no runtime dependencies to resolve', () => {
  assert.deepEqual(manifest.dependencies, {});
  assert.equal(manifest.type, 'module');
});
