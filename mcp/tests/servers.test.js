import test from 'node:test';
import assert from 'node:assert/strict';

import { readServers, transportOf, targetOf, isAuthenticated } from '../lib/servers.js';
import { SCHEMAS } from '../lib/schema.js';

/**
 * A Context stand-in exposing only what `readServers` reads: the Loader and,
 * when a test provides one, the tool registry. Nothing else is consulted, so
 * this is the whole surface the plugin depends on.
 * @param options - `{ entries, tools }`.
 * @returns A minimal `ctx`.
 */
function fakeCtx({ entries = [], tools = undefined } = {}) {
  return {
    get(key) {
      if (key === 'loader') return { entries: () => entries };
      if (key === 'tools') return tools;
      return undefined;
    },
  };
}

/**
 * One Loader entry shaped like the MCP client's rows in this deployment.
 * @param overrides - Entry fields to override.
 * @returns The entry.
 */
function entry(overrides = {}) {
  return {
    options: {
      id: 'gaia-mcp-unraid',
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        serverName: 'unraid',
        transport: 'streamable-http',
        url: 'http://192.0.2.10:8043/mcp',
        toolCallTimeoutMs: 120000,
      },
    },
    disabled: false,
    fiber: { state: 2 },
    ...overrides,
  };
}

test('rows keep Loader order and are read into the panel shape', () => {
  const ctx = fakeCtx({
    entries: [
      entry(),
      entry({
        options: {
          id: 'gaia-mcp-ynab',
          name: '@deepseek-ai/dsh-mcp-client',
          config: { serverName: 'ynab', transport: 'stdio', command: '/tmp/bridge.sh', args: [], toolCallTimeoutMs: 60000 },
        },
      }),
    ],
  });

  const { servers, totals } = readServers(ctx);

  assert.deepEqual(servers.map((server) => server.serverName), ['unraid', 'ynab']);
  assert.deepEqual(servers[0], {
    id: 'gaia-mcp-unraid',
    serverName: 'unraid',
    moduleName: '@deepseek-ai/dsh-mcp-client',
    enabled: true,
    phase: 'active',
    transport: 'http',
    target: 'http://192.0.2.10:8043/mcp',
    authenticated: false,
    timeoutMs: 120000,
    toolPrefix: 'mcp__unraid',
    toolCount: null,
  });
  assert.equal(servers[1].transport, 'stdio');
  assert.equal(servers[1].target, '/tmp/bridge.sh');
  assert.deepEqual(totals, { servers: 2, enabled: 2, active: 2, failed: 0, tools: null });
});

test('the payload the Host returns satisfies its own strict codec', () => {
  const ctx = fakeCtx({ entries: [entry()] });
  const { servers, totals } = readServers(ctx);
  const parsed = SCHEMAS.ListResult.parse({ generatedAt: 1, servers, totals });
  assert.equal(parsed.servers.length, 1);
  assert.equal(parsed.totals.servers, 1);
});

test('non-MCP rows and structural groups are ignored', () => {
  const ctx = fakeCtx({
    entries: [
      { options: { id: 'gaia-cortex', name: '/Users/you/repo/gaia/tools/dsh-cortex/index.mjs' }, fiber: { state: 2 } },
      { options: { id: 'gaia-roles', name: 'group', group: true }, fiber: { state: 2 } },
      entry(),
    ],
  });

  const { servers } = readServers(ctx);
  assert.deepEqual(servers.map((server) => server.id), ['gaia-mcp-unraid']);
});

test('disabled, failed and statusless rows report honestly', () => {
  const ctx = fakeCtx({
    entries: [
      entry({ disabled: true, fiber: { state: 0 } }),
      entry({ options: { id: 'gaia-mcp-diagram', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'diagram', transport: 'streamable-http', url: 'http://192.0.2.11:8023/mcp' } } , fiber: { state: 3 } }),
      entry({ options: { id: 'gaia-mcp-search', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'search', transport: 'streamable-http', url: 'http://192.0.2.11:8027/mcp' } }, fiber: undefined }),
    ],
  });

  const { servers, totals } = readServers(ctx);
  assert.deepEqual(servers.map((server) => [server.serverName, server.enabled, server.phase]), [
    ['unraid', false, 'pending'],
    ['diagram', true, 'failed'],
    ['search', true, 'idle'],
  ]);
  assert.equal(servers[2].timeoutMs, null);
  assert.deepEqual(totals, { servers: 3, enabled: 2, active: 0, failed: 1, tools: null });
});

