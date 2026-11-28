// JavaScript client for the whiteboard API. Runs unchanged in browsers and Node.js 22 or later.
// Types live in whiteboard.d.mts.
import { parseExactJSON } from './exact-json.mjs';

export { numberText } from './exact-json.mjs';

export class APIError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Returns trimmed JSON object text, or throws a message for people typing JSON.
export function jsonObject(input) {
  let value;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error('Enter valid JSON.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Enter a JSON object enclosed in braces.');
  }
  return input.trim();
}

const unsupported = 'This runtime cannot preserve exact JSON numbers. Use Node.js 22 or later, or update your browser.';

function checkedURL(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // A path such as /api/boards/demo is resolved against the page by the browser.
    if (!url.startsWith('/') || url.startsWith('//')) throw new Error('Use an absolute board API URL or a path starting with /.');
    return url.replace(/\/+$/, '');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('Use an HTTPS board URL or HTTP on loopback.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Use the board API URL without credentials, a query, or a fragment.');
  }
  return parsed.href.replace(/\/+$/, '');
}

const jsonText = value => typeof value === 'string' ? value : JSON.stringify(value);

function query(params) {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value === true) search.set(name, '1');
    else if (value) search.set(name, value);
  }
  const text = search.toString();
  return text ? '?' + text : '';
}

function memoryKeys() {
  const keys = new Map();
  return { get: operation => keys.get(operation), set: (operation, key) => keys.set(operation, key), delete: operation => keys.delete(operation) };
}

function client(token, options) {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('Pass a whiteboard access token.');
  return {
    token: trimmed,
    keys: options.keys ?? memoryKeys(),
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    timeoutMs: options.timeoutMs ?? 15_000,
  };
}

async function request(config, url, { body, signal, waitMs = 0, key } = {}) {
  const headers = new Headers({ Authorization: 'Bearer ' + config.token });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (key) headers.set('Idempotency-Key', key);
  const timeout = AbortSignal.timeout(config.timeoutMs + waitMs);
  const response = await config.fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    cache: 'no-store',
    redirect: 'error',
    // Bearer tokens authorize requests, so a cross-origin server never sees cookies.
    credentials: 'omit',
  });
  if (!response.ok) {
    const fallback = response.status === 401 ? 'Access token is invalid.' : 'The whiteboard request failed with HTTP ' + response.status + '.';
    const error = await response.json().catch(() => ({}));
    throw new APIError(response.status, error.code, error.message || fallback);
  }
  return response.status === 204 ? null : parseExactJSON(await response.text(), unsupported);
}

// Sends a Post, Take, or other keyed request. A lost reply or 5xx is resent once with the same
// key, and the key stays stored until the board confirms the outcome, so repeating the call reuses it.
async function mutate(config, url, body, { key, action, signal } = {}, waitMs = 0) {
  const input = new TextEncoder().encode(JSON.stringify([url, config.token, action ?? url, body]));
  const digest = await crypto.subtle.digest('SHA-256', input);
  const operation = 'whiteboard:request:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const requestKey = key ?? config.keys.get(operation) ?? crypto.randomUUID();
  config.keys.set(operation, requestKey);
  const send = () => request(config, url, { body, signal, waitMs, key: requestKey });
  const confirmed = error => signal?.aborted || (error instanceof APIError && error.status < 500);
  try {
    const result = await send().catch(error => {
      if (confirmed(error)) throw error;
      return send().catch(cause => {
        if (signal?.aborted || cause instanceof APIError) throw cause;
        throw new Error('Could not confirm whiteboard request ' + requestKey + '.', { cause });
      });
    });
    config.keys.delete(operation);
    return result;
  } catch (error) {
    if (error instanceof APIError && error.code && error.status < 500) config.keys.delete(operation);
    throw error;
  }
}

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

// Creates a whiteboard on a server whose operator issued a creation token.
export async function createBoard(server, token, details, options = {}) {
  const config = client(token, options);
  const origin = checkedURL(server);
  const created = await mutate(config, origin + '/api/boards', JSON.stringify(details), { signal: options.signal }).catch(error => {
    if (error instanceof APIError || options.signal?.aborted) throw error;
    throw new Error('Could not reach the target server. Check its address and whether it allows creation from this site.', { cause: error });
  });
  if (created?.id !== details.slug || typeof created.tokenId !== 'string' ||
      typeof created.token !== 'string' || !tokenPattern.test(created.token)) {
    throw new Error('The server did not return a whiteboard access token.');
  }
  return created;
}

export class Whiteboard {
  #config;

  constructor(url, token, options = {}) {
    this.url = checkedURL(url);
    this.#config = client(token, options);
  }

  details({ signal } = {}) {
    return request(this.#config, this.url, { signal });
  }

  post(payload, { expiresAt, ...options } = {}) {
    const deadline = expiresAt === undefined ? '' : ',"expiresAt":' + JSON.stringify(expiresAt);
    return mutate(this.#config, this.url + '/entries', '{"payload":' + jsonText(payload) + deadline + '}', options);
  }

  take(target, options) {
    if ('entryId' in target) return mutate(this.#config, this.url + '/take', JSON.stringify({ entryId: target.entryId }), options);
    const waitMs = target.waitMs ?? 0;
    const body = '{"pattern":' + jsonText(target.pattern) + (waitMs ? ',"waitMs":' + waitMs : '') + '}';
    return mutate(this.#config, this.url + '/take', body, options, waitMs);
  }

  repost(entryId, options) {
    const url = this.url + '/entries/' + encodeURIComponent(entryId) + '/repost';
    return mutate(this.#config, url, '{}', { action: 'recover:' + entryId, ...options });
  }

  read(pattern, { waitMs = 0, signal } = {}) {
    const body = '{"pattern":' + jsonText(pattern) + (waitMs ? ',"waitMs":' + waitMs : '') + '}';
    return request(this.#config, this.url + '/read', { body, signal, waitMs });
  }

  browse(pattern, { cursor, summary, signal } = {}) {
    return request(this.#config, this.url + '/browse' + query({ summary, cursor }), { body: '{"pattern":' + jsonText(pattern) + '}', signal });
  }

  history({ cursor, entryId, summary, signal } = {}) {
    return request(this.#config, this.url + '/history' + query({ summary, cursor, entryId }), { signal });
  }

  entry(id, { signal } = {}) {
    return request(this.#config, this.url + '/entries/' + encodeURIComponent(id), { signal });
  }

  overview({ tasks, signal } = {}) {
    return request(this.#config, this.url + '/overview' + query({ tasks }), { signal });
  }
}
