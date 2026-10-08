/**
 * Self-contained recurrence engine for scheduled tasks.
 *
 * This module is a dependency-free reimplementation of the recurrence surface
 * the plugin used to import from `@deepseek-ai/dsh-schedule`. A profile-installed
 * plugin cannot resolve `@deepseek-ai/*` at runtime, so the rule parsing,
 * next-occurrence arithmetic, and IANA time-zone handling live here instead.
 *
 * Wall-clock ↔ instant conversion is built on `Intl.DateTimeFormat` alone
 * (see {@link wallToInstant}); nothing here reads the host time zone and no
 * third-party module is imported.
 *
 * @module dsh-plugin-scheduled-tasks/recurrence
 */

/** Longest forward walk of a calendar-rule search, in days (~10 years). */
const CALENDAR_HORIZON_DAYS = 366 * 10;

/** Longest forward walk of a cron-rule search, in days (8 years covers Feb 29 gaps). */
const CRON_HORIZON_DAYS = 366 * 8;

/** Milliseconds in one day. */
const DAY_MS = 86_400_000;

/** Smallest instant a four-digit-year RFC 3339 UTC timestamp can name. */
const MIN_FOUR_DIGIT_YEAR_MS = Date.parse('0001-01-01T00:00:00.000Z');

/** Largest instant a four-digit-year RFC 3339 UTC timestamp can name. */
const MAX_FOUR_DIGIT_YEAR_MS = Date.parse('9999-12-31T23:59:59.999Z');

/** Fixed lower bound for an `every` interval, in seconds. */
const MIN_EVERY_INTERVAL_SECONDS = 60;

/** `HH:mm:ss` with optional one-to-three fractional digits; no leap second, no 24:00. */
const CLOCK_TIME = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d):(?<second>[0-5]\d)(?:\.(?<fraction>\d{1,3}))?$/;

/** `YYYY-MM-DD` local calendar date. */
const LOCAL_DATE = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/;

/** RFC 3339 instant with an explicit `Z` or numeric offset. */
const OFFSET_INSTANT = new RegExp(
  String.raw`^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})`
  + String.raw`T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})`
  + String.raw`(?:\.(?<fraction>\d{1,3}))?(?<zone>Z|(?<sign>[+-])`
  + String.raw`(?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$`,
);

/** The shipped engine's accepted spelling of an IANA zone name (or `UTC`). */
const IANA_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/;

/** Cron field bounds; `canonicalMax` folds day-of-week 7 onto 0 (Sunday). */
const CRON_FIELDS = [
  { name: 'minute', min: 0, max: 59, canonicalMax: 59 },
  { name: 'hour', min: 0, max: 23, canonicalMax: 23 },
  { name: 'day-of-month', min: 1, max: 31, canonicalMax: 31 },
  { name: 'month', min: 1, max: 12, canonicalMax: 12 },
  { name: 'day-of-week', min: 0, max: 7, canonicalMax: 6 },
];

/** Recurring rule kinds, i.e. the ones with a rule to advance. */
const RECURRING_KINDS = new Set(['every', 'daily', 'weekly', 'cron']);

/** Predicate used by rules that select a clock time on every local date. */
const EVERY_DAY = () => true;

/**
 * A rejected rule. `code` is the stable machine-readable reason.
 *
 * Codes: `invalid_rule`, `invalid_time_zone`, `frequency_too_high`,
 * `time_out_of_range`.
 */
export class RuleError extends Error {
  /**
   * @param code - Stable machine-readable reason.
   * @param message - Human-readable explanation.
   * @param options - Optional contained cause.
   */
  constructor(code, message, options) {
    super(message, options);
    this.name = 'RuleError';
    this.code = code;
  }
}

/** Whether an unknown value is a non-array object. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Milliseconds as if the given calendar fields were UTC, without two-digit-year mapping. */
function utcMs(year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) {
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  value.setUTCHours(hour, minute, second, millisecond);
  return value.getTime();
}

/** ISO weekday (Mon=1 … Sun=7) of one local calendar date. */
function isoWeekday(day) {
  return ((new Date(utcMs(day.year, day.month, day.day)).getUTCDay() + 6) % 7) + 1;
}

/** Integer day number of one local calendar date, counted from the epoch. */
function dayNumberOf(day) {
  return Math.floor(utcMs(day.year, day.month, day.day) / DAY_MS);
}

