import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PACKAGE, NAMESPACE, descriptors } from '../lib/contract.js';

const SOURCE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js'),
  'utf8',
);

/**
 * Load `client.js` the way the browser module loader does — as a classic
 * script whose only dependency is `react` — and drive its real component code.
 *
 * React is not on disk (it is served from the archive to the browser), so the
 * stub below implements exactly the four hooks this file uses. What that buys
 * is a genuine pass over the component tree: a typo, a missing locale key, or
 * a bad `h()` call fails here rather than as a blank sidebar entry.
 * @param options - `{ payload, state }`.
 * @returns The captured registrations and remote facts.
 */
function loadClient({ payload = { generatedAt: 1, servers: [], totals: { servers: 0, enabled: 0, active: 0, failed: 0, tools: null } }, state = {}, mountFails = false } = {}) {
  const registrations = [];
  const mounts = [];
  const disposers = [];
  const dictionaries = new Map();
  let plugin = null;
  let injected = 0;

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== undefined) };
    },
    useState(initial) {
      return [Object.hasOwn(state, 'current') ? state.current : initial, () => {}];
    },
    useEffect() {},
    useCallback(fn) {
      return fn;
    },
  };

  const service = { list: async () => ({ ok: true, value: payload }) };
  const ctx = {
    root: {},
    effect(callback) {
      const result = callback();
      if (typeof result === 'function') disposers.push(result);
    },
    inject(_deps, callback) {
      injected += 1;
      callback({ remote: { [NAMESPACE]: service } });
      return { dispose() {} };
    },
    locale: {
      register(namespace, dictionary) {
        dictionaries.set(namespace, dictionary.en ?? dictionary);
      },
      // The real binder returns the template, placeholders intact; callers fill
      // them (`fill(t('card.tools'), { count })`), so this matches.
      bind: (namespace) => (key) => dictionaries.get(namespace)?.[key] ?? key,
    },
    slots: {
      inject(_name, callback) {
        callback();
      },
      register(options, component) {
        registrations.push({ options, component });
        return component;
      },
    },
    remote: {
      async $mount(contribution) {
        if (mountFails) throw new Error('the gateway refused the contribution');
        mounts.push(contribution);
        return () => {};
      },
    },
  };

  const window = {
    __ModuleLoader__: {
      load(definition) {
        plugin = definition.factory((id) => {
          if (id === 'react') return React;
          throw new Error(`client.js must not require ${id}`);
        });
        return undefined;
      },
    },
  };

  // eslint-disable-next-line no-new-func -- the browser loads this file as a classic script
  new Function('window', SOURCE)(window);
  assert.ok(plugin, 'client.js must call window.__ModuleLoader__.load');
  plugin.apply(ctx);

  const main = registrations.find((entry) => entry.options.name === 'main');
  const panel = registrations.find((entry) => entry.options.name === 'sidebar.panellist');
  return {
    plugin,
    registrations,
    main,
    panel,
    mounts,
    disposers,
    dictionaries,
    /** A getter, not a copy: the mount happens on a microtask after `apply`. */
    get injected() {
      return injected;
    },
    /** Let the mount promise chain settle before asserting on it. */
    flush: () => new Promise((resolve) => { setImmediate(resolve); }),
  };
}

/**
 * Render an element tree to the text it would put on screen, calling function
 * components the way React does.
 * @param node - An element, string, or array of them.
 * @returns The concatenated visible text.
 */
function text(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (typeof node.type === 'function') return text(node.type(node.props));
  return node.children.map(text).join(' ');
}

