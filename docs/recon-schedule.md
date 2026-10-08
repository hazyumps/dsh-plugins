# Recon: `@deepseek-ai/dsh-schedule` public exports

Extracted from the installed app.asar (installed 2026-09-29, newer than the
`~/repo/deepseek-harness` checkout from 2026-08-15). Source of truth:
`/dsh/node_modules/@deepseek-ai/dsh-schedule/lib/types/domain.js`.

## Why this matters

The package is **shipped with dsh**, so a profile-installed plugin can import it
without declaring a dependency (same rule the plugin-development skill states
for shipped packages). Its exports give exact parity with DSH's own recurrence
semantics, timezone math (`@js-temporal/polyfill`), and DST gap/overlap rules —
so the plugin does not need to reimplement any calendar logic.

## Exports used

```js
import {
  ScheduleInputError,          // carries .code and .message
  createAtScheduleRecord,      // (id, prompt, at, now, title)
  createEveryScheduleRecord,   // (id, prompt, everySeconds, now, title)
  createDailyScheduleRecord,   // (id, prompt, daily, now, title)
  createWeeklyScheduleRecord,  // (id, prompt, weekly, now, title)
  createCronScheduleRecord,    // (id, prompt, cron, now, title)
  resolveRecurringOccurrence,  // (record, acceptedAt) -> { occurrenceAt, nextScheduledAt? }
  MIN_EVERY_INTERVAL_SECONDS,  // 60
  MAX_TITLE_LENGTH,
} from '@deepseek-ai/dsh-schedule';
```

Also exported: `resolveDailyOccurrence`, `resolveWeeklyOccurrence`,
`resolveEveryOccurrence`, `resolveCronOccurrence`, `parseCronInput`,
`parseWeeklyInput`, `canonicalizeCronExpression`, `normalizeWeekdays`,
`weeklyTime`, `scheduleTitle`.

## Input shapes (mirror the model-facing tools)

- `at`: an RFC 3339 string, or `{ date, time, time_zone }`.
- `everySeconds`: integer, `>= MIN_EVERY_INTERVAL_SECONDS` (60).
- `daily`: `{ time: 'HH:mm:ss[.SSS]', time_zone: '<IANA>' }` — exact keys.
- `weekly`: `{ time, time_zone, weekdays: [1..7] }` — ISO weekdays, Monday = 1.
- `cron`: `{ expression: '<5-field Vixie>', time_zone }`.

`time_zone` is canonicalized; an invalid one raises `invalid_time_zone`.

## Record shapes produced

Every record is frozen and carries `id`, `kind`, `title`, `prompt`, `scheduledAt`
(ISO 8601 UTC). `kind` selects the rule fields:

| kind    | extra fields                  |
|---------|-------------------------------|
| `at`    | —                             |
| `after` | `afterSeconds`                |
| `every` | `everySeconds`                |
| `daily` | `time`, `timeZone`            |
| `weekly`| `time`, `timeZone`, `weekdays`|
| `cron`  | `expression`, `timeZone`      |

## Scheduler loop

`resolveRecurringOccurrence(record, acceptedAt)` is the dispatch-time resolver:
given the active record and the wall-clock decision instant it returns the
`occurrenceAt` that was due (never earlier than the record's own `scheduledAt`)
and `nextScheduledAt` when another occurrence is representable. A run therefore
is: fire → replace the record's `scheduledAt` with `nextScheduledAt` → persist.
Recurring kinds are `every`, `daily`, `weekly`, `cron`; `at` and `after` are
one-shot, so their stored `scheduledAt` is the target and they end after firing.

`createXScheduleRecord` throws `ScheduleInputError` with codes
`invalid_prompt`, `invalid_rule`, `invalid_time_zone`, `frequency_too_high`,
`time_out_of_range`.
