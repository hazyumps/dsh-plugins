import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  createScanCache,
  dayFormatter,
  dayKey,
  emptyTokens,
  isPeak,
  parseLog,
  scanSessions,
  sessionFiles,
} from '../lib/scan.js';

/** A session-log row carrying token usage. */
function row(time, model, usage, provider = 'deepseek-official') {
  return `${JSON.stringify({
    type: 'assistant/message',
    time: Date.parse(time),
    data: { message: { source: { kind: 'model', provider, model } }, usage },
  })}\n`;
}

/** A temporary sessions tree. */
function makeTree(build) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-scan-'));
  build(root);
  return root;
}

/** Write a session log, optionally zstd-framed per record. */
function writeLog(root, workspace, session, lines, { compressed = false } = {}) {
  const dir = path.join(root, workspace, session);
  fs.mkdirSync(dir, { recursive: true });
  const name = compressed ? 'session.v4.jsonl.zstd' : 'session.v4.jsonl';
  const body = compressed
    ? Buffer.concat(lines.map((line) => zlib.zstdCompressSync(Buffer.from(line))))
    : Buffer.from(lines.join(''));
  fs.writeFileSync(path.join(dir, name), body);
  return path.join(dir, name);
}

const USAGE_A = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 0, totalTokens: 1110 };
const USAGE_B = { inputTokens: 200, outputTokens: 20, cacheReadTokens: 2000, cacheWriteTokens: 0, totalTokens: 2220 };

test('buckets peak and off-peak hours by UTC weekday and hour', () => {
  assert.equal(isPeak(Date.parse('2026-10-07T02:00:00Z')), true, 'Wednesday 02:00 UTC is peak');
  assert.equal(isPeak(Date.parse('2026-10-07T06:00:00Z')), true, 'Wednesday 06:00 UTC is peak');
  assert.equal(isPeak(Date.parse('2026-10-07T04:30:00Z')), false, 'the 04:00-06:00 gap is off-peak');
  assert.equal(isPeak(Date.parse('2026-10-07T12:00:00Z')), false, 'Wednesday midday is off-peak');
  assert.equal(isPeak(Date.parse('2026-10-10T02:00:00Z')), false, 'Saturday is off-peak all day');
});

test('lists session logs and ignores other files', () => {
  const root = makeTree((dir) => {
    writeLog(dir, '--ws--', 'session-a', [row('2026-10-07T02:00:00Z', 'deepseek-flash', USAGE_A)]);
    fs.writeFileSync(path.join(dir, '--ws--', 'session-a', 'session.lock'), '');
  });
  const files = sessionFiles(root);
  assert.equal(files.length, 1);
  assert.match(files[0], /session-a\/session\.v4\.jsonl$/);
});

test('folds a plain log into model and day totals with a peak split', () => {
  const root = makeTree((dir) => {
    writeLog(dir, '--ws--', 'session-a', [
      row('2026-10-07T02:00:00Z', 'deepseek-flash', USAGE_A), // peak
      row('2026-10-07T12:00:00Z', 'deepseek-flash', USAGE_B), // off-peak
    ]);
  });
  const scan = scanSessions({ root, timeZone: 'UTC' });
  const model = scan.byModel['deepseek-official/deepseek-flash'];
  assert.equal(model.input, 300);
  assert.equal(model.output, 30);
  assert.equal(model.cacheRead, 3000);
  assert.equal(model.steps, 2);
  assert.equal(model.peakInput, 100);
  assert.equal(model.peakOutput, 10);
  assert.equal(model.peakCacheRead, 1000);
  assert.equal(model.peakSteps, 1);
  assert.deepEqual(Object.keys(scan.byDay), ['2026-10-07']);
  assert.equal(scan.byDay['2026-10-07'].input, 300);
});

test('folds a multi-frame zstd log the same way', () => {
  const root = makeTree((dir) => {
    writeLog(dir, '--ws--', 'session-b', [
      row('2026-10-07T02:00:00Z', 'deepseek-flash', USAGE_A),
      row('2026-10-07T12:00:00Z', 'deepseek-flash', USAGE_B),
    ], { compressed: true });
  });
  const scan = scanSessions({ root, timeZone: 'UTC' });
  const model = scan.byModel['deepseek-official/deepseek-flash'];
  assert.equal(model.input, 300);
  assert.equal(model.peakInput, 100);
});

