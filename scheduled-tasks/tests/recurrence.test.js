/**
 * Tests for the self-contained recurrence engine.
 *
 * The important half of this file is differential: every rule is built twice —
 * once by `lib/recurrence.js` and once by the shipped `@deepseek-ai/dsh-schedule`
 * implementation extracted from the installed app — and the two are required to
 * agree. The shipped engine is the reference, so a disagreement means the local
 * engine is wrong.
 *
 * Run with:
 *   node --import ./tests/loader.mjs --test tests/recurrence.test.js
 *
 * @module dsh-plugin-scheduled-tasks/tests/recurrence
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RuleError,
  isRecurring,
  nextTarget,
  parseRule,
} from '../lib/recurrence.js';
import {
  ScheduleInputError,
  canonicalizeCronExpression,
  createAfterScheduleRecord,
  createAtScheduleRecord,
  createCronScheduleRecord,
  createDailyScheduleRecord,
  createEveryScheduleRecord,
  createWeeklyScheduleRecord,
  resolveRecurringOccurrence,
} from '@deepseek-ai/dsh-schedule';

/** Build the shipped engine's record for the same rule input this module takes. */
function shippedRecord(rule, now) {
  switch (rule.kind) {
    case 'daily':
      return createDailyScheduleRecord('job', 'prompt', { time: rule.time, time_zone: rule.timeZone }, now, 'Job');
    case 'weekly':
      return createWeeklyScheduleRecord(
        'job',
        'prompt',
        { time: rule.time, time_zone: rule.timeZone, weekdays: rule.weekdays },
        now,
        'Job',
      );
    case 'every':
      return createEveryScheduleRecord('job', 'prompt', rule.everySeconds, now, 'Job');
    case 'cron':
      return createCronScheduleRecord('job', 'prompt', { expression: rule.expression, time_zone: rule.timeZone }, now, 'Job');
    case 'at':
      return createAtScheduleRecord('job', 'prompt', rule.at, now, 'Job');
    case 'after':
      return createAfterScheduleRecord('job', 'prompt', rule.afterSeconds, now, 'Job');
    default:
      throw new Error(`unknown kind ${String(rule.kind)}`);
  }
}

/** Human-readable case label for assertion messages. */
function tag(rule, now) {
  return `${JSON.stringify(rule)} @ ${new Date(now).toISOString()}`;
}

