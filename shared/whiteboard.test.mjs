import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APIError, Whiteboard, createBoard, numberText } from './whiteboard.mjs';

const url = 'https://whiteboard.example.com/api/boards/demo';

function stub(...replies) {
  const calls = [];
  const fetch = async (target, init) => {
    calls.push({ target, init });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return new Response(reply.body ?? null, { status: reply.status });
  };
  return { calls, fetch };
}

const entry = '{"id":"e1","payload":{"n":12345678901234567890.5},"postedAt":"now"}';
const keyOf = call => call.init.headers.get('Idempotency-Key');

test('retries a lost reply once with the same key and body', async () => {
  const { calls, fetch } = stub(new TypeError('fetch failed'), { status: 201, body: entry });
  const board = new Whiteboard(url, 'token', { fetch });
  const posted = await board.post('{"n":12345678901234567890.5}', { expiresAt: '2026-12-01T00:00:00.000Z' });
  assert.equal(calls.length, 2);
  assert.equal(keyOf(calls[0]), keyOf(calls[1]));
  assert.equal(calls[1].init.body, '{"payload":{"n":12345678901234567890.5},"expiresAt":"2026-12-01T00:00:00.000Z"}');
  assert.equal(numberText(posted.payload.n), '12345678901234567890.5');
  assert.equal(JSON.stringify(posted.payload), '{"n":12345678901234567890.5}');
});

test('keeps the key after an unconfirmed failure and clears it after a confirmed one', async () => {
  const { calls, fetch } = stub(
    { status: 503 }, { status: 503 },
    { status: 409, body: '{"code":"already_taken","message":"Taken."}' },
    { status: 204 },
  );
  const board = new Whiteboard(url, 'token', { fetch });
  await assert.rejects(board.take({ entryId: 'e1' }), APIError);
  await assert.rejects(board.take({ entryId: 'e1' }), { code: 'already_taken' });
  assert.equal(await board.take({ entryId: 'e1' }), null);
  assert.equal(new Set(calls.slice(0, 3).map(keyOf)).size, 1);
  assert.notEqual(keyOf(calls[3]), keyOf(calls[0]));
});

test('names the request key when neither attempt is confirmed', async () => {
  const { calls, fetch } = stub(new TypeError('fetch failed'), new TypeError('fetch failed'));
  const board = new Whiteboard(url, 'token', { fetch });
  await assert.rejects(board.repost('e1'), error => error.message.includes(keyOf(calls[0])));
  assert.equal(calls[0].target, url + '/entries/e1/repost');
});

test('returns null when a pattern has no match', async () => {
  const { calls, fetch } = stub({ status: 204 });
  const board = new Whiteboard(url, 'token', { fetch });
  assert.equal(await board.read({ kind: 'work' }, { waitMs: 50 }), null);
  assert.equal(calls[0].target, url + '/read');
  assert.equal(calls[0].init.body, '{"pattern":{"kind":"work"},"waitMs":50}');
});

test('creates a board and rejects a reply without a token', async () => {
  const token = 'a'.repeat(43);
  const { calls, fetch } = stub(
    { status: 201, body: JSON.stringify({ id: 'demo', tokenId: 't1', token }) },
    { status: 201, body: '{"id":"demo"}' },
  );
  const details = { slug: 'demo', name: 'Demo', actor: 'Maintainer' };
  assert.equal((await createBoard('https://boards.example.com', 'create', details, { fetch })).token, token);
  assert.equal(calls[0].target, 'https://boards.example.com/api/boards');
  assert.equal(calls[0].init.credentials, 'omit');
  await assert.rejects(createBoard('https://boards.example.com', 'create', details, { fetch }), /did not return/);
});

test('rejects unsafe board URLs', () => {
  assert.throws(() => new Whiteboard('http://whiteboard.example.com/api/boards/demo', 't'), /HTTPS/);
  assert.throws(() => new Whiteboard('https://u:p@whiteboard.example.com/api/boards/demo', 't'), /credentials/);
  assert.throws(() => new Whiteboard('//evil.example.com/api', 't'), /absolute/);
  assert.equal(new Whiteboard('http://127.0.0.1:8080/api/boards/demo/', 't').url, 'http://127.0.0.1:8080/api/boards/demo');
  assert.equal(new Whiteboard('/api/boards/demo', 't').url, '/api/boards/demo');
});
