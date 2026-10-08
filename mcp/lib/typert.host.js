/**
 * Strict Host reflection for the `mcp` namespace.
 *
 * `@deepseek-ai/dsh-typert-loader` finds this through the package's `./typert`
 * export and registers it when the plugin row mounts. Every codec here is the
 * schema the gateway actually validates a payload against.
 *
 * @module dsh-plugin-mcp/typert
 */

import { PACKAGE, descriptors } from './contract.js';
import { SCHEMAS } from './schema.js';

/**
 * Resolve one codec's schema.
 * @param typeSymbol - The declared type symbol, `<package>#<ShortName>`.
 * @returns A thunk returning the schema.
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
      key: 'mcp',
      exportName: 'McpService',
      description: 'The MCP servers this Harness is connected to, read live from the Loader and the tool registry.',
      summary: 'MCP',
      tags: [],
      members: [
        { kind: 'method', name: 'list', signature: 'list(request: ListRequest): ListResult' },
      ],
      types: [],
    }],
    events: [],
    objects: [],
  },
};

export default TYPERT;
