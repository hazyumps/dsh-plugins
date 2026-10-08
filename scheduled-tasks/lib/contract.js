/**
 * The wire contract for the `scheduledTasks` Remote namespace.
 *
 * The Host registers this through the `./typert` export; the Client mounts the
 * same descriptor ids through `ctx.remote.$mount` so the namespace exists as a
 * callable client proxy. Their codecs differ — the Host validates with zod,
 * while the browser half only needs `mode: 'strict'` — so the descriptors are
 * built from a schema resolver rather than shared as literals.
 *
 * @module dsh-plugin-scheduled-tasks/contract
 */

/** Must equal this package's `name`; the Typert loader asserts it. */
export const PACKAGE = 'dsh-plugin-scheduled-tasks';

/** Service key, Remote namespace, and descriptor service name. */
export const NAMESPACE = 'scheduledTasks';

/** One strict codec for a named result or request type. */
function codec(typeSymbol, schemaFor) {
  return { mode: 'strict', typeSymbol, create: schemaFor(typeSymbol) };
}

/**
 * Build every invocation descriptor.
 * @param schemaFor - `(typeSymbol) => () => unknown`; the Host supplies zod
 *   schemas, the browser half a stub, because it never executes them.
 * @returns The descriptor list, in namespace order.
 */
export function descriptors(schemaFor) {
  const result = (symbol) => ({
    mode: 'strict',
    typeSymbol: `${PACKAGE}#${symbol}`,
    create: schemaFor(symbol),
  });
  const request = (name, symbol) => [{
    name,
    wire: name,
    source: 'json',
    codec: codec(`${PACKAGE}#${symbol}`, schemaFor),
  }];
  const endpoint = (method) => ({
    id: `${PACKAGE}#${NAMESPACE}/${method}`,
    service: NAMESPACE,
    namespace: NAMESPACE,
    method,
    invocation: { kind: 'direct' },
  });

  return [
    { ...endpoint('list'), parameters: [], result: result('TaskListResult') },
    { ...endpoint('settings'), parameters: [], result: result('SettingsResult') },
    {
      ...endpoint('saveSettings'),
      parameters: request('request', 'SettingsUpdateRequest'),
      result: result('SettingsResult'),
    },
    { ...endpoint('workspaces'), parameters: [], result: result('WorkspaceListResult') },
    {
      ...endpoint('create'),
      parameters: request('request', 'TaskCreateRequest'),
      result: result('TaskResult'),
    },
    {
      ...endpoint('update'),
      parameters: request('request', 'TaskUpdateRequest'),
      result: result('TaskResult'),
    },
    {
      // Named `delete`, not `remove`: `remove` is a method on the browser
      // half's own namespace service, and mounting it throws.
      ...endpoint('delete'),
      parameters: request('request', 'TaskDeleteRequest'),
      result: result('TaskDeleteResult'),
    },
    {
      ...endpoint('runNow'),
      parameters: request('request', 'TaskRunRequest'),
      result: result('TaskRunResult'),
    },
  ];
}

/** Method names the namespace carries, in display order. */
export const METHODS = [
  'list', 'settings', 'saveSettings', 'workspaces', 'create', 'update', 'delete', 'runNow',
];
