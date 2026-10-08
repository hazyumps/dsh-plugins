import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createJob, nextRunAt } from '../lib/job.js';
import { MAX_DELAY_MS, createScheduler } from '../lib/scheduler.js';

const CHICAGO = 'America/Chicago';
const WEDNESDAY = Date.parse('2026-10-07T15:24:00.000Z');

/** In-memory job store with the two methods the scheduler uses. */
function createStore(jobs = []) {
  const rows = new Map(jobs.map((job) => [job.id, job]));
  return {
    rows,
    async list() {
      return [...rows.values()];
    },
    async put(job) {
      rows.set(job.id, job);
    },
  };
}

/** Controllable clock. */
function createClock(start = WEDNESDAY) {
  let current = start;
  return {
    now: () => current,
    set: (value) => {
      current = value;
    },
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

/** Timer harness that records what the scheduler armed instead of waiting. */
function createTimers() {
  const armed = [];
  let cleared = 0;
  return {
    armed,
    get cleared() {
      return cleared;
    },
    set(fn, delay) {
      const handle = { fn, delay, unref() {} };
      armed.push(handle);
      return handle;
    },
    clear() {
      cleared += 1;
    },
  };
}

/** A daily 07:00 job plus a runner that records the calls. */
function scenario(overrides = {}) {
  const job = createJob({
    id: 'job-1',
    title: 'Brief',
    prompt: 'Prepare the brief.',
    rule: { kind: 'daily', time: '07:00:00', timeZone: CHICAGO },
    target: { model: 'Spark', effort: 'medium', preset: 'drive' },
    now: WEDNESDAY,
    ...overrides,
  });
  const clock = createClock();
  const store = createStore([job]);
  const calls = [];
  return { job, clock, store, calls };
}

describe('scheduler.tick', () => {
  it('runs a due job, records the session, and advances the target', async () => {
    const { job, clock, store, calls } = scenario();
    const target = nextRunAt(job);
    clock.set(target);
    const scheduler = createScheduler({
      store,
      now: clock.now,
      run: async (running) => {
        calls.push(running.id);
        return 'session-9';
      },
    });

    assert.equal(await scheduler.tick(), 1);
    const [stored] = await store.list();
    assert.deepEqual(calls, ['job-1']);
    assert.equal(stored.lastRun.sessionId, 'session-9');
    assert.equal(stored.lastRun.ok, true);
    assert.equal(stored.schedule.scheduledAt, '2026-10-09T12:00:00.000Z');
  });

  it('leaves a job that is not due alone', async () => {
    const { store, clock } = scenario();
    const scheduler = createScheduler({
      store,
      now: clock.now,
      run: async () => 'session-9',
    });
    assert.equal(await scheduler.tick(), 0);
    const [stored] = await store.list();
    assert.equal(stored.lastRun, null);
  });

  it('runs due jobs in target order', async () => {
    const later = createJob({
      id: 'later',
      prompt: 'later',
      rule: { kind: 'daily', time: '23:00:00', timeZone: CHICAGO },
      now: WEDNESDAY,
    });
    const earlier = createJob({
      id: 'earlier',
      prompt: 'earlier',
      rule: { kind: 'daily', time: '18:00:00', timeZone: CHICAGO },
      now: WEDNESDAY,
    });
    const clock = createClock(Date.parse('2026-10-09T00:00:00.000Z'));
    const store = createStore([later, earlier]);
    const order = [];
    const scheduler = createScheduler({
      store,
      now: clock.now,
      run: async (job) => {
        order.push(job.id);
        return 'session-x';
      },
    });
    await scheduler.tick();
    assert.deepEqual(order, ['earlier', 'later']);
  });

  it('advances and records a failed run instead of retrying it', async () => {
    const { job, clock, store } = scenario();
    clock.set(nextRunAt(job));
    const failures = [];
    const scheduler = createScheduler({
      store,
      now: clock.now,
      run: async () => {
        throw new Error('model unavailable');
      },
      onError: (failed, error) => failures.push([failed.id, error.message]),
    });

    assert.equal(await scheduler.tick(), 1);
    const [stored] = await store.list();
    assert.deepEqual(failures, [['job-1', 'model unavailable']]);
    assert.equal(stored.lastRun.ok, false);
    assert.equal(stored.lastRun.error, 'model unavailable');
    assert.equal(stored.schedule.scheduledAt, '2026-10-09T12:00:00.000Z');
    // The next tick has nothing left to do, so the failure cannot hot-loop.
    assert.equal(await scheduler.tick(), 0);
  });

  it('shares one pass between concurrent callers', async () => {
    const { job, clock, store } = scenario();
    clock.set(nextRunAt(job));
    let runs = 0;
    const scheduler = createScheduler({
      store,
      now: clock.now,
      run: async () => {
        runs += 1;
        await new Promise((resolve) => setImmediate(resolve));
        return 'session-1';
      },
    });
    const [first, second] = await Promise.all([scheduler.tick(), scheduler.tick()]);
    assert.equal(first, 1);
    assert.equal(second, 1);
    assert.equal(runs, 1);
  });
});

describe('scheduler.nextDelay', () => {
  it('reports the wait until the earliest target', async () => {
    const { job, clock, store } = scenario();
    const scheduler = createScheduler({ store, now: clock.now, run: async () => null });
    assert.equal(await scheduler.nextDelay(), nextRunAt(job) - WEDNESDAY);
  });

  it('is null when nothing is pending', async () => {
    const store = createStore([]);
    const clock = createClock();
    const scheduler = createScheduler({ store, now: clock.now, run: async () => null });
    assert.equal(await scheduler.nextDelay(), null);
  });

  it('never returns a negative delay for an overdue job', async () => {
    const { job, clock, store } = scenario();
    clock.set(nextRunAt(job) + 60_000);
    const scheduler = createScheduler({ store, now: clock.now, run: async () => null });
    assert.equal(await scheduler.nextDelay(), 0);
  });

  it('clamps a very distant target to the platform timer limit', async () => {
    const job = createJob({
      id: 'job-far',
      prompt: 'far',
      rule: { kind: 'daily', time: '07:00:00', timeZone: CHICAGO },
      now: WEDNESDAY,
    });
    const clock = createClock();
    const store = createStore([job]);
    const scheduler = createScheduler({ store, now: clock.now, run: async () => null });
    clock.set(nextRunAt(job) - (MAX_DELAY_MS * 3));
    assert.equal(await scheduler.nextDelay(), MAX_DELAY_MS);
  });
});

describe('scheduler lifecycle', () => {
  it('catches up an overdue job when started', async () => {
    const { job, clock, store, calls } = scenario();
    clock.set(nextRunAt(job) + 3_600_000);
    const timers = createTimers();
    const scheduler = createScheduler({
      store,
      now: clock.now,
      timers,
      run: async (running) => {
        calls.push(running.id);
        return 'session-2';
      },
    });

    await scheduler.start();
    assert.deepEqual(calls, ['job-1']);
    const [stored] = await store.list();
    assert.equal(stored.lastRun.sessionId, 'session-2');
    // A recurring job leaves a fresh timer armed.
    assert.equal(timers.armed.length, 1);
    assert.equal(timers.armed[0].delay, 24 * 60 * 60 * 1000 - 3_600_000);
    scheduler.stop();
  });

  it('clears the pending timer on stop', async () => {
    const { clock, store } = scenario();
    const timers = createTimers();
    const scheduler = createScheduler({ store, now: clock.now, timers, run: async () => null });
    await scheduler.start();
    assert.equal(timers.armed.length, 1);
    scheduler.stop();
    assert.equal(timers.cleared, 1);
  });

  it('arms nothing when no job is pending', async () => {
    const clock = createClock();
    const timers = createTimers();
    const scheduler = createScheduler({
      store: createStore([]),
      now: clock.now,
      timers,
      run: async () => null,
    });
    await scheduler.start();
    assert.equal(timers.armed.length, 0);
    scheduler.stop();
  });
});
