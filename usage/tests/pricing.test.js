import test from 'node:test';
import assert from 'node:assert/strict';

import { costOf, rateFor, tokensCost, round } from '../lib/pricing.js';
import { emptyTokens } from '../lib/scan.js';

/** A counter with the given totals, all off-peak. */
function counter(values) {
  return { ...emptyTokens(), ...values };
}

test('finds the flash rate card', () => {
  const rate = rateFor('deepseek-official', 'deepseek-flash');
  assert.equal(rate.label, 'DeepSeek V4.1 Flash');
  assert.equal(rate.peak.input, 0.3);
  assert.equal(rate.offPeak.input, 0.15);
});

test('accepts the retired flash aliases', () => {
  assert.equal(rateFor('deepseek-official', 'deepseek-v4-flash').label, 'DeepSeek V4.1 Flash');
});

test('bills one million of each field at the off-peak card', () => {
  const cost = tokensCost(
    { cacheRead: 0.003, input: 0.15, output: 0.6, cacheWrite: 0 },
    { cacheRead: 1_000_000, input: 1_000_000, output: 1_000_000, cacheWrite: 1_000_000 },
  );
  assert.equal(round(cost), 0.753);
});

test('splits a counter into its peak and off-peak halves', () => {
  const priced = costOf('deepseek-official', 'deepseek-flash', counter({
    input: 2_000_000,
    peakInput: 1_000_000,
    cacheRead: 0,
    output: 0,
  }));
  // 1M at the peak miss rate (0.30) plus 1M at the off-peak rate (0.15).
  assert.equal(priced.peakCost, 0.3);
  assert.equal(priced.offPeakCost, 0.15);
  assert.equal(priced.cost, 0.45);
  assert.equal(priced.priced, true);
});

test('charges nothing for a local provider but still prices it', () => {
  const priced = costOf('gaia-local', 'Ember', counter({ input: 5_000_000, output: 1_000_000 }));
  assert.equal(priced.cost, 0);
  assert.equal(priced.priced, true);
});

test('leaves an unknown model unpriced rather than free', () => {
  const priced = costOf('deepseek-official', 'deepseek-v9-unreleased', counter({ input: 1_000_000 }));
  assert.equal(priced.cost, 0);
  assert.equal(priced.priced, false);
  assert.equal(priced.rate, null);
});

test('prices an unknown provider as unpriced', () => {
  assert.equal(costOf('someone-else', 'gpt-x', counter({ input: 1000 })).priced, false);
});
