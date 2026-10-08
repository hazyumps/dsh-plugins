import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { importLegacyTasks, readLegacyTasks, toCreateRequest } from '../lib/import.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-tasks-import-'));
after(() => fs.rmSync(home, { recursive: true, force: true }));

/**
 * Write a legacy store into a scratch harness home.
 * @param name - Sub-directory to isolate the case.
 * @param document - The document to write, or null to write nothing.
 * @returns The harness home for that case.
 */
function harnessHome(name, document) {
  const root = path.join(home, name);
  if (document !== null) {
    fs.mkdirSync(path.join(root, 'storages'), { recursive: true });
    fs.writeFileSync(path.join(root, 'storages', 'schedule.json'), JSON.stringify(document));
  }
  return root;
}

/** A legacy row wrapping one record. */
function row(record, status = 'active') {
  return { sessionId: 'session-1', record, status, deliveryHistory: {} };
}

const NORTHSTAR = row({
  id: 'schedule-1',
  kind: 'weekly',
  title: 'Northstar training brief',
  prompt: "Prepare Patrick's Northstar training brief for today.",
  time: '07:00:00.000',
  timeZone: 'America/Chicago',
  weekdays: [1, 2, 3, 4, 5],
  scheduledAt: '2026-10-08T12:00:00.000Z',
});

describe('readLegacyTasks', () => {
  it('reads the stored rows', () => {
    const root = harnessHome('read', { tables: { tasks: { 'schedule-1': NORTHSTAR } } });
    assert.equal(readLegacyTasks(root).length, 1);
  });

  it('is empty when nothing was ever stored', () => {
    assert.deepEqual(readLegacyTasks(harnessHome('absent', null)), []);
  });

  it('is empty when the document is unreadable', () => {
    const root = path.join(home, 'broken');
    fs.mkdirSync(path.join(root, 'storages'), { recursive: true });
    fs.writeFileSync(path.join(root, 'storages', 'schedule.json'), 'not json');
    assert.deepEqual(readLegacyTasks(root), []);
  });
});

describe('toCreateRequest', () => {
  it('maps a weekly task field for field', () => {
    assert.deepEqual(toCreateRequest(NORTHSTAR), {
      title: 'Northstar training brief',
      prompt: "Prepare Patrick's Northstar training brief for today.",
      rule: { kind: 'weekly', time: '07:00:00.000', timeZone: 'America/Chicago', weekdays: [1, 2, 3, 4, 5] },
      enabled: true,
    });
  });

  it('carries an inactive status into enabled:false', () => {
    assert.equal(toCreateRequest(row({ ...NORTHSTAR.record }, 'inactive')).enabled, false);
  });

  it('maps every rule kind it can express', () => {
    const base = { id: 'x', title: 't', prompt: 'p', scheduledAt: '2026-10-08T12:00:00.000Z' };
    assert.deepEqual(
      toCreateRequest(row({ ...base, kind: 'daily', time: '07:00:00.000', timeZone: 'UTC' })).rule,
      { kind: 'daily', time: '07:00:00.000', timeZone: 'UTC' },
    );
    assert.deepEqual(
      toCreateRequest(row({ ...base, kind: 'every', everySeconds: 900 })).rule,
      { kind: 'every', everySeconds: 900 },
    );
    assert.deepEqual(
      toCreateRequest(row({ ...base, kind: 'cron', expression: '0 7 * * 1-5', timeZone: 'UTC' })).rule,
      { kind: 'cron', expression: '0 7 * * 1-5', timeZone: 'UTC' },
    );
    assert.deepEqual(
      toCreateRequest(row({ ...base, kind: 'at' })).rule,
      { kind: 'at', at: '2026-10-08T12:00:00.000Z' },
    );
  });

  it('refuses a record it cannot express', () => {
    assert.equal(toCreateRequest(row({ id: 'x', kind: 'after', prompt: 'p', afterSeconds: 60 })), null);
    assert.equal(toCreateRequest(row({ id: 'x', kind: 'daily', prompt: '   ' })), null);
    assert.equal(toCreateRequest(null), null);
  });
});

describe('importLegacyTasks', () => {
  it('creates every translatable task', async () => {
    const root = harnessHome('import', {
      tables: { tasks: { 'schedule-1': NORTHSTAR, 'schedule-2': row({ id: 's2', kind: 'after', prompt: 'p', afterSeconds: 5 }) } },
    });
    const created = [];
    const count = await importLegacyTasks({
      home: root,
      store: { size: 0 },
      create: async (request) => {
        created.push(request.title);
      },
    });
    assert.equal(count, 1);
    assert.deepEqual(created, ['Northstar training brief']);
  });

  it('leaves a non-empty list alone', async () => {
    const root = harnessHome('import-full', { tables: { tasks: { 'schedule-1': NORTHSTAR } } });
    const count = await importLegacyTasks({
      home: root,
      store: { size: 3 },
      create: async () => {
        throw new Error('must not run');
      },
    });
    assert.equal(count, 0);
  });

  it('keeps going when one task is rejected, and reports it', async () => {
    const root = harnessHome('import-partial', {
      tables: { tasks: { a: NORTHSTAR, b: row({ ...NORTHSTAR.record, id: 'b', title: 'Second', kind: 'daily', time: '08:00:00.000' }) } },
    });
    const warned = [];
    const count = await importLegacyTasks({
      home: root,
      store: { size: 0 },
      create: async (request) => {
        if (request.title === 'Second') throw new Error('nope');
      },
      logger: { warn: (message) => warned.push(message) },
    });
    assert.equal(count, 1);
    assert.match(warned[0], /Second/);
  });
});
