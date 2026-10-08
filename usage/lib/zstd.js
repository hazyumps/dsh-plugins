/**
 * Multi-frame zstd decoding.
 *
 * DSH appends each session-log record as its own zstd frame, and Node's
 * `zstdDecompressSync` stops after the first frame — so a whole-file call
 * silently returns one record instead of the whole log. This module walks the
 * frame magic and decodes each frame separately, which reproduces `zstd -dc`
 * byte for byte (verified against the CLI on a live log).
 *
 * @module dsh-plugin-usage/zstd
 */

import zlib from 'node:zlib';

/** The zstd frame magic number, little-endian `0xFD2FB528`. */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Whether a buffer starts with a zstd frame.
 * @param buffer - Candidate bytes.
 * @returns True when the buffer begins with the zstd magic.
 */
export function isZstd(buffer) {
  return buffer.length >= MAGIC.length && buffer.subarray(0, MAGIC.length).equals(MAGIC);
}

/**
 * Decode every zstd frame in a buffer.
 *
 * A candidate offset that is not a real frame start — the magic can occur by
 * chance inside compressed data — throws and is skipped. A buffer that is not
 * zstd at all is returned unchanged, so a plain `.jsonl` log reads the same way.
 * @param buffer - Compressed (or plain) bytes.
 * @param options - Decoder options.
 * @param options.decompress - Frame decoder, injectable for tests.
 * @returns The concatenated decoded bytes.
 */
export function decodeFrames(buffer, options = {}) {
  const decompress = options.decompress ?? zlib.zstdDecompressSync;
  if (buffer.length === 0) return Buffer.alloc(0);
  if (!isZstd(buffer)) return buffer;

  const chunks = [];
  let index = 0;
  for (;;) {
    const at = buffer.indexOf(MAGIC, index);
    if (at === -1) break;
    index = at + MAGIC.length;
    try {
      chunks.push(decompress(buffer.subarray(at)));
    } catch {
      // Not a frame boundary; the reader keeps walking.
    }
  }
  if (chunks.length === 0) throw new Error('no zstd frame could be decoded');
  return Buffer.concat(chunks);
}
