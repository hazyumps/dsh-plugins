/**
 * MCP — the Host half.
 *
 * Answers one question for the browser half: which MCP servers is this Harness
 * connected to, where do they point, and what are they contributing right now.
 * The rows come from the Loader — the same entries the composition holds — and
 * the counts come from the tool registry the model is actually dispatched
 * through, so the page reports live state rather than a config file's intent.
 *
 * Nothing here trusts the client, and the whole payload is validated on the
 * way out by `lib/typert.host.js` against `lib/schema.js`. Credentials stay
 * Host-side: the row shape has no field to carry one.
 *
 * @module dsh-plugin-mcp
 */

import { readServers } from './lib/servers.js';

/** Cordis service key, Remote namespace, and plugin name. */
export const name = 'mcp';

/**
 * Host services this plugin needs. Deliberately empty: the Loader and the tool
 * registry are read lazily through `ctx.get`, so a profile that mounts neither
 * still activates and reports an empty page instead of failing to load.
 */
export const inject = [];

/**
 * Mount the service.
 * @param ctx - The plugin Context.
 */
export function apply(ctx) {
  const service = {
    /**
     * Read every MCP server row.
     *
     * The request is a strict empty object: this namespace has no options yet,
     * and accepting unknown keys would let a future field pass unvalidated.
     * @returns The list payload.
     */
    async list() {
      const { servers, totals } = readServers(ctx);
      ctx.logger?.debug?.(`mcp: ${servers.length} server(s), ${totals.active} active`);
      return { generatedAt: Date.now(), servers, totals };
    },
  };

  // The exact visible protocol binding; strict reflection is contributed
  // separately by ./typert, with no decorator or source discovery.
  service.typertRemote = Object.freeze({ service, serviceKey: name, namespace: name });
  ctx.provide(name, service);
}
