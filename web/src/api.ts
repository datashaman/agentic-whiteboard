export type Permission = 'post' | 'read' | 'take';
export type Payload = Record<string, unknown>;

export interface Board {
  id: string;
  name: string;
  actor: string;
  permissions: Permission[];
}

export interface Entry {
  id: string;
  payload: Payload;
  postedAt: string;
}

export interface BoardEvent {
  id: string;
  operation: 'post' | 'take';
  actor: string;
  at: string;
  entry: Entry;
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

interface RawNumber { readonly rawJSON: string }

const losslessJSON = JSON as JSON & {
  rawJSON?: (source: string) => RawNumber;
  isRawJSON?: (value: unknown) => value is RawNumber;
};

export function numberText(value: unknown): string {
  return losslessJSON.isRawJSON?.(value) ? value.rawJSON : '';
}

function parseResponse(text: string): unknown {
  const rawJSON = losslessJSON.rawJSON;
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== 'number') return value;
    // PostgreSQL numbers can exceed JavaScript's precision, including in recovered entries.
    if (!rawJSON || !losslessJSON.isRawJSON || context?.source === undefined) {
      throw new Error('This browser cannot open whiteboards with exact JSON numbers. Update your browser and try again.');
    }
    return rawJSON(context.source);
  });
}

export class BoardAPI {
  private readonly path: string;
  private readonly requestKeys = new Map<string, string>();

  constructor(slug: string, private readonly token: string) {
    this.path = '/api/boards/' + encodeURIComponent(slug);
  }

  board() {
    return this.request<Board>('');
  }

  browse(pattern: string, signal: AbortSignal) {
    return this.request<{ entries: Entry[] }>('/browse', '{"pattern":' + pattern + '}', signal);
  }

  history(signal?: AbortSignal) {
    return this.request<{ events: BoardEvent[] }>('/history', undefined, signal);
  }

  post(payload: string, action: string) {
    return this.mutate('/entries', '{"payload":' + payload + '}', action);
  }

  take(entryId: string) {
    return this.mutate('/take', JSON.stringify({ entryId }), 'take');
  }

  private async mutate(path: string, body: string, action: string) {
    // Reuse the request ID when retrying a mutation with an unknown outcome.
    const operation = action + '\n' + body;
    const key = this.requestKeys.get(operation) ?? crypto.randomUUID();
    this.requestKeys.set(operation, key);
    try {
      const entry = await this.request<Entry>(path, body, undefined, key);
      this.requestKeys.delete(operation);
      return entry;
    } catch (error) {
      if (error instanceof APIError && error.status < 500) this.requestKeys.delete(operation);
      throw error;
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
    return parseResponse(await response.text()) as T;
  }
}
