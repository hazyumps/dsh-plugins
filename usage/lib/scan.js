/**
 * Reading the Harness's own token usage.
 *
 * The durable session log is the only place DSH records what a request cost in
 * tokens: every `assistant/message` row carries a `usage` object and the
 * provider/model that produced it. This module walks `<home>/sessions`, decodes
 * each log, and folds those rows into per-model totals and a per-day,
 * per-model split (which is what makes a per-day dollar figure exact — a day
 * total alone cannot be priced, because models have different rates).
 *
 * Reading files rather than the session services is deliberate: it needs no
 * injection, works in any profile, and covers every workspace on disk — not
 * just sessions this Host has open.
 *
 * @module dsh-plugin-usage/scan
 */

import fs from 'node:fs';
import path from 'node:path';

import { decodeFrames } from './zstd.js';

/** Named token fields. */
export const TOKEN_FIELDS = ['input', 'cacheRead', 'cacheWrite', 'output'];

/**
 * The subset of each counter that was billed at peak rates.
 *
 * DeepSeek charges twice as much during peak hours, and the rate applies to
 * when each request ran — not to the day as a whole. The scan therefore keeps
 * both the total and the peak slice, and the pricer bills the difference at
 * the off-peak rate.
 */
export const PEAK_FIELDS = ['peakInput', 'peakCacheRead', 'peakCacheWrite', 'peakOutput'];

/** Every numeric field of a counter, for the fold. */
const COUNTER_FIELDS = [...TOKEN_FIELDS, ...PEAK_FIELDS, 'steps', 'peakSteps'];

/** An all-zero token counter. */
export function emptyTokens() {
  return {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    steps: 0,
    peakInput: 0,
    peakCacheRead: 0,
    peakCacheWrite: 0,
    peakOutput: 0,
    peakSteps: 0,
  };
}

/**
 * One token counter.
 * @typedef {ReturnType<typeof emptyTokens>} Tokens
 */

/**
 * Whether an instant falls in DeepSeek's peak window.
 *
 * Peak is 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday, excluding Chinese
 * public holidays. The exclusion is not modelled — a holiday request is billed
 * as peak, so a holiday estimate is at most one window's worth too high.
 * @param time - Epoch milliseconds.
 * @returns True when peak rates apply.
 */
export function isPeak(time) {
  const at = new Date(time);
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/**
 * Add one usage row into a counter, in place.
 * @param counter - Destination counter.
 * @param usage - A session-log `usage` object.
 * @param peak - Whether this row was billed at peak rates.
 */
function addUsage(counter, usage, peak) {
  const fields = [
    ['input', usage.inputTokens ?? 0],
    ['cacheRead', usage.cacheReadTokens ?? 0],
    ['cacheWrite', usage.cacheWriteTokens ?? 0],
    ['output', usage.outputTokens ?? 0],
  ];
  for (const [field, value] of fields) {
    counter[field] += value;
    if (peak) counter[`peak${field[0].toUpperCase()}${field.slice(1)}`] += value;
  }
  counter.steps += 1;
  if (peak) counter.peakSteps += 1;
}

/**
 * Add one counter into another, in place.
 * @param target - Destination counter.
 * @param source - Counter to add.
 */
export function addCounter(target, source) {
  for (const field of COUNTER_FIELDS) target[field] += source[field] ?? 0;
}

/**
 * The local calendar day a timestamp falls on.
 * @param time - Epoch milliseconds.
 * @param formatter - A configured `Intl.DateTimeFormat`.
 * @returns `YYYY-MM-DD` in the formatter's zone.
 */
export function dayKey(time, formatter) {
  return formatter.format(new Date(time));
}

/**
 * A day-key formatter for one IANA zone.
 * @param timeZone - IANA zone; empty or invalid falls back to the host zone.
 * @returns The formatter.
 */
export function dayFormatter(timeZone) {
  const options = { year: 'numeric', month: '2-digit', day: '2-digit' };
  if (typeof timeZone === 'string' && timeZone.length > 0) {
    try {
      return new Intl.DateTimeFormat('en-CA', { ...options, timeZone });
    } catch {
      // Fall through to the host zone.
    }
  }
  return new Intl.DateTimeFormat('en-CA', options);
}

/**
 * `readdirSync` that answers an empty list instead of throwing.
 * @param dir - Directory to read.
 * @returns Dirent entries.
 */
function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Every session log under a sessions root.
 * @param root - The `<home>/sessions` directory.
 * @returns Absolute file paths, sorted.
 */
export function sessionFiles(root) {
  const found = [];
  for (const workspace of safeReaddir(root)) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = path.join(root, workspace.name);
    for (const session of safeReaddir(workspaceDir)) {
      if (!session.isDirectory()) continue;
      const sessionDir = path.join(workspaceDir, session.name);
      for (const entry of safeReaddir(sessionDir)) {
        if (!entry.isFile()) continue;
        if (!/^session.*\.(jsonl|jsonl\.zstd)$/.test(entry.name)) continue;
        found.push(path.join(sessionDir, entry.name));
      }
    }
  }
  return found.sort();
}

