import { numberText, type BoardEvent, type Entry, type Payload } from './api';

export type Lane = 'available' | 'taken' | 'result';

export interface TaskRef {
  id: string;
  issue: string;
}

interface TaskCard {
  ref: TaskRef;
  entry: Entry;
  lane: Lane;
  attribution: string;
}

interface PositionedEvent {
  event: BoardEvent;
  index: number;
}

export function issueOf(payload: Payload): string {
  return typeof payload.issue === 'string' ? payload.issue : numberText(payload.issue);
}

export function issueLabel(issue: string): string {
  return /^\d+$/.test(issue) ? '#' + issue : issue;
}

export function taskOf(payload: Payload): TaskRef | undefined {
  if (typeof payload.task !== 'string' || !payload.task.trim()) return;
  return { id: payload.task, issue: issueOf(payload) };
}

export function matchesTask(payload: Payload, task: TaskRef): boolean {
  const entryIssue = issueOf(payload);
  return payload.task === task.id && (!entryIssue || entryIssue === task.issue);
}

function taskKey(ref: TaskRef): string {
  return JSON.stringify([ref.issue, ref.id]);
}

export function taskCards(entries: Entry[], events: BoardEvent[]): TaskCard[] {
  const liveWork = new Map<string, Entry>();
  const historicalWork = new Map<string, Entry>();
  const posts = new Map<string, PositionedEvent>();
  const takes = new Map<string, BoardEvent>();
  const results = new Map<string, PositionedEvent>();

  // Browse is oldest first. History is newest first, including within a timestamp.
  for (const entry of entries) {
    const ref = taskOf(entry.payload);
    if (ref && entry.payload.kind === 'work') liveWork.set(taskKey(ref), entry);
  }
  for (const [index, event] of events.entries()) {
    const { entry } = event;
    if (event.operation === 'take') {
      takes.set(entry.id, event);
      continue;
    }
    posts.set(entry.id, { event, index });
    const ref = taskOf(entry.payload);
    if (!ref) continue;
    const key = taskKey(ref);
    if (entry.payload.kind === 'work' && !historicalWork.has(key)) historicalWork.set(key, entry);
    if (entry.payload.kind === 'result' && !results.has(key)) results.set(key, { event, index });
  }

  const work = new Map([...historicalWork, ...liveWork]);
  const taskOccurrences = new Map<string, number>();
  for (const entry of work.values()) {
    const { id } = taskOf(entry.payload)!;
    taskOccurrences.set(id, (taskOccurrences.get(id) ?? 0) + 1);
  }

  const cards: TaskCard[] = [];
  for (const [key, entry] of work) {
    const ref = taskOf(entry.payload)!;
    const posted = posts.get(entry.id);
    const taken = takes.get(entry.id);
    const scoped = results.get(key);
    const unscoped = taskOccurrences.get(ref.id) === 1
      ? results.get(taskKey({ id: ref.id, issue: '' }))
      : undefined;
    const result = (scoped?.index ?? Infinity) < (unscoped?.index ?? Infinity) ? scoped : unscoped;

    if (liveWork.has(key)) {
      cards.push({ ref, entry, lane: 'available', attribution: posted ? 'Posted by ' + posted.event.actor : 'Ready to take' });
    } else if (posted && result && result.index < posted.index) {
      cards.push({ ref, entry, lane: 'result', attribution: 'Result by ' + result.event.actor });
    } else if (taken) {
      cards.push({ ref, entry, lane: 'taken', attribution: 'Taken by ' + taken.actor });
    }
  }
  return cards;
}
