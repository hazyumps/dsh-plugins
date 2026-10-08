/**
 * Pure job-record helpers for scheduled tasks.
 *
 * A job is one rule from `./recurrence.js` plus the run target and bookkeeping
 * this plugin adds: which model, thinking level, and agent preset the new
 * session should use, whether the job is enabled, and what the last run did.
 *
 * Nothing here touches a running Harness or the filesystem; every function is
 * total and synchronous so it can be unit-tested with plain `node --test`.
 *
 * @module dsh-plugin-scheduled-tasks/job
 */

import { RuleError, isRecurring, nextTarget, parseRule } from './recurrence.js';

/** Longest stored title. */
export const MAX_TITLE_LENGTH = 120;

/** Runs retained per job. */
export const MAX_RUNS = 20;

/** A rejected job definition. `code` is stable; `message` is user-facing. */
export class JobInputError extends Error {
  /**
   * @param code - Stable machine-readable reason.
   * @param message - Human-readable explanation.
   */
  constructor(code, message) {
    super(message);
    this.name = 'JobInputError';
    this.code = code;
  }
}

/**
 * Normalize a title, falling back to the prompt's first line.
 * @param title - Candidate title, possibly empty.
 * @param prompt - The job prompt.
 * @returns A non-empty title within {@link MAX_TITLE_LENGTH}.
 */
export function normalizeTitle(title, prompt) {
  const candidate = typeof title === 'string' ? title.trim() : '';
  const fallback = typeof prompt === 'string'
    ? (prompt.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '')
    : '';
  const chosen = candidate.length > 0 ? candidate : fallback;
  const clipped = chosen.slice(0, MAX_TITLE_LENGTH);
  return clipped.length > 0 ? clipped : 'Scheduled task';
}

/**
 * Normalize the run target.
 * @param target - Candidate `{ provider, model, effort, preset }`, any field optional.
 * @param fallback - Values used for absent or empty fields.
 * @returns The frozen normalized target.
 */
export function normalizeTarget(target, fallback) {
  const pick = (value, otherwise) => {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length > 0 ? text : otherwise;
  };
  const source = target ?? {};
  return Object.freeze({
    provider: pick(source.provider, fallback.provider),
    model: pick(source.model, fallback.model),
    effort: pick(source.effort, fallback.effort),
    preset: pick(source.preset, fallback.preset),
  });
}

/**
 * Build the stored rule record for one job.
 * @param identity - Identity and text the record carries.
 * @param rule - The rule to schedule.
 * @param now - Current wall-clock instant in milliseconds.
 * @returns The frozen schedule record.
 */
function buildSchedule(identity, rule, now) {
  try {
    return Object.freeze({ ...identity, ...parseRule(rule, now) });
  } catch (error) {
    if (error instanceof RuleError) throw new JobInputError(error.code, error.message);
    throw error;
  }
}

/**
 * Create one job.
 * @param options - Job definition.
 * @param options.id - Stable job identity.
 * @param options.title - Display title; falls back to the prompt's first line.
 * @param options.prompt - Prompt sent when the job runs.
 * @param options.rule - Recurrence rule.
 * @param options.target - `{ provider, model, effort, preset }` for the new session.
 * @param options.enabled - Whether the job is scheduled at all.
 * @param options.defaultTarget - Target values used for absent fields.
 * @param options.now - Current wall-clock instant in milliseconds.
 * @returns A frozen job record.
 */
export function createJob(options) {
  const { id, prompt, rule, target, now } = options;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new JobInputError('invalid_prompt', 'prompt must be non-empty after trimming.');
  }
  if (!Number.isSafeInteger(now)) {
    throw new JobInputError('invalid_time', 'now must be a millisecond instant.');
  }
  const title = normalizeTitle(options.title, prompt);
  const schedule = buildSchedule(
    { id, title, prompt: prompt.trim() },
    rule,
    now,
  );
  return Object.freeze({
    id,
    title,
    enabled: options.enabled !== false,
    schedule,
    target: normalizeTarget(target, options.defaultTarget ?? {
      provider: '', model: '', effort: '', preset: '',
    }),
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    lastRun: null,
    runs: Object.freeze([]),
  });
}

/**
 * Replace a job's rule, rebuilding its next target from `now`.
 * @param job - Existing job.
 * @param rule - Replacement rule.
 * @param now - Current wall-clock instant in milliseconds.
 * @returns A frozen job record with the same identity and run history.
 */
export function rescheduleJob(job, rule, now) {
  const schedule = buildSchedule(
    { id: job.id, title: job.title, prompt: job.schedule.prompt },
    rule,
    now,
  );
  return Object.freeze({ ...job, schedule, updatedAt: new Date(now).toISOString() });
}

/**
 * The job's next target.
 * @param job - Job to inspect.
 * @returns Milliseconds since the epoch, or null when it will not run again.
 */
export function nextRunAt(job) {
  if (!job.enabled) return null;
  const parsed = Date.parse(job.schedule.scheduledAt);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Decide whether a job is due.
 * @param job - Job to inspect.
 * @param now - Current wall-clock instant in milliseconds.
 * @returns True when the job should run now.
 */
export function isDue(job, now) {
  const target = nextRunAt(job);
  return target !== null && now >= target;
}

/**
 * Advance a job after it ran.
 *
 * A recurring job keeps its record and stores the occurrence's next target; a
 * one-shot job ends and is left with no future target.
 * @param job - The job that just ran.
 * @param now - The decision instant used for the run.
 * @returns `{ schedule, ended }` — the replacement record and whether the job is finished.
 */
export function advance(job, now) {
  const record = job.schedule;
  if (!isRecurring(record)) {
    return { schedule: record, ended: true };
  }
  const next = nextTarget(record, now);
  if (next === null) {
    return { schedule: record, ended: true };
  }
  return { schedule: Object.freeze({ ...record, scheduledAt: next }), ended: false };
}

/**
 * Record one completed run.
 * @param job - The job that ran.
 * @param options - Run outcome.
 * @param options.now - Completion instant in milliseconds.
 * @param options.occurrenceAt - The occurrence that was delivered.
 * @param options.sessionId - The session the run started.
 * @param options.schedule - The replacement record from {@link advance}.
 * @param options.ended - Whether the job is finished.
 * @param options.error - Failure text, when the run failed.
 * @returns A frozen job record.
 */
export function recordRun(job, options) {
  const { now, occurrenceAt, sessionId, schedule, ended, error } = options;
  const run = Object.freeze({
    occurrenceAt,
    sessionId: sessionId ?? null,
    finishedAt: new Date(now).toISOString(),
    ok: error === undefined,
    error: error ?? null,
  });
  const runs = Object.freeze([run, ...job.runs].slice(0, MAX_RUNS));
  return Object.freeze({
    ...job,
    schedule,
    enabled: ended ? false : job.enabled,
    lastRun: run,
    runs,
    updatedAt: new Date(now).toISOString(),
  });
}

/**
 * Summarize a job for a list view.
 * @param job - Job to summarize.
 * @param now - Current wall-clock instant in milliseconds.
 * @returns A plain JSON-safe summary.
 */
export function summarize(job, now) {
  const target = nextRunAt(job);
  return {
    id: job.id,
    title: job.title,
    enabled: job.enabled,
    kind: job.schedule.kind,
    provider: job.target.provider,
    model: job.target.model,
    effort: job.target.effort,
    preset: job.target.preset,
    scheduledAt: job.schedule.scheduledAt,
    state: target === null ? 'ended' : (now >= target ? 'overdue' : 'scheduled'),
    lastRun: job.lastRun,
  };
}