/** One server row, shaped exactly as the Host returns it. */
function row(overrides = {}) {
  return {
    id: 'gaia-mcp-unraid',
    serverName: 'unraid',
    moduleName: 'dsh-plugin-mcp',
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

test('the plugin registers one sidebar entry and one page, under the right option names', () => {
  const client = loadClient();

  assert.deepEqual(client.plugin.inject, ['slots', 'locale', 'remote']);
  assert.deepEqual(client.registrations.map((entry) => entry.options.name), ['main', 'sidebar.panellist']);

  // The README's oldest trap: `main` takes `key`, `sidebar.panellist` takes
  // `id`, and swapping them throws inside the slot ledger.
  assert.equal(client.main.options.key, 'mcp');
  assert.ok(!Object.hasOwn(client.main.options, 'id'));
  assert.equal(client.panel.options.id, 'mcp');
  assert.ok(!Object.hasOwn(client.panel.options, 'key'));
  assert.equal(client.panel.options.order, 20);
  assert.equal(typeof client.panel.component, 'function');
});

test('the descriptors the browser mounts are the descriptors the Host registers', async () => {
  const client = loadClient();
  await client.flush();

  assert.equal(client.mounts.length, 1, '$mount is called once with the contribution');
  const mounted = client.mounts[0];
  assert.equal(mounted.package, PACKAGE);
  assert.equal(mounted.descriptors.length, descriptors(() => () => undefined).length);

  /** Drop the `create` closures; only the ids and type symbols must agree. */
  const shape = (invocation) => ({
    id: invocation.id,
    service: invocation.service,
    namespace: invocation.namespace,
    method: invocation.method,
    invocation: invocation.invocation,
    parameters: invocation.parameters.map((parameter) => ({
      name: parameter.name,
      wire: parameter.wire,
      source: parameter.source,
      codec: { mode: parameter.codec.mode, typeSymbol: parameter.codec.typeSymbol },
    })),
    result: { mode: invocation.result.mode, typeSymbol: invocation.result.typeSymbol },
  });

  assert.deepEqual(
    mounted.descriptors.map(shape),
    descriptors(() => () => undefined).map(shape),
  );
  assert.equal(mounted.descriptors[0].id, `${PACKAGE}#${NAMESPACE}/list`);
});

test('the page renders every field the Host sends', () => {
  const payload = {
    generatedAt: 1_760_000_000_000,
    servers: [
      row(),
      row({ id: 'gaia-mcp-affine', serverName: 'affine', transport: 'http', target: 'http://10.1.3.202:8029/mcp', authenticated: true, toolCount: 26 }),
      row({ id: 'gaia-mcp-wharf', serverName: 'wharf', phase: 'failed', enabled: false, toolCount: null, target: '' }),
      row({ id: 'gaia-mcp-quiet', serverName: 'quiet', phase: 'pending', toolCount: 0 }),
    ],
    totals: { servers: 4, enabled: 3, active: 2, failed: 1, tools: 152 },
  };
  const client = loadClient({ payload, state: { current: { phase: 'ready', report: payload, error: null } } });
  const { t, api } = client.main.options.inject();
  const rendered = text(client.main.component({ t, api }));

  // The header, the refresh control, and the tiles.
  assert.match(rendered, /MCP servers/);
  assert.match(rendered, /Refresh/);
  assert.match(rendered, /Servers 4/);
  assert.match(rendered, /Active 2/);
  assert.match(rendered, /Tools 152/);
  assert.match(rendered, /Failed 1/);

  // A known server: its registry label, its one-line note, its transport, its
  // endpoint, and the tool count the registry actually reported.
  assert.match(rendered, /Unraid/);
  assert.match(rendered, /The NAS: array, containers, VMs/);
  assert.match(rendered, /HTTP/);
  assert.match(rendered, /http:\/\/10\.1\.3\.200:8043\/mcp/);
  assert.match(rendered, /126 tools/);
  assert.match(rendered, /120s timeout/);
  assert.match(rendered, /active/);

  // A credential shows as the word `auth`, never as a value.
  assert.match(rendered, /auth/);

  // A failed server reads failed even while it is switched off; a server with
  // no registry tools reads zero, not a dash.
  assert.match(rendered, /failed/);
  assert.match(rendered, /off/);
  assert.match(rendered, /0 tools/);

  // An unknown server still gets a readable name, the neutral mark, and a dash
  // where the tool registry could not answer — no invented description.
  assert.match(rendered, /Wharf/);
  assert.match(rendered, /tool count unavailable/);
  assert.match(rendered, /no endpoint reported/);

  // The footer states the source of truth and the failure rule.
  assert.match(rendered, /Read-only\. Servers are declared in gaia\/mcp\.yml/);
  assert.match(rendered, /keeps its last tool set/);
});

test('the empty state explains where the servers come from', () => {
  const payload = { generatedAt: 1, servers: [], totals: { servers: 0, enabled: 0, active: 0, failed: 0, tools: null } };
  const client = loadClient({ payload, state: { current: { phase: 'ready', report: payload, error: null } } });
  const { t, api } = client.main.options.inject();
  const panel = client.main.component({ t, api });
  const rendered = text(panel);

  assert.match(rendered, /No MCP servers in this profile/);
  assert.match(rendered, /gaia sync-dsh renders them from gaia\/mcp\.yml/);
  assert.ok(!JSON.stringify(panel).includes('dsm-grid'), 'no grid is drawn for an empty list');
  assert.match(rendered, /Tools —/);
});

test('a failed read renders the error line and keeps the header', () => {
  const client = loadClient({
    state: { current: { phase: 'error', report: null, error: { code: 'x', message: 'the mcp Remote namespace did not become available' } } },
  });
  const { t, api } = client.main.options.inject();
  const rendered = text(client.main.component({ t, api }));

  assert.match(rendered, /Could not read the MCP servers: the mcp Remote namespace did not become available/);
  assert.match(rendered, /Refresh/);
  assert.match(rendered, /Servers —/);
});

test('the injected api calls the Host namespace and passes its answer through', async () => {
  const payload = { generatedAt: 5, servers: [], totals: { servers: 0, enabled: 0, active: 0, failed: 0, tools: null } };
  const client = loadClient({ payload });
  const { api } = client.main.options.inject();

  assert.deepEqual(await api.list(), { ok: true, value: payload });
  await client.flush();
  assert.equal(client.injected, 1, 'the namespace is injected once');
});

test('a refused mount is reported to the panel, not thrown at it', async () => {
  const client = loadClient({ mountFails: true });
  const { api } = client.main.options.inject();
  await client.flush();

  const result = await api.list();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, `${PACKAGE}/namespace`);
  assert.match(result.error.message, /refused the contribution/);
});

test('every locale key the component asks for exists in the dictionary', () => {
  const payload = {
    generatedAt: 1,
    servers: [row(), row({ id: 'gaia-mcp-quiet', serverName: 'quiet', phase: 'pending', enabled: false, transport: 'other', toolCount: null })],
    totals: { servers: 2, enabled: 1, active: 1, failed: 0, tools: 1 },
  };
  const client = loadClient({ payload, state: { current: { phase: 'ready', report: payload, error: null } } });
  const dictionary = client.dictionaries.get('mcp');
  assert.ok(dictionary, 'the panel registers its dictionary');

  // The component's own `t` returns the key when a lookup misses, so a missing
  // entry shows up here as a bare dotted key on screen.
  const { t, api } = client.main.options.inject();
  const rendered = text(client.main.component({ t, api }));
  const keys = rendered.split(/\s+/).filter((word) => /^[a-z]+\.[a-z.]+$/.test(word));
  for (const key of new Set(keys)) {
    assert.ok(Object.hasOwn(dictionary, key), `locale key ${key} is missing from the dictionary`);
  }
});
