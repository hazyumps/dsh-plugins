/**
 * What a token costs.
 *
 * One table, one formula. DeepSeek bills input cache hits, input cache misses,
 * and output — cache writes are free — and charges double during peak hours
 * (01:00-04:00 and 06:00-10:00 UTC, Monday to Friday). The scan records the
 * peak slice of each counter, so a total is priced as peak tokens at the peak
 * rate plus the remainder at the off-peak rate.
 *
 * A model with no matching row is *unpriced* rather than free: the panel shows
 * a dash so an unknown model never reads as a zero-cost one.
 *
 * @module dsh-plugin-usage/pricing
 */

/** The date these rates were read from the vendor's page. */
export const RATES_VERIFIED = '2026-10-07';

/** Where the rates came from. */
export const RATES_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing';

/** The divisor every published rate is quoted against. */
export const UNIT = 1_000_000;

/** Peak and off-peak USD per 1M tokens. */
export const RATES = Object.freeze([
  {
    provider: /^deepseek/,
    model: /^(deepseek-flash|deepseek-v4-flash|deepseek-v4-flash-vision-exp)$/,
    label: 'DeepSeek V4.1 Flash',
    peak: { cacheRead: 0.006, input: 0.3, output: 1.2, cacheWrite: 0 },
    offPeak: { cacheRead: 0.003, input: 0.15, output: 0.6, cacheWrite: 0 },
  },
  {
    provider: /^deepseek/,
    model: /^deepseek-v4-pro$/,
    label: 'DeepSeek V4 Pro',
    peak: { cacheRead: 0.044, input: 1.32, output: 3.96, cacheWrite: 0 },
    offPeak: { cacheRead: 0.022, input: 0.66, output: 1.98, cacheWrite: 0 },
  },
  {
    provider: /^gaia-local$/,
    model: /.*/,
    label: 'Local',
    local: true,
    peak: { cacheRead: 0, input: 0, output: 0, cacheWrite: 0 },
    offPeak: { cacheRead: 0, input: 0, output: 0, cacheWrite: 0 },
  },
]);

/** The rates a report was priced with, for the panel's footnote. */
export const PRICE_NOTE = Object.freeze({
  verified: RATES_VERIFIED,
  source: RATES_SOURCE,
  unit: 'per 1M tokens, USD',
  peakHours: 'Peak is 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri; everything else is half price.',
});

/**
 * The rate row for a provider/model pair.
 * @param providerId - Provider id from a session log.
 * @param model - Model id from a session log.
 * @returns The row, or null when nothing matches.
 */
export function rateFor(providerId, model) {
  return RATES.find((entry) => entry.provider.test(providerId) && entry.model.test(model)) ?? null;
}

/**
 * Price one set of tokens at one rate card.
 * @param card - `{ cacheRead, input, output, cacheWrite }` per 1M.
 * @param tokens - Counts for the same four fields.
 * @returns USD.
 */
export function tokensCost(card, tokens) {
  return (
    (tokens.cacheRead ?? 0) * card.cacheRead
    + (tokens.input ?? 0) * card.input
    + (tokens.cacheWrite ?? 0) * card.cacheWrite
    + (tokens.output ?? 0) * card.output
  ) / UNIT;
}

/**
 * Price a counter.
 * @param providerId - Provider id.
 * @param model - Model id.
 * @param counter - A token counter, including its peak slice.
 * @returns `{ cost, priced, rate, peakCost, offPeakCost }`.
 */
export function costOf(providerId, model, counter) {
  const rate = rateFor(providerId, model);
  if (rate === null) {
    return { cost: 0, priced: false, rate: null, peakCost: 0, offPeakCost: 0 };
  }

  const peakTokens = {
    input: counter.peakInput ?? 0,
    cacheRead: counter.peakCacheRead ?? 0,
    cacheWrite: counter.peakCacheWrite ?? 0,
    output: counter.peakOutput ?? 0,
  };
  const offPeakTokens = {
    input: (counter.input ?? 0) - peakTokens.input,
    cacheRead: (counter.cacheRead ?? 0) - peakTokens.cacheRead,
    cacheWrite: (counter.cacheWrite ?? 0) - peakTokens.cacheWrite,
    output: (counter.output ?? 0) - peakTokens.output,
  };

  const peakCost = tokensCost(rate.peak, peakTokens);
  const offPeakCost = tokensCost(rate.offPeak, offPeakTokens);
  return {
    cost: round(peakCost + offPeakCost),
    priced: true,
    rate,
    peakCost: round(peakCost),
    offPeakCost: round(offPeakCost),
  };
}

/**
 * Trim float noise to sub-cent precision.
 * @param value - USD.
 * @returns The rounded value.
 */
export function round(value) {
  return Math.round(value * 1e6) / 1e6;
}
