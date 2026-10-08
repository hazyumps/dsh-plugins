import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createService, TaskNotFound } from '../lib/service.js';

const CHICAGO = 'America/Chicago';
const WEDNESDAY = Date.parse('2026-10-07T15:24:00.000Z');

const DEFAULTS = Object.freeze({
  target: { provider: 'gaia-local', model: 'Spark', effort: 'medium', preset: 'drive' },
});

/** The stored settings a scenario starts from. */
const STORED = Object.freeze({
  cwd: '/tmp/workspace',
  workspaceId: '',
  provider: 'gaia-local',
  model: 'Spark',
  effort: 'medium',
  preset: 'drive',
  importFromScheduler: false,
});

/** In-memory stand-in for the durable store. */
function createTable(seed = [], settings = {}) {
  const rows = new Map(seed.map((row) => [row.id, row]));
  let current = { ...STORED, ...settings };
  return {
    rows,
    get: (key) => rows.get(key),
    entries: () => [...rows.values()],
    get size() {
      return rows.size;
    },
    put: async (key, value) => {
      rows.set(key, value);
    },
    delete: async (key) => rows.delete(key),
    settings: () => ({ ...current }),
    saveSettings: (next) => {
      current = { ...next };
      return { ...current };
    },
  };
}

/** A service over a fresh table, recording every run. */
function scenario(seed = [], overrides = {}) {
  const table = createTable(seed);
  const started = [];
  const service = createService({
    store: table,
    // Mirrors index.js: read per request, straight from the stored settings.
    defaults: () => {
      const { provider, model, effort, preset } = table.settings();
      return { target: { provider, model, effort, preset } };
    },
    run: async (job) => {
      started.push(job.id);
      return `session-${started.length}`;
    },
    now: () => WEDNESDAY,
    ...overrides,
  });
  return { table, service, started };
}

/** A valid create request. */
const CREATE = Object.freeze({
  title: 'Northstar training brief',
  prompt: 'Prepare the brief.',
  rule: { kind: 'daily', time: '07:00:00', timeZone: CHICAGO },
});

describe('service.create', () => {
  it('stores a task with the configured defaults filled in', async () => {
    const { service, table } = scenario();
    const { task } = await service.create(CREATE);
    assert.match(task.id, /^task-/);
    assert.equal(task.title, 'Northstar training brief');
    assert.equal(task.enabled, true);
    assert.deepEqual(task.target, DEFAULTS.target);
    assert.equal(task.schedule.scheduledAt, '2026-10-08T12:00:00.000Z');
    assert.equal(task.lastRun, null);
    assert.equal(table.rows.size, 1);
  });

  it('lets a caller override the target', async () => {
    const { service } = scenario();
    const { task } = await service.create({
      ...CREATE,
      target: { provider: 'gaia-local', model: 'Ember', effort: 'low' },
    });
    assert.deepEqual(task.target, {
      provider: 'gaia-local', model: 'Ember', effort: 'low', preset: 'drive',
    });
  });

  it('reports a bad rule as a wire error, not a crash', async () => {
    const { service } = scenario();
    await assert.rejects(
      service.create({ ...CREATE, rule: { kind: 'daily', time: '07:00:00', timeZone: 'Mars/Olympus' } }),
      (error) => {
        assert.equal(error.code, 'scheduled-tasks/invalid_time_zone');
        return true;
      },
    );
  });

  it('reports an empty prompt', async () => {
    const { service } = scenario();
    await assert.rejects(
      service.create({ ...CREATE, prompt: '   ' }),
      (error) => error.code === 'scheduled-tasks/invalid_prompt',
    );
  });

  it('returns detached copies', async () => {
    const { service } = scenario();
    const { task } = await service.create(CREATE);
    task.title = 'mutated';
    const { tasks } = await service.list();
    assert.equal(tasks[0].title, 'Northstar training brief');
  });
});

describe('service.list', () => {
  it('is empty before anything is created', async () => {
    const { service } = scenario();
    assert.deepEqual(await service.list(), { tasks: [] });
  });
});