test('a credential in the row config never reaches the payload', () => {
  const ctx = fakeCtx({
    entries: [entry({
      options: {
        id: 'gaia-mcp-affine',
        name: '@deepseek-ai/dsh-mcp-client',
        config: {
          serverName: 'affine',
          transport: 'streamable-http',
          url: 'http://192.0.2.12:8029/mcp',
          headers: { Authorization: 'Bearer 665cbc108b5b823d29eb77d1d1e5e5f4a950ee60006bb4f9749dc612631ca245' },
        },
      },
    })],
  });

  const result = readServers(ctx);
  const wire = JSON.stringify(result);

  assert.equal(result.servers[0].authenticated, true);
  assert.ok(!wire.includes('665cbc108b5b823d29eb77d1d1e5e5f4'), 'the bearer value must not appear anywhere in the payload');
  assert.ok(!wire.includes('Authorization'));
  assert.ok(!Object.keys(result.servers[0]).includes('headers'));
  assert.ok(!Object.keys(result.servers[0]).includes('env'));
});

test('tool counts come from the registry and are attributed per server', () => {
  const tools = {
    schemas: () => [
      { name: 'mcp__unraid__get_array_status' },
      { name: 'mcp__unraid__list_containers' },
      { name: 'mcp__ynab__list_budgets' },
      { name: 'read' },
      { name: 'mcp__' },
      { name: 'mcp__orphan__tool' },
    ],
  };
  const ctx = fakeCtx({
    entries: [
      entry(),
      entry({ options: { id: 'gaia-mcp-ynab', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'ynab', transport: 'stdio', command: '/tmp/bridge.sh' } } }),
    ],
    tools,
  });

  const { servers, totals } = readServers(ctx);
  assert.deepEqual(servers.map((server) => server.toolCount), [2, 1]);
  assert.equal(totals.tools, 3);
});

test('an unreadable registry reports a dash, never a false zero', () => {
  const broken = { schemas: () => { throw new Error('no agent scope'); } };
  const missing = fakeCtx({ entries: [entry()] });

  assert.equal(readServers(fakeCtx({ entries: [entry()], tools: broken })).servers[0].toolCount, null);
  assert.equal(readServers(fakeCtx({ entries: [entry()], tools: broken })).totals.tools, null);
  assert.equal(readServers(missing).servers[0].toolCount, null);
});

test('a context without a Loader reports an empty list instead of throwing', () => {
  assert.deepEqual(readServers(undefined), {
    servers: [],
    totals: { servers: 0, enabled: 0, active: 0, failed: 0, tools: null },
  });
  assert.deepEqual(readServers({ get: () => { throw new Error('not mounted'); } }).servers, []);
});

test('transport mapping and endpoint extraction', () => {
  assert.equal(transportOf({ transport: 'streamable-http' }), 'http');
  assert.equal(transportOf({ transport: 'http' }), 'http');
  assert.equal(transportOf({ transport: 'stdio' }), 'stdio');
  assert.equal(transportOf({ transport: 'sse' }), 'http');
  assert.equal(transportOf({}), 'other');

  assert.equal(targetOf('http', { url: 'http://host/mcp' }), 'http://host/mcp');
  assert.equal(targetOf('http', {}), '');
  assert.equal(targetOf('stdio', { command: '/usr/bin/node', args: ['a.js', '--flag'] }), '/usr/bin/node a.js --flag');
  assert.equal(targetOf('other', { url: 'http://host/mcp' }), '');
});

test('a long endpoint is elided rather than wrapping the card', () => {
  const long = `http://192.0.2.10:8043/${'x'.repeat(300)}`;
  const target = targetOf('http', { url: long });
  assert.equal(target.length, 160);
  assert.ok(target.endsWith('…'));
});

test('authentication is a boolean read from either header or env', () => {
  assert.equal(isAuthenticated({ headers: { Authorization: 'Bearer x' } }), true);
  assert.equal(isAuthenticated({ env: { GITHUB_TOKEN: 'x' } }), true);
  assert.equal(isAuthenticated({ headers: {} }), false);
  assert.equal(isAuthenticated({}), false);
  assert.equal(isAuthenticated(null), false);
});

test('a timeout is reported as whole milliseconds, or not at all', () => {
  const withTimeout = (toolCallTimeoutMs) => readServers(fakeCtx({
    entries: [entry({
      options: {
        id: 'gaia-mcp-search',
        name: '@deepseek-ai/dsh-mcp-client',
        config: { serverName: 'search', transport: 'streamable-http', url: 'http://host/mcp', toolCallTimeoutMs },
      },
    })],
  })).servers[0].timeoutMs;

  assert.equal(withTimeout(120000), 120000);
  assert.equal(withTimeout(1500.4), 1500, 'a fractional config value must not fail the strict codec');
  assert.equal(withTimeout('120000'), null);
  assert.equal(withTimeout(0), null);
  assert.equal(withTimeout(-1), null);
});