/** Local calendar date one integer day number ahead. */
function dayFromNumber(number) {
  const value = new Date(number * DAY_MS);
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

/** Positively-signed millisecond remainder, so sub-second precision survives. */
function positiveModulo(value, modulus) {
  return ((value % modulus) + modulus) % modulus;
}

/** Cache of one `Intl.DateTimeFormat` per zone; construction is the expensive part. */
const FORMATTERS = new Map();

/**
 * Formatter that renders an instant as its zone wall clock in 24-hour form.
 * @param timeZone - Canonical IANA zone name.
 * @returns The cached formatter.
 */
function zoneFormatter(timeZone) {
  let formatter = FORMATTERS.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * Wall-clock fields of one instant in one zone.
 * @param epochMs - Instant in epoch milliseconds.
 * @param timeZone - Canonical IANA zone name.
 * @returns `{ year, month, day, hour, minute, second }` as numbers.
 */
function wallParts(epochMs, timeZone) {
  const fields = new Map();
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') fields.set(part.type, part.value);
  }
  return {
    year: Number(fields.get('year')),
    month: Number(fields.get('month')),
    day: Number(fields.get('day')),
    hour: Number(fields.get('hour')),
    minute: Number(fields.get('minute')),
    second: Number(fields.get('second')),
  };
}

/** The same wall clock read as if it were UTC — the basis of every offset sample. */
function wallClockMs(epochMs, timeZone) {
  const parts = wallParts(epochMs, timeZone);
  return utcMs(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second)
    + positiveModulo(epochMs, 1000);
}

/**
 * Zone offset at one instant, as `wallClock - instant`.
 * @param epochMs - Instant in epoch milliseconds.
 * @param timeZone - Canonical IANA zone name.
 * @returns The offset in milliseconds.
 */
function zoneOffsetMs(epochMs, timeZone) {
  return wallClockMs(epochMs, timeZone) - epochMs;
}

/** Offsets are sampled a day either side so a transition cannot hide between probes. */
const OFFSET_PROBES_MS = Object.freeze([-DAY_MS, -6 * 3_600_000, 0, 6 * 3_600_000, DAY_MS]);

/**
 * Convert a wall clock in one zone to the instant it names.
 *
 * Every candidate instant is `wall - offset` for an offset sampled around the
 * target, then accepted only when reading it back reproduces the same wall
 * clock. That single rule gives all three required behaviours:
 *
 * - a normal local time round-trips through exactly one candidate;
 * - a spring-forward gap admits no candidate at all, so the caller skips the
 *   occurrence instead of shifting the clock;
 * - a fall-back overlap admits two, and the smallest (earliest) wins.
 *
 * Because the round trip is checked per candidate, a probe whose offset is
 * stale is discarded rather than silently wrong.
 *
 * @param wallMs - Wall clock expressed in epoch milliseconds as if it were UTC.
 * @param timeZone - Canonical IANA zone name.
 * @returns The instant in epoch milliseconds, or `undefined` when the local time does not exist.
 */
function wallToInstant(wallMs, timeZone) {
  const offsets = new Set();
  for (const probe of OFFSET_PROBES_MS) offsets.add(zoneOffsetMs(wallMs + probe, timeZone));
  let earliest;
  for (const offset of offsets) {
    const candidate = wallMs - offset;
    if (candidate + zoneOffsetMs(candidate, timeZone) !== wallMs) continue;
    if (earliest === undefined || candidate < earliest) earliest = candidate;
  }
  return earliest;
}

/**
 * Validate and canonicalize one IANA time zone.
 * @param value - Candidate `UTC` or `Area/Location` name.
 * @returns The runtime's canonical zone name.
 */
function canonicalizeTimeZone(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value
    || (value !== 'UTC' && !IANA_ZONE.test(value))) {
    throw new RuleError('invalid_time_zone', 'timeZone must be UTC or a valid IANA Area/Location name.');
  }
  let canonical;
  try {
    canonical = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch (cause) {
    throw new RuleError('invalid_time_zone', 'timeZone must be UTC or a valid IANA Area/Location name.', { cause });
  }
  if (typeof canonical !== 'string' || (canonical !== 'UTC' && !IANA_ZONE.test(canonical))) {
    throw new RuleError('invalid_time_zone', 'timeZone must resolve to UTC or an IANA Area/Location name.');
  }
  return canonical;
}

/**
 * Parse one strict local clock time.
 * @param value - Candidate `HH:mm:ss` with optional 1-3 fractional digits.
 * @param selector - Selector name used in the diagnostic.
 * @returns `{ hour, minute, second, millisecond, canonical }`.
 */
function parseClockTime(value, selector) {
  if (typeof value !== 'string') {
    throw new RuleError(
      'invalid_rule',
      `${selector}.time must use HH:mm:ss with optional 1-3 fractional digits, without leap seconds or 24:00.`,
    );
  }
  const groups = CLOCK_TIME.exec(value)?.groups;
  if (groups === undefined) {
    throw new RuleError(
      'invalid_rule',
      `${selector}.time must use HH:mm:ss with optional 1-3 fractional digits, without leap seconds or 24:00.`,
    );
  }
  const millisecond = groups.fraction === undefined ? 0 : Number(groups.fraction.padEnd(3, '0'));
  return {
    hour: Number(groups.hour),
    minute: Number(groups.minute),
    second: Number(groups.second),
    millisecond,
    canonical: `${groups.hour}:${groups.minute}:${groups.second}.${String(millisecond).padStart(3, '0')}`,
  };
}

/**
 * Validate the explicit ISO weekday set of one weekly rule.
 *
 * Unordered input is sorted into canonical order, but a repeated weekday is
 * rejected exactly as the shipped engine rejects it: the set has no more
 * meaning with the repeat, and silently dropping it would hide a caller bug.
 * @param value - Untrusted candidate weekday values.
 * @returns Unique ascending weekdays from 1 (Monday) through 7 (Sunday).
 */
function normalizeWeekdays(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RuleError('invalid_rule', 'weekly.weekdays must be a non-empty array of ISO weekday numbers.');
  }
  const unique = new Set();
  for (const weekday of value) {
    if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      throw new RuleError('invalid_rule', 'Each weekly.weekdays entry must be an integer from 1 (Monday) through 7 (Sunday).');
    }
    if (unique.has(weekday)) {
      throw new RuleError('invalid_rule', `weekly.weekdays must not repeat weekday ${weekday}.`);
    }
    unique.add(weekday);
  }
  return [...unique].sort((left, right) => left - right);
}

