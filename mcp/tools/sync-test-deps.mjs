/**
 * Materialize the shipped modules the tests import.
 *
 * `lib/typert.host.js` is checked against the Harness's own
 * `@deepseek-ai/dsh-typert-loader`, which resolves only inside the running
 * Harness. Plain `node --test` from this folder cannot import it, so this
 * script extracts that module — and the `schemastery` it imports — out of
 * `app.asar` into `tests/.fixtures/`, and `tests/hooks.mjs` maps the bare
 * specifiers onto those copies. The tests then exercise the shipped validator
 * rather than a reimplementation of its rules.
 *
 * The plugin itself imports nothing but node builtins: a plugin installed into
 * a profile by path resolves no bare dependencies, so `app.asar` is the only
 * honest source for anything the tests need from the Harness.
 *
 * Usage: node tools/sync-test-deps.mjs [--check]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
const ASAR = process.env['DSH_ASAR'] ?? DEFAULT_ASAR;
const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const OUT = path.join(ROOT, 'tests', '.fixtures');

/** Archive paths copied out, keyed by the fixture directory they land in. */
const SOURCES = {
  schemastery: 'dsh/node_modules/@deepseek-ai/schemastery',
  cosmokit: 'dsh/node_modules/@deepseek-ai/cosmokit',
  typertLoader: 'dsh/node_modules/@deepseek-ai/dsh-typert-loader/lib/index.js',
};

/** Fixture file names that are single files rather than package trees. */
const RENAMES = { typertLoader: 'typert-loader.js' };

/** Bump when {@link SOURCES} changes, so stale fixtures are re-extracted. */
const FIXTURE_VERSION = 4;

/**
 * Read the archive's JSON directory index.
 * @param fd - Open descriptor for the archive.
 * @returns The index and the offset of the file data.
 */
function readIndex(fd) {
  const sizeBuf = Buffer.alloc(16);
  fs.readSync(fd, sizeBuf, 0, 16, 0);
  const headerSize = sizeBuf.readUInt32LE(4);
  const header = Buffer.alloc(headerSize);
  fs.readSync(fd, header, 0, headerSize, 8);
  const jsonLength = header.readUInt32LE(4);
  return {
    index: JSON.parse(header.subarray(8, 8 + jsonLength).toString('utf8')),
    base: 8 + headerSize,
  };
}

/**
 * Resolve one slash-separated archive path to its node.
 * @param index - Root directory node.
 * @param archivePath - Path inside the archive.
 * @returns The node, or undefined when absent.
 */
function lookup(index, archivePath) {
  let node = index;
  for (const segment of archivePath.split('/')) {
    node = node?.files?.[segment];
    if (node === undefined) return undefined;
  }
  return node;
}

/**
 * Copy one archive node to disk.
 * @param fd - Open descriptor for the archive.
 * @param base - Offset of the archive's file data.
 * @param node - Directory or file node to copy.
 * @param destination - Absolute path to write.
 * @returns Number of files written.
 */
function copyNode(fd, base, node, destination) {
  if (node.files === undefined) {
    const size = Number(node.size);
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, BigInt(base) + BigInt(node.offset ?? 0));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, buffer);
    return 1;
  }
  let written = 0;
  for (const [name, child] of Object.entries(node.files)) {
    written += copyNode(fd, base, child, path.join(destination, name));
  }
  return written;
}

/** @returns True when every fixture is present and newer than the archive. */
function fixturesCurrent() {
  const stamp = path.join(OUT, '.extracted');
  if (!fs.existsSync(stamp)) return false;
  try {
    const [version] = fs.readFileSync(stamp, 'utf8').split('\n');
    if (Number(version) !== FIXTURE_VERSION) return false;
    return fs.statSync(stamp).mtimeMs >= fs.statSync(ASAR).mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Extract every fixture from the installed archive.
 * @returns Total files written.
 */
export function sync() {
  if (!fs.existsSync(ASAR)) {
    throw new Error(`DeepSeek Harness archive not found at ${ASAR}; set DSH_ASAR to override.`);
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const fd = fs.openSync(ASAR, 'r');
  try {
    const { index, base } = readIndex(fd);
    let written = 0;
    for (const [fixture, archivePath] of Object.entries(SOURCES)) {
      const node = lookup(index, archivePath);
      if (node === undefined) throw new Error(`archive path not found: ${archivePath}`);
      written += copyNode(fd, base, node, path.join(OUT, RENAMES[fixture] ?? fixture));
    }
    fs.writeFileSync(path.join(OUT, '.extracted'), `${FIXTURE_VERSION}\n${new Date().toISOString()}\n`);
    return written;
  } finally {
    fs.closeSync(fd);
  }
}

if (process.argv.includes('--check')) {
  console.log(fixturesCurrent() ? 'fixtures current' : 'fixtures stale — run without --check');
} else {
  try {
    console.log(`extracted ${sync()} file(s) to ${OUT}`);
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exit(1);
  }
}
