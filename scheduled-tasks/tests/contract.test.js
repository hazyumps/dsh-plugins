import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { METHODS, PACKAGE, descriptors } from '../lib/contract.js';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

/** The browser half's schema resolver, which never executes the schemas. */
const stub = () => () => undefined;

/** The descriptor list, built the way the Host builds it. */
const built = descriptors(stub);

/**
 * Method names a Remote namespace cannot use.
 *
 * Taken from the installed browser half: `REMOTE_NAMESPACE_FIELDS`, plus the
 * members of its `RemoteNamespaceService` prototype (`assertMethodAvailable`
 * rejects `method in RemoteNamespaceService.prototype`). Mounting a method in
 * this set throws `client api: method "<ns>/<name>" conflicts with its
 * namespace service`, which blanks the panel.
 */
const RESERVED = new Set([
  ...['ctx', 'empty', 'invokeRemote', 'methods', 'name', 'namespace'],
  ...['constructor', 'assertMethodAvailable', 'has', 'install', 'installDirect', 'installScoped', 'remove'],
]);

describe('contract', () => {
  it('avoids every method name the namespace service reserves', () => {
    for (const method of METHODS) {
      assert.equal(RESERVED.has(method), false, `${method} is reserved by the namespace service`);
    }
  });

  it('does not name a method `remove`, which is reserved', () => {
    // The regression this guards: `remove` mounts on the Host and throws only
    // in the browser, so nothing but this check catches it before the user does.
    assert.equal(METHODS.includes('delete'), true);
    assert.equal(METHODS.includes('remove'), false);
  });

  it('names the package it is exported from', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(PACKAGE, manifest.name);
  });

  it('declares one descriptor per method, in order', () => {
    assert.deepEqual(built.map((entry) => entry.method), METHODS);
  });

  it('builds ids as <package>#<namespace>/<method>', () => {
    for (const entry of built) {
      assert.equal(entry.id, `${PACKAGE}#${entry.namespace}/${entry.method}`);
      assert.equal(entry.service, entry.namespace);
    }
  });

  it('uses only direct unary invocations', () => {
    for (const entry of built) {
      assert.deepEqual(entry.invocation, { kind: 'direct' });
      assert.equal(entry.mode, undefined);
    }
  });

  it('gives every parameter and result a strict codec', () => {
    for (const entry of built) {
      for (const parameter of entry.parameters) {
        assert.equal(parameter.codec.mode, 'strict', `${entry.id} parameter ${parameter.name}`);
        assert.equal(parameter.source, 'json');
        assert.equal(parameter.wire, parameter.name);
        assert.equal(typeof parameter.codec.create, 'function');
      }
      assert.equal(entry.result.mode, 'strict', `${entry.id} result`);
      assert.equal(typeof entry.result.create, 'function');
      assert.match(entry.result.typeSymbol, new RegExp(`^${PACKAGE}#`));
    }
  });

  it('covers every declared result type in the Host manifest', () => {
    // The Host half resolves each result symbol against a zod schema; the two
    // lists are authored separately, so drift is worth catching here.
    const source = fs.readFileSync(path.join(root, 'lib', 'typert.host.js'), 'utf8');
    for (const entry of built) {
      const short = entry.result.typeSymbol.slice(PACKAGE.length + 1);
      assert.match(source, new RegExp(`\\b${short}:`), `${short} has no schema in typert.host.js`);
    }
    for (const entry of built) {
      for (const parameter of entry.parameters) {
        const short = parameter.codec.typeSymbol.slice(PACKAGE.length + 1);
        assert.match(source, new RegExp(`\\b${short}:`), `${short} has no schema in typert.host.js`);
      }
    }
  });

  it('declares the Host manifest under the package name with the host face', () => {
    const source = fs.readFileSync(path.join(root, 'lib', 'typert.host.js'), 'utf8');
    assert.match(source, /face: 'host'/);
    assert.match(source, /package: PACKAGE/);
  });
});