/** Fold a matched cron value into the canonical range (day-of-week 7 becomes 0). */
function foldCronValue(spec, value) {
  return spec.canonicalMax !== spec.max && value === spec.max ? spec.min : value;
}

/** Stable diagnostic for one malformed cron field element. */
function invalidCronField(spec, element) {
  return new RuleError(
    'invalid_rule',
    `cron.expression ${spec.name} field element ${JSON.stringify(element)} must be *, a value, a-b, */n, a-b/n, `
    + 'or a comma-separated list of those.',
  );
}

/** Read one in-range cron field value. */
function cronFieldValue(text, spec) {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
    throw new RuleError('invalid_rule', `cron.expression ${spec.name} field value ${text} is outside ${spec.min}-${spec.max}.`);
  }
  return value;
}

/** Read one positive cron field step. */
function cronFieldStep(text, spec) {
  const step = Number(text);
  if (!Number.isSafeInteger(step) || step < 1) {
    throw new RuleError('invalid_rule', `cron.expression ${spec.name} field step must be a positive integer.`);
  }
  return step;
}

/** Expand one comma-separated cron field into its matched values, in ascending order. */
function cronFieldValues(raw, spec) {
  const matched = new Set();
  for (const element of raw.split(',')) {
    if (element.length === 0) {
      throw new RuleError('invalid_rule', `cron.expression ${spec.name} field must not contain an empty list element.`);
    }
    if (element === '*') {
      for (let value = spec.min; value <= spec.max; value += 1) matched.add(value);
      continue;
    }
    if (element.startsWith('*')) {
      const stepped = /^\*\/(?<step>\d+)$/.exec(element)?.groups;
      if (stepped === undefined) throw invalidCronField(spec, element);
      const step = cronFieldStep(stepped.step, spec);
      for (let value = spec.min; value <= spec.max; value += step) matched.add(value);
      continue;
    }
    const groups = /^(?<start>\d+)(?:-(?<end>\d+))?(?:\/(?<step>\d+))?$/.exec(element)?.groups;
    if (groups === undefined) throw invalidCronField(spec, element);
    const start = cronFieldValue(groups.start, spec);
    if (groups.end === undefined) {
      // A bare value with a step (`5/2`) has no anchor range, so it is rejected.
      if (groups.step !== undefined) throw invalidCronField(spec, element);
      matched.add(start);
      continue;
    }
    const last = cronFieldValue(groups.end, spec);
    if (start > last) {
      throw new RuleError('invalid_rule', `cron.expression ${spec.name} field range ${start}-${last} is inverted.`);
    }
    const step = groups.step === undefined ? 1 : cronFieldStep(groups.step, spec);
    for (let value = start; value <= last; value += step) matched.add(value);
  }
  const values = new Set();
  for (const value of matched) values.add(foldCronValue(spec, value));
  return [...values].sort((left, right) => left - right);
}

