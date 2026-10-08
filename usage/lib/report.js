/**
 * Assembling one report for the panel.
 *
 * Pure: it turns a scan, a balance read, and the provider registry into the
 * exact shape the browser half renders. Nothing here touches the filesystem or
 * the network, so the arithmetic — the day windows and the cost roll-up — is
 * directly testable.
 *
 * @module dsh-plugin-usage/report
 */

import { TOKEN_FIELDS, emptyTokens, addCounter } from './scan.js';
import { costOf, PRICE_NOTE } from './pricing.js';
import { modelLabel, provider as providerRow } from './registry.js';

/**
 * Parse a `YYYY-MM-DD` key into UTC midnight, so day arithmetic never drifts
 * with the host zone.
 * @param day - Day key.
 * @returns Epoch milliseconds.
 */
function dayStart(day) {
  const [year, month, date] = day.split('-').map(Number);
  return Date.UTC(year, (month ?? 1) - 1, date ?? 1);
}

/**
 * Shift a day key by whole days.
 * @param day - Day key.
 * @param delta - Days to add; negative goes back.
 * @returns The shifted key.
 */
export function shiftDay(day, delta) {
  return new Date(dayStart(day) + delta * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The provider and model behind one bucket entry.
 *
 * The scan writes them onto the counter; a hand-built scan may only have the
 * `provider/model` key. Reading both shapes here keeps such a scan priced and
 * labelled instead of silently unpriced.
 * @param key - The bucket key.
 * @param counter - The counter.
 * @returns `{ providerId, model }`.
 */
function identify(key, counter) {
  if (typeof counter.provider === 'string' && typeof counter.model === 'string') {
    return { providerId: counter.provider, model: counter.model };
  }
  const separator = key.indexOf('/');
  return separator === -1
    ? { providerId: key, model: 'unknown' }
    : { providerId: key.slice(0, separator), model: key.slice(separator + 1) };
}

/**
 * Price one day's per-model split.
 * @param dayModels - `{ [provider/model]: counter }`.
 * @returns `{ cost, tokens, unpriced }`.
 */
export function priceDay(dayModels) {
  let cost = 0;
  let unpriced = 0;
  const tokens = emptyTokens();
  for (const [key, counter] of Object.entries(dayModels)) {
    const { providerId, model } = identify(key, counter);
    const priced = costOf(providerId, model, counter);
    cost += priced.cost;
    if (!priced.priced) unpriced += 1;
    addCounter(tokens, counter);
  }
  return { cost, tokens, unpriced };
}

/**
 * Spend inside a window of days ending today.
 * @param byDayModel - `{ [day]: { [model]: counter } }`.
 * @param today - Today's day key.
 * @param days - Window length; `null` means every day seen.
 * @returns `{ cost, currency, tokens, days }`.
 */
export function windowSpend(byDayModel, today, days) {
  const floor = days === null ? null : shiftDay(today, -(days - 1));
  let cost = 0;
  const tokens = emptyTokens();
  for (const [day, models] of Object.entries(byDayModel)) {
    if (floor !== null && day < floor) continue;
    const priced = priceDay(models);
    cost += priced.cost;
    addCounter(tokens, priced.tokens);
  }
  return { cost, currency: 'USD', tokens, days };
}

/**
 * Build the report.
 * @param options - Report inputs.
 * @param options.scan - Result of `scanSessions`.
 * @param options.balance - Balance object, or null when none was read.
 * @param options.providers - Provider rows for the panel.
 * @param options.today - Today's day key, in the scan's zone.
 * @param options.days - How many days of history to list.
 * @param options.now - Epoch milliseconds.
 * @returns The summary payload.
 */
export function buildReport(options) {
  const scan = options.scan;
  const now = options.now ?? Date.now();
  const days = options.days ?? 30;
  const byDayModel = scan.byDayModel ?? {};

  const byModel = Object.entries(scan.byModel)
    .map(([key, counter]) => {
      const { providerId, model } = identify(key, counter);
      const priced = costOf(providerId, model, counter);
      return {
        provider: providerId,
        model,
        label: modelLabel(providerId, model),
        kind: providerRow(providerId).kind,
        input: counter.input,
        cacheRead: counter.cacheRead,
        cacheWrite: counter.cacheWrite,
        output: counter.output,
        steps: counter.steps,
        cost: priced.cost,
        priced: priced.priced,
      };
    })
    .sort((left, right) => (right.cost - left.cost) || (right.output - left.output));

  const byDay = Object.entries(byDayModel)
    .map(([day, models]) => {
      const priced = priceDay(models);
      return {
        day,
        cost: priced.cost,
        input: priced.tokens.input,
        cacheRead: priced.tokens.cacheRead,
        cacheWrite: priced.tokens.cacheWrite,
        output: priced.tokens.output,
        steps: priced.tokens.steps,
      };
    })
    .sort((left, right) => (left.day < right.day ? 1 : -1))
    .slice(0, days);

  const tokens = emptyTokens();
  for (const counter of Object.values(scan.byModel)) addCounter(tokens, counter);

  return {
    generatedAt: now,
    credentialRef: options.credentialRef ?? null,
    balance: options.balance ?? null,
    spend: {
      today: windowSpend(byDayModel, options.today, 1),
      last7: windowSpend(byDayModel, options.today, 7),
      last30: windowSpend(byDayModel, options.today, 30),
      all: windowSpend(byDayModel, options.today, null),
    },
    tokens,
    byModel,
    byDay,
    providers: options.providers ?? [],
    price: PRICE_NOTE,
    scan: {
      root: scan.root,
      files: scan.files,
      sessions: scan.sessions,
      bytes: scan.bytes,
      records: scan.records,
      usageRecords: scan.usageRecords,
      ms: scan.ms,
      cached: scan.reused,
    },
  };
}

/**
 * Model keys that carry tokens, for tests and diagnostics.
 * @param scan - Result of `scanSessions`.
 * @returns Sorted model keys.
 */
export function modelKeys(scan) {
  return Object.keys(scan.byModel).sort();
}

/** Re-exported so callers can build the same zero counter. */
export { emptyTokens, TOKEN_FIELDS };
