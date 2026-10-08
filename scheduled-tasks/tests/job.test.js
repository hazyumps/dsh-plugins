import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  JobInputError,
  MAX_RUNS,
  advance,
  createJob,
  isDue,
  nextRunAt,
  normalizeTarget,
  normalizeTitle,
  recordRun,
  rescheduleJob,
  summarize,
} from '../lib/job.js';

const CHICAGO = 'America/Chicago';

/** 2026-10-07T15:24:00Z — 10:24 on a Wednesday in Chicago. */
const WEDNESDAY = Date.parse('2026-10-07T15:24:00.000Z');

/** A minimal job definition; individual tests override what they exercise. */
function definition(overrides = {}) {
  return {
    id: 'job-1',
    title: 'Northstar training brief',
    prompt: 'Prepare the brief.',
    rule: { kind: 'daily', time: '07:00:00', timeZone: CHICAGO },
    target: { provider: 'gaia-local', model: 'Spark', effort: 'medium', preset: 'drive' },
    now: WEDNESDAY,
    ...overrides,
  };
}

describe('normalizeTitle', () => {
  it('prefers an explicit title', () => {
    assert.equal(normalizeTitle('  Brief  ', 'prompt'), 'Brief');
  });

  it("falls back to the prompt's first non-empty line", () => {
    assert.equal(normalizeTitle('', '\n\n  Do the thing  \nmore'), 'Do the thing');
  });

  it('clips to the shipped title limit', () => {
    assert.equal(normalizeTitle('x'.repeat(400), '').length, 120);
  });

  it('never returns an empty title', () => {
    assert.equal(normalizeTitle('', ''), 'Scheduled task');
  });
});

describe('normalizeTarget', () => {
  it('fills absent and blank fields from the fallback', () => {
    const target = normalizeTarget({ model: '  ', effort: 'high' }, {
      provider: 'gaia-local', model: 'Spark', effort: 'medium', preset: 'drive',
    });
    assert.deepEqual(target, {
      provider: 'gaia-local', model: 'Spark', effort: 'high', preset: 'drive',
    });
  });

  it('tolerates a missing target', () => {
    const target = normalizeTarget(undefined, { provider: 'P', model: 'A', effort: 'B', preset: 'C' });
    assert.deepEqual(target, { provider: 'P', model: 'A', effort: 'B', preset: 'C' });
  });
});

describe('createJob', () => {
  it('builds a daily record targeting the next local 07:00', () => {
    const job = createJob(definition());
    assert.equal(job.schedule.kind, 'daily');
    assert.equal(job.schedule.timeZone, CHICAGO);
    assert.equal(job.schedule.scheduledAt, '2026-10-08T12:00:00.000Z');
    assert.equal(job.enabled, true);
    assert.deepEqual(job.target, {
      provider: 'gaia-local', model: 'Spark', effort: 'medium', preset: 'drive',
    });
    assert.equal(job.lastRun, null);
  });

  it('accepts a weekly rule with ISO weekdays', () => {
    const job = createJob(definition({
      rule: { kind: 'weekly', time: '07:00:00', timeZone: CHICAGO, weekdays: [1, 2, 3, 4, 5] },
    }));
    assert.equal(job.schedule.kind, 'weekly');
    assert.deepEqual([...job.schedule.weekdays], [1, 2, 3, 4, 5]);
    assert.equal(job.schedule.scheduledAt, '2026-10-08T12:00:00.000Z');
  });

  it('accepts an every rule', () => {
    const job = createJob(definition({ rule: { kind: 'every', everySeconds: 900 } }));
    assert.equal(job.schedule.kind, 'every');
    assert.equal(job.schedule.everySeconds, 900);
  });

  it('accepts a cron rule', () => {
    const job = createJob(definition({
      rule: { kind: 'cron', expression: '0 7 * * 1-5', timeZone: CHICAGO },
    }));
    assert.equal(job.schedule.kind, 'cron');
    assert.equal(job.schedule.scheduledAt, '2026-10-08T12:00:00.000Z');
  });

  it('keeps a 07:00 local target across the end of daylight saving', () => {
    const beforeDst = Date.parse('2026-10-31T13:00:00.000Z');
    const job = createJob(definition({ now: beforeDst }));
    assert.equal(job.schedule.scheduledAt, '2026-11-01T13:00:00.000Z');
  });

  it('rejects an empty prompt', () => {
    assert.throws(() => createJob(definition({ prompt: '   ' })), (error) => {
      assert.ok(error instanceof JobInputError);
      assert.equal(error.code, 'invalid_prompt');
      return true;
    });
  });

  it('rejects an unknown time zone', () => {
    assert.throws(
      () => createJob(definition({
        rule: { kind: 'daily', time: '07:00:00', timeZone: 'Mars/Olympus' },
      })),
      (error) => {
        assert.ok(error instanceof JobInputError);
        assert.equal(error.code, 'invalid_time_zone');
        return true;
      },
    );
  });

  it('rejects an unsupported rule kind', () => {
    assert.throws(() => createJob(definition({ rule: { kind: 'hourly' } })), (error) => {
      assert.equal(error.code, 'invalid_rule');
      return true;
    });
  });
});