/** Read one value the encoder already proved present. */
function cronFieldValueAt(values, index) {
  const value = values[index];
  if (value === undefined) throw new RuleError('invalid_rule', 'cron field encoding requires a non-empty value set.');
  return value;
}

/** Encode one matched value set as the shortest equivalent comma-separated field. */
function encodeCronField(values) {
  const first = cronFieldValueAt(values, 0);
  if (values.length === 1) return String(first);
  const last = cronFieldValueAt(values, values.length - 1);
  const step = cronFieldValueAt(values, 1) - first;
  let uniform = true;
  for (let index = 2; index < values.length; index += 1) {
    if (cronFieldValueAt(values, index) - cronFieldValueAt(values, index - 1) !== step) {
      uniform = false;
      break;
    }
  }
  if (uniform) return step === 1 ? `${first}-${last}` : `${first}-${last}/${step}`;
  const parts = [];
  let runStart = first;
  for (let index = 1; index < values.length; index += 1) {
    const current = cronFieldValueAt(values, index);
    const previous = cronFieldValueAt(values, index - 1);
    if (current === previous + 1) continue;
    parts.push(runStart === previous ? String(runStart) : `${runStart}-${previous}`);
    runStart = current;
  }
  const final = cronFieldValueAt(values, values.length - 1);
  parts.push(runStart === final ? String(runStart) : `${runStart}-${final}`);
  return parts.join(',');
}

/** One uniform walk from a field's minimum, folded exactly as a parsed field folds. */
function starWalk(spec, step) {
  const walked = new Set();
  for (let value = spec.min; value <= spec.max; value += step) walked.add(foldCronValue(spec, value));
  return [...walked].sort((left, right) => left - right);
}

/**
 * Canonical spelling of a field whose text started with `*`.
 *
 * The leading star is semantic — it decides cron's day-of-month/day-of-week
 * AND/OR branch — so a star-led field must stay star-led after canonicalization
 * even when its matched set is narrower than the full range. Only a bare star
 * and a star-step admit a leading `*`, so the encoding is the bare star when every value is
 * matched, otherwise the widest star-step walk plus any leftovers as a list.
 */
function encodeStarCronField(values, spec) {
  if (values.length === spec.canonicalMax - spec.min + 1) return '*';
  const present = new Set(values);
  let bestStep;
  let bestWalk = [];
  for (let step = 1; step <= spec.max - spec.min + 1; step += 1) {
    const walk = starWalk(spec, step);
    if (walk.length > bestWalk.length && walk.every((value) => present.has(value))) {
      bestStep = step;
      bestWalk = walk;
    }
  }
  if (bestStep === undefined) throw new RuleError('invalid_rule', `${spec.name} cannot keep a leading \`*\`.`);
  const walked = new Set(bestWalk);
  const remaining = values.filter((value) => !walked.has(value));
  const walkText = `*/${bestStep}`;
  return remaining.length === 0 ? walkText : `${walkText},${encodeCronField(remaining)}`;
}

/**
 * Parse one cron field into its matched values, canonical spelling, and star flag.
 *
 * The star flag tests the field text's first character, exactly as Vixie sets
 * `DOM_STAR`/`DOW_STAR`: a stepped star (a `*` followed by `/2`) is a star although it matches
 * half the range, while an explicit full range such as `1-31` is restricted.
 */
function parseCronField(raw, spec) {
  const values = cronFieldValues(raw, spec);
  const star = raw.startsWith('*');
  return Object.freeze({
    values: Object.freeze(values),
    canonical: star ? encodeStarCronField(values, spec) : encodeCronField(values),
    star,
  });
}

/**
 * Parse and canonicalize one strict five-field cron expression.
 * @param expression - Candidate `minute hour day-of-month month day-of-week`.
 * @returns Parsed fields, matched values, and the canonical expression text.
 */
function parseCronExpression(expression) {
  if (typeof expression !== 'string' || expression.length === 0 || expression.trim() !== expression) {
    throw new RuleError('invalid_rule', 'cron.expression must be a non-empty trimmed string.');
  }
  const fields = expression.split(/\s+/);
  if (fields.length !== 5) {
    throw new RuleError(
      'invalid_rule',
      'cron.expression must contain exactly five whitespace-separated fields: minute hour day-of-month month day-of-week.',
    );
  }
  const parsed = fields.map((field, index) => parseCronField(field, CRON_FIELDS[index]));
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed;
  return {
    expression: parsed.map((field) => field.canonical).join(' '),
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dayOfMonth.values,
    months: month.values,
    daysOfWeek: dayOfWeek.values,
    dayOfMonthStar: dayOfMonth.star,
    dayOfWeekStar: dayOfWeek.star,
  };
}