/** Run a function and return the thrown error, or undefined. */
function caught(fn) {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Assert a call throws a `RuleError` carrying the expected stable code. */
function assertRuleError(fn, code, label) {
  const error = caught(fn);
  assert.ok(error instanceof RuleError, `${label}: expected RuleError, got ${String(error)}`);
  assert.equal(error.code, code, `${label}: wrong code (${error.message})`);
}

// ---------------------------------------------------------------------------
// Case tables
// ---------------------------------------------------------------------------

/** Zones exercising whole-hour, half-hour, and half-hour-DST offsets. */
const ZONES = ['America/Chicago', 'UTC', 'Europe/Berlin', 'Asia/Kolkata', 'Australia/Lord_Howe'];

/** Instants around the 2026 US spring-forward, fall-back, and ordinary dates. */
const ANCHORS = {
  midYear: '2026-07-15T12:00:00.000Z',
  beforeSpring: '2026-03-06T12:00:00.000Z',
  springDay: '2026-03-08T06:00:00.000Z',
  beforeFall: '2026-10-31T12:00:00.000Z',
  fallDay: '2026-11-01T05:00:00.000Z',
};

/** A Friday, Saturday, Sunday, and Monday spanning a weekend. */
const WEEKEND = {
  friday: '2026-03-06T12:00:00.000Z',
  saturday: '2026-03-07T12:00:00.000Z',
  sunday: '2026-03-08T12:00:00.000Z',
  monday: '2026-03-09T15:00:00.000Z',
};

/** Cron expressions the dialect must accept. */
const CRON_EXPRESSIONS = [
  '0 7 * * 1-5',
  '*/15 * * * *',
  '0 0 1 * *',
  '30 3 * * 0',
  '0 0 * * *',
  '0 9-17/2 * * 1-5',
];

/** Valid rules for the parse differential. */
const PARSE_CASES = [];

for (const timeZone of ZONES) {
  for (const time of ['07:00:00', '23:30:00']) {
    for (const iso of Object.values(ANCHORS)) {
      PARSE_CASES.push({ rule: { kind: 'daily', time, timeZone }, now: Date.parse(iso) });
    }
  }
}

// Millisecond precision must survive the wall-clock round trip.
for (const [time, iso] of [
  ['07:00:00.25', ANCHORS.midYear],
  ['00:00:00.5', ANCHORS.beforeSpring],
  ['02:30:00.123', ANCHORS.springDay],
  ['23:30:00.001', ANCHORS.beforeFall],
]) {
  PARSE_CASES.push({ rule: { kind: 'daily', time, timeZone: 'America/Chicago' }, now: Date.parse(iso) });
}

for (const weekdays of [[1, 2, 3, 4, 5], [7]]) {
  for (const timeZone of ['America/Chicago', 'UTC', 'Asia/Kolkata', 'Europe/Berlin', 'Australia/Lord_Howe']) {
    for (const iso of Object.values(WEEKEND)) {
      PARSE_CASES.push({ rule: { kind: 'weekly', time: '09:00:00', timeZone, weekdays }, now: Date.parse(iso) });
    }
  }
}

for (const everySeconds of [900, 3600]) {
  for (const iso of [ANCHORS.midYear, '2026-03-06T12:15:00.000Z', ANCHORS.beforeSpring, ANCHORS.fallDay]) {
    PARSE_CASES.push({ rule: { kind: 'every', everySeconds }, now: Date.parse(iso) });
  }
}

for (const expression of CRON_EXPRESSIONS) {
  for (const timeZone of ['America/Chicago', 'UTC', 'Asia/Kolkata']) {
    for (const iso of [ANCHORS.midYear, ANCHORS.beforeSpring, ANCHORS.springDay, ANCHORS.fallDay]) {
      PARSE_CASES.push({ rule: { kind: 'cron', expression, timeZone }, now: Date.parse(iso) });
    }
  }
}

for (const at of [
  '2026-07-15T12:00:01Z',
  '2026-07-15T12:00:00.500Z',
  '2026-07-15T07:00:00-05:00',
  '2026-07-15T23:59:59+05:30',
  { date: '2026-07-16', time: '09:30:00', time_zone: 'America/Chicago' },
  { date: '2026-11-01', time: '01:30:00', time_zone: 'America/Chicago' },
]) {
  PARSE_CASES.push({ rule: { kind: 'at', at }, now: Date.parse(ANCHORS.midYear) - 365 * 86_400_000 });
}

for (const afterSeconds of [1, 60, 900, 86_400]) {
  PARSE_CASES.push({ rule: { kind: 'after', afterSeconds }, now: Date.parse(ANCHORS.midYear) });
}

// Expressions whose canonical spelling is not the input spelling.
const CANONICAL_CASES = [
  '0 0 * * 7',
  '0 0 1,15 * 3',
  '15,45 0-5/2 * * *',
  '*/15 * * * *',
  '0 0 * * */2',
  '* * * * *',
  '1-59/2 0-23/3 1-31/2 1-12/2 0-6',
];

console.log(`differential parse cases: ${PARSE_CASES.length}`);

// ---------------------------------------------------------------------------
// Differential: parseRule
// ---------------------------------------------------------------------------

test('differential: parseRule.scheduledAt equals the shipped engine', () => {
  let compared = 0;
  for (const { rule, now } of PARSE_CASES) {
    const expected = shippedRecord(rule, now).scheduledAt;
    const actual = parseRule(rule, now).scheduledAt;
    assert.equal(actual, expected, `scheduledAt mismatch for ${tag(rule, now)}`);
    compared += 1;
  }
  assert.equal(compared, PARSE_CASES.length);
});

test('differential: cron canonical spelling equals the shipped engine', () => {
  for (const expression of [...CRON_EXPRESSIONS, ...CANONICAL_CASES]) {
    const rule = { kind: 'cron', expression, timeZone: 'UTC' };
    const canonical = canonicalizeCronExpression(expression);
    assert.equal(parseRule(rule, Date.parse(ANCHORS.midYear)).expression, canonical, `canonical mismatch for ${expression}`);
  }
});

test('differential: cron day-of-month/day-of-week AND/OR branch', () => {
  // `1` day-of-month with `5` weekday is restricted on both sides, so a date
  // matches if EITHER does; a star on one side makes BOTH required.
  const branched = [
    '0 0 1 * 5',
    '0 0 * * 5',
    '0 0 1 * *',
    '0 0 13 * 5',
    '0 0 29 2 *',
    '0 0 1,15 * 3',
    '0 0 * * */2',
    '0 0 1-31 * 1-5',
  ];
  for (const expression of branched) {
    for (const timeZone of ['UTC', 'America/Chicago', 'Australia/Lord_Howe']) {
      for (const iso of [ANCHORS.midYear, ANCHORS.beforeSpring, ANCHORS.fallDay]) {
        const rule = { kind: 'cron', expression, timeZone };
        const now = Date.parse(iso);
        assert.equal(parseRule(rule, now).scheduledAt, shippedRecord(rule, now).scheduledAt, tag(rule, now));
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Differential: nextTarget
// ---------------------------------------------------------------------------

/** Recurring rules advanced at several offsets past their committed target. */
const NEXT_TARGET_CASES = [
  { kind: 'daily', time: '07:00:00', timeZone: 'America/Chicago' },
  { kind: 'daily', time: '02:30:00', timeZone: 'America/Chicago' },
  { kind: 'daily', time: '23:30:00', timeZone: 'Europe/Berlin' },
  { kind: 'daily', time: '07:00:00', timeZone: 'Australia/Lord_Howe' },
  { kind: 'weekly', time: '09:00:00', timeZone: 'America/Chicago', weekdays: [1, 2, 3, 4, 5] },
  { kind: 'weekly', time: '01:30:00', timeZone: 'America/Chicago', weekdays: [7] },
  { kind: 'every', everySeconds: 900 },
  { kind: 'every', everySeconds: 3600 },
  { kind: 'cron', expression: '0 7 * * 1-5', timeZone: 'America/Chicago' },
  { kind: 'cron', expression: '*/15 * * * *', timeZone: 'UTC' },
  { kind: 'cron', expression: '0 0 1 * *', timeZone: 'America/Chicago' },
  { kind: 'cron', expression: '30 3 * * 0', timeZone: 'America/Chicago' },
];

/** Decision offsets, in milliseconds, applied to each committed target. */
const DECISION_OFFSETS = [0, 1, 5 * 60_000, 3 * 86_400_000, 10 * 86_400_000, 400 * 86_400_000];

console.log(`differential nextTarget rules: ${NEXT_TARGET_CASES.length} x ${DECISION_OFFSETS.length} decisions`);

test('differential: nextTarget equals resolveRecurringOccurrence.nextScheduledAt', () => {
  let compared = 0;
  for (const rule of NEXT_TARGET_CASES) {
    const now = Date.parse(ANCHORS.beforeSpring);
    const shipped = shippedRecord(rule, now);
    const mine = parseRule(rule, now);
    assert.equal(mine.scheduledAt, shipped.scheduledAt, `committed target differs for ${rule.kind}`);

    for (const offset of DECISION_OFFSETS) {
      const decision = Date.parse(shipped.scheduledAt) + offset;
      const expected = resolveRecurringOccurrence(shipped, decision).nextScheduledAt ?? null;
      assert.equal(nextTarget(mine, decision), expected, `${JSON.stringify(rule)} decision +${offset}ms`);
      compared += 1;
    }
  }
  assert.equal(compared, NEXT_TARGET_CASES.length * DECISION_OFFSETS.length);
});

test('differential: every occurrence stays on its anchor grid', () => {
  for (const everySeconds of [900, 3600]) {
    const rule = { kind: 'every', everySeconds };
    const now = Date.parse('2026-03-06T12:15:00.000Z');
    const shipped = shippedRecord(rule, now);
    const mine = parseRule(rule, now);
    // `now` sits exactly on the 900s grid, so the committed target is one whole
    // interval later and every advance lands back on the grid.
    assert.equal(mine.scheduledAt, shipped.scheduledAt);
    const decision = Date.parse(mine.scheduledAt);
    const expected = resolveRecurringOccurrence(shipped, decision).nextScheduledAt;
    assert.equal(nextTarget(mine, decision), expected);
    assert.equal((Date.parse(expected) - Date.parse(mine.scheduledAt)) % (everySeconds * 1000), 0);
  }
});

test('differential: one-shot records exhaust exactly like the shipped engine', () => {
  for (const rule of [
    { kind: 'at', at: '2026-07-15T12:00:00.000Z' },
    { kind: 'after', afterSeconds: 300 },
  ]) {
    const now = Date.parse('2026-07-15T11:00:00.000Z');
    const shipped = shippedRecord(rule, now);
    const mine = parseRule(rule, now);
    assert.equal(mine.scheduledAt, shipped.scheduledAt);
    const decision = Date.parse(mine.scheduledAt);
    // Shipped one-shots expose no `nextScheduledAt`; this module's contract is null.
    assert.equal(resolveRecurringOccurrence(shipped, decision), undefined);
    assert.equal(nextTarget(mine, decision - 1), mine.scheduledAt);
    assert.equal(nextTarget(mine, decision), null);
    assert.equal(nextTarget(mine, decision + 1), null);
  }
});

// ---------------------------------------------------------------------------
// Direct DST unit tests — exact UTC instants
// ---------------------------------------------------------------------------

test('DST spring-forward gap is skipped, not shifted', () => {
  // 2026-03-08 02:30 does not exist in Chicago (02:00 CST jumps to 03:00 CDT),
  // so the first real occurrence is the next local day at 02:30 CDT.
  const record = parseRule(
    { kind: 'daily', time: '02:30:00', timeZone: 'America/Chicago' },
    Date.parse('2026-03-08T06:00:00.000Z'),
  );
  assert.equal(record.scheduledAt, '2026-03-09T07:30:00.000Z');

  // Berlin: 2026-03-29 02:30 does not exist; the next day is 02:30 CEST.
  const berlin = parseRule(
    { kind: 'daily', time: '02:30:00', timeZone: 'Europe/Berlin' },
    Date.parse('2026-03-28T12:00:00.000Z'),
  );
  assert.equal(berlin.scheduledAt, '2026-03-30T00:30:00.000Z');

  // Lord Howe shifts only 30 minutes (02:00 +10:30 becomes 02:30 +11:00) on
  // 2026-10-04, which still swallows the 02:15 occurrence.
  const lordHowe = parseRule(
    { kind: 'daily', time: '02:15:00', timeZone: 'Australia/Lord_Howe' },
    Date.parse('2026-10-03T12:00:00.000Z'),
  );
  assert.equal(lordHowe.scheduledAt, '2026-10-04T15:15:00.000Z');
});

test('DST fall-back overlap resolves to the earlier instant', () => {
  // 2026-11-01 01:30 occurs twice in Chicago: 06:30Z (CDT) and 07:30Z (CST).
  const chicago = parseRule(
    { kind: 'daily', time: '01:30:00', timeZone: 'America/Chicago' },
    Date.parse('2026-10-31T12:00:00.000Z'),
  );
  assert.equal(chicago.scheduledAt, '2026-11-01T06:30:00.000Z');

  // Berlin repeats 02:30 on 2026-10-25: 00:30Z (CEST) and 01:30Z (CET).
  const berlin = parseRule(
    { kind: 'daily', time: '02:30:00', timeZone: 'Europe/Berlin' },
    Date.parse('2026-10-24T12:00:00.000Z'),
  );
  assert.equal(berlin.scheduledAt, '2026-10-25T00:30:00.000Z');

  // Lord Howe repeats 01:30-01:59 on 2026-04-05 (+11:00 then +10:30).
  const lordHowe = parseRule(
    { kind: 'daily', time: '01:45:00', timeZone: 'Australia/Lord_Howe' },
    Date.parse('2026-04-04T12:00:00.000Z'),
  );
  assert.equal(lordHowe.scheduledAt, '2026-04-04T14:45:00.000Z');
});

test('DST applies to weekly rules the same way', () => {
  // Sunday 2026-03-08 is the gap day, so the weekly Sunday 02:30 rule lands a week later.
  const spring = parseRule(
    { kind: 'weekly', time: '02:30:00', timeZone: 'America/Chicago', weekdays: [7] },
    Date.parse('2026-03-07T12:00:00.000Z'),
  );
  assert.equal(spring.scheduledAt, '2026-03-15T07:30:00.000Z');

  // Sunday 2026-11-01 repeats 01:30; the earlier instant wins.
  const fall = parseRule(
    { kind: 'weekly', time: '01:30:00', timeZone: 'America/Chicago', weekdays: [7] },
    Date.parse('2026-10-25T12:00:00.000Z'),
  );
  assert.equal(fall.scheduledAt, '2026-11-01T06:30:00.000Z');
});

test('half-hour offsets and milliseconds are preserved', () => {
  const kolkata = parseRule(
    { kind: 'daily', time: '07:00:00', timeZone: 'Asia/Kolkata' },
    Date.parse('2026-03-06T12:00:00.000Z'),
  );
  assert.equal(kolkata.scheduledAt, '2026-03-07T01:30:00.000Z');

  const precise = parseRule(
    { kind: 'daily', time: '07:00:00.25', timeZone: 'America/Chicago' },
    Date.parse('2026-03-06T12:00:00.000Z'),
  );
  assert.equal(precise.scheduledAt, '2026-03-06T13:00:00.250Z');
  assert.equal(precise.time, '07:00:00.250');
});

test('weekly selects the same weekday next week once today has passed', () => {
  // Monday 2026-03-09 10:00 CDT is already past 09:00, so the next Monday wins.
  const record = parseRule(
    { kind: 'weekly', time: '09:00:00', timeZone: 'America/Chicago', weekdays: [1] },
    Date.parse('2026-03-09T15:00:00.000Z'),
  );
  assert.equal(record.scheduledAt, '2026-03-16T14:00:00.000Z');
});

test('nextTarget is strict about its lower bound', () => {
  const record = parseRule(
    { kind: 'daily', time: '07:00:00', timeZone: 'America/Chicago' },
    Date.parse('2026-03-06T12:00:00.000Z'),
  );
  const target = Date.parse(record.scheduledAt);
  assert.equal(nextTarget(record, target - 1), record.scheduledAt);
  assert.equal(nextTarget(record, target), '2026-03-07T13:00:00.000Z');

  const every = parseRule({ kind: 'every', everySeconds: 900 }, Date.parse('2026-03-06T12:00:00.000Z'));
  const grid = Date.parse(every.scheduledAt);
  assert.equal(nextTarget(every, grid), '2026-03-06T12:30:00.000Z');
  assert.equal(nextTarget(every, grid + 1), '2026-03-06T12:30:00.000Z');

  const cron = parseRule(
    { kind: 'cron', expression: '*/15 * * * *', timeZone: 'UTC' },
    Date.parse('2026-03-06T12:00:00.000Z'),
  );
  assert.equal(nextTarget(cron, Date.parse(cron.scheduledAt)), '2026-03-06T12:30:00.000Z');
});

// ---------------------------------------------------------------------------
// Cron dialect rejections
// ---------------------------------------------------------------------------

const REJECTED_CRON = [
  ['0 0 L * *', 'L modifier'],
  ['0 0 15W * *', 'W modifier'],
  ['0 0 * * 5#3', 'nth-weekday modifier'],
  ['0 0 * JAN *', 'month name'],
  ['0 0 * * MON', 'weekday name'],
  ['@daily', 'macro'],
  ['0 0 * * * *', 'six fields'],
  ['0 0 * *', 'four fields'],
  ['60 0 * * *', 'minute out of range'],
  ['0 24 * * *', 'hour out of range'],
  ['0 0 0 * *', 'day-of-month below range'],
  ['0 0 32 * *', 'day-of-month above range'],
  ['0 0 * 0 *', 'month below range'],
  ['0 0 * 13 *', 'month above range'],
  ['0 0 * * 8', 'day-of-week above range'],
  ['10-5 0 * * *', 'inverted range'],
  ['*/0 0 * * *', 'zero step'],
  ['5/2 0 * * *', 'step without range'],
  ['1,,3 0 * * *', 'empty list element'],
  ['-1 0 * * *', 'negative value'],
  ['1-2-3 0 * * *', 'malformed range'],
  ['0 0 * * * ', 'trailing whitespace'],
  [' 0 0 * * *', 'leading whitespace'],
  ['', 'empty expression'],
];

test('cron dialect rejections match the shipped engine', () => {
  for (const [expression, label] of REJECTED_CRON) {
    const shipped = caught(() => shippedRecord({ kind: 'cron', expression, timeZone: 'UTC' }, 0));
    assert.ok(shipped instanceof ScheduleInputError, `${label}: shipped engine accepted ${JSON.stringify(expression)}`);
    assertRuleError(
      () => parseRule({ kind: 'cron', expression, timeZone: 'UTC' }, Date.parse(ANCHORS.midYear)),
      'invalid_rule',
      `${label} (${JSON.stringify(expression)})`,
    );
  }
});

test('cron accepts the documented dialect', () => {
  for (const expression of ['* * * * *', '0-59/5 0-23/2 1-31/3 1-12/4 0-6/2', '5 4 3 2 1', '7,9 0 1,15 6 0']) {
    assert.doesNotThrow(() => parseRule(
      { kind: 'cron', expression, timeZone: 'UTC' },
      Date.parse(ANCHORS.midYear),
    ));
  }
});

test('differential: repeated weekdays are rejected by both engines', () => {
  for (const weekdays of [[1, 1], [3, 3, 5], [7, 7, 7]]) {
    const shipped = caught(() => shippedRecord(
      { kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays },
      Date.parse(ANCHORS.midYear),
    ));
    assert.ok(shipped instanceof ScheduleInputError, `shipped accepted weekdays ${JSON.stringify(weekdays)}`);
    assertRuleError(
      () => parseRule({ kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays }, Date.parse(ANCHORS.midYear)),
      'invalid_rule',
      `weekdays ${JSON.stringify(weekdays)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// RuleError codes
// ---------------------------------------------------------------------------

test('invalid_rule covers malformed and unsatisfiable rules', () => {
  const now = Date.parse(ANCHORS.midYear);
  const cases = [
    [() => parseRule(undefined, now), 'missing rule'],
    [() => parseRule(null, now), 'null rule'],
    [() => parseRule([], now), 'array rule'],
    [() => parseRule({}, now), 'missing kind'],
    [() => parseRule({ kind: 'yearly' }, now), 'unknown kind'],
    [() => parseRule({ kind: 'daily', time: '7:00:00', timeZone: 'UTC' }, now), 'unpadded hour'],
    [() => parseRule({ kind: 'daily', time: '07:00', timeZone: 'UTC' }, now), 'missing seconds'],
    [() => parseRule({ kind: 'daily', time: '24:00:00', timeZone: 'UTC' }, now), '24:00'],
    [() => parseRule({ kind: 'daily', time: '07:00:60', timeZone: 'UTC' }, now), 'leap second'],
    [() => parseRule({ kind: 'daily', time: 700, timeZone: 'UTC' }, now), 'non-string time'],
    [() => parseRule({ kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: [] }, now), 'empty weekdays'],
    [() => parseRule({ kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: [0] }, now), 'weekday below range'],
    [() => parseRule({ kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: [8] }, now), 'weekday above range'],
    [() => parseRule({ kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: ['1'] }, now), 'string weekday'],
    [() => parseRule({ kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: [1, 1] }, now), 'repeated weekday'],
    [() => parseRule({ kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: [3, 3, 5] }, now), 'repeated weekday mid-list'],
    [() => parseRule({ kind: 'every', everySeconds: 60.5 }, now), 'fractional interval'],
    [() => parseRule({ kind: 'every', everySeconds: '900' }, now), 'string interval'],
    [() => parseRule({ kind: 'after', afterSeconds: 0 }, now), 'zero delay'],
    [() => parseRule({ kind: 'after', afterSeconds: -5 }, now), 'negative delay'],
    [() => parseRule({ kind: 'at', at: '2020-01-01T00:00:00Z' }, now), 'at in the past'],
    [() => parseRule({ kind: 'at', at: 'not-a-date' }, now), 'at not a date'],
    [() => parseRule({ kind: 'at', at: { date: '2026-02-30', time: '09:00:00', time_zone: 'UTC' } }, now), 'at impossible date'],
    [() => parseRule({ kind: 'at', at: { date: '2026-07-16', time: '09:00:00' } }, now), 'at missing zone'],
  ];
  for (const [fn, label] of cases) assertRuleError(fn, 'invalid_rule', label);
});

test('invalid_time_zone covers unknown and malformed zones', () => {
  const now = Date.parse(ANCHORS.midYear);
  const cases = [
    [() => parseRule({ kind: 'daily', time: '07:00:00', timeZone: 'Mars/Phobos' }, now), 'unknown area'],
    [() => parseRule({ kind: 'daily', time: '07:00:00', timeZone: 'NotAZone' }, now), 'no area'],
    [() => parseRule({ kind: 'daily', time: '07:00:00', timeZone: '' }, now), 'empty zone'],
    [() => parseRule({ kind: 'daily', time: '07:00:00', timeZone: ' UTC' }, now), 'untrimmed zone'],
    [() => parseRule({ kind: 'daily', time: '07:00:00', timeZone: 42 }, now), 'non-string zone'],
    [() => parseRule({ kind: 'daily', time: '07:00:00' }, now), 'missing zone'],
    [() => parseRule({ kind: 'cron', expression: '0 0 * * *', timeZone: 'Nowhere/Atall' }, now), 'cron unknown zone'],
    [() => parseRule({ kind: 'at', at: { date: '2026-07-16', time: '09:00:00', time_zone: 'Bad Zone' } }, now), 'at bad zone'],
  ];
  for (const [fn, label] of cases) assertRuleError(fn, 'invalid_time_zone', label);
});

test('frequency_too_high is reserved for sub-minute intervals', () => {
  const now = Date.parse(ANCHORS.midYear);
  assertRuleError(() => parseRule({ kind: 'every', everySeconds: 0 }, now), 'frequency_too_high', 'zero');
  assertRuleError(() => parseRule({ kind: 'every', everySeconds: 59 }, now), 'frequency_too_high', '59 seconds');
  assert.equal(parseRule({ kind: 'every', everySeconds: 60 }, now).scheduledAt, '2026-07-15T12:01:00.000Z');
});

test('time_out_of_range covers unrepresentable instants', () => {
  const now = Date.parse(ANCHORS.midYear);
  assertRuleError(() => parseRule({ kind: 'after', afterSeconds: 1e15 }, now), 'time_out_of_range', 'after overflow');
  assertRuleError(() => parseRule({ kind: 'every', everySeconds: 1e15 }, now), 'time_out_of_range', 'every overflow');
  assertRuleError(
    () => parseRule({ kind: 'daily', time: '07:00:00', timeZone: 'UTC' }, Date.parse('9999-12-31T23:59:59.999Z')),
    'time_out_of_range',
    'no representable daily occurrence',
  );
  assertRuleError(() => parseRule({ kind: 'daily', time: '07:00:00', timeZone: 'UTC' }, Number.NaN), 'time_out_of_range', 'NaN now');
  assertRuleError(() => parseRule({ kind: 'daily', time: '07:00:00', timeZone: 'UTC' }, 'now'), 'time_out_of_range', 'string now');
});

test('nextTarget stays total at the representable-range edges', () => {
  const daily = parseRule({ kind: 'daily', time: '07:00:00', timeZone: 'UTC' }, Date.parse(ANCHORS.midYear));
  const cron = parseRule({ kind: 'cron', expression: '0 7 * * *', timeZone: 'UTC' }, Date.parse(ANCHORS.midYear));
  const every = parseRule({ kind: 'every', everySeconds: 900 }, Date.parse(ANCHORS.midYear));

  // Past the four-digit-year ceiling there is nothing representable: null, not a throw.
  for (const bound of [253402300800000, 300000000000000, 8e15]) {
    assert.equal(nextTarget(daily, bound), null);
    assert.equal(nextTarget(cron, bound), null);
    assert.equal(nextTarget(every, bound), null);
  }
  // Before the floor the walk clamps up instead of formatting an invalid Date.
  assert.equal(nextTarget(daily, -8e15), '0001-01-01T07:00:00.000Z');
  assert.equal(nextTarget(cron, -8e15), '0001-01-01T07:00:00.000Z');
  assert.equal(nextTarget(every, -8e15), every.scheduledAt);
  // A non-instant bound is a caller bug, not a silent null.
  assertRuleError(() => nextTarget(daily, Number.NaN), 'invalid_rule', 'NaN bound');
  assertRuleError(() => nextTarget(daily, 1e16), 'invalid_rule', 'unsafe bound');
});

// ---------------------------------------------------------------------------
// Record shape
// ---------------------------------------------------------------------------

test('parsed records carry canonical fields', () => {
  const now = Date.parse(ANCHORS.midYear);
  assert.deepEqual(
    parseRule({ kind: 'daily', time: '07:00:00', timeZone: 'america/chicago' }, now),
    {
      kind: 'daily',
      time: '07:00:00.000',
      timeZone: 'America/Chicago',
      // now is exactly the 07:00 CDT target, so the first occurrence strictly after it is tomorrow.
      scheduledAt: '2026-07-16T12:00:00.000Z',
    },
  );
  assert.deepEqual(
    parseRule({ kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: [5, 1, 3] }, now).weekdays,
    [1, 3, 5],
  );
  assert.equal(parseRule({ kind: 'every', everySeconds: 900 }, now).everySeconds, 900);
  assert.equal(parseRule({ kind: 'cron', expression: '0 0 * * 7', timeZone: 'UTC' }, now).expression, '0 0 * * 0');
  assert.deepEqual(
    Object.keys(parseRule({ kind: 'at', at: '2026-07-15T13:00:00Z' }, now)).sort(),
    ['kind', 'scheduledAt'],
  );
  assert.deepEqual(
    Object.keys(parseRule({ kind: 'after', afterSeconds: 300 }, now)).sort(),
    ['afterSeconds', 'kind', 'scheduledAt'],
  );
});

test('isRecurring identifies the rule kinds that repeat', () => {
  const now = Date.parse(ANCHORS.midYear);
  assert.equal(isRecurring(parseRule({ kind: 'every', everySeconds: 900 }, now)), true);
  assert.equal(isRecurring(parseRule({ kind: 'daily', time: '07:00:00', timeZone: 'UTC' }, now)), true);
  assert.equal(isRecurring(parseRule({ kind: 'weekly', time: '07:00:00', timeZone: 'UTC', weekdays: [1] }, now)), true);
  assert.equal(isRecurring(parseRule({ kind: 'cron', expression: '0 7 * * *', timeZone: 'UTC' }, now)), true);
  assert.equal(isRecurring(parseRule({ kind: 'at', at: '2026-07-16T00:00:00Z' }, now)), false);
  assert.equal(isRecurring(parseRule({ kind: 'after', afterSeconds: 60 }, now)), false);
  assert.equal(isRecurring(undefined), false);
  assert.equal(isRecurring({}), false);
});

test('RuleError exposes a stable name and code', () => {
  const error = new RuleError('invalid_rule', 'nope');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'RuleError');
  assert.equal(error.code, 'invalid_rule');
  assert.equal(error.message, 'nope');
});
