/**
 * Durable record shapes and the wire shapes the editor submits.
 *
 * This is the one place the stored task, the stored settings, and the whole
 * document are declared.
 *
 * @module dsh-plugin-scheduled-tasks/schema
 */

import { z } from 'zod';

/**
 * One shipped `ScheduleRecord`, as produced by `@deepseek-ai/dsh-schedule`.
 *
 * The rule fields are kind-dependent, so every optional one is listed; a record
 * only ever carries the fields its own `kind` defines.
 */
export const scheduleRecord = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  title: z.string(),
  prompt: z.string().min(1),
  scheduledAt: z.string().min(1),
  time: z.string().optional(),
  timeZone: z.string().optional(),
  weekdays: z.array(z.number().int()).optional(),
  everySeconds: z.number().int().optional(),
  afterSeconds: z.number().int().optional(),
  expression: z.string().optional(),
});

/** Which model, thinking level, and agent preset a run starts with. */
export const runTarget = z.object({
  provider: z.string(),
  model: z.string(),
  effort: z.string(),
  preset: z.string(),
});

/** One completed run. */
export const runRecord = z.object({
  occurrenceAt: z.string(),
  sessionId: z.string().nullable(),
  finishedAt: z.string(),
  ok: z.boolean(),
  error: z.string().nullable(),
});

/** One scheduled task. */
export const taskRecord = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  enabled: z.boolean(),
  schedule: scheduleRecord,
  target: runTarget,
  // Defaulted, not required: a task stored before this field existed must still
  // load, or an upgrade would strand it.
  workspaceId: z.string().default(''),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRun: runRecord.nullable(),
  runs: z.array(runRecord),
});

/** A rule as this plugin accepts it from a caller. */
export const ruleInput = z.object({
  kind: z.enum(['at', 'after', 'every', 'daily', 'weekly', 'cron']),
  at: z.union([z.string(), z.object({
    date: z.string(),
    time: z.string(),
    time_zone: z.string(),
  })]).optional(),
  afterSeconds: z.number().int().optional(),
  everySeconds: z.number().int().optional(),
  time: z.string().optional(),
  timeZone: z.string().optional(),
  weekdays: z.array(z.number().int()).optional(),
  expression: z.string().optional(),
});

/** The run target as a caller supplies it. */
export const targetInput = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  preset: z.string().optional(),
});

/** `scheduledTasks.list` */
export const listResult = z.object({ tasks: z.array(taskRecord) });

/** `scheduledTasks.create` and `scheduledTasks.update` result. */
export const taskResult = z.object({ task: taskRecord });

/** `scheduledTasks.create` */
export const createRequest = z.object({
  title: z.string().optional(),
  prompt: z.string(),
  rule: ruleInput,
  target: targetInput.optional(),
  enabled: z.boolean().optional(),
  workspaceId: z.string().optional(),
  cwd: z.string().optional(),
});

/** `scheduledTasks.update` */
export const updateRequest = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  prompt: z.string().optional(),
  rule: ruleInput.optional(),
  target: targetInput.optional(),
  enabled: z.boolean().optional(),
  workspaceId: z.string().optional(),
});

/** `scheduledTasks.delete` */
export const deleteRequest = z.object({ id: z.string().min(1) });

/** `scheduledTasks.delete` result. */
export const deleteResult = z.object({ id: z.string(), deleted: z.boolean() });

/** `scheduledTasks.runNow` */
export const runNowRequest = z.object({ id: z.string().min(1) });

/** `scheduledTasks.runNow` result. */
export const runNowResult = z.object({ id: z.string(), sessionId: z.string() });

/** The plugin's own settings, edited from the task page. */
export const settings = z.object({
  cwd: z.string(),
  // Defaulted, not required: a document written before this field existed must
  // still load, or an upgrade would strand the tasks already stored.
  workspaceId: z.string().default(''),
  provider: z.string(),
  model: z.string(),
  effort: z.string(),
  preset: z.string(),
  importFromScheduler: z.boolean(),
});

/** The store document, as it is written to disk. */
export const document = z.object({
  version: z.number().int(),
  settings,
  tasks: z.record(z.string(), taskRecord),
});

/** `scheduledTasks.settings` */
export const settingsResult = z.object({ settings });

/** `scheduledTasks.saveSettings` */
export const settingsUpdateRequest = z.object({
  cwd: z.string().optional(),
  workspaceId: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  preset: z.string().optional(),
  importFromScheduler: z.boolean().optional(),
});

/** `scheduledTasks.workspaces` */
export const workspaceListResult = z.object({
  workspaces: z.array(z.object({
    id: z.string(),
    title: z.string(),
    path: z.string(),
  })),
});
