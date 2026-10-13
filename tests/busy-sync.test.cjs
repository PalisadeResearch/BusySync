const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'sync.gs'), 'utf8');
const start = '2026-10-14T10:00:00Z';
const end = '2026-10-14T11:00:00Z';

function block(id, startTime = start, endTime = end) {
  return {
    id,
    start: { dateTime: startTime },
    end: { dateTime: endTime },
    extendedProperties: { private: { personalBusySync: 'v2' } },
  };
}

function runBusySync({ busy = [], pages = [{ items: [] }] } = {}) {
  const removed = [];
  const inserted = [];
  const queries = [];
  const context = vm.createContext({
    Calendar: {
      Freebusy: {
        query: () => ({ calendars: { 'XXXXXXXXXX@gmail.com': { busy } } }),
      },
      Events: {
        list: (calendarId, params) => {
          assert.equal(calendarId, 'primary');
          assert.equal(params.privateExtendedProperty, 'personalBusySync=v2');
          queries.push({ ...params });
          const page = pages[queries.length - 1];
          assert.ok(page, 'unexpected extra calendar query');
          return page;
        },
        remove: (calendarId, id) => {
          assert.equal(calendarId, 'primary');
          removed.push(id);
        },
        insert: (event, calendarId) => {
          assert.equal(calendarId, 'primary');
          inserted.push(JSON.parse(JSON.stringify(event)));
        },
      },
    },
    Session: { getScriptTimeZone: () => 'UTC' },
    Logger: { log: () => {} },
  });
  vm.runInContext(script, context);
  vm.runInContext(
    "syncBusyBlocks_(new Date('2026-10-14T00:00:00Z'), new Date('2026-11-14T00:00:00Z'))",
    context,
  );
  return { removed, inserted, queries };
}

test('removes every duplicate when its busy interval disappears', () => {
  const result = runBusySync({ pages: [{ items: [block('first'), block('second')] }] });
  assert.deepEqual(result.removed, ['first', 'second']);
  assert.deepEqual(result.inserted, []);
});

test('keeps one existing block when duplicate blocks still match a busy interval', () => {
  const result = runBusySync({
    busy: [{ start, end }],
    pages: [{ items: [block('first'), block('second'), block('third')] }],
  });
  assert.deepEqual(result.removed, ['second', 'third']);
  assert.deepEqual(result.inserted, []);
});

test('deduplicates matching instants even when their timezone offsets differ', () => {
  const result = runBusySync({
    busy: [{ start, end }],
    pages: [{ items: [block('first'), block('second', '2026-10-14T12:00:00+02:00', '2026-10-14T13:00:00+02:00')] }],
  });
  assert.deepEqual(result.removed, ['second']);
  assert.deepEqual(result.inserted, []);
});

test('removes stale duplicates found on different pages', () => {
  const result = runBusySync({
    pages: [
      { items: [block('first')], nextPageToken: 'next-page' },
      { items: [block('second')] },
    ],
  });
  assert.equal(result.queries[1].pageToken, 'next-page');
  assert.deepEqual(result.removed, ['first', 'second']);
});

test('leaves a single matching block unchanged', () => {
  const result = runBusySync({ busy: [{ start, end }], pages: [{ items: [block('first')] }] });
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.inserted, []);
});

test('creates a missing private busy block and removes all stale duplicates', () => {
  const result = runBusySync({
    busy: [{ start: '2026-10-14T15:00:00Z', end: '2026-10-14T16:00:00Z' }],
    pages: [{ items: [block('first'), block('second')] }],
  });
  assert.deepEqual(result.removed, ['first', 'second']);
  assert.equal(result.inserted.length, 1);
  assert.equal(result.inserted[0].start.dateTime, '2026-10-14T15:00:00.000Z');
  assert.equal(result.inserted[0].end.dateTime, '2026-10-14T16:00:00.000Z');
  assert.equal(result.inserted[0].summary, '[Busy]');
  assert.equal(result.inserted[0].visibility, 'private');
  assert.equal(result.inserted[0].transparency, 'opaque');
});
