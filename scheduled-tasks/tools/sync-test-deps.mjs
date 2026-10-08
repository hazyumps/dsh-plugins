/**
 * Materialize the shipped scheduler modules the unit tests import.
 *
 * `lib/job.js` imports `@deepseek-ai/dsh-schedule`, which only resolves inside
 * the running Harness (Electron reads it out of `app.asar`). Plain `node --test`
 * cannot, so this script copies the two real modules the tests need out of the
 * installed archive into `tests/.fixtures/`, and the test loader maps the bare
 * specifiers onto those copies.
 *
 * The extracted files are the shipped ones, so the tests exercise DSH's actual
 * recurrence code — not a reimplementation.
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

/** Paths inside the archive, relative to its root. */
const SOURCES = {
  scheduleDomain: 'dsh/node_modules/@deepseek-ai/dsh-schedule/lib/types/domain.js',
  temporal: 'dsh/node_modules/@js-temporal/polyfill',
  jsbi: 'dsh/node_modules/jsbi',
  schemastery: 'dsh/node_modules/@deepseek-ai/schemastery',
  cosmokit: 'dsh/node_modules/@deepseek-ai/cosmokit',
  standardSchema: 'dsh/node_modules/@standard-schema/spec',
};

/** Package trees copied whole, keyed by the fixture directory name. */
const TREES = {
  temporal: 'js-temporal-polyfill',
  jsbi: 'jsbi',
  schemastery: 'schemastery',
  cosmokit: 'cosmokit',
  standardSchema: 'standard-schema-spec',
};

/** A stand-in for the storage-domain facade, keeping its real validation rules. */
const DOMAIN_STUB = `/**
 * Test-only stand-in for \`@deepseek-ai/dsh-storage-domain\`.
 *
 * Declaration and validation follow the shipped package, so a spec this stub
 * accepts is one the real facility accepts. The backend is not reproduced: the
 * tests supply their own table, and only the record schema is exercised.
 */
export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

/** Storage unit names, as the shipped package constrains them. */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** Declare one table. */
export function domainTable(schema) {
  return { valueSchema: schema };
}

/** Validate and return a domain declaration. */
export function defineDomain(spec) {
  if (!UNIT_NAME_RE.test(spec.name)) {
    throw new Error(\`domain name '\${spec.name}' must match \${UNIT_NAME_RE}\`);
  }
  if (!Number.isInteger(spec.version) || spec.version < 0) {
    throw new Error(\`domain '\${spec.name}' version must be a non-negative integer, got \${spec.version}\`);
  }
  for (const compat of spec.compatibleVersions ?? []) {
    if (!Number.isInteger(compat) || compat < 0 || compat >= spec.version) {
      throw new Error(\`domain '\${spec.name}' compatibleVersions entries must be non-negative integers below version \${spec.version}, got \${compat}\`);
    }
  }
  const layout = spec.layout;
  if (layout !== undefined && layout !== 'single' && layout !== 'per-record') {
    throw new Error(\`domain '\${spec.name}' layout must be "single" or "per-record", got \${String(layout)}\`);
  }
  return spec;
}
`;

/** A stand-in for the Remote error the service raises on the wire. */
const TYPERT_STUB = `/**
 * Test-only stand-in for \`@deepseek-ai/dsh-typert-protocol\`.
 *
 * The real class carries a code, a message, and details so the gateway can fold
 * a throw into a wire failure. Only the code and message matter to these tests.
 */
export class RemoteError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RemoteError';
    this.code = code;
    this.details = details;
  }
}
`;

/** A stand-in for the one unrelated symbol the scheduler module imports. */
const SESSION_STUB = `/**
 * Test-only stand-in for \`@deepseek-ai/dsh-session\`.
 *
 * The shipped scheduler module imports \`SessionLogOffset\`, a branded type used
 * only by its durable-decode paths, which these tests do not exercise. The
 * binding has to exist for the module graph to link.
 */
export const SessionLogOffset = (value) => value;
`;

/**
 * Read the archive's JSON directory index.
 * @param fd - Open descriptor for the archive.
 * @returns The root directory node.
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
 * Resolve one slash-separated archive path to its directory node.
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
 * Copy one archive node (file or directory) to disk.
 * @param fd - Open descriptor for the archive.
 * @param base - Offset of the archive's file data.
 * @param node - Directory or file node to copy.
 * @param destination - Absolute path to write.
 * @returns Number of files written.
 */
function copyNode(fd, base, node, destination) {
  if (node.files === undefined) {
    // The archive stores sizes and offsets as strings once they exceed 32 bits.
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

/** Bump when {@link SOURCES} changes, so stale fixtures are re-extracted. */
const FIXTURE_VERSION = 5;

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

    const domain = lookup(index, SOURCES.scheduleDomain);
    if (domain === undefined) {
      throw new Error(`${SOURCES.scheduleDomain} is missing from ${ASAR}; is this a DSH install?`);
    }
    written += copyNode(fd, base, domain, path.join(OUT, 'dsh-schedule-domain.js'));

    for (const [key, directory] of Object.entries(TREES)) {
      const source = SOURCES[key];
      const node = lookup(index, source);
      if (node === undefined) {
        throw new Error(`${source} is missing from ${ASAR}; is this a DSH install?`);
      }
      written += copyNode(fd, base, node, path.join(OUT, directory));
    }

    fs.writeFileSync(path.join(OUT, 'dsh-session-stub.js'), SESSION_STUB);
    fs.writeFileSync(path.join(OUT, 'dsh-typert-stub.js'), TYPERT_STUB);
    fs.writeFileSync(path.join(OUT, 'dsh-storage-domain-stub.js'), DOMAIN_STUB);
    written += 3;
    fs.writeFileSync(path.join(OUT, '.extracted'), `${FIXTURE_VERSION}\n${new Date().toISOString()}\n`);
    return written;
  } finally {
    fs.closeSync(fd);
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  if (process.argv.includes('--check')) {
    if (fixturesCurrent()) {
      console.log(`test fixtures are current in ${OUT}`);
    } else {
      console.error(`test fixtures are missing or stale; run: node tools/sync-test-deps.mjs`);
      process.exitCode = 1;
    }
  } else if (fixturesCurrent()) {
    console.log(`test fixtures are current in ${OUT}`);
  } else {
    const written = sync();
    console.log(`extracted ${written} files from ${ASAR} into ${OUT}`);
  }
}
