import test from 'node:test';
import assert from 'node:assert/strict';

import { PACKAGE, NAMESPACE, descriptors } from '../lib/contract.js';
import { SCHEMAS, summaryRequest, summaryResult } from '../lib/schema.js';
import { buildReport } from '../lib/report.js';
import { emptyTokens } from '../lib/scan.js';

/** A counter with the given totals. */
function counter(values) {
  return { ...emptyTokens(), provider: 'deepseek-official', model: 'deepseek-flash', ...values };
}

/** A scan that produced usage on two providers and two days. */
function scan() {
  return {
    root: '/Users/you/.dsh/sessions',
    files: 2,
    sessions: 2,
    bytes: 2048,
    records: 20,
    usageRecords: 3,
    ms: 4,
    reused: 1,
    byDay: {
      '2026-10-07': counter({ input: 100, output: 10, steps: 1 }),
      '2026-10-06': counter({ input: 50, cacheRead: 500, steps: 1, peakInput: 50 }),
    },
    byDayModel: {
      '2026-10-07': { 'deepseek-official/deepseek-flash': counter({ input: 100, output: 10, steps: 1 }) },
      '2026-10-06': { 'deepseek-official/deepseek-flash': counter({ input: 50, cacheRead: 500, steps: 1, peakInput: 50 }) },
    },
    byModel: { 'deepseek-official/deepseek-flash': counter({ input: 150, cacheRead: 500, output: 10, steps: 2, peakInput: 50 }) },
  };
}

/** The balance object the Host produces on a good read. */
const BALANCE = {
  status: 'ready',
  source: 'https://api.deepseek.com/user/balance',
  checkedAt: 1_700_000_000_000,
  message: null,
  available: true,
  wallets: [{ currency: 'USD', total: '62.46', granted: '0.00', toppedUp: '62.46' }],
};

test('a built report validates against the wire schema', () => {
  const report = buildReport({
    scan: scan(),
    balance: BALANCE,
    providers: [{ id: 'deepseek-official', label: 'DeepSeek', kind: 'api-key', status: 'ready', note: 'n' }],
    credentialRef: 'DEEPSEEK_API_KEY',
    today: '2026-10-07',
    days: 30,
    now: 1_700_000_000_000,
  });
  const parsed = summaryResult.parse(report);
  assert.deepEqual(Object.keys(parsed).sort(), Object.keys(report).sort(), 'no field is missing or dropped');
  assert.equal(parsed.credentialRef, 'DEEPSEEK_API_KEY');
  assert.equal(parsed.spend.today.cost, report.spend.today.cost);
});

test('a report with no balance read is still valid', () => {
  const report = buildReport({ scan: scan(), today: '2026-10-07', now: 1 });
  assert.equal(report.balance, null);
  assert.equal(report.credentialRef, null);
  assert.doesNotThrow(() => summaryResult.parse(report));
});

test('every unready balance state validates', () => {
  for (const status of ['unavailable', 'not-configured']) {
    const report = buildReport({
      scan: scan(),
      balance: { status, source: 'x', checkedAt: 1, message: 'why', available: false, wallets: [] },
      today: '2026-10-07',
      now: 1,
    });
    assert.doesNotThrow(() => summaryResult.parse(report));
  }
});

test('an empty report validates', () => {
  const report = buildReport({
    scan: { root: '/nowhere', files: 0, sessions: 0, bytes: 0, records: 0, usageRecords: 0, ms: 0, reused: 0, byDay: {}, byDayModel: {}, byModel: {} },
    today: '2026-10-07',
    now: 1,
  });
  assert.doesNotThrow(() => summaryResult.parse(report));
});

test('the request schema accepts the panel request and rejects junk', () => {
  assert.doesNotThrow(() => summaryRequest.parse({}));
  assert.doesNotThrow(() => summaryRequest.parse({ refresh: true }));
  assert.doesNotThrow(() => summaryRequest.parse({ days: 7 }));
  assert.throws(() => summaryRequest.parse({ days: 0 }));
  assert.throws(() => summaryRequest.parse({ days: 400 }));
  assert.throws(() => summaryRequest.parse({ refresh: 'yes' }));
});

test('the descriptors resolve every schema the manifest needs', () => {
  const schemaFor = (typeSymbol) => {
    const short = typeSymbol.slice(typeSymbol.lastIndexOf('#') + 1);
    const schema = SCHEMAS[short];
    assert.ok(schema, `schema declared for ${typeSymbol}`);
    return () => schema;
  };
  const list = descriptors(schemaFor);
  assert.equal(list.length, 1);
  const entry = list[0];
  assert.equal(entry.id, `${PACKAGE}#${NAMESPACE}/summary`);
  assert.equal(entry.service, NAMESPACE);
  assert.equal(entry.namespace, NAMESPACE);
  assert.equal(entry.method, 'summary');
  assert.deepEqual(entry.invocation, { kind: 'direct' });
  assert.equal(entry.parameters.length, 1);
  assert.deepEqual(
    { name: entry.parameters[0].name, wire: entry.parameters[0].wire, source: entry.parameters[0].source },
    { name: 'request', wire: 'request', source: 'json' },
  );
  assert.equal(entry.parameters[0].codec.mode, 'strict');
  assert.equal(entry.parameters[0].codec.typeSymbol, `${PACKAGE}#SummaryRequest`);
  assert.equal(entry.parameters[0].codec.create(), SCHEMAS.SummaryRequest);
  assert.equal(entry.result.mode, 'strict');
  assert.equal(entry.result.typeSymbol, `${PACKAGE}#SummaryResult`);
  assert.equal(entry.result.create(), SCHEMAS.SummaryResult);
});

test('every contract entry uses the package name the loader asserts', () => {
  assert.equal(PACKAGE, 'dsh-plugin-usage');
  assert.equal(NAMESPACE, 'usage');
});
