import { numberText, type BoardEvent, type Entry, type Payload } from './api';

export type Lane = 'available' | 'taken' | 'result';

export interface TaskRef {
  id: string;
  issue: string;
}

export interface TaskIssues {
  byTask: ReadonlyMap<string, string | null>;
  byEntry: ReadonlyMap<string, TaskRef>;
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
  if (typeof payload.issue === 'string') return payload.issue;
  const number = numberText(payload.issue);
  return number ? normalizedIssueNumber(number) : '';
}

function normalizedIssueNumber(number: string): string {
  const sign = number.startsWith('-') ? '-' : '';
  const [mantissa = '', exponent = ''] = number.slice(sign.length).split(/[eE]/);
  const [whole = '', fraction = ''] = mantissa.split('.');
  const digits = (whole + fraction).replace(/^0+/, '');
  if (!digits) return '0';
  let end = digits.length;
  while (digits[end - 1] === '0') end--;
  const significant = sign + digits.slice(0, end);
  const power = shiftExponent(exponent, digits.length - end - fraction.length);

  // Keep ordinary integer issue numbers readable without expanding large exponents.
  if (power.length <= 2) {
    const zeros = Number(power);
    if (zeros >= 0 && zeros <= 20) return significant + '0'.repeat(zeros);
  }
  return significant + 'e' + power;
}

function shiftExponent(exponent: string, offset: number): string {
  const negative = exponent.startsWith('-');
  const digits = exponent.replace(/^[+-]?0*/, '');
  if (digits.length <= 9) return String((negative ? -1 : 1) * Number(digits) + offset);

  if (negative) offset = -offset;
  const suffix: string[] = [];
  let end = digits.length;
  while (end > 0 && offset !== 0) {
    const value = Number(digits[--end]) + offset;
    const digit = (value % 10 + 10) % 10;
    suffix.push(String(digit));
    offset = (value - digit) / 10;
  }
  const adjusted = digits.slice(0, end) + suffix.reverse().join('');
  const magnitude = offset > 0 ? '1' + adjusted : adjusted.replace(/^0+/, '');
  return negative ? '-' + magnitude : magnitude;
}

export function issueLabel(issue: string): string {
  return /^\d+$/.test(issue) ? '#' + issue : issue;
}

function taskOf(payload: Payload): TaskRef | undefined {
  if (typeof payload.task !== 'string' || !payload.task.trim()) return;
  return { id: payload.task, issue: issueOf(payload) };
}

export function collectTaskIssues(events: BoardEvent[]): TaskIssues {
  const issues = new Map<string, string | null>();
  const work = new Map<string, TaskRef>();
  function track(entry: Entry) {
    if (entry.payload.kind !== 'work') return;
    const ref = taskOf(entry.payload);
    if (!ref) return;
    const previous = issues.get(ref.id);
    issues.set(ref.id, previous === undefined || previous === ref.issue ? ref.issue : null);
    work.set(entry.id, ref);
  }
  for (const { entry } of events) track(entry);
  return { byTask: issues, byEntry: work };
}

export function relatedIssue(payload: Payload, taskIssues: TaskIssues): string | null {
  const issue = issueOf(payload);
  if (issue || payload.kind === 'work' || typeof payload.task !== 'string') return issue;
  if (payload.kind === 'result' && typeof payload.sourceEntryId === 'string') {
    const source = taskIssues.byEntry.get(payload.sourceEntryId);
    if (source?.id === payload.task) return source.issue;
  }
  const taskIssue = taskIssues.byTask.get(payload.task);
  return taskIssue === undefined ? '' : taskIssue;
}

export function matchesTask(payload: Payload, task: TaskRef, taskIssues: TaskIssues): boolean {
  return payload.task === task.id && relatedIssue(payload, taskIssues) === task.issue;
}

function taskKey(ref: TaskRef): string {
  return JSON.stringify([ref.issue, ref.id]);
}

export function taskCards(events: BoardEvent[], taskIssues: TaskIssues): TaskCard[] {
  const liveWork = new Map<string, Entry>();
  const historicalWork = new Map<string, Entry>();
  const posts = new Map<string, PositionedEvent>();
  const takes = new Map<string, BoardEvent>();
  const legacyResults = new Map<string, PositionedEvent>();
  const linkedResults = new Map<string, PositionedEvent>();

  for (const event of events) {
    const { entry, operation } = event;
    if (operation === 'take') takes.set(entry.id, event);
  }
  // History is newest first, including within a timestamp.
  for (const [index, event] of events.entries()) {
    const { entry } = event;
    if (event.operation === 'take') continue;
    posts.set(entry.id, { event, index });
    const ref = taskOf(entry.payload);
    if (!ref) continue;
    const key = taskKey(ref);
    if (entry.payload.kind === 'work') {
      if (!historicalWork.has(key)) historicalWork.set(key, entry);
      const live = liveWork.get(key);
      if (!takes.has(entry.id) && (!live || BigInt(entry.id) > BigInt(live.id))) liveWork.set(key, entry);
    }
    if (entry.payload.kind === 'result') {
      const source = entry.payload.sourceEntryId;
      if (typeof source === 'string' && source) {
        const work = taskIssues.byEntry.get(source);
        const issue = issueOf(entry.payload);
        if (work?.id === ref.id && (!issue || issue === work.issue) && !linkedResults.has(source)) {
          linkedResults.set(source, { event, index });
        }
        continue;
      }
      const issue = relatedIssue(entry.payload, taskIssues);
      if (issue === null) continue;
      const resultKey = taskKey({ id: ref.id, issue });
      if (!legacyResults.has(resultKey)) legacyResults.set(resultKey, { event, index });
    }
  }

  const work = new Map([...historicalWork, ...liveWork]);
  const cards: TaskCard[] = [];
  for (const [key, entry] of work) {
    const ref = taskOf(entry.payload)!;
    const posted = posts.get(entry.id);
    const taken = takes.get(entry.id);
    let result = linkedResults.get(entry.id);
    const legacy = legacyResults.get(key);
    if (legacy && (!result || legacy.index < result.index)) result = legacy;

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