/**
 * The per-file aggregate carried across scans.
 * @typedef {object} FileAggregate
 * @property {number} size - File size when parsed, for cache validation.
 * @property {number} mtimeMs - File mtime when parsed, for cache validation.
 * @property {number} bytes - Compressed bytes read.
 * @property {number} records - Log rows seen.
 * @property {number} usageRecords - Rows carrying token usage.
 * @property {Record<string, Record<string, Tokens & {provider: string, model: string}>>} dayModels
 *   `{ [day]: { [provider/model]: counter } }`.
 * @property {Record<string, Tokens & {provider: string, model: string}>} models
 *   `{ [provider/model]: counter }`.
 */

/**
 * Parse one session log into day/model counters.
 * @param file - Absolute log path.
 * @param stat - Its `fs.statSync` result.
 * @param options - Parse options.
 * @param options.formatter - Day-key formatter.
 * @returns The aggregate.
 */
export function parseLog(file, stat, options) {
  const formatter = options.formatter;
  const aggregate = {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    bytes: 0,
    records: 0,
    usageRecords: 0,
    dayModels: {},
    models: {},
  };

  let text;
  try {
    const raw = fs.readFileSync(file);
    aggregate.bytes = raw.length;
    text = decodeFrames(raw).toString('utf8');
  } catch {
    // A truncated or unreadable log contributes nothing rather than failing the
    // whole scan. Size/mtime stay recorded, so it is re-read once it settles.
    return aggregate;
  }

  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    aggregate.records += 1;
    const usage = record?.data?.usage;
    if (usage === undefined || usage === null) continue;
    aggregate.usageRecords += 1;

    const source = record?.data?.message?.source ?? {};
    const providerId = typeof source.provider === 'string' && source.provider.length > 0
      ? source.provider : 'unknown';
    const model = typeof source.model === 'string' && source.model.length > 0
      ? source.model : 'unknown';
    const key = `${providerId}/${model}`;

    const time = typeof record.time === 'number' ? record.time : 0;
    const peak = isPeak(time);
    const day = dayKey(time, formatter);

    const modelCounter = aggregate.models[key] ?? { provider: providerId, model, ...emptyTokens() };
    addUsage(modelCounter, usage, peak);
    aggregate.models[key] = modelCounter;

    const dayModels = aggregate.dayModels[day] ?? {};
    const dayCounter = dayModels[key] ?? { provider: providerId, model, ...emptyTokens() };
    addUsage(dayCounter, usage, peak);
    dayModels[key] = dayCounter;
    aggregate.dayModels[day] = dayModels;
  }

  return aggregate;
}

/**
 * A cache of parsed logs, keyed by path.
 * @returns A fresh `Map`.
 */
export function createScanCache() {
  return new Map();
}

/**
 * Scan every session log under a root.
 *
 * A file whose size and mtime are unchanged is served from `cache`, so a
 * repeated summary is a stat-walk rather than a re-decode.
 * @param options - Scan options.
 * @param options.root - The `<home>/sessions` directory.
 * @param options.timeZone - IANA zone for day bucketing.
 * @param options.cache - Cache from {@link createScanCache}.
 * @param options.now - Epoch milliseconds, injectable for tests.
 * @returns The folded scan result.
 */
export function scanSessions(options) {
  const started = Date.now();
  const root = options.root;
  const cache = options.cache ?? createScanCache();
  const formatter = dayFormatter(options.timeZone);

  /** @type {Record<string, Record<string, Tokens & {provider: string, model: string}>>} */
  const byDayModel = {};
  /** @type {Record<string, Tokens & {provider: string, model: string}>} */
  const byModel = {};
  let files = 0;
  let reused = 0;
  let bytes = 0;
  let records = 0;
  let usageRecords = 0;

  for (const file of sessionFiles(root)) {
    files += 1;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }

    const cached = cache.get(file);
    let aggregate;
    if (cached !== undefined && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      aggregate = cached;
      reused += 1;
    } else {
      aggregate = parseLog(file, stat, { formatter });
    }
    cache.set(file, aggregate);

    bytes += aggregate.bytes;
    records += aggregate.records;
    usageRecords += aggregate.usageRecords;

    for (const [day, models] of Object.entries(aggregate.dayModels)) {
      const dayBucket = byDayModel[day] ?? (byDayModel[day] = {});
      for (const [key, counter] of Object.entries(models)) {
        const existing = dayBucket[key];
        if (existing === undefined) dayBucket[key] = { ...counter };
        else addCounter(existing, counter);
      }
    }
    for (const [key, counter] of Object.entries(aggregate.models)) {
      const existing = byModel[key];
      if (existing === undefined) byModel[key] = { ...counter };
      else addCounter(existing, counter);
    }
  }

  /** @type {Record<string, Tokens>} */
  const byDay = {};
  for (const [day, models] of Object.entries(byDayModel)) {
    const total = emptyTokens();
    for (const counter of Object.values(models)) addCounter(total, counter);
    byDay[day] = total;
  }

  return {
    root,
    files,
    reused,
    bytes,
    records,
    usageRecords,
    sessions: files,
    ms: Date.now() - started,
    byDay,
    byDayModel,
    byModel,
    generatedAt: options.now ?? Date.now(),
  };
}