/**
 * Build the local-date predicate of one parsed cron rule under Vixie semantics.
 *
 * The star flag selects the branch and nothing else. When either day field's
 * text starts with `*`, a date must satisfy BOTH fields — a stepped star such
 * as a `*` with `/2` still restricts the days it matches, and a bare `*` matches
 * everything, so the AND degrades to the other field exactly like Vixie's
 * `DOM_STAR`/`DOW_STAR` test. Only when neither field text starts with `*` is
 * a date accepted by either field matching.
 * @param parsed - Parsed cron rule.
 * @returns Whether one local calendar date matches, months aside.
 */
function cronDateMatcher(parsed) {
  const months = new Set(parsed.months);
  const daysOfMonth = new Set(parsed.daysOfMonth);
  const daysOfWeek = new Set(parsed.daysOfWeek);
  const dayOfMonthRestricted = !parsed.dayOfMonthStar;
  const dayOfWeekRestricted = !parsed.dayOfWeekStar;
  return (day) => {
    if (!months.has(day.month)) return false;
    const dayOfMonth = daysOfMonth.has(day.day);
    const dayOfWeek = daysOfWeek.has(isoWeekday(day) % 7);
    if (dayOfMonthRestricted && dayOfWeekRestricted) return dayOfMonth || dayOfWeek;
    return dayOfMonth && dayOfWeek;
  };
}

/**
 * First wall-clock occurrence strictly after one instant.
 * @param timeZone - Canonical IANA zone name.
 * @param fields - Parsed clock time of the rule.
 * @param afterMs - Exclusive lower bound in epoch milliseconds.
 * @param matches - Local-date predicate.
 * @param horizonDays - Bound on the forward walk.
 * @returns The instant in epoch milliseconds, or null when nothing is representable.
 */
function findNextWallClock(timeZone, fields, afterMs, matches, horizonDays) {
  if (afterMs > MAX_FOUR_DIGIT_YEAR_MS) return null;
  // A bound before year 1 is clamped up so every probe stays a real Date; any
  // occurrence above the clamp is still strictly after the original bound.
  const floorMs = afterMs < MIN_FOUR_DIGIT_YEAR_MS ? MIN_FOUR_DIGIT_YEAR_MS : afterMs;
  const start = dayNumberOf(wallParts(floorMs, timeZone));
  for (let offset = 0; offset <= horizonDays; offset += 1) {
    const day = dayFromNumber(start + offset);
    if (!matches(day)) continue;
    const wall = utcMs(day.year, day.month, day.day, fields.hour, fields.minute, fields.second, fields.millisecond);
    if (wall > MAX_FOUR_DIGIT_YEAR_MS) return null;
    const instant = wallToInstant(wall, timeZone);
    // A gap removes this occurrence outright: skip to the next matching date.
    if (instant === undefined) continue;
    if (instant >= MIN_FOUR_DIGIT_YEAR_MS && instant > afterMs && instant <= MAX_FOUR_DIGIT_YEAR_MS) return instant;
  }
  return null;
}

/**
 * First cron occurrence strictly after one instant.
 * @param parsed - Parsed cron rule.
 * @param timeZone - Canonical IANA zone name.
 * @param afterMs - Exclusive lower bound in epoch milliseconds.
 * @returns The instant in epoch milliseconds, or null when nothing is representable.
 */
function findNextCron(parsed, timeZone, afterMs) {
  if (afterMs > MAX_FOUR_DIGIT_YEAR_MS) return null;
  const floorMs = afterMs < MIN_FOUR_DIGIT_YEAR_MS ? MIN_FOUR_DIGIT_YEAR_MS : afterMs;
  const matches = cronDateMatcher(parsed);
  const floor = wallParts(floorMs, timeZone);
  const floorTimeOfDay = floor.hour * 3_600_000 + floor.minute * 60_000 + floor.second * 1_000;
  const start = dayNumberOf(floor);
  for (let offset = 0; offset <= CRON_HORIZON_DAYS; offset += 1) {
    const day = dayFromNumber(start + offset);
    if (!matches(day)) continue;
    for (const hour of parsed.hours) {
      for (const minute of parsed.minutes) {
        // On the floor's own date, only times at or after its wall clock can win.
        if (offset === 0 && hour * 3_600_000 + minute * 60_000 < floorTimeOfDay) continue;
        const wall = utcMs(day.year, day.month, day.day, hour, minute);
        if (wall > MAX_FOUR_DIGIT_YEAR_MS) return null;
        const instant = wallToInstant(wall, timeZone);
        if (instant === undefined) continue;
        if (instant >= MIN_FOUR_DIGIT_YEAR_MS && instant > afterMs && instant <= MAX_FOUR_DIGIT_YEAR_MS) {
          return instant;
        }
      }
    }
  }
  return null;
}

