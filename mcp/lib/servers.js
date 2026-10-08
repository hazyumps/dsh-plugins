/**
 * Read the Harness's MCP servers out of the Loader and the tool registry.
 *
 * The MCP client contributes one Loader row per server (`gaia-mcp-<name>` in
 * this deployment). Everything the page shows is derived here, Host-side, and
 * nothing else: `lib/schema.js` has no field a credential could travel in, so
 * a `headers` map or a stdio `env` can never reach the browser half — only the
 * boolean that says one was configured.
 *
 * @module dsh-plugin-mcp/servers
 */

/** The module specifier every MCP client row in this Harness uses. */
export const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client';

/** Public tool-name prefix the bridge publishes: `mcp__<server>__<tool>`. */
export const TOOL_NAMESPACE = 'mcp__';

/** Longest endpoint or command line the page will draw, before elision. */
const TARGET_LIMIT = 160;

/**
 * Cordis `FiberState` is a cross-package const enum, so it is mirrored here
 * the way `dsh-host-plugin-inventory` mirrors it. A disposed fiber reads as
 * idle: the entry has no live root, which is what the panel shows.
 */
const PHASE_BY_STATE = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: 'idle',
  5: 'unloading',
};

/**
 * Resolve one optional Cordis service.
 * @param ctx - The plugin Context.
 * @param key - Service key.
 * @returns The service, or undefined when the profile does not mount it.
 */
function service(ctx, key) {
  if (ctx === undefined || ctx === null || typeof ctx.get !== 'function') return undefined;
  try {
    return ctx.get(key) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The live phase of a row's root fiber.
 * @param entry - A Loader entry.
 * @returns One of the phases the panel knows.
 */
export function phaseOf(entry) {
  const state = entry?.fiber?.state;
  if (typeof state !== 'number') return 'idle';
  return PHASE_BY_STATE[state] ?? 'idle';
}

/**
 * The panel's transport vocabulary.
 * @param config - A resolved row config.
 * @returns `http`, `stdio`, or `other`.
 */
export function transportOf(config) {
  const transport = config?.transport;
  if (transport === 'stdio') return 'stdio';
  if (transport === 'streamable-http' || transport === 'http' || transport === 'sse') return 'http';
  return 'other';
}

/**
 * Elide one long value for display.
 * @param value - The string to shorten.
 * @returns At most {@link TARGET_LIMIT} characters.
 */
function elide(value) {
  return value.length <= TARGET_LIMIT ? value : `${value.slice(0, TARGET_LIMIT - 1)}…`;
}

/**
 * What the row points at: a URL for HTTP, an argv line for stdio.
 *
 * Only the endpoint shape is taken — `headers` and `env` are deliberately not
 * read, so no credential value can be copied out of the config.
 * @param transport - The row's transport, from {@link transportOf}.
 * @param config - A resolved row config.
 * @returns A display string, possibly empty.
 */
export function targetOf(transport, config) {
  if (transport === 'http') {
    return typeof config?.url === 'string' ? elide(config.url) : '';
  }
  const argv = [config?.command, ...(Array.isArray(config?.args) ? config.args : [])]
    .filter((part) => typeof part === 'string' && part.length > 0);
  return argv.length === 0 ? '' : elide(argv.join(' '));
}

/**
 * Whether the row carries a credential of its own.
 * @param config - A resolved row config.
 * @returns True when headers or env were configured. The values stay here.
 */
export function isAuthenticated(config) {
  const has = (value) => value !== null && typeof value === 'object' && Object.keys(value).length > 0;
  return has(config?.headers) || has(config?.env);
}

/**
 * Count the tools the model currently sees, per MCP server.
 *
 * `ctx.tools.schemas()` with no scope is the global registry view — the same
 * projection that feeds the model-facing tool set. A profile without the tool
 * registry, or one that throws, reports `null` and the page shows a dash
 * rather than a wrong zero.
 * @param ctx - The plugin Context.
 * @returns A Map of server name to tool count, or null when unreadable.
 */
export function countTools(ctx) {
  const tools = service(ctx, 'tools');
  if (tools === undefined || typeof tools.schemas !== 'function') return null;
  try {
    const counts = new Map();
    for (const definition of tools.schemas()) {
      const name = definition?.name;
      if (typeof name !== 'string' || !name.startsWith(TOOL_NAMESPACE)) continue;
      const rest = name.slice(TOOL_NAMESPACE.length);
      const separator = rest.indexOf('__');
      if (separator <= 0) continue;
      const server = rest.slice(0, separator);
      counts.set(server, (counts.get(server) ?? 0) + 1);
    }
    return counts;
  } catch {
    return null;
  }
}

/**
 * One `serverRow` for a Loader entry.
 * @param entry - A Loader entry.
 * @param counts - Per-server tool counts, or null when unreadable.
 * @returns The row the browser half renders.
 */
function rowOf(entry, counts) {
  const config = entry?.options?.config ?? {};
  const serverName = typeof config.serverName === 'string' && config.serverName.length > 0
    ? config.serverName
    : String(entry?.options?.id ?? '');
  const transport = transportOf(config);
  const timeout = config.toolCallTimeoutMs;

  return {
    id: String(entry?.options?.id ?? ''),
    serverName,
    moduleName: String(entry?.options?.name ?? MCP_CLIENT_MODULE),
    enabled: entry?.disabled !== true,
    phase: phaseOf(entry),
    transport,
    target: targetOf(transport, config),
    authenticated: isAuthenticated(config),
    timeoutMs: typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
      ? Math.round(timeout)
      : null,
    toolPrefix: `${TOOL_NAMESPACE}${serverName}`,
    toolCount: counts === null ? null : (counts.get(serverName) ?? 0),
  };
}

/**
 * Every MCP server this Harness is composed with.
 *
 * Rows keep Loader order, which is the order the profile patch declares them,
 * so the page reads the way the configuration does.
 * @param ctx - The plugin Context.
 * @returns `{ servers, totals }`, ready for the strict codec.
 */
export function readServers(ctx) {
  const loader = service(ctx, 'loader');
  const entries = loader !== undefined && typeof loader.entries === 'function'
    ? [...loader.entries()]
    : [];

  const counts = countTools(ctx);
  const servers = entries
    .filter((entry) => entry?.options?.group !== true)
    .filter((entry) => entry?.options?.name === MCP_CLIENT_MODULE)
    .map((entry) => rowOf(entry, counts));

  const tools = counts === null
    ? null
    : servers.reduce((total, server) => total + (server.toolCount ?? 0), 0);

  return {
    servers,
    totals: {
      servers: servers.length,
      enabled: servers.filter((server) => server.enabled).length,
      active: servers.filter((server) => server.enabled && server.phase === 'active').length,
      failed: servers.filter((server) => server.phase === 'failed').length,
      tools,
    },
  };
}
