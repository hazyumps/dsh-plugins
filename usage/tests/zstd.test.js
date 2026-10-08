import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { decodeFrames, isZstd } from '../lib/zstd.js';

/** One compressed frame of `text`. */
function frame(text) {
  return zlib.zstdCompressSync(Buffer.from(text));
}

test('decodes every frame of a multi-frame buffer', () => {
  const parts = ['{"a":1}\n', '{"a":2}\n', '{"a":3}\n'];
  const buffer = Buffer.concat(parts.map(frame));
  assert.equal(isZstd(buffer), true);
  assert.equal(decodeFrames(buffer).toString('utf8'), parts.join(''));
});

test('decodes a single-frame buffer', () => {
  assert.equal(decodeFrames(frame('{"only":true}\n')).toString('utf8'), '{"only":true}\n');
});

test('passes non-zstd bytes through unchanged', () => {
  const plain = Buffer.from('{"plain":1}\n');
  assert.equal(isZstd(plain), false);
  assert.equal(decodeFrames(plain).toString('utf8'), '{"plain":1}\n');
});

test('handles an empty buffer', () => {
  assert.equal(decodeFrames(Buffer.alloc(0)).length, 0);
});

test('skips a stray magic that is not a frame start', () => {
  const buffer = Buffer.concat([frame('{"a":1}\n'), Buffer.from('trailing')]);
  assert.equal(decodeFrames(buffer).toString('utf8'), '{"a":1}\n');
});

test('throws when the magic never leads to a frame', () => {
  const buffer = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('nonsense')]);
  assert.throws(() => decodeFrames(buffer), /no zstd frame/);
});