/**
 * Require a safe, representable, strictly future target.
 * @param epoch - Candidate instant in epoch milliseconds.
 * @param now - Explicit acceptance instant.
 * @returns The canonical UTC ISO 8601 timestamp.
 */
function requireFutureInstant(epoch, now) {
  if (!Number.isSafeInteger(epoch) || epoch < MIN_FOUR_DIGIT_YEAR_MS || epoch > MAX_FOUR_DIGIT_YEAR_MS) {
    throw new RuleError('time_out_of_range', 'The scheduled time must be representable as a four-digit-year RFC 3339 UTC instant.');
  }
  if (epoch <= now) throw new RuleError('invalid_rule', 'The scheduled time must be strictly in the future.');
  return new Date(epoch).toISOString();
}

/** Read one required named regular-expression group as a number. */
function groupNumber(groups, name) {
  const value = groups[name];
  if (value === undefined) throw new RuleError('invalid_rule', 'The at value has an invalid shape.');
  return Number(value);
}

/** Normalize an optional one-to-three digit fractional second to milliseconds. */
function millisecondsOf(fraction) {
  return fraction === undefined ? 0 : Number(fraction.padEnd(3, '0'));
}

/** Reject a wall clock that is not a real calendar date and time. */
function requireRealWallClock(wallMs, parts) {
  const value = new Date(wallMs);
  if (!Number.isFinite(wallMs)
    || value.getUTCFullYear() !== parts.year
    || value.getUTCMonth() + 1 !== parts.month
    || value.getUTCDate() !== parts.day) {
    throw new RuleError('invalid_rule', 'The at value must be a real ISO calendar date and time.');
  }
}

/** Parse a strict RFC 3339 instant whose numeric offset is part of the input. */
function parseOffsetInstant(value) {
  const groups = OFFSET_INSTANT.exec(value)?.groups;
  if (groups === undefined) {
    throw new RuleError(
      'invalid_rule',
      'at must use YYYY-MM-DDTHH:mm:ss with optional 1-3 digit fractional seconds and an explicit Z or numeric offset.',
    );
  }
  const parts = {
    year: groupNumber(groups, 'year'),
    month: groupNumber(groups, 'month'),
    day: groupNumber(groups, 'day'),
    hour: groupNumber(groups, 'hour'),
    minute: groupNumber(groups, 'minute'),
    second: groupNumber(groups, 'second'),
    millisecond: millisecondsOf(groups.fraction),
  };
  if (parts.year === 0 || parts.hour > 23 || parts.minute > 59 || parts.second > 59) {
    throw new RuleError('invalid_rule', 'The at value must be a real ISO calendar date and time.');
  }
  const local = utcMs(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond);
  requireRealWallClock(local, parts);
  if (groups.zone === 'Z') return local;
  const offsetHour = groupNumber(groups, 'offsetHour');
  const offsetMinute = groupNumber(groups, 'offsetMinute');
  if (offsetHour > 23 || offsetMinute > 59 || (groups.sign === '-' && offsetHour === 0 && offsetMinute === 0)) {
    throw new RuleError('invalid_rule', 'The at numeric offset is invalid.');
  }
  const direction = groups.sign === '+' ? 1 : -1;
  return local - direction * (offsetHour * 60 + offsetMinute) * 60_000;
}

