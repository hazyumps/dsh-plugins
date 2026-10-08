import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReport, priceDay, shiftDay, windowSpend } from '../lib/report.js';
import { emptyTokens } from '../lib/scan.js';

/** A counter with the given totals. */
function counter(values) {
  return { ...emptyTokens(), ...values };
}

/** One million input and output tokens, all inside the peak window. */
const PEAK_MILLION = counter({
  input: 1_000_000,
  output: 1_000_000,
  peakInput: 1_000_000,
  peakOutput: 1_000_000,
  steps: 2,
});

/** One million uncached input tokens off-peak. */
const OFFPEAK_MILLION = counter({ input: 1_000_000, steps: 1 });

/** A scan shaped like `scanSessions` output, without touching the disk. */
function fakeScan() {
  return {
    root: '/tmp/sessions',
    files: 3,
    sessions: 3,
    bytes: 4096,
    records: 40,
    usageRecords: 4,
    ms: 7,
    reused: 0,
    byDay: {
      '2026-10-07': counter({ input: 1_000_000, output: 1_000_000, peakInput: 1_000_000, peakOutput: 1_000_000, steps: 2 }),
      '2026-10-06': counter({ input: 500, output: 100, steps: 1 }),
      '2026-09-20': counter({ input: 1_000_000, steps: 1 }),
    },
    byDayModel: {
      '2026-10-07': { 'deepseek-official/deepseek-flash': PEAK_MILLION },
      '2026-10-06': { 'gaia-local/Ember': counter({ input: 500, output: 100, steps: 1 }) },
      '2026-09-20': { 'deepseek-official/deepseek-flash': OFFPEAK_MILLION },
    },
    byModel: {
      'deepseek-official/deepseek-flash': counter({
        input: 2_000_000,
        output: 1_000_000,
        peakInput: 1_000_000,
        peakOutput: 1_000_000,
        steps: 3,
      }),
      'gaia-local/Ember': counter({ input: 500, output: 100, steps: 1 }),
    },
  };
}

test('prices a day as peak tokens at the peak rate plus the rest off-peak', () => {
  const priced = priceDay(fakeScan().byDayModel['2026-10-07']);
  // 1M peak input at 0.30 plus 1M peak output at 1.20.
  assert.equal(priced.cost, 1.5);
  assert.equal(priced.tokens.input, 1_000_000);
});

test('prices a local model at zero and counts it as priced', () => {
  const priced = priceDay(fakeScan().byDayModel['2026-10-06']);
  assert.equal(priced.cost, 0);
  assert.equal(priced.unpriced, 0);
});

test('shifts day keys without drifting with the host zone', () => {
  assert.equal(shiftDay('2026-10-07', -1), '2026-10-06');
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31');
});

test('windows spend by day, ending today', () => {
  const scan = fakeScan();
  const today = windowSpend(scan.byDayModel, '2026-10-07', 1);
  assert.equal(today.cost, 1.5);
  const week = windowSpend(scan.byDayModel, '2026-10-07', 7);
  assert.equal(week.cost, 1.5);
  const month = windowSpend(scan.byDayModel, '2026-10-07', 30);
  assert.equal(month.cost, 1.65, 'the 2026-09-20 row is inside 30 days');
  const all = windowSpend(scan.byDayModel, '2026-10-07', null);
  assert.equal(all.cost, 1.65);
  assert.equal(all.days, null);
});

test('builds a report with sorted models, windows, and provenance', () => {
  const report = buildReport({
    scan: fakeScan(),
    balance: { status: 'ready', source: 'x', checkedAt: 1, message: null, available: true, wallets: [] },
    providers: [{ id: 'deepseek-official', label: 'DeepSeek', kind: 'api-key', status: 'ready', note: 'n' }],
    today: '2026-10-07',
    days: 30,
    now: 1_700_000_000_000,
  });

  assert.equal(report.generatedAt, 1_700_000_000_000);
  assert.equal(report.spend.today.cost, 1.5);
  assert.equal(report.spend.last30.cost, 1.65);
  assert.equal(report.byModel[0].model, 'deepseek-flash', 'the expensive model sorts first');
  assert.equal(report.byModel[0].priced, true);
  assert.equal(report.byModel[1].kind, 'local');
  assert.equal(report.tokens.input, 2_000_500);
  assert.equal(report.byDay[0].day, '2026-10-07', 'days are newest first');
  assert.equal(report.byDay[0].cost, 1.5);
  assert.equal(report.providers.length, 1);
  assert.equal(report.price.verified, '2026-10-07');
});

test('limits the day list without changing the windows', () => {
  const report = buildReport({
    scan: fakeScan(),
    today: '2026-10-07',
    days: 1,
    now: 1,
  });
  assert.equal(report.byDay.length, 1);
  assert.equal(report.spend.last30.cost, 1.65);
  assert.equal(report.balance, null);
});

test('an unknown model shows as unpriced and adds no cost', () => {
  const scan = fakeScan();
  scan.byModel['deepseek-official/deepseek-v9'] = counter({ input: 1_000_000, output: 1_000_000, steps: 1 });
  scan.byDayModel['2026-10-07']['deepseek-official/deepseek-v9'] = counter({ input: 1_000_000, output: 1_000_000, steps: 1 });
  const report = buildReport({ scan, today: '2026-10-07', days: 30, now: 1 });
  const row = report.byModel.find((entry) => entry.model === 'deepseek-v9');
  assert.equal(row.priced, false);
  assert.equal(row.cost, 0);
  assert.equal(report.spend.today.cost, 1.5, 'an unpriced model cannot inflate the total');
});
