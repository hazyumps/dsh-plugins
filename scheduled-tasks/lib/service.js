/**
 * The task service: the one place a task is created, edited, run, or removed.
 *
 * Both callers — the agent tools and the Web editor — go through these methods,
 * so an edit means the same thing however it arrives.
 *
 * @module dsh-plugin-scheduled-tasks/service
 */

import { randomUUID } from 'node:crypto';

import { TaskError, asTaskError } from './errors.js';
import { JobInputError, createJob, normalizeTarget, recordRun, rescheduleJob } from './job.js';

/** Raised when a task id names nothing stored. */
export class TaskNotFound extends Error {
  /** @param id - The unknown task id. */
  constructor(id) {
    super(`no scheduled task with id "${id}"`);
    this.name = 'TaskNotFound';
    this.id = id;
  }
}

/**
 * Turn a validation failure into a wire-visible error.
 * @param error - The thrown value.
 * @returns A `TaskError` carrying the stable reason.
 */
function asRemoteError(error) {
  if (error instanceof JobInputError) {
    return new TaskError(`scheduled-tasks/${error.code}`, error.message, { code: error.code });
  }
  if (error instanceof TaskNotFound) {
    return new TaskError('scheduled-tasks/not-found', error.message, { id: error.id });
  }
  return asTaskError(error);
}

/**
 * Build the service a Host plugin contributes.
 * @param options - Service dependencies.
 * @param options.store - The durable store.
 * @param options.defaults - `() => ({ target })`, the values an absent target
 *   field inherits; read per request so a settings change is picked up.
 * @param options.run - `(job) => Promise<string>` starting one run.
 * @param options.workspaces - `() => Array<{ id, title, path }>`, the registry
 *   projection offered to the editor's workspace picker.
 * @param options.now - Clock returning a millisecond instant.
 * @param options.onChanged - Awaited after any task is created, edited, or
 *   removed, so the scheduler can re-arm from the new state.
 * @param options.logger - Host logger.
 * @returns The service object bound to the Typert namespace.
 */
export function createService(options) {
  const { store, defaults, run } = options;
  const now = options.now ?? (() => Date.now());
  const logger = options.logger;
  const onChanged = options.onChanged ?? (() => {});
  const workspaces = options.workspaces ?? (() => []);

  /**
   * Read one stored task.
   * @param id - Task identity.
   * @returns The stored task.
   */
  function require(id) {
    const found = store.get(id);
    if (found === undefined) throw new TaskNotFound(id);
    return found;
  }

  /** @returns A detached, JSON-safe copy. */
  function copy(task) {
    return JSON.parse(JSON.stringify(task));
  }

  return {
    /** @returns The workspaces a run can be placed in. */
    workspaces() {
      return { workspaces: workspaces() };
    },

    /** @returns The plugin's current settings. */
    settings() {
      return { settings: store.settings() };
    },

    /**
     * Replace the plugin's settings. Absent fields keep their stored value.
     * @param request - Validated settings request.
     * @returns The stored settings.
     */
    saveSettings(request) {
      const current = store.settings();
      const next = { ...current };
      for (const key of Object.keys(next)) {
        const value = request[key];
        if (value === undefined) continue;
        next[key] = typeof value === 'string' ? value.trim() : value;
      }
      if (next.cwd.length === 0) {
        throw new TaskError('scheduled-tasks/invalid_cwd', 'cwd must be non-empty.');
      }
      return { settings: store.saveSettings(next) };
    },

    /** @returns Every stored task. */
    list() {
      return { tasks: store.entries().map((value) => copy(value)) };
    },

    /**
     * Create one task.
     * @param request - Validated create request.
     * @returns The stored task.
     */
    async create(request) {
      try {
        const id = `task-${randomUUID()}`;
        const job = createJob({
          id,
          title: request.title,
          prompt: request.prompt,
          rule: request.rule,
          target: request.target,
          enabled: request.enabled,
          defaultTarget: defaults().target,
          workspaceId: request.workspaceId,
          now: now(),
        });
        const stored = request.cwd === undefined ? job : { ...job, cwd: request.cwd };
        await store.put(id, stored);
        await onChanged();
        return { task: copy(stored) };
      } catch (error) {
        throw asRemoteError(error);
      }
    },

    /**
     * Edit one task. Absent fields keep their stored value, and the next target
     * is recomputed only when the rule itself changes.
     * @param request - Validated update request.
     * @returns The stored task.
     */
    async update(request) {
      try {
        const job = require(request.id);
        const prompt = request.prompt === undefined ? job.schedule.prompt : request.prompt.trim();
        if (prompt.length === 0) {
          throw new JobInputError('invalid_prompt', 'prompt must be non-empty after trimming.');
        }
        let next = {
          ...job,
          title: request.title === undefined || request.title.trim() === ''
            ? job.title
            : request.title.trim(),
          enabled: request.enabled ?? job.enabled,
          schedule: { ...job.schedule, prompt },
          target: normalizeTarget(request.target ?? job.target, job.target),
          workspaceId: request.workspaceId === undefined
            ? job.workspaceId
            : request.workspaceId.trim(),
          updatedAt: new Date(now()).toISOString(),
        };
        if (request.rule !== undefined) {
          next = { ...next, ...rescheduleJob(next, request.rule, now()) };
        }
        await store.put(next.id, next);
        await onChanged();
        return { task: copy(next) };
      } catch (error) {
        throw asRemoteError(error);
      }
    },

    /**
     * Delete one task and its run history.
     * @param request - Validated delete request.
     * @returns The deleted identity.
     */
    async delete(request) {
      try {
        require(request.id);
        await store.delete(request.id);
        await onChanged();
        return { id: request.id, deleted: true };
      } catch (error) {
        throw asRemoteError(error);
      }
    },

    /**
     * Run one task now without disturbing its schedule.
     * @param request - Validated run request.
     * @returns The started session id.
     */
    async runNow(request) {
      const job = require(request.id);
      const stamp = now();
      let sessionId = null;
      let error;
      try {
        sessionId = await run(job);
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
        logger?.warn?.(`scheduled-tasks: manual run of "${job.title}" failed: ${error}`);
      }
      // Record the manual run against the unchanged record, so the next
      // scheduled fire still happens.
      await store.put(job.id, recordRun(job, {
        now: stamp,
        occurrenceAt: job.schedule.scheduledAt,
        sessionId,
        schedule: job.schedule,
        ended: false,
        error,
      }));
      if (error !== undefined) {
        throw new TaskError('scheduled-tasks/run-failed', error, { id: job.id });
      }
      return { id: job.id, sessionId };
    },
  };
}