describe('service.update', () => {
  it('edits the title without disturbing the schedule', async () => {
    const { service } = scenario();
    const { task } = await service.create(CREATE);
    const { task: edited } = await service.update({ id: task.id, title: 'Morning brief' });
    assert.equal(edited.title, 'Morning brief');
    assert.equal(edited.schedule.scheduledAt, task.schedule.scheduledAt);
    assert.equal(edited.schedule.prompt, task.schedule.prompt);
  });

  it('toggles enabled without recomputing the target', async () => {
    const { service } = scenario();
    const { task } = await service.create(CREATE);
    const { task: off } = await service.update({ id: task.id, enabled: false });
    assert.equal(off.enabled, false);
    assert.equal(off.schedule.scheduledAt, task.schedule.scheduledAt);
  });

  it('recomputes the target only when the rule changes', async () => {
    const { service } = scenario();
    const { task } = await service.create(CREATE);
    const { task: moved } = await service.update({
      id: task.id,
      rule: { kind: 'daily', time: '09:30:00', timeZone: CHICAGO },
    });
    assert.equal(moved.schedule.time, '09:30:00.000');
    assert.equal(moved.schedule.scheduledAt, '2026-10-08T14:30:00.000Z');
  });

  it('carries a new prompt into the stored rule', async () => {
    const { service } = scenario();
    const { task } = await service.create(CREATE);
    const { task: edited } = await service.update({ id: task.id, prompt: ' Do the other thing. ' });
    assert.equal(edited.schedule.prompt, 'Do the other thing.');
    assert.equal(edited.schedule.scheduledAt, task.schedule.scheduledAt);
  });

  it('keeps the stored prompt when the request omits it', async () => {
    const { service } = scenario();
    const { task } = await service.create(CREATE);
    const { task: edited } = await service.update({ id: task.id, enabled: false });
    assert.equal(edited.schedule.prompt, 'Prepare the brief.');
  });

  it('rejects a prompt that trims to nothing', async () => {
    const { service } = scenario();
    const { task } = await service.create(CREATE);
    await assert.rejects(
      service.update({ id: task.id, prompt: '  ' }),
      (error) => error.code === 'scheduled-tasks/invalid_prompt',
    );
  });

  it('reports an unknown id', async () => {
    const { service } = scenario();
    await assert.rejects(
      service.update({ id: 'task-nope', title: 'x' }),
      (error) => error.code === 'scheduled-tasks/not-found',
    );
  });
});

describe('service.delete', () => {
  it('deletes the task', async () => {
    const { service, table } = scenario();
    const { task } = await service.create(CREATE);
    assert.deepEqual(await service.delete({ id: task.id }), { id: task.id, deleted: true });
    assert.equal(table.rows.size, 0);
  });

  it('reports an unknown id', async () => {
    const { service } = scenario();
    await assert.rejects(
      service.delete({ id: 'task-nope' }),
      (error) => error instanceof TaskNotFound === false && error.code === 'scheduled-tasks/not-found',
    );
  });
});

describe('service.runNow', () => {
  it('runs the task and records the run without moving the target', async () => {
    const { service, started } = scenario();
    const { task } = await service.create(CREATE);
    const result = await service.runNow({ id: task.id });
    assert.equal(result.sessionId, 'session-1');
    assert.deepEqual(started, [task.id]);
    const { tasks } = await service.list();
    assert.equal(tasks[0].lastRun.sessionId, 'session-1');
    assert.equal(tasks[0].lastRun.ok, true);
    assert.equal(tasks[0].schedule.scheduledAt, task.schedule.scheduledAt);
  });

  it('surfaces a failed run and still records it', async () => {
    const { service } = scenario([], {
      run: async () => {
        throw new Error('no model route');
      },
    });
    const { task } = await service.create(CREATE);
    await assert.rejects(
      service.runNow({ id: task.id }),
      (error) => error.code === 'scheduled-tasks/run-failed',
    );
    const { tasks } = await service.list();
    assert.equal(tasks[0].lastRun.ok, false);
    assert.equal(tasks[0].lastRun.error, 'no model route');
  });
});

describe('settings', () => {
  it('reads the store defaults', () => {
    const { service } = scenario();
    assert.deepEqual(service.settings().settings, STORED);
  });

  it('merges a sparse update and trims strings', () => {
    const { service } = scenario();
    service.saveSettings({ model: '  Spark  ', provider: 'gaia-local' });
    const { settings } = service.settings();
    assert.equal(settings.model, 'Spark');
    assert.equal(settings.provider, 'gaia-local');
    assert.equal(settings.cwd, '/tmp/workspace');
  });

  it('refuses an empty cwd', () => {
    const { service } = scenario();
    assert.throws(() => service.saveSettings({ cwd: '   ' }), (error) => {
      assert.equal(error.code, 'scheduled-tasks/invalid_cwd');
      return true;
    });
  });

  it('lets a saved default fill a new task target', () => {
    const { service } = scenario();
    service.saveSettings({ provider: 'gaia-local', model: 'Spark', effort: 'low' });
    return service.create(CREATE).then(({ task }) => {
      assert.equal(task.target.model, 'Spark');
      assert.equal(task.target.effort, 'low');
    });
  });
});
