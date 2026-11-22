import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['src/board-view.ts'], bundle: true, format: 'esm', write: false });
const { BoardView } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const board = { id: 'demo', name: 'Demo', actor: 'Writer', permissions: ['read', 'post', 'take'], archived: false };
const entry = (id, issue) => ({ id, payload: { issue }, postedAt: '2026-11-22T08:00:00Z' });
const event = (id, record, operation = 'post') => ({ id, entry: record, operation, actor: 'Writer', at: record.postedAt });
const silent = () => {};

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function viewWith(reader) {
  return new BoardView({
    board: async () => board,
    overview: async () => ({ issues: ['alpha', 'beta'], events: [] }),
    history: async () => ({ events: [] }),
    browse: async () => ({ entries: [] }),
    ...reader,
  }, board);
}

test('Refresh keeps the selected Activity page and focused record until navigation', async () => {
  const recent = event('10', entry('7', 'alpha'));
  const older = event('6', entry('3', 'alpha'));
  const focused = event('2', entry('1', 'beta'), 'take');
  const requests = [];
  const view = viewWith({ history: async (_signal, cursor, id) => {
    requests.push([cursor, id]);
    if (id) return { events: [focused] };
    return cursor ? { events: [older] } : { events: [recent], nextCursor: recent.id };
  } });

  view.select({ type: 'issue', issue: 'alpha' });
  view.select({ type: 'view', view: 'activity' });
  await view.refresh(silent);
  view.select({ type: 'page', direction: 'next' });
  view.select({ type: 'focus', focus: { entryId: '1', operation: 'take' } });
  await view.refresh(silent);
  await view.refresh(silent);
  assert.deepEqual(requests.slice(-2), [[recent.id, undefined], [undefined, '1']]);
  assert.deepEqual(view.data.events, [older]);
  assert.equal(view.focusedRecord, focused);

  view.select({ type: 'page', direction: 'previous' });
  await view.refresh(silent);
  assert.deepEqual(view.data.events, [recent]);
  assert.equal(view.focusedRecord, undefined);
});

test('a page failure retains matching results and applies archive status as soon as it arrives', async () => {
  const good = entry('2', 'alpha');
  const failedPage = deferred();
  const archiveSeen = deferred();
  let archived = false;
  const view = viewWith({
    board: async () => ({ ...board, archived }),
    browse: async (_pattern, _signal, cursor) => {
      if (!archived) return { entries: [good] };
      return cursor ? failedPage.promise : { entries: [entry('3', 'beta')], nextCursor: '3' };
    },
  });
  view.select({ type: 'view', view: 'entries' });
  view.select({ type: 'issue', issue: 'alpha' });
  await view.refresh(silent);
  archived = true;
  const refreshing = assert.rejects(view.refresh(() => {
    if (view.board.archived && view.loading) archiveSeen.resolve();
  }), /page failed/);
  await archiveSeen.promise;
  assert.equal(view.can('post'), false);
  assert.deepEqual(view.data.entries, [good]);
  failedPage.reject(new Error('page failed'));
  await refreshing;
  assert.deepEqual(view.data.entries, [good]);

  view.select({ type: 'issue', issue: 'beta' });
  assert.equal(view.data, undefined);
});

test('a late response for a superseded view never replaces the active view', async () => {
  const late = deferred();
  const fresh = event('1', entry('1', 'alpha'));
  const view = viewWith({
    browse: async () => late.promise,
    history: async () => ({ events: [fresh] }),
  });
  view.select({ type: 'view', view: 'entries' });
  const previous = view.refresh(silent);
  view.select({ type: 'view', view: 'activity' });
  await view.refresh(silent);
  late.resolve({ entries: [entry('2', 'beta')] });
  await previous;
  assert.deepEqual(view.data.events, [fresh]);
  assert.deepEqual(view.data.entries, []);
});