/** Resolve the absolute selector of an `at` rule to an instant. */
function parseAtInstant(at) {
  if (typeof at === 'string') return parseOffsetInstant(at);
  if (!isPlainObject(at)) {
    throw new RuleError('invalid_rule', 'at must be an explicit-offset string or local calendar object.');
  }
  if (!('date' in at) || !('time' in at) || !('time_zone' in at)) {
    throw new RuleError('invalid_rule', 'Local at must contain date, time, and time_zone.');
  }
  if (typeof at.date !== 'string' || typeof at.time !== 'string') {
    throw new RuleError('invalid_rule', 'Local at date and time must be strings.');
  }
  if (typeof at.time_zone !== 'string') throw new RuleError('invalid_time_zone', 'time_zone must be a string.');
  const date = LOCAL_DATE.exec(at.date)?.groups;
  if (date === undefined) throw new RuleError('invalid_rule', 'Local at requires date YYYY-MM-DD.');
  const clock = parseClockTime(at.time, 'at');
  const parts = {
    year: groupNumber(date, 'year'),
    month: groupNumber(date, 'month'),
    day: groupNumber(date, 'day'),
    hour: clock.hour,
    minute: clock.minute,
    second: clock.second,
    millisecond: clock.millisecond,
  };
  if (parts.year === 0) throw new RuleError('invalid_rule', 'The local at value must be a real ISO calendar date and time.');
  const wall = utcMs(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond);
  requireRealWallClock(wall, parts);
  const timeZone = canonicalizeTimeZone(at.time_zone);
  const instant = wallToInstant(wall, timeZone);
  // A one-shot has no "next occurrence" to skip to, so an absent local time is rejected.
  if (instant === undefined) {
    throw new RuleError('invalid_rule', 'The local at time does not exist in the selected time zone.');
  }
  return instant;
}

/**
 * Validate and canonicalize one recurrence rule.
 *
 * The returned record's `scheduledAt` is the first occurrence strictly after
 * `now`, as a canonical UTC ISO 8601 timestamp. Accepted inputs are
 * `{ kind: 'daily', time, timeZone }`, `{ kind: 'weekly', time, timeZone,
 * weekdays }`, `{ kind: 'every', everySeconds }`, `{ kind: 'cron', expression,
 * timeZone }`, `{ kind: 'at', at }`, and `{ kind: 'after', afterSeconds }`.
 *
 * @param input - Rule to validate.
 * @param now - Acceptance instant in epoch milliseconds.
 * @returns The canonical rule record, including `kind` and `scheduledAt`.
 * @throws {RuleError} With a stable `code` when the rule is unusable.
 */
export function parseRule(input, now) {
  if (!Number.isSafeInteger(now) || now < MIN_FOUR_DIGIT_YEAR_MS || now > MAX_FOUR_DIGIT_YEAR_MS) {
    throw new RuleError('time_out_of_range', 'now must be a representable four-digit-year millisecond instant.');
  }
  if (!isPlainObject(input) || typeof input.kind !== 'string') {
    throw new RuleError('invalid_rule', 'rule must be an object with a kind.');
  }
  switch (input.kind) {
    case 'daily': {
      if (typeof input.timeZone !== 'string') throw new RuleError('invalid_time_zone', 'daily.timeZone must be a string.');
      const time = parseClockTime(input.time, 'daily');
      const timeZone = canonicalizeTimeZone(input.timeZone);
      const scheduled = findNextWallClock(timeZone, time, now, EVERY_DAY, CALENDAR_HORIZON_DAYS);
      if (scheduled === null) {
        throw new RuleError('time_out_of_range', 'No future daily occurrence is representable.');
      }
      return { kind: 'daily', time: time.canonical, timeZone, scheduledAt: new Date(scheduled).toISOString() };
    }
    case 'weekly': {
      if (typeof input.timeZone !== 'string') throw new RuleError('invalid_time_zone', 'weekly.timeZone must be a string.');
      const time = parseClockTime(input.time, 'weekly');
      const timeZone = canonicalizeTimeZone(input.timeZone);
      const weekdays = normalizeWeekdays(input.weekdays);
      const selected = new Set(weekdays);
      const scheduled = findNextWallClock(
        timeZone,
        time,
        now,
        (day) => selected.has(isoWeekday(day)),
        CALENDAR_HORIZON_DAYS,
      );
      if (scheduled === null) {
        throw new RuleError('time_out_of_range', 'No future weekly occurrence is representable.');
      }
      return { kind: 'weekly', time: time.canonical, timeZone, weekdays, scheduledAt: new Date(scheduled).toISOString() };
    }
    case 'every': {
      if (!Number.isSafeInteger(input.everySeconds)) {
        throw new RuleError('invalid_rule', 'every.everySeconds must be a safe integer.');
      }
      if (input.everySeconds < MIN_EVERY_INTERVAL_SECONDS) {
        throw new RuleError('frequency_too_high', `everySeconds must be at least ${MIN_EVERY_INTERVAL_SECONDS}.`);
      }
      return {
        kind: 'every',
        everySeconds: input.everySeconds,
        scheduledAt: requireFutureInstant(now + input.everySeconds * 1000, now),
      };
    }
    case 'cron': {
      if (typeof input.timeZone !== 'string') throw new RuleError('invalid_time_zone', 'cron.timeZone must be a string.');
      const parsed = parseCronExpression(input.expression);
      const timeZone = canonicalizeTimeZone(input.timeZone);
      const scheduled = findNextCron(parsed, timeZone, now);
      if (scheduled === null) {
        throw new RuleError('time_out_of_range', 'No future cron occurrence is representable.');
      }
      return { kind: 'cron', expression: parsed.expression, timeZone, scheduledAt: new Date(scheduled).toISOString() };
    }
    case 'at':
      return { kind: 'at', scheduledAt: requireFutureInstant(parseAtInstant(input.at), now) };
    case 'after': {
      if (!Number.isSafeInteger(input.afterSeconds) || input.afterSeconds <= 0) {
        throw new RuleError('invalid_rule', 'after.afterSeconds must be a positive safe integer.');
      }
      return {
        kind: 'after',
        afterSeconds: input.afterSeconds,
        scheduledAt: requireFutureInstant(now + input.afterSeconds * 1000, now),
      };
    }
    default:
      throw new RuleError('invalid_rule', `unsupported rule kind: ${String(input.kind)}`);
  }
}

