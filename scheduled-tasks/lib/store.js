/**
 * The durable store.
 *
 * The plugin keeps its own document rather than the Host's storage-domain
 * service, because a profile-installed plugin cannot resolve `@deepseek-ai/*`
 * packages at runtime. The file lives beside the other harness state and is
 * replaced atomically, so a crash mid-write leaves the previous document
 * intact.
 *
 * @module dsh-plugin-scheduled-tasks/store
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { document as documentSchema, taskRecord } from './schema.js';

/** Document version this plugin writes. */
export const VERSION = 1;

/** Settings a fresh store starts with. */
export const DEFAULT_SETTINGS = Object.freeze({
  cwd: os.homedir(),
  workspaceId: '',
  provider: '',
  model: '',
  effort: '',
  preset: '',
  importFromScheduler: false,
});

/**
 * The harness home, as the Host reports it.
 * @returns The absolute path of the harness home directory.
 */
export function harnessHome() {
  const configured = process.env['DSH_HOME'];
  return typeof configured === 'string' && configured.length > 0
    ? configured
    : path.join(os.homedir(), '.dsh');
}

/**
 * The store file's path.
 * @param home - Harness home.
 * @returns The absolute path of this plugin's document.
 */
export function storeFile(home = harnessHome()) {
  return path.join(home, 'storages', 'scheduled_tasks.json');
}

/**
 * Open a store over one document.
 *
 * A missing file opens empty. An unreadable or invalid file is left exactly as
 * it is on disk and reported, so a bad document is never silently overwritten.
 * @param options - Store options.
 * @param options.file - Absolute path of the document.
 * @param options.logger - Host logger.
 * @returns The store handle.
 */
export function createStore(options) {
  const { file } = options;
  const logger = options.logger;
  const tasks = new Map();
  let settings = { ...DEFAULT_SETTINGS };
  let loaded = false;

  /** Read the document from disk into memory. */
  function load() {
    if (loaded) return;
    loaded = true;
    if (!fs.existsSync(file)) return;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      logger?.warn?.(`scheduled-tasks: ${file} is not readable JSON, starting empty: ${String(error)}`);
      return;
    }
    const parsed = documentSchema.safeParse(raw);
    if (!parsed.success) {
      logger?.warn?.(`scheduled-tasks: ${file} does not match the expected document, starting empty`);
      return;
    }
    for (const [id, task] of Object.entries(parsed.data.tasks)) tasks.set(id, task);
    settings = parsed.data.settings;
  }

  /** Replace the document on disk atomically. */
  function flush() {
    const payload = {
      version: VERSION,
      settings,
      tasks: Object.fromEntries(tasks),
    };
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
    fs.renameSync(temporary, file);
  }

  return {
    /** @returns The current settings. */
    settings() {
      load();
      return { ...settings };
    },

    /**
     * Replace the settings.
     * @param next - Complete settings object.
     * @returns The stored settings.
     */
    saveSettings(next) {
      load();
      settings = { ...next };
      flush();
      return { ...settings };
    },

    /**
     * Read one task.
     * @param id - Task identity.
     * @returns The stored task, or undefined.
     */
    get(id) {
      load();
      return tasks.get(id);
    },

    /** @returns Every stored task. */
    entries() {
      load();
      return [...tasks.values()];
    },

    /** @returns The number of stored tasks. */
    get size() {
      load();
      return tasks.size;
    },

    /**
     * Store one task, validating it first.
     * @param id - Task identity.
     * @param task - The task record.
     * @returns The validated record.
     */
    put(id, task) {
      load();
      const validated = taskRecord.parse(task);
      tasks.set(id, validated);
      flush();
      return validated;
    },

    /**
     * Remove one task.
     * @param id - Task identity.
     * @returns Whether a task was removed.
     */
    delete(id) {
      load();
      const removed = tasks.delete(id);
      if (removed) flush();
      return removed;
    },

    /** @returns The absolute path of the document. */
    get file() {
      return file;
    },
  };
}