test('keeps the per-day model split, which is what a day cost needs', () => {
  const root = makeTree((dir) => {
    writeLog(dir, '--ws--', 'session-c', [
      row('2026-10-07T02:00:00Z', 'deepseek-flash', USAGE_A),
      row('2026-10-07T02:00:00Z', 'Ember', USAGE_B, 'gaia-local'),
    ]);
  });
  const scan = scanSessions({ root, timeZone: 'UTC' });
  const day = scan.byDayModel['2026-10-07'];
  assert.deepEqual(Object.keys(day).sort(), ['deepseek-official/deepseek-flash', 'gaia-local/Ember']);
  assert.equal(day['gaia-local/Ember'].input, 200);
});

test('reuses a cached log until its size or mtime changes', () => {
  let file;
  const root = makeTree((dir) => {
    file = writeLog(dir, '--ws--', 'session-d', [row('2026-10-07T12:00:00Z', 'deepseek-flash', USAGE_A)]);
  });
  const cache = createScanCache();
  const first = scanSessions({ root, timeZone: 'UTC', cache });
  assert.equal(first.reused, 0);
  const second = scanSessions({ root, timeZone: 'UTC', cache });
  assert.equal(second.reused, 1);

  fs.appendFileSync(file, row('2026-10-07T12:01:00Z', 'deepseek-flash', USAGE_B));
  const third = scanSessions({ root, timeZone: 'UTC', cache });
  assert.equal(third.reused, 0, 'a changed file is re-read');
  assert.equal(third.byModel['deepseek-official/deepseek-flash'].input, 300);
});

test('survives a corrupt log without failing the scan', () => {
  const root = makeTree((dir) => {
    writeLog(dir, '--ws--', 'session-e', [row('2026-10-07T12:00:00Z', 'deepseek-flash', USAGE_A)]);
    const broken = path.join(dir, '--ws--', 'session-f');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, 'session.v4.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01]));
  });
  const scan = scanSessions({ root, timeZone: 'UTC' });
  assert.equal(scan.files, 2);
  assert.equal(scan.byModel['deepseek-official/deepseek-flash'].input, 100);
});

test('answers an empty root with zeroes rather than throwing', () => {
  const scan = scanSessions({ root: '/definitely/not/here', timeZone: 'UTC' });
  assert.equal(scan.files, 0);
  assert.deepEqual(scan.byModel, {});
});

test('buckets days in the requested zone', () => {
  const formatter = dayFormatter('America/Chicago');
  // 03:00 UTC on the 8th is still the evening of the 7th in Chicago.
  assert.equal(dayKey(Date.parse('2026-10-08T03:00:00Z'), formatter), '2026-10-07');
});

test('falls back to the host zone for an invalid zone', () => {
  const formatter = dayFormatter('Not/AZone');
  assert.match(dayKey(Date.parse('2026-10-08T03:00:00Z'), formatter), /^\d{4}-\d{2}-\d{2}$/);
});

test('parses a log directly, keeping an unreadable file addressable', () => {
  const root = makeTree((dir) => {
    writeLog(dir, '--ws--', 'session-g', [row('2026-10-07T12:00:00Z', 'deepseek-flash', USAGE_A)]);
  });
  const file = sessionFiles(root)[0];
  const stat = fs.statSync(file);
  const aggregate = parseLog(file, stat, { formatter: dayFormatter('UTC') });
  assert.equal(aggregate.records, 1);
  assert.equal(aggregate.usageRecords, 1);
  assert.equal(aggregate.models['deepseek-official/deepseek-flash'].input, 100);

  const missing = parseLog('/nope/session.v4.jsonl', { size: 1, mtimeMs: 1 }, { formatter: dayFormatter('UTC') });
  assert.equal(missing.records, 0);
  assert.equal(missing.size, 1);
});

test('ignores rows with no usage and unknown sources stay labelled', () => {
  const root = makeTree((dir) => {
    writeLog(dir, '--ws--', 'session-h', [
      `${JSON.stringify({ type: 'user/message', time: Date.parse('2026-10-07T12:00:00Z'), data: {} })}\n`,
      `${JSON.stringify({ type: 'assistant/message', time: Date.parse('2026-10-07T12:00:00Z'), data: { usage: USAGE_A } })}\n`,
    ]);
  });
  const scan = scanSessions({ root, timeZone: 'UTC' });
  assert.ok(scan.byModel['unknown/unknown'], 'a row without a source is still counted');
  assert.equal(scan.byModel['unknown/unknown'].input, 100);
  assert.equal(scan.usageRecords, 1);
  assert.equal(scan.records, 2);
});

test('emptyTokens starts at zero for every field', () => {
  for (const value of Object.values(emptyTokens())) assert.equal(value, 0);
});
