/**
 * Test-only module resolution for the shipped Harness packages.
 *
 * `lib/job.js` imports `@deepseek-ai/dsh-schedule`, which resolves only inside
 * the running Harness. These hooks point that specifier — and the two modules it
 * needs — at the copies `tools/sync-test-deps.mjs` extracted from `app.asar`.
 *
 * Nothing here affects the plugin at runtime; the Harness resolves the real
 * packages itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '.fixtures');

const substitutions = {
  '@deepseek-ai/dsh-schedule': path.join(fixtures, 'dsh-schedule-domain.js'),
  '@js-temporal/polyfill': path.join(fixtures, 'js-temporal-polyfill', 'dist', 'index.esm.js'),
  jsbi: path.join(fixtures, 'jsbi', 'dist', 'jsbi.mjs'),
  '@deepseek-ai/dsh-session': path.join(fixtures, 'dsh-session-stub.js'),
  '@deepseek-ai/schemastery': path.join(fixtures, 'schemastery', 'lib', 'index.mjs'),
  '@deepseek-ai/cosmokit': path.join(fixtures, 'cosmokit', 'lib', 'index.js'),
  '@standard-schema/spec': path.join(fixtures, 'standard-schema-spec', 'dist', 'index.js'),
  '@deepseek-ai/dsh-typert-protocol': path.join(fixtures, 'dsh-typert-stub.js'),
  '@deepseek-ai/dsh-storage-domain': path.join(fixtures, 'dsh-storage-domain-stub.js'),
};

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
  if (!fs.existsSync(target)) {
    throw new Error(
      `Missing test fixture ${target}. Run: node tools/sync-test-deps.mjs`,
    );
  }
  return { url: pathToFileURL(target).href, format: 'module', shortCircuit: true };
}
