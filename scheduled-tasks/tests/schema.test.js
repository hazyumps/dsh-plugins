/**
 * The wire schema is the seam between the editor and the Host, and the editor
 * builds its payloads by hand. These cases are the exact shapes `client.js`
 * sends, so a drift on either side fails here rather than at the first save.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createRequest,
  document,
  listResult,
  deleteRequest,
  runNowRequest,
  settingsResult,
  settingsUpdateRequest,
  workspaceListResult,
  taskRecord,
  taskResult,
  updateRequest,
} from '../lib/schema.js';
import { TYPERT } from '../lib/typert.host.js';

/** A complete stored task, as the service returns one. */
const TASK = {
  id: 'task-1',
  title: 'Northstar training brief',
  enabled: true,
  schedule: {
    id: 'task-1',
    kind: 'weekly',
    title: 'Northstar training brief',
    prompt: 'Prepare the brief.',
    scheduledAt: '2026-10-08T12:00:00.000Z',
    time: '07:00:00.000',
    timeZone: 'America/Chicago',
    weekdays: [1, 2, 3, 4, 5],
  },
  target: { provider: 'gaia-local', model: 'Spark', effort: 'medium', preset: '' },
  workspaceId: '',
  createdAt: '2026-10-07T15:24:00.000Z',
  updatedAt: '2026-10-07T15:24:00.000Z',
  lastRun: null,
  runs: [],
};

/** Every rule the editor can produce, from `client.js`'s `buildRule`. */
const RULES = {
  daily: { kind: 'daily', time: '07:00:00', timeZone: 'America/Chicago' },
  weekdays: { kind: 'weekly', time: '07:00:00', timeZone: 'America/Chicago', weekdays: [1, 2, 3, 4, 5] },
  weekly: { kind: 'weekly', time: '09:30:00', timeZone: 'America/Chicago', weekdays: [2, 4] },
  everyMinutes: { kind: 'every', everySeconds: 900 },
  everyHours: { kind: 'every', everySeconds: 7200 },
  once: {
    kind: 'at',
    at: { date: '2026-10-08', time: '07:00:00', time_zone: 'America/Chicago' },
  },
  custom: { kind: 'cron', expression: '0 7 * * 1-5', timeZone: 'America/Chicago' },
};

/** The target the editor builds; empty fields are omitted rather than sent. */
function target(entries) {
  return entries;
}

describe('the editor\'s payloads', () => {
  for (const [name, rule] of Object.entries(RULES)) {
    it(`accepts the ${name} rule on create`, () => {
      const parsed = createRequest.parse({
        title: 'A task',
        prompt: 'Do the thing.',
        rule,
        target: target({ provider: 'gaia-local', model: 'Spark', effort: 'medium' }),
        enabled: true,
      });
      assert.deepEqual(parsed.rule, rule);
    });
  }

  it('accepts an empty title, which the Host replaces with the prompt\'s first line', () => {
    const parsed = createRequest.parse({
      title: '', prompt: 'Do the thing.', rule: RULES.daily, target: target({}), enabled: true,
    });
    assert.equal(parsed.title, '');
  });

  it('accepts a target with every field omitted', () => {
    const parsed = createRequest.parse({
      title: 'A task', prompt: 'p', rule: RULES.daily, target: target({}), enabled: false,
    });
    assert.deepEqual(parsed.target, {});
  });

  it('carries a workspace on create and update', () => {
    assert.equal(createRequest.parse({
      prompt: 'p', rule: RULES.daily, workspaceId: 'ws-1',
    }).workspaceId, 'ws-1');
    assert.equal(updateRequest.parse({ id: 'task-1', workspaceId: 'ws-2' }).workspaceId, 'ws-2');
  });

  it('accepts the update body, which carries the rule on every save', () => {
    const parsed = updateRequest.parse({
      id: 'task-1',
      title: 'A task',
      prompt: 'p',
      rule: RULES.custom,
      target: target({ provider: 'gaia-local', model: 'Ember' }),
      enabled: true,
    });
    assert.equal(parsed.rule.kind, 'cron');
  });

  it('accepts the toggle, run, and delete payloads', () => {
    assert.deepEqual(updateRequest.parse({ id: 'task-1', enabled: false }), {
      id: 'task-1', enabled: false,
    });
    assert.deepEqual(runNowRequest.parse({ id: 'task-1' }), { id: 'task-1' });
    assert.deepEqual(deleteRequest.parse({ id: 'task-1' }), { id: 'task-1' });
  });
});

