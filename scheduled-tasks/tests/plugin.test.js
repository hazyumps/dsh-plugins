/**
 * Drives the real plugin entry point: `apply` from `index.js`, the real store on
 * a scratch harness home, the real service, scheduler, and runner.
 *
 * Only two things are substituted — the Web session controller and the
 * default-model service — so everything this plugin decides is exercised. The
 * store writes a real file, so the document shape is verified too.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { apply } from '../index.js';

/** Let queued promise work settle. */
async function settle() {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-tasks-home-'));
  process.env.DSH_HOME = home;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** A context with only the services this plugin touches. */
function createHarness() {
  const provided = new Map();
  const disposers = [];
  const calls = { create: [], rename: [], prompt: [], selectModel: [], saveSelection: [] };
  const previousSelection = { provider: 'deepseek-official', model: 'deepseek-flash' };

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect: (fn) => {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
      return typeof disposer === 'function' ? disposer : () => {};
    },
    provide: (key, service) => provided.set(key, service),
    workspaceRegistry: {
      list: () => [
        { id: 'ws-1', title: 'nst', path: '/Users/patrick/repo/nst', sessionIds: [] },
      ],
      get: (id) => (id === 'ws-1' ? { id: 'ws-1', path: '/Users/patrick/repo/nst' } : undefined),
      // Only the seeded project directory is owned by a workspace.
      resolveByPath: async (path) => (
        path === '/tmp/workspace' ? { id: 'ws-1' } : undefined
      ),
    },
    sessionController: {
      async create(request) {
        calls.create.push(request);
        return { sessionId: `session-${calls.create.length}` };
      },
      async rename(request) {
        calls.rename.push(request);
      },
      async prompt(request) {
        calls.prompt.push(request);
        return { accepted: true };
      },
      async selectModel(request) {
        calls.selectModel.push(request);
        return { selected: {} };
      },
    },
    agentDefaultModel: {
      currentSelection: () => previousSelection,
      async saveSelection(next) {
        calls.saveSelection.push(next);
      },
    },
  };

  return { ctx, provided, disposers, calls, previousSelection };
}

/** Apply the plugin and wait for the store to open. */
async function mount(harness, settings) {
  apply(harness.ctx);
  await settle();
  const service = harness.provided.get('scheduledTasks');
  assert.ok(service, 'the plugin never provided its service');
  if (settings !== undefined) service.saveSettings(settings);
  return service;
}

/** A task definition the editor would submit. */
const CREATE = Object.freeze({
  title: 'Northstar training brief',
  prompt: 'Prepare the brief.',
  rule: { kind: 'weekly', time: '07:00:00', timeZone: 'America/Chicago', weekdays: [1, 2, 3, 4, 5] },
  target: { provider: 'gaia-local', model: 'Spark', effort: 'medium' },
  enabled: true,
});

/** Settings a run needs. */
const SETTINGS = Object.freeze({ cwd: '/tmp/workspace' });

