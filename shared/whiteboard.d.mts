export { numberText } from './exact-json.mjs';

export type Permission = 'post' | 'read' | 'take';
export type Payload = Record<string, unknown>;
/** JSON object text, or a value to serialize. Pass text to keep numbers exactly as typed. */
export type JSONObject = string | Payload;

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

export interface EntryPage { entries: Entry[]; nextCursor?: string }
export interface EventPage { events: BoardEvent[]; nextCursor?: string }

/** Stores Idempotency-Keys for requests whose outcome is still unknown. */
export interface KeyStore {
  get(operation: string): string | null | undefined;
  set(operation: string, key: string): void;
  delete(operation: string): void;
}

export interface Options {
  /** Defaults to memory. Persist keys to retry safely across restarts. */
  keys?: KeyStore;
  fetch?: typeof fetch;
  /** Per request, added to any waitMs. Defaults to 15 seconds. */
  timeoutMs?: number;
}

export interface MutationOptions {
  /** Idempotency-Key to use instead of the stored or generated one. */
  key?: string;
  /** Separates identical requests made for different reasons. */
  action?: string;
  signal?: AbortSignal;
}

export class APIError extends Error {
  constructor(status: number, code: string | undefined, message: string);
  readonly status: number;
  readonly code: string | undefined;
}

export function jsonObject(input: string): string;

export function createBoard(
  server: string,
  token: string,
  details: { slug: string; name: string; actor: string },
  options?: Options & { signal?: AbortSignal },
): Promise<{ id: string; tokenId: string; token: string }>;

export class Whiteboard {
  /** Board API URL, such as https://whiteboard.example.com/api/boards/demo, or a path in a browser. */
  constructor(url: string, token: string, options?: Options);
  readonly url: string;
  details(options?: { signal?: AbortSignal }): Promise<Board>;
  post(payload: JSONObject, options?: MutationOptions & { expiresAt?: string }): Promise<Entry>;
  /** Resolves null when nothing matches within waitMs. */
  take(target: { pattern: JSONObject; waitMs?: number } | { entryId: string }, options?: MutationOptions): Promise<Entry | null>;
  repost(entryId: string, options?: MutationOptions): Promise<Entry>;
  /** Resolves null when nothing matches within waitMs. */
  read(pattern: JSONObject, options?: { waitMs?: number; signal?: AbortSignal }): Promise<Entry | null>;
  browse(pattern: JSONObject, options?: { cursor?: string; summary?: boolean; signal?: AbortSignal }): Promise<EntryPage>;
  history(options?: { cursor?: string; entryId?: string; summary?: boolean; signal?: AbortSignal }): Promise<EventPage>;
  /** Includes entries already taken. */
  entry(id: string, options?: { signal?: AbortSignal }): Promise<Entry>;
  overview(options?: { tasks?: boolean; signal?: AbortSignal }): Promise<Overview>;
}
