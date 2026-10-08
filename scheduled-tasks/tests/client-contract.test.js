/**
 * The two halves declare the Remote contract separately — the Host through
 * `./typert`, the browser through `$mount` — so this loads `client.js` in a
 * mocked browser and compares what it mounts with `lib/contract.js`.
 *
 * The client is a classic script, not a module, so it is evaluated through
 * `window.__ModuleLoader__` the way the Harness loads it.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { PACKAGE, descriptors } from '../lib/contract.js';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

/** Anything the client asks React for behaves as an unused stub here. */
const reactStub = new Proxy({}, {
  get: () => () => null,
  has: () => true,
});

/**
 * Load `client.js` and run its `apply` against a recording context.
 * @returns `{ id, inject, mounted, applied, slots }`.
 */
async function loadClient() {
  const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8');
  let registration;
  const window = {
    __ModuleLoader__: {
      load(entry) {
        registration = entry;
      },
    },
  };
  // Both are read as bare globals by a classic script.
  const previousWindow = globalThis.window;
  globalThis.window = window;
  try {
    // eslint-disable-next-line no-new-func -- the only way to run a classic script
    new Function('window', source)(window);
  } finally {
    globalThis.window = previousWindow;
  }
  assert.ok(registration, 'client.js never called __ModuleLoader__.load');

  const module = registration.factory((specifier) => {
    if (specifier === 'react') return reactStub;
    throw new Error(`client.js required an unexpected module: ${specifier}`);
  });

  const mounted = [];
  const slots = [];
  const ctx = {
    root: {},
    effect: (fn) => {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    on: () => () => {},
    inject: (_services, callback) => {
      callback({ remote: { scheduledTasks: {} } });
      return () => {};
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    slots: {
      inject: (_name, callback) => {
        callback();
        return () => {};
      },
      register: (options) => {
        slots.push(options);
        return () => {};
      },
    },
    remote: {
      $mount: async (contribution) => {
        mounted.push(contribution);
      },
    },
  };
  module.apply(ctx);
  // The mount is asynchronous; let its promise chain settle.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return { ...registration, inject: module.inject, mounted, slots };
}

describe('client contract', () => {
  it('loads as a classic script under the package name', async () => {
    const client = await loadClient();
    assert.equal(client.id, PACKAGE);
  });

  it('mounts exactly the Host descriptors, with stub codecs', async () => {
    const client = await loadClient();
    assert.equal(client.mounted.length, 1, 'expected exactly one $mount');
    const [contribution] = client.mounted;
    assert.equal(contribution.package, PACKAGE);

    const expected = descriptors(() => () => undefined);
    // Compare the structure the client must agree on; `create` is a stub there
    // and a zod schema here, so only its presence is comparable.
    const normalize = (list) => list.map((entry) => ({
      ...entry,
      parameters: entry.parameters.map((parameter) => ({
        ...parameter,
        codec: { ...parameter.codec, create: typeof parameter.codec.create },
      })),
      result: { ...entry.result, create: typeof entry.result.create },
    }));
    assert.deepEqual(normalize(contribution.descriptors), normalize(expected));
  });

  it('registers a sidebar entry and a main panel under one shared id', async () => {
    const client = await loadClient();
    const main = client.slots.find((entry) => entry.name === 'main');
    const sidebar = client.slots.find((entry) => entry.name === 'sidebar.panellist');
    assert.ok(main, 'no main panel registered');
    assert.ok(sidebar, 'no sidebar entry registered');
    // `main` is keyed by `key`; `sidebar.panellist` is a list keyed by `id`.
    assert.equal(main.key, sidebar.id);
    assert.equal(typeof sidebar.label, 'function');
  });

  it('declares the shipped namespaces it reads', async () => {
    const client = await loadClient();
    // Reading an undeclared service off the context throws
    // `cannot get property "x" without inject`, so every namespace the page
    // touches must be declared. The shipped ones exist on their own.
    for (const service of ['slots', 'locale', 'remote', 'remote.session', 'remote.agentPresets']) {
      assert.equal(client.inject.includes(service), true, `${service} must be injected`);
    }
  });

  it('does not inject its own namespace, which does not exist until $mount', async () => {
    const client = await loadClient();
    assert.equal(client.inject.some((entry) => entry.startsWith('remote.scheduledTasks')), false);
  });
});
