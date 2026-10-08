/**
 * Strict Host reflection for the `usage` namespace.
 *
 * `@deepseek-ai/dsh-typert-loader` finds this through the package's `./typert`
 * export and registers it when the plugin row mounts. Every codec here is the
 * zod schema the gateway actually validates a payload against.
 *
 * @module dsh-plugin-usage/typert
 */

import { PACKAGE, descriptors } from './contract.js';
import { SCHEMAS } from './schema.js';

/**
 * Resolve one codec's schema.
 * @param typeSymbol - The declared type symbol, `<package>#<ShortName>`.
 * @returns A thunk returning the zod schema.
 */
function schemaFor(typeSymbol) {
  const short = typeSymbol.slice(typeSymbol.lastIndexOf('#') + 1);
  const schema = SCHEMAS[short];
  if (schema === undefined) throw new Error(`no schema declared for ${typeSymbol}`);
  return () => schema;
}

/** The Host face of this plugin's Remote contribution. */
export const TYPERT = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
  invocations: descriptors(schemaFor),
  model: {
    services: [{
      key: 'usage',
      exportName: 'UsageService',
      description: 'Provider balance and token spend, read from the API key and the Harness session logs.',
      summary: 'Usage',
      tags: [],
      members: [
        { kind: 'method', name: 'summary', signature: 'summary(request: SummaryRequest): SummaryResult' },
      ],
      types: [],
    }],
    events: [],
    objects: [],
  },
};

export default TYPERT;