describe('nextRunAt and isDue', () => {
  it('reports the target only once it has passed', () => {
    const job = createJob(definition());
    const target = Date.parse('2026-10-08T12:00:00.000Z');
    assert.equal(nextRunAt(job), target);
    assert.equal(isDue(job, target - 1), false);
    assert.equal(isDue(job, target), true);
  });

  it('reports no target while the job is disabled', () => {
    const job = createJob(definition({ enabled: false }));
    assert.equal(nextRunAt(job), null);
    assert.equal(isDue(job, WEDNESDAY), false);
  });
});

describe('advance', () => {
  it('moves a recurring job to its next occurrence', () => {
    const job = createJob(definition());
    const target = Date.parse('2026-10-08T12:00:00.000Z');
    const { schedule, ended } = advance(job, target);
    assert.equal(ended, false);
    assert.equal(schedule.scheduledAt, '2026-10-09T12:00:00.000Z');
  });

  it('keeps the local clock across the end of daylight saving', () => {
    const beforeDst = Date.parse('2026-10-31T13:00:00.000Z');
    const job = createJob(definition({ now: beforeDst }));
    assert.equal(job.schedule.scheduledAt, '2026-11-01T13:00:00.000Z');
    const { schedule } = advance(job, Date.parse('2026-11-01T13:00:00.000Z'));
    assert.equal(schedule.scheduledAt, '2026-11-02T13:00:00.000Z');
  });

  it('ends a one-shot job', () => {
    const job = createJob(definition({
      rule: { kind: 'at', at: '2026-10-08T12:00:00.000Z' },
    }));
    const { ended } = advance(job, Date.parse('2026-10-08T12:00:00.000Z'));
    assert.equal(ended, true);
  });
});

describe('recordRun', () => {
  it('stores the run and disables a finished job', () => {
    const job = createJob(definition({
      rule: { kind: 'at', at: '2026-10-08T12:00:00.000Z' },
    }));
    const target = Date.parse('2026-10-08T12:00:00.000Z');
    const { schedule, ended } = advance(job, target);
    const next = recordRun(job, {
      now: target,
      occurrenceAt: job.schedule.scheduledAt,
      sessionId: 'session-1',
      schedule,
      ended,
    });
    assert.equal(next.enabled, false);
    assert.equal(next.lastRun.ok, true);
    assert.equal(next.lastRun.sessionId, 'session-1');
    assert.equal(next.runs.length, 1);
  });

  it('caps retained runs', () => {
    let job = createJob(definition());
    for (let index = 0; index < MAX_RUNS + 5; index += 1) {
      const target = nextRunAt(job);
      const { schedule, ended } = advance(job, target);
      job = recordRun(job, {
        now: target,
        occurrenceAt: job.schedule.scheduledAt,
        sessionId: `session-${index}`,
        schedule,
        ended,
      });
    }
    assert.equal(job.runs.length, MAX_RUNS);
    assert.equal(job.runs[0].sessionId, `session-${MAX_RUNS + 4}`);
  });

  it('marks a failed run', () => {
    const job = createJob(definition());
    const target = nextRunAt(job);
    const { schedule, ended } = advance(job, target);
    const next = recordRun(job, {
      now: target,
      occurrenceAt: job.schedule.scheduledAt,
      schedule,
      ended,
      error: 'boom',
    });
    assert.equal(next.lastRun.ok, false);
    assert.equal(next.lastRun.error, 'boom');
    assert.equal(next.enabled, true);
  });
});

describe('rescheduleJob', () => {
  it('rebuilds the target and keeps identity and history', () => {
    const job = createJob(definition());
    const moved = rescheduleJob(job, { kind: 'daily', time: '09:30:00', timeZone: CHICAGO }, WEDNESDAY);
    assert.equal(moved.id, job.id);
    assert.equal(moved.schedule.prompt, job.schedule.prompt);
    assert.equal(moved.schedule.time, '09:30:00.000');
    assert.equal(moved.schedule.scheduledAt, '2026-10-08T14:30:00.000Z');
  });
});

describe('summarize', () => {
  it('describes a scheduled job', () => {
    const job = createJob(definition());
    const summary = summarize(job, WEDNESDAY);
    assert.deepEqual(summary, {
      id: 'job-1',
      title: 'Northstar training brief',
      enabled: true,
      kind: 'daily',
      provider: 'gaia-local',
      model: 'Spark',
      effort: 'medium',
      preset: 'drive',
      scheduledAt: '2026-10-08T12:00:00.000Z',
      state: 'scheduled',
      lastRun: null,
    });
  });

  it('reports an overdue job', () => {
    const job = createJob(definition());
    assert.equal(summarize(job, Date.parse('2026-10-09T00:00:00.000Z')).state, 'overdue');
  });
});
