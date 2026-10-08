/**
 * One-shot import of tasks from DSH's shipped scheduler.
 *
 * Both features live in the same harness home, so an existing Automation task
 * can be carried across once. This is deliberately a read of another plugin's
 * stored document, and it only ever runs against an empty task list.
 *
 * @module dsh-plugin-scheduled-tasks/import
 */

import fs from 'node:fs';
import path from 'node:path';

/** The shipped scheduler's durable store, relative to `$DSH_HOME`. */
const LEGACY = path.join('storages', 'schedule.json');

/**
 * Read the shipped scheduler's stored tasks.
 * @param home - `$DSH_HOME`.
 * @returns The stored task rows, or an empty array when there is nothing to read.
 */
export function readLegacyTasks(home) {
  const file = path.join(home, LEGACY);
  if (!fs.existsSync(file)) return [];
  let document;
  try {
    document = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const rows = document?.tables?.tasks;
  if (rows === null || typeof rows !== 'object') return [];
  return Object.values(rows);
}

/**
 * Translate one shipped task into a create request for this plugin.
 *
 * The stored record already carries this plugin's rule vocabulary, so the rule
 * maps field for field; the model, thinking level, and agent come from the
 * plugin's configured defaults, because the shipped task has no such fields.
 * @param row - One stored row from the shipped scheduler.
 * @returns A create request, or null when the row cannot be expressed.
 */
export function toCreateRequest(row) {
  const record = row?.record;
  if (record === null || typeof record !== 'object') return null;
  if (typeof record.prompt !== 'string' || record.prompt.trim().length === 0) return null;
  const rule = ruleOf(record);
  if (rule === null) return null;
  return {
    title: typeof record.title === 'string' ? record.title : undefined,
    prompt: record.prompt,
    rule,
    enabled: row?.status === undefined ? true : row.status !== 'inactive',
  };
}

/**
 * Translate a stored rule.
 * @param record - A shipped `ScheduleRecord`.
 * @returns This plugin's rule, or null for a kind it cannot express.
 */
function ruleOf(record) {
  switch (record.kind) {
    case 'daily':
      return { kind: 'daily', time: record.time, timeZone: record.timeZone };
    case 'weekly':
      return {
        kind: 'weekly',
        time: record.time,
        timeZone: record.timeZone,
        weekdays: record.weekdays,
      };
    case 'cron':
      return { kind: 'cron', expression: record.expression, timeZone: record.timeZone };
    case 'every':
      return { kind: 'every', everySeconds: record.everySeconds };
    case 'at':
      return { kind: 'at', at: record.scheduledAt };
    default:
      // `after` is a one-shot delay whose anchor is gone; a fresh one would be
      // meaningless, so it is reported as untranslatable rather than guessed at.
      return null;
  }
}

/**
 * Import every translatable task into an empty list.
 * @param options - Import dependencies.
 * @param options.home - `$DSH_HOME`.
 * @param options.store - The task store to write into.
 * @param options.create - `(request) => Promise<unknown>`, the service's create.
 * @param options.logger - Host logger.
 * @returns The number of tasks imported.
 */
export async function importLegacyTasks(options) {
  const { home, store, create, logger } = options;
  if (store.size > 0) return 0;
  const requests = readLegacyTasks(home).map(toCreateRequest).filter((entry) => entry !== null);
  let imported = 0;
  for (const request of requests) {
    try {
      await create(request);
      imported += 1;
    } catch (error) {
      logger?.warn?.(`scheduled-tasks: could not import "${request.title}": ${String(error)}`);
    }
  }
  return imported;
}
