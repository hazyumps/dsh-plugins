/**
 * The scheduling loop for scheduled tasks.
 *
 * The scheduler owns no I/O of its own: it reads jobs from an injected store,
 * hands each due job to an injected runner, and writes the advanced record
 * back. Everything it needs — the clock and the timer functions — is injected
 * too, so the whole loop is deterministic under test.
 *
 * @module dsh-plugin-scheduled-tasks/scheduler
 */

import { advance, isDue, nextRunAt, recordRun } from './job.js';

/** Longest delay a single platform timer is asked to wait. */
export const MAX_DELAY_MS = 2 ** 31 - 1;

/** @returns A message for an unknown thrown value. */
function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Build a scheduler.
 * @param options - Scheduler dependencies.
 * @param options.store - `{ list(): Promise<Job[]>, put(job): Promise<void> }`.
 * @param options.run - `(job) => Promise<string|null>`; resolves with the started
 *   session id once the prompt is accepted. It must not wait for the agent to
 *   finish, or one slow job would hold the timer.
 * @param options.now - Clock returning a millisecond instant.
 * @param options.timers - `{ set, clear }`; defaults to the platform timer.
 * @param options.onError - Observer for a failed run; receives `(job, error)`.
 * @returns The scheduler handle.
 */
export function createScheduler(options) {
  const { store, run } = options;
  const now = options.now ?? (() => Date.now());
  const timers = options.timers ?? { set: setTimeout, clear: clearTimeout };
  const onError = options.onError ?? (() => {});

  let handle = null;
  let running = null;
  let stopped = false;
  let generation = 0;

  /**
   * Run every due job once, in target order.
   * @returns The number of jobs run.
   */
  async function runDue() {
    const stamp = now();
    const jobs = await store.list();
    const due = jobs
      .filter((job) => isDue(job, stamp))
      .sort((left, right) => nextRunAt(left) - nextRunAt(right));

    for (const job of due) {
      let sessionId = null;
      let error;
      try {
        sessionId = await run(job);
      } catch (failure) {
        error = describe(failure);
        onError(job, failure);
      }
      // Advance even after a failure: a job that cannot start must not be
      // retried in a tight loop. The failure stays on the record instead.
      const { schedule, ended } = advance(job, stamp);
      await store.put(recordRun(job, {
        now: stamp,
        occurrenceAt: job.schedule.scheduledAt,
        sessionId,
        schedule,
        ended,
        error,
      }));
    }
    return due.length;
  }

  /**
   * Run the due jobs, sharing one pass with any concurrent caller.
   * @returns The number of jobs run.
   */
  function tick() {
    if (running !== null) return running;
    running = runDue().finally(() => {
      running = null;
    });
    return running;
  }

  /** @returns Milliseconds until the earliest target, or null when nothing is pending. */
  function nextDelay() {
    return store.list().then((jobs) => {
      const stamp = now();
      let soonest = null;
      for (const job of jobs) {
        const target = nextRunAt(job);
        if (target === null) continue;
        if (soonest === null || target < soonest) soonest = target;
      }
      if (soonest === null) return null;
      return Math.min(Math.max(soonest - stamp, 0), MAX_DELAY_MS);
    });
  }

  /**
   * Arm the next timer from the store's current state.
   *
   * Re-arming is how a task created, edited, or removed while the Host runs
   * takes effect: the timer is chosen from the store, so a new task with an
   * earlier target replaces a later pending one. Each call supersedes the last
   * through the generation counter, so two overlapping arms cannot leave a
   * stale timer behind.
   */
  async function arm() {
    if (stopped) return;
    const mine = ++generation;
    const delay = await nextDelay();
    if (stopped || mine !== generation) return;
    if (handle !== null) {
      timers.clear(handle);
      handle = null;
    }
    if (delay === null) return;
    handle = timers.set(() => {
      handle = null;
      void tick()
        .catch(() => {})
        .then(() => arm());
    }, delay);
    // A long wait must not hold the process open on its own.
    if (typeof handle?.unref === 'function') handle.unref();
  }

  return {
    /**
     * Start scheduling.
     *
     * A pass runs first, so anything that fell due while the Host was down is
     * caught up; the timer is armed from the state that pass leaves behind.
     * @returns A promise resolving once the first timer is armed.
     */
    async start() {
      stopped = false;
      await tick();
      await arm();
    },
    /** Stop scheduling and drop the pending timer. */
    stop() {
      stopped = true;
      if (handle !== null) {
        timers.clear(handle);
        handle = null;
      }
    },
    /** Run the due jobs now. @returns The number of jobs run. */
    tick,
    /** Re-arm the timer from the store's current state. */
    rearm: arm,
    /** @returns Milliseconds until the next target, or null. */
    nextDelay,
  };
}
