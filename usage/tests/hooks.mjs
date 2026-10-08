/**
 * Test-only module resolution for the shipped Harness modules.
 *
 * `lib/typert.host.js` is validated by the shipped
 * `@deepseek-ai/dsh-typert-loader`, which does not resolve from this folder —
 * only inside the running Harness, or from the archive. This hook points that
 * specifier (and the schemastery it imports) at the copies
 * `tools/sync-test-deps.mjs` extracted from `app.asar`, so the tests exercise
 * the real loader rather than a reimplementation of its rules.
 *
 * Nothing here affects the plugin at runtime; the Harness resolves the real
 * packages itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '.fixtures');

/** Specifier -> fixture directory, with an optional explicit entry file. */
const substitutions = {
  '@deepseek-ai/schemastery': { dir: path.join(fixtures, 'schemastery'), entry: 'lib/index.mjs' },
  '@deepseek-ai/cosmokit': { dir: path.join(fixtures, 'cosmokit'), entry: 'lib/index.js' },
  '@deepseek-ai/dsh-typert-loader': { file: path.join(fixtures, 'typert-loader.js') },
};

/**
 * The ESM entry of an extracted package.
 * @param dir - Fixture directory.
 * @returns Absolute path of the entry module.
 */
function entryOf(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const exported = manifest.exports?.['.'];
  const candidates = [
    typeof exported === 'string' ? exported : undefined,
    typeof exported === 'object' ? (exported.import?.default ?? exported.import ?? exported.default) : undefined,
    manifest.module,
    manifest.main,
    'index.js',
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const resolved = path.join(dir, candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  throw new Error(`no entry module found for the fixture at ${dir}`);
}

/**
 * Redirect a bare shipped-package specifier to its extracted fixture.
 * @param specifier - The requested specifier.
 * @param context - Node's resolution context.
 * @param next - The default resolver.
 * @returns The substituted resolution, or the default one.
 */
export async function resolve(specifier, context, next) {
  const target = substitutions[specifier];
  if (target === undefined) return next(specifier, context);
  const dir = target.dir;
  if (dir !== undefined && !fs.existsSync(dir)) {
    throw new Error(`Missing test fixture ${dir}. Run: node tools/sync-test-deps.mjs`);
  }
  const file = target.file !== undefined
    ? target.file
    : path.join(dir, target.entry ?? path.relative(dir, entryOf(dir)));
  if (!fs.existsSync(file)) {
    throw new Error(`Missing test fixture ${file}. Run: node tools/sync-test-deps.mjs`);
  }
  return { url: pathToFileURL(file).href, format: 'module', shortCircuit: true };
}
