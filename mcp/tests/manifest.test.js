import test from 'node:test';
import assert from 'node:assert/strict';

import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader';

import { PACKAGE, NAMESPACE, descriptors } from '../lib/contract.js';
import { TYPERT } from '../lib/typert.host.js';
import { SCHEMAS } from '../lib/schema.js';

/**
 * The gate the Host actually passes through when the plugin row mounts:
 * `@deepseek-ai/dsh-typert-loader` imports the `./typert` export and runs this
 * validator over it. The fixture is the shipped module, extracted from
 * app.asar, so a manifest that passes here is one the loader accepts.
 */
test('the shipped loader accepts this manifest', () => {
  assert.equal(validateTypertManifest(PACKAGE, TYPERT), TYPERT);
});

test('the loader rejects a manifest that names another package', () => {
  assert.throws(
    () => validateTypertManifest('dsh-plugin-something-else', TYPERT),
    /must be owned by the package that exports it/,
  );
});

test('the loader rejects a client face', () => {
  assert.throws(() => validateTypertManifest(PACKAGE, { ...TYPERT, face: 'client' }), /face is not "host"/);
});

test('the manifest declares exactly the methods the client mounts', () => {
  const service = TYPERT.model.services[0];
  assert.equal(service.key, NAMESPACE);
  const declared = service.members.filter((member) => member.kind === 'method').map((member) => member.name);
  const mounted = descriptors(() => () => undefined).map((invocation) => invocation.method);
  assert.deepEqual(declared, mounted);
});

test('the service key matches the Host service the plugin provides', () => {
  assert.equal(NAMESPACE, 'mcp');
  assert.equal(TYPERT.model.services[0].key, NAMESPACE);
});

test('every invocation references a schema the manifest can resolve', () => {
  const invocations = descriptors((typeSymbol) => {
    const short = typeSymbol.slice(typeSymbol.lastIndexOf('#') + 1);
    assert.ok(SCHEMAS[short], `schema for ${typeSymbol}`);
    return () => SCHEMAS[short];
  });
  assert.equal(invocations.length, TYPERT.invocations.length);
  assert.equal(invocations[0].parameters[0].codec.create(), SCHEMAS.ListRequest);
  assert.equal(invocations[0].result.create(), SCHEMAS.ListResult);
});

test('the descriptor ids name the package the client half mounts', () => {
  const invocation = descriptors(() => () => undefined)[0];
  assert.equal(invocation.id, 'dsh-plugin-mcp#mcp/list');
  assert.equal(invocation.namespace, 'mcp');
  assert.equal(invocation.service, 'mcp');
});
