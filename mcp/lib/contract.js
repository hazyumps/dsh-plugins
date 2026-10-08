/**
 * The wire contract for the `mcp` Remote namespace.
 *
 * The Host registers this through the `./typert` export; the browser half
 * mounts the same descriptor ids through `ctx.remote.$mount` so the namespace
 * exists as a callable client proxy. Their codecs differ — the Host validates
 * with the hand-rolled schemas in `./schema.js`, the browser half only needs
 * `mode: 'strict'` — so the descriptors are built from a schema resolver
 * rather than shared as literals.
 *
 * @module dsh-plugin-mcp/contract
 */

/** Must equal this package's `name`; the Typert loader asserts it. */
export const PACKAGE = 'dsh-plugin-mcp';

/** Service key, Remote namespace, and descriptor service name. */
export const NAMESPACE = 'mcp';

/**
 * One strict codec for a named request or result type.
 * @param typeSymbol - `<package>#<ShortName>`.
 * @param schemaFor - `(typeSymbol) => () => unknown`.
 * @returns The codec.
 */
function codec(typeSymbol, schemaFor) {
  return { mode: 'strict', typeSymbol, create: schemaFor(typeSymbol) };
}

/**
 * Build every invocation descriptor.
 *
 * The browser half must mount exactly this set: ids, parameter names, and type
 * symbols are compared against the Host's registration.
 * @param schemaFor - `(typeSymbol) => () => unknown`; the Host supplies the
 *   real schemas, the browser half a stub, because it never executes them.
 * @returns The descriptor list, in namespace order.
 */
export function descriptors(schemaFor) {
  const endpoint = (method) => ({
    id: `${PACKAGE}#${NAMESPACE}/${method}`,
    service: NAMESPACE,
    namespace: NAMESPACE,
    method,
    invocation: { kind: 'direct' },
  });

  return [{
    ...endpoint('list'),
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec(`${PACKAGE}#ListRequest`, schemaFor),
    }],
    result: codec(`${PACKAGE}#ListResult`, schemaFor),
  }];
}