/** The plugin's document on disk. */
function readDocument() {
  const file = path.join(home, 'storages', 'scheduled_tasks.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Write the plugin's own document before it mounts, which is how a stored
 * setting is present when `apply` runs.
 * @param partial - Settings to override the defaults with.
 */
function seedSettings(partial) {
  const file = path.join(home, 'storages', 'scheduled_tasks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const settings = {
    cwd: os.homedir(), workspaceId: '', provider: '', model: '', effort: '', preset: '',
    importFromScheduler: false,
    ...partial,
  };
  fs.writeFileSync(file, JSON.stringify({ version: 1, settings, tasks: {} }));
}

/** A task record as an older version of this plugin stored it. */
const OLDER_TASK = Object.freeze({
  id: 'task-old',
  title: 'Older task',
  enabled: true,
  schedule: {
    id: 'task-old', kind: 'daily', title: 'Older task', prompt: 'p',
    scheduledAt: '2026-10-08T12:00:00.000Z', time: '07:00:00.000', timeZone: 'America/Chicago',
  },
  target: { provider: '', model: '', effort: '', preset: '' },
  createdAt: '2026-10-07T15:00:00.000Z',
  updatedAt: '2026-10-07T15:00:00.000Z',
  lastRun: null,
  runs: [],
});

/** A shipped-scheduler document holding one task. */
function legacyDocument(tasks) {
  return JSON.stringify({ tables: { tasks } });
}

describe('mounting', () => {
  it('provides the service under the namespace the descriptors name', async () => {
    const harness = createHarness();
    const service = await mount(harness);
    assert.deepEqual(service.typertRemote, {
      service,
      serviceKey: 'scheduledTasks',
      namespace: 'scheduledTasks',
    });
    for (const method of ['list', 'settings', 'saveSettings', 'workspaces', 'create', 'update', 'delete', 'runNow']) {
      assert.equal(typeof service[method], 'function', method);
    }
  });

  it('starts with the documented defaults and an empty list', async () => {
    const harness = createHarness();
    const service = await mount(harness);
    assert.deepEqual(await service.list(), { tasks: [] });
    assert.deepEqual(service.settings().settings, {
      cwd: os.homedir(),
      workspaceId: '',
      provider: '',
      model: '',
      effort: '',
      preset: '',
      importFromScheduler: false,
    });
  });

  it('imports nothing unless asked', async () => {
    // A legacy store is present, but the flag is off.
    fs.mkdirSync(path.join(home, 'storages'), { recursive: true });
    fs.writeFileSync(path.join(home, 'storages', 'schedule.json'), legacyDocument({
      a: {
        record: {
          id: 'a', kind: 'daily', title: 'Legacy', prompt: 'p',
          time: '07:00:00.000', timeZone: 'UTC', scheduledAt: '2026-10-08T07:00:00.000Z',
        },
        status: 'active',
      },
    }));
    const harness = createHarness();
    const service = await mount(harness);
    await settle();
    assert.deepEqual((await service.list()).tasks, []);
  });

  it('carries the shipped scheduler\'s tasks across once, then clears the flag', async () => {
    fs.mkdirSync(path.join(home, 'storages'), { recursive: true });
    fs.writeFileSync(path.join(home, 'storages', 'schedule.json'), legacyDocument({
      a: {
        record: {
          id: 'a', kind: 'weekly', title: 'Northstar training brief',
          prompt: "Prepare Patrick's brief.",
          time: '07:00:00.000', timeZone: 'America/Chicago', weekdays: [1, 2, 3, 4, 5],
          scheduledAt: '2026-10-08T12:00:00.000Z',
        },
        status: 'active',
      },
      b: {
        record: {
          id: 'b', kind: 'after', title: 'Delay', prompt: 'p',
          afterSeconds: 60, scheduledAt: '2026-10-08T12:00:00.000Z',
        },
        status: 'active',
      },
    }));
    // The flag must already be stored when `apply` runs, because that is when
    // the one-shot import happens.
    seedSettings({ importFromScheduler: true });
    const harness = createHarness();
    const service = await mount(harness);
    await settle();

    const { tasks } = await service.list();
    assert.equal(tasks.length, 1, 'only the expressible task is imported');
    assert.equal(tasks[0].title, 'Northstar training brief');
    assert.deepEqual(tasks[0].schedule.weekdays, [1, 2, 3, 4, 5]);
    assert.equal(service.settings().settings.importFromScheduler, false);
  });

  it('refuses an empty cwd', async () => {
    const harness = createHarness();
    const service = await mount(harness);
    assert.throws(() => service.saveSettings({ cwd: '  ' }));
  });
});

describe('the stored document', () => {
  it('writes a versioned document with settings and tasks', async () => {
    const harness = createHarness();
    const service = await mount(harness, SETTINGS);
    const { task } = await service.create(CREATE);
    const document = readDocument();
    assert.equal(document.version, 1);
    assert.equal(document.settings.cwd, '/tmp/workspace');
    assert.deepEqual(Object.keys(document.tasks), [task.id]);
    assert.equal(document.tasks[task.id].title, 'Northstar training brief');
  });

  it('reopens what it wrote', async () => {
    const first = createHarness();
    const service = await mount(first, SETTINGS);
    const { task } = await service.create(CREATE);

    // A second mount reads the same file, as a restart would.
    const second = createHarness();
    const reopened = await mount(second);
    const { tasks } = await reopened.list();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, task.id);
    assert.equal(tasks[0].schedule.prompt, 'Prepare the brief.');
    assert.equal(reopened.settings().settings.cwd, '/tmp/workspace');
  });

  it('loads a document written before a newer settings field existed', async () => {
    // The upgrade case: a store from an older version has no `workspaceId`.
    fs.mkdirSync(path.join(home, 'storages'), { recursive: true });
    fs.writeFileSync(path.join(home, 'storages', 'scheduled_tasks.json'), JSON.stringify({
      version: 1,
      settings: {
        cwd: '/tmp/workspace', provider: '', model: '', effort: '', preset: '',
        importFromScheduler: false,
      },
      tasks: { 'task-old': { ...OLDER_TASK } },
    }));
    const harness = createHarness();
    const service = await mount(harness);
    const { tasks } = await service.list();
    assert.equal(tasks.length, 1, 'the stored task must survive the upgrade');
    assert.equal(tasks[0].title, 'Older task');
    assert.equal(service.settings().settings.workspaceId, '');
    assert.equal(service.settings().settings.cwd, '/tmp/workspace');
  });

  it('starts empty, and says so, when the document is corrupt', async () => {
    fs.mkdirSync(path.join(home, 'storages'), { recursive: true });
    fs.writeFileSync(path.join(home, 'storages', 'scheduled_tasks.json'), '{ not json');
    const harness = createHarness();
    const warnings = [];
    harness.ctx.logger.warn = (message) => warnings.push(message);
    const service = await mount(harness);
    assert.deepEqual((await service.list()).tasks, []);
    assert.ok(warnings.some((line) => line.includes('not readable JSON')), warnings.join('\n'));
  });

  it('leaves a corrupt document on disk rather than overwriting it', async () => {
    const file = path.join(home, 'storages', 'scheduled_tasks.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    const harness = createHarness();
    await mount(harness);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
  });
});

describe('a run', () => {
  it('starts a session with the task target, then sends the prompt', async () => {
    const harness = createHarness();
    const service = await mount(harness, SETTINGS);
    const { task } = await service.create(CREATE);
    const result = await service.runNow({ id: task.id });

    assert.equal(result.sessionId, 'session-1');
    // `/tmp/workspace` is owned by ws-1, so the run attaches to that project.
    assert.deepEqual(harness.calls.create, [{ workspaceId: 'ws-1' }]);
    assert.deepEqual(harness.calls.selectModel, [{
      sessionId: 'session-1',
      provider: 'gaia-local',
      model: 'Spark',
      reasoningEffort: 'medium',
    }]);
    assert.equal(harness.calls.prompt.length, 1);
    assert.deepEqual(harness.calls.prompt[0].content, [{ type: 'text', text: 'Prepare the brief.' }]);
    assert.equal(harness.calls.prompt[0].mode, 'queue');
    assert.equal(harness.calls.prompt[0].clientTimeZone, 'America/Chicago');
    assert.match(harness.calls.prompt[0].requestId, /^[0-9a-f-]{36}$/);
  });

  it('falls back to the plain directory when no workspace owns it', async () => {
    const harness = createHarness();
    const service = await mount(harness, { cwd: '/tmp/not-a-project' });
    const { task } = await service.create(CREATE);
    await service.runNow({ id: task.id });
    assert.deepEqual(harness.calls.create, [{ cwd: '/tmp/not-a-project' }]);
  });

  it('lets a task choose its own workspace, over the plugin default', async () => {
    const harness = createHarness();
    const service = await mount(harness, { workspaceId: '', cwd: '/tmp/not-a-project' });
    const { task } = await service.create({ ...CREATE, workspaceId: 'ws-1' });
    assert.equal(task.workspaceId, 'ws-1');
    await service.runNow({ id: task.id });
    assert.deepEqual(harness.calls.create, [{ workspaceId: 'ws-1' }]);
  });

  it('inherits the plugin workspace when the task names none', async () => {
    const harness = createHarness();
    const service = await mount(harness, { workspaceId: 'ws-1', cwd: '/tmp/not-a-project' });
    const { task } = await service.create(CREATE);
    assert.equal(task.workspaceId, '');
    await service.runNow({ id: task.id });
    assert.deepEqual(harness.calls.create, [{ workspaceId: 'ws-1' }]);
  });

  it('ignores a task workspace that no longer exists', async () => {
    const harness = createHarness();
    const service = await mount(harness, { workspaceId: '', cwd: '/tmp/not-a-project' });
    const { task } = await service.create({ ...CREATE, workspaceId: 'ws-gone' });
    await service.runNow({ id: task.id });
    assert.deepEqual(harness.calls.create, [{ cwd: '/tmp/not-a-project' }]);
  });

  it('can clear a task workspace on update', async () => {
    const harness = createHarness();
    const service = await mount(harness, { cwd: '/tmp/not-a-project' });
    const { task } = await service.create({ ...CREATE, workspaceId: 'ws-1' });
    const { task: cleared } = await service.update({ id: task.id, workspaceId: '' });
    assert.equal(cleared.workspaceId, '');
    const { task: kept } = await service.update({ id: task.id, title: 'Renamed' });
    assert.equal(kept.workspaceId, '');
  });

  it('prefers a chosen workspace, and ignores a stale one', async () => {
    const chosen = createHarness();
    const chosenService = await mount(chosen, { workspaceId: 'ws-1', cwd: '/tmp/not-a-project' });
    const { task: first } = await chosenService.create(CREATE);
    await chosenService.runNow({ id: first.id });
    assert.deepEqual(chosen.calls.create, [{ workspaceId: 'ws-1' }]);

    const stale = createHarness();
    const staleService = await mount(stale, { workspaceId: 'ws-gone', cwd: '/tmp/not-a-project' });
    const { task: second } = await staleService.create(CREATE);
    await staleService.runNow({ id: second.id });
    assert.deepEqual(stale.calls.create, [{ cwd: '/tmp/not-a-project' }]);
  });

  it('names the session after the task', async () => {
    const harness = createHarness();
    const service = await mount(harness, SETTINGS);
    const { task } = await service.create(CREATE);
    await service.runNow({ id: task.id });
    assert.match(harness.calls.rename[0].title, /^Northstar training brief — \d{4}-\d{2}-\d{2}$/);
  });

  it('gives every run its own request id', async () => {
    // `prompt` treats a repeated id as a duplicate and runs nothing.
    const harness = createHarness();
    const service = await mount(harness, SETTINGS);
    const { task } = await service.create(CREATE);
    await service.runNow({ id: task.id });
    await service.runNow({ id: task.id });
    const [first, second] = harness.calls.prompt;
    assert.notEqual(first.requestId, second.requestId);
  });

  it('puts the user\'s default model back after choosing the task\'s', async () => {
    const harness = createHarness();
    const service = await mount(harness, SETTINGS);
    const { task } = await service.create(CREATE);
    await service.runNow({ id: task.id });
    assert.deepEqual(harness.calls.saveSelection, [harness.previousSelection]);
  });

  it('mounts the agent preset on the session, and omits it when unset', async () => {
    const harness = createHarness();
    const service = await mount(harness, { ...SETTINGS, preset: 'minimal' });
    const { task } = await service.create({ ...CREATE, target: { provider: 'p', model: 'm' } });
    await service.runNow({ id: task.id });
    assert.equal(harness.calls.create[0].agentPreset, 'minimal');

    // A second harness reads the same file, so give it a fresh home rather
    // than inheriting the preset the first one saved.
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-tasks-home-'));
    process.env.DSH_HOME = home;
    const bare = createHarness();
    const bareService = await mount(bare, SETTINGS);
    const { task: second } = await bareService.create(CREATE);
    await bareService.runNow({ id: second.id });
    assert.equal('agentPreset' in bare.calls.create[0], false);
  });

  it('lets a saved default fill a field the task leaves out', async () => {
    const harness = createHarness();
    const service = await mount(harness, {
      ...SETTINGS, provider: 'gaia-local', model: 'Spark', effort: 'medium', preset: '',
    });
    const { task } = await service.create({ ...CREATE, target: { model: 'Ember' } });
    assert.deepEqual(task.target, {
      provider: 'gaia-local', model: 'Ember', effort: 'medium', preset: '',
    });
  });

  it('leaves the session on its own model when no target is set anywhere', async () => {
    const harness = createHarness();
    const service = await mount(harness, SETTINGS);
    const { task } = await service.create({ ...CREATE, target: undefined });
    assert.deepEqual(task.target, { provider: '', model: '', effort: '', preset: '' });
    await service.runNow({ id: task.id });
    assert.deepEqual(harness.calls.selectModel, []);
  });

  it('omits the effort when neither the task nor the defaults set one', async () => {
    const harness = createHarness();
    const service = await mount(harness, { ...SETTINGS, effort: '' });
    const { task } = await service.create({ ...CREATE, target: { provider: 'p', model: 'm' } });
    await service.runNow({ id: task.id });
    assert.equal(harness.calls.selectModel[0].reasoningEffort, undefined);
  });

  it('keeps running when the session could not be named', async () => {
    const harness = createHarness();
    harness.ctx.sessionController.rename = async () => {
      throw new Error('no session-title service');
    };
    const service = await mount(harness, SETTINGS);
    const { task } = await service.create(CREATE);
    const result = await service.runNow({ id: task.id });
    assert.equal(result.sessionId, 'session-1');
    assert.equal(harness.calls.prompt.length, 1);
  });
});

describe('the timer', () => {
  it('arms a timer for a task created after start', async () => {
    // A task created while the Host runs has to take effect without a reload.
    const armed = [];
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    globalThis.setTimeout = (fn, delay) => {
      const handle = { fn, delay, unref() {} };
      armed.push(handle);
      return handle;
    };
    globalThis.clearTimeout = () => {};
    try {
      const harness = createHarness();
      const service = await mount(harness, SETTINGS);
      assert.equal(armed.length, 0, 'nothing should be armed while the list is empty');
      await service.create(CREATE);
      await settle();
      assert.equal(armed.length, 1, 'creating a task did not arm a timer');
      const target = Date.parse((await service.list()).tasks[0].schedule.scheduledAt);
      assert.ok(Math.abs(armed[0].delay - (target - Date.now())) <= 50, `delay ${armed[0].delay}`);
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
  });

  it('re-arms when the last task is removed', async () => {
    const armed = [];
    const cleared = [];
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    globalThis.setTimeout = (fn, delay) => {
      const handle = { fn, delay, unref() {} };
      armed.push(handle);
      return handle;
    };
    globalThis.clearTimeout = (handle) => {
      cleared.push(handle);
    };
    try {
      const harness = createHarness();
      const service = await mount(harness, SETTINGS);
      const { task } = await service.create(CREATE);
      await settle();
      await service.delete({ id: task.id });
      await settle();
      assert.equal(armed.length, 1);
      assert.equal(cleared.length, 1, 'removing the last task left a timer armed');
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
  });
});

describe('shutdown', () => {
  it('stops the timer', async () => {
    const harness = createHarness();
    await mount(harness, SETTINGS);
    assert.equal(harness.disposers.length, 1);
    for (const dispose of harness.disposers) dispose();
  });
});
