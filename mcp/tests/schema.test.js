import test from 'node:test';
import assert from 'node:assert/strict';

import { SCHEMAS, schema, specs } from '../lib/schema.js';

/** One valid row, as `lib/servers.js` builds it. */
function row(overrides = {}) {
  return {
    id: 'gaia-mcp-unraid',
    serverName: 'unraid',
    moduleName: '@deepseek-ai/dsh-mcp-client',
    enabled: true,
    phase: 'active',
    transport: 'http',
    target: 'http://10.1.3.200:8043/mcp',
    authenticated: false,
    timeoutMs: 120000,
    toolPrefix: 'mcp__unraid',
    toolCount: 126,
    ...overrides,
  };
}

/** One valid payload. */
function payload(overrides = {}) {
  return {
    generatedAt: 1_760_000_000_000,
    servers: [row()],
    totals: { servers: 1, enabled: 1, active: 1, failed: 0, tools: 126 },
    ...overrides,
  };
}

test('the strict codec accepts the shape the Host builds', () => {
  const parsed = SCHEMAS.ListResult.parse(payload());
  assert.equal(parsed.servers[0].serverName, 'unraid');
  assert.equal(parsed.servers[0].toolCount, 126);
});

test('a null tool count is valid — an unreadable registry is not a zero', () => {
  const parsed = SCHEMAS.ListResult.parse(payload({
    servers: [row({ toolCount: null })],
    totals: { servers: 1, enabled: 1, active: 1, failed: 0, tools: null },
  }));
  assert.equal(parsed.servers[0].toolCount, null);
  assert.equal(parsed.totals.tools, null);
});

test('an unknown field is an error, not something silently stripped', () => {
  assert.throws(
    () => SCHEMAS.ListResult.parse(payload({ servers: [row({ headers: { Authorization: 'Bearer x' } })] })),
    /unknown field "headers"/,
  );
  assert.throws(
    () => SCHEMAS.ListResult.parse(payload({ servers: [row({ env: { TOKEN: 'x' } })] })),
    /unknown field "env"/,
  );
});

test('enums reject a phase or transport the panel cannot draw', () => {
  assert.throws(() => SCHEMAS.ListResult.parse(payload({ servers: [row({ phase: 'exploded' })] })), /must be one of/);
  assert.throws(() => SCHEMAS.ListResult.parse(payload({ servers: [row({ transport: 'grpc' })] })), /must be one of/);
});

test('types are checked on every field the panel reads', () => {
  assert.throws(() => SCHEMAS.ListResult.parse(payload({ servers: [row({ enabled: 'yes' })] })), /must be a boolean/);
  assert.throws(() => SCHEMAS.ListResult.parse(payload({ servers: [row({ timeoutMs: 'soon' })] })), /must be a finite number/);
  assert.throws(() => SCHEMAS.ListResult.parse(payload({ servers: [row({ toolCount: 1.5 })] })), /must be an integer/);
  assert.throws(() => SCHEMAS.ListResult.parse(payload({ servers: [row({ target: null })] })), /must be a string/);
  assert.throws(() => SCHEMAS.ListResult.parse(payload({ totals: { servers: 1 } })), /totals\.enabled is required/);
});

test('an absent field is an error too — the contract is not partial', () => {
  const complete = row();
  const withoutCount = { ...complete };
  delete withoutCount.toolCount;
  assert.equal(complete.toolCount, 126);
  assert.throws(() => SCHEMAS.ListResult.parse(payload({ servers: [withoutCount] })), /toolCount is required/);
});

test('the list request is a strict empty object', () => {
  assert.deepEqual(SCHEMAS.ListRequest.parse({}), {});
  assert.throws(() => SCHEMAS.ListRequest.parse({ refresh: true }), /unknown field "refresh"/);
});

test('the spec vocabulary refuses a type the checks do not implement', () => {
  assert.throws(
    () => schema(specs.object({ when: { type: 'date' } })).parse({ when: 'x' }),
    /unsupported spec type/,
  );
  assert.equal(specs.object({}).type, 'object');
  assert.equal(specs.nullable(specs.string()).type, 'nullable');
});
