import { parseExactJSON } from '../../shared/exact-json.mjs';
export { numberText } from '../../shared/exact-json.mjs';

export type Permission = 'post' | 'read' | 'take';
export type Payload = Record<string, unknown>;

export interface Board {
  id: string;
  name: string;
  actor: string;
  permissions: Permission[];
  archived: boolean;
}

export interface Entry {
  id: string;
  payload: Payload;
  postedAt: string;
  expiresAt?: string;
  expired?: boolean;
}

export interface BoardEvent {
  id: string;
  operation: 'post' | 'take';
  actor: string;
  at: string;
  entry: Entry;
  repostedFrom?: string;
  latestRepost?: string;
}

export interface Overview {
  issues: unknown[];
  events: BoardEvent[];
}

export class APIError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) {
    super(message);
  }
}

export function jsonObject(input: string): string {
  let value: unknown;
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

export class BoardAPI {
  private readonly path: string;
  private readonly requestKeys = new Map<string, string>();

  constructor(slug: string, private readonly token: string) {
    this.path = '/api/boards/' + encodeURIComponent(slug);
  }

  board(signal?: AbortSignal) {
    return this.request<Board>('', undefined, signal);
  }

  browse(pattern: string, signal: AbortSignal, cursor?: string) {
    const query = new URLSearchParams({ summary: '1' });
    if (cursor) query.set('cursor', cursor);
    return this.request<{ entries: Entry[]; nextCursor?: string }>('/browse?' + query, '{"pattern":' + pattern + '}', signal);
  }

  history(signal: AbortSignal, cursor?: string, entryId?: string) {
    const query = new URLSearchParams({ summary: '1' });
    if (cursor) query.set('cursor', cursor);
    if (entryId) query.set('entryId', entryId);
    return this.request<{ events: BoardEvent[]; nextCursor?: string }>('/history?' + query, undefined, signal);
  }

  overview(tasks: boolean, signal: AbortSignal) {
    return this.request<Overview>(tasks ? '/overview?tasks=1' : '/overview', undefined, signal);
  }

  entry(id: string, signal?: AbortSignal) {
    return this.request<Entry>('/entries/' + encodeURIComponent(id), undefined, signal);
  }

  post(payload: string, expiresAt?: string) {
    const deadline = expiresAt === undefined ? '' : ',"expiresAt":' + JSON.stringify(expiresAt);
    return this.mutate('/entries', '{"payload":' + payload + deadline + '}', 'post');
  }

  take(entryId: string) {
    return this.mutate('/take', JSON.stringify({ entryId }), 'take');
  }

  repost(entryId: string) {
    return this.mutate('/entries/' + encodeURIComponent(entryId) + '/repost', '{}', 'recover:' + entryId);
  }

  private async mutate(path: string, body: string, action: string) {
    // Reuse the request ID when retrying a mutation with an unknown outcome.
    const input = new TextEncoder().encode(JSON.stringify([this.path, this.token, action, body]));
    const digest = await crypto.subtle.digest('SHA-256', input);
    const operation = 'whiteboard:request:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const key = this.pendingKey(operation) ?? crypto.randomUUID();
    this.saveKey(operation, key);
    try {
      const entry = await this.request<Entry>(path, body, undefined, key);
      this.saveKey(operation);
      return entry;
    } catch (error) {
      // Only a confirmed response from the board resolves an uncertain outcome.
      if (error instanceof APIError && error.code && error.status < 500) this.saveKey(operation);
      throw error;
    }
  }

  private pendingKey(operation: string) {
    try {
      return this.requestKeys.get(operation) ?? sessionStorage.getItem(operation);
    } catch {
      return this.requestKeys.get(operation);
    }
  }

  private saveKey(operation: string, key?: string) {
    if (key) this.requestKeys.set(operation, key);
    else this.requestKeys.delete(operation);
    try {
      if (key) sessionStorage.setItem(operation, key);
      else sessionStorage.removeItem(operation);
    } catch {
      // Storage can be disabled. In-page retries still reuse the key.
    }
  }

  private async request<T>(path: string, body?: string, signal?: AbortSignal, requestKey?: string): Promise<T> {
    const headers = new Headers({ Authorization: 'Bearer ' + this.token });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (requestKey) headers.set('Idempotency-Key', requestKey);
    const response = await fetch(this.path + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body,
      signal,
      cache: 'no-store',
    });
    if (!response.ok) {
      const fallback = response.status === 401 ? 'Access token is invalid.' : 'The whiteboard request failed.';
      const error = await response.json().catch(() => ({})) as { code?: string; message?: string };
      throw new APIError(response.status, error.code, error.message || fallback);
    }
    return parseExactJSON(
      await response.text(),
      'This browser cannot open whiteboards with exact JSON numbers. Update your browser and try again.',
    ) as T;
  }
}