describe('the durable record', () => {
  it('accepts a task with run history', () => {
    const parsed = taskRecord.parse({
      ...TASK,
      lastRun: {
        occurrenceAt: TASK.schedule.scheduledAt,
        sessionId: 'session-1',
        finishedAt: '2026-10-08T12:00:04.000Z',
        ok: true,
        error: null,
      },
      runs: [{
        occurrenceAt: TASK.schedule.scheduledAt,
        sessionId: 'session-1',
        finishedAt: '2026-10-08T12:00:04.000Z',
        ok: true,
        error: null,
      }],
    });
    assert.equal(parsed.runs.length, 1);
  });

  it('accepts a record for every rule kind', () => {
    for (const rule of Object.values(RULES)) {
      const schedule = { ...TASK.schedule, kind: rule.kind };
      for (const [key, value] of Object.entries(rule)) {
        if (key !== 'kind') schedule[key] = value;
      }
      assert.doesNotThrow(() => taskRecord.parse({ ...TASK, schedule }), rule.kind);
    }
  });

  it('accepts a task that names its own workspace, and one that inherits', () => {
    const owned = taskRecord.parse({ ...TASK, workspaceId: 'ws-1' });
    assert.equal(owned.workspaceId, 'ws-1');
    const { workspaceId, ...withoutField } = TASK;
    assert.equal(taskRecord.parse(withoutField).workspaceId, '', 'an older task inherits');
  });

  it('rejects a task with no prompt', () => {
    assert.throws(() => taskRecord.parse({
      ...TASK,
      schedule: { ...TASK.schedule, prompt: '' },
    }));
  });

  it('rejects a run without an outcome', () => {
    assert.throws(() => taskRecord.parse({
      ...TASK,
      runs: [{ occurrenceAt: 'x', sessionId: null, finishedAt: 'y' }],
    }));
  });

  it('round-trips through JSON, as the store does', () => {
    assert.deepEqual(taskRecord.parse(JSON.parse(JSON.stringify(TASK))), TASK);
  });

  it('accepts the list and create results the service returns', () => {
    assert.doesNotThrow(() => listResult.parse({ tasks: [TASK] }));
    assert.doesNotThrow(() => taskResult.parse({ task: TASK }));
  });
});

describe('the Host manifest', () => {
  it('names this package, is the host face, and declares its model', () => {
    assert.equal(TYPERT.package, 'dsh-plugin-scheduled-tasks');
    assert.equal(TYPERT.face, 'host');
    assert.equal(TYPERT.model.services[0].key, 'scheduledTasks');
    assert.deepEqual(TYPERT.schemas, []);
  });

  it('resolves a real schema for every declared codec', () => {
    // The Typert loader requires `create` to be a function; the gateway then
    // uses what it returns, so it has to be a usable schema and not a stub.
    for (const invocation of TYPERT.invocations) {
      const result = invocation.result.create();
      assert.equal(typeof result?.parse, 'function', `${invocation.id} result`);
      for (const parameter of invocation.parameters) {
        assert.equal(
          typeof parameter.codec.create()?.parse,
          'function',
          `${invocation.id} parameter ${parameter.name}`,
        );
      }
    }
  });

  it('documents every member the manifest advertises', () => {
    const [service] = TYPERT.model.services;
    assert.deepEqual(service.members.map((member) => member.name), [
      'list', 'settings', 'saveSettings', 'workspaces', 'create', 'update', 'delete', 'runNow',
    ]);
    for (const member of service.members) assert.equal(member.kind, 'method');
    assert.equal(typeof service.description, 'string');
    assert.equal(typeof service.summary, 'string');
    assert.deepEqual(service.tags, []);
  });
});

describe('settings and the document', () => {
  const SETTINGS = {
    cwd: '/Users/you/repo/example',
    workspaceId: '',
    provider: 'gaia-local',
    model: 'Spark',
    effort: 'medium',
    preset: '',
    importFromScheduler: false,
  };

  it('accepts the settings the editor submits, sparsely', () => {
    assert.deepEqual(settingsUpdateRequest.parse({ cwd: '/tmp' }), { cwd: '/tmp' });
    assert.deepEqual(settingsUpdateRequest.parse({ workspaceId: 'ws-1' }), { workspaceId: 'ws-1' });
    assert.deepEqual(settingsUpdateRequest.parse({}), {});
  });

  it('accepts the settings result the service returns', () => {
    assert.deepEqual(settingsResult.parse({ settings: SETTINGS }).settings, SETTINGS);
  });

  it('accepts a whole document', () => {
    assert.doesNotThrow(() => document.parse({
      version: 1, settings: SETTINGS, tasks: { 'task-1': TASK },
    }));
  });

  it('rejects a document missing its settings', () => {
    assert.throws(() => document.parse({ version: 1, tasks: {} }));
  });

  it('rejects a task key whose record is invalid', () => {
    assert.throws(() => document.parse({
      version: 1,
      settings: SETTINGS,
      tasks: { 'task-1': { ...TASK, title: '' } },
    }));
  });
});

describe('the workspace list', () => {
  it('accepts what the registry projection returns', () => {
    const parsed = workspaceListResult.parse({
      workspaces: [{ id: 'ws-1', title: 'example', path: '/Users/you/repo/example' }],
    });
    assert.equal(parsed.workspaces[0].title, 'nst');
  });

  it('accepts an empty registry', () => {
    assert.deepEqual(workspaceListResult.parse({ workspaces: [] }), { workspaces: [] });
  });
});