/**
 * First occurrence of a record strictly after an instant.
 *
 * `record.scheduledAt` is authoritative for every kind; a recurring record's
 * next target is computed from its rule, so this works both before and after
 * the stored target is consumed.
 *
 * @param record - A record from {@link parseRule}.
 * @param afterMs - Exclusive lower bound in epoch milliseconds.
 * @returns The next occurrence as a UTC ISO 8601 timestamp, or null when there is none.
 * @throws {RuleError} When the record or bound is malformed.
 */
export function nextTarget(record, afterMs) {
  if (!isPlainObject(record) || typeof record.kind !== 'string') {
    throw new RuleError('invalid_rule', 'record must be a schedule record.');
  }
  if (!Number.isSafeInteger(afterMs)) throw new RuleError('invalid_rule', 'afterMs must be a millisecond instant.');
  switch (record.kind) {
    case 'at':
    case 'after': {
      const stored = Date.parse(record.scheduledAt);
      if (!Number.isFinite(stored)) {
        throw new RuleError('invalid_rule', 'record.scheduledAt must be an ISO 8601 instant.');
      }
      return stored > afterMs ? new Date(stored).toISOString() : null;
    }
    case 'every': {
      if (!Number.isSafeInteger(record.everySeconds) || record.everySeconds < MIN_EVERY_INTERVAL_SECONDS) {
        throw new RuleError('invalid_rule', `every.everySeconds must be a safe integer of at least ${MIN_EVERY_INTERVAL_SECONDS}.`);
      }
      const anchor = Date.parse(record.scheduledAt);
      if (!Number.isFinite(anchor)) {
        throw new RuleError('invalid_rule', 'record.scheduledAt must be an ISO 8601 instant.');
      }
      const interval = record.everySeconds * 1000;
      const occurrence = anchor > afterMs
        ? anchor
        : anchor + (Math.floor((afterMs - anchor) / interval) + 1) * interval;
      return occurrence <= MAX_FOUR_DIGIT_YEAR_MS ? new Date(occurrence).toISOString() : null;
    }
    case 'daily': {
      const time = parseClockTime(record.time, 'daily');
      const timeZone = canonicalizeTimeZone(record.timeZone);
      const scheduled = findNextWallClock(timeZone, time, afterMs, EVERY_DAY, CALENDAR_HORIZON_DAYS);
      return scheduled === null ? null : new Date(scheduled).toISOString();
    }
    case 'weekly': {
      const time = parseClockTime(record.time, 'weekly');
      const timeZone = canonicalizeTimeZone(record.timeZone);
      const selected = new Set(normalizeWeekdays(record.weekdays));
      const scheduled = findNextWallClock(
        timeZone,
        time,
        afterMs,
        (day) => selected.has(isoWeekday(day)),
        CALENDAR_HORIZON_DAYS,
      );
      return scheduled === null ? null : new Date(scheduled).toISOString();
    }
    case 'cron': {
      const timeZone = canonicalizeTimeZone(record.timeZone);
      const scheduled = findNextCron(parseCronExpression(record.expression), timeZone, afterMs);
      return scheduled === null ? null : new Date(scheduled).toISOString();
    }
    default:
      throw new RuleError('invalid_rule', `unsupported rule kind: ${String(record.kind)}`);
  }
}

/**
 * Whether a record repeats after its stored target.
 * @param record - A record from {@link parseRule}.
 * @returns True for `every`, `daily`, `weekly`, and `cron`.
 */
export function isRecurring(record) {
  return isPlainObject(record) && RECURRING_KINDS.has(record.kind);
}
