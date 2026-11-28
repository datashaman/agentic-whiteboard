import { APIError, type Board, type Whiteboard, type BoardEvent, type Entry, type Permission } from './api';
import { collectTaskIssues, issueOf, matchesTask, relatedIssue, taskCards, type TaskRef } from './tasks';

export type View = 'tasks' | 'entries' | 'activity';
type TaskFilter = 'open' | 'result';
export type ActivityFocus = { entryId: string; operation?: BoardEvent['operation'] };
export type ViewAction =
  | { type: 'view'; view: View; task?: TaskRef }
  | { type: 'issue'; issue: string }
  | { type: 'pattern'; pattern: string }
  | { type: 'filter'; filter: TaskFilter }
  | { type: 'page'; direction: 'previous' | 'next' }
  | { type: 'latest-activity' }
  | { type: 'focus'; focus: ActivityFocus };

interface Selection {
  view: View;
  issue: string;
  task?: TaskRef;
  filter: TaskFilter;
  pattern: string;
  pages: readonly string[];
  focus?: ActivityFocus;
}

interface ViewData {
  issues: string[];
  entries: Entry[];
  events: BoardEvent[];
  cards: ReturnType<typeof taskCards>;
  nextCursor?: string;
  focused?: BoardEvent;
  activityHead?: string;
}

type BoardReader = Pick<Whiteboard, 'details' | 'browse' | 'history' | 'overview'>;
type HistoryPage = Awaited<ReturnType<BoardReader['history']>>;

function activityHead(page: HistoryPage) {
  return page.events.map(event => event.id).join(',');
}

export class BoardView {
  private selection: Selection;
  private loaded?: { scope: number; data: ViewData };
  private scope = 0;
  private request?: AbortController;
  private access: Board;
  private issueOptions: string[] = [];
  private activityHead?: string;
  private activityPending = false;

  constructor(private readonly reader: BoardReader, board: Board) {
    this.access = board;
    this.selection = {
      view: board.permissions.includes('read') ? 'tasks' : 'entries',
      issue: '', pattern: '{}', filter: 'open', pages: [],
    };
  }

  get current(): Readonly<Selection> { return this.selection; }
  get board(): Readonly<Board> { return this.access; }
  get issues(): readonly string[] { return this.issueOptions; }
  get loading() { return Boolean(this.request); }
  get hasNewActivity() { return this.activityPending; }
  get data(): Readonly<ViewData> | undefined {
    return this.loaded?.scope === this.scope ? this.loaded.data : undefined;
  }

  get focusedRecord(): BoardEvent | undefined {
    const { focus } = this.selection;
    const event = this.data?.focused;
    if (event && focus && event.entry.id === focus.entryId && (!focus.operation || event.operation === focus.operation)) return event;
  }

  get activity(): readonly BoardEvent[] {
    const events = this.data?.events ?? [];
    const focus = this.focusedRecord;
    return focus && !events.some(event => event.id === focus.id) ? [focus, ...events] : events;
  }

  can(permission: Permission) {
    return this.board.permissions.includes(permission) && (permission === 'read' || !this.board.archived);
  }

  select(action: ViewAction): boolean {
    const current = this.selection;
    switch (action.type) {
      case 'filter':
        this.selection = { ...current, filter: action.filter };
        return false;
      case 'view':
        this.selection = {
          ...current, view: action.view, task: action.task, pages: [], focus: undefined,
          pattern: action.task ? '{}' : current.pattern,
        };
        break;
      case 'issue': {
        const task = current.task && (!action.issue || current.task.issue === action.issue) ? current.task : undefined;
        this.selection = { ...current, issue: action.issue, task, pages: [], focus: undefined };
        if (current.view === 'tasks') return false;
        break;
      }
      case 'pattern':
        this.selection = { ...current, pattern: action.pattern, pages: [], focus: undefined };
        if (action.pattern === current.pattern && !current.pages.length) return true;
        break;
      case 'page': {
        const next = this.data?.nextCursor;
        if (action.direction === 'next' && !next) return false;
        if (action.direction === 'previous' && !current.pages.length) return false;
        const pages = action.direction === 'next' && next ? [...current.pages, next] : current.pages.slice(0, -1);
        this.selection = { ...current, pages, focus: undefined };
        break;
      }
      case 'latest-activity':
        if (!current.pages.length) return true;
        this.selection = { ...current, pages: [] };
        break;
      case 'focus':
        this.selection = {
          ...current, view: 'activity', task: undefined, focus: action.focus,
          pages: current.view === 'activity' ? current.pages : [],
        };
        if (current.view === 'activity') return true;
        break;
    }
    this.scope++;
    return true;
  }

  dismissFocus() {
    if (this.selection.focus) this.selection = { ...this.selection, focus: undefined };
  }

  cancel() {
    this.request?.abort();
    this.request = undefined;
  }

  async checkActivity(signal: AbortSignal, canApply: () => boolean): Promise<boolean> {
    const selection = this.selection;
    if (selection.view !== 'activity' || !this.data || this.loading || this.activityHead === undefined) return false;
    const displayed = this.loaded;
    const stillCurrent = () => !signal.aborted && this.selection === selection && this.loaded === displayed && !this.loading;
    const canUpdate = () => !selection.pages.length && !this.activityPending && canApply();

    const page = await this.reader.history({ summary: true, signal });
    if (!stillCurrent() || activityHead(page) === this.activityHead) return false;
    if (canUpdate()) {
      const data = await this.load(selection, signal, page);
      if (!stillCurrent()) return false;
      if (canUpdate()) {
        this.apply(this.scope, data);
        return true;
      }
    }
    this.activityPending = true;
    return false;
  }

  async refresh(changed: () => void) {
    this.cancel();
    const request = new AbortController();
    this.request = request;
    const { signal } = request;
    const scope = this.scope;
    const selection = this.selection;
    changed();
    try {
      const board = this.reader.details({ signal }).then(access => {
        if (signal.aborted) return;
        const archived = this.board.archived;
        this.access = access;
        if (archived !== access.archived) changed();
      });
      const data = this.can('read') ? this.load(selection, signal) : undefined;
      const [access, result] = await Promise.allSettled([board, data]);
      if (signal.aborted) return;
      if (result.status === 'rejected' && result.reason instanceof APIError && result.reason.status === 401) {
        throw result.reason;
      }
      if (access.status === 'rejected') throw access.reason;
      if (result.status === 'rejected') throw result.reason;
      if (result.value) this.apply(scope, result.value);
    } finally {
      if (this.request === request) {
        this.request = undefined;
        changed();
      }
    }
  }

  private apply(scope: number, data: ViewData) {
    this.loaded = { scope, data };
    this.issueOptions = data.issues;
    if (data.activityHead !== undefined) {
      this.activityHead = data.activityHead;
      this.activityPending = false;
    }
  }

  private async load(selection: Readonly<Selection>, signal: AbortSignal, firstPage?: HistoryPage): Promise<ViewData> {
    const { view, pages, focus, issue, task, pattern } = selection;
    const cursor = pages.at(-1);
    const [overview, initialLive, initialHistory, focused] = await Promise.all([
      this.reader.overview({ tasks: view === 'tasks', signal }),
      view === 'entries' ? this.reader.browse(pattern, { cursor, summary: true, signal }) : undefined,
      view === 'activity' ? firstPage ?? this.reader.history({ cursor, summary: true, signal }) : undefined,
      focus ? this.reader.history({ entryId: focus.entryId, summary: true, signal }) : undefined,
    ]);
    const taskIssues = collectTaskIssues(overview.events);
    const accepts = ({ payload }: Entry) =>
      (!issue || relatedIssue(payload, taskIssues) === issue) && (!task || matchesTask(payload, task, taskIssues));
    let live = initialLive;
    let history = initialHistory;
    while (live?.nextCursor && !live.entries.some(accepts)) {
      signal.throwIfAborted();
      live = await this.reader.browse(pattern, { cursor: live.nextCursor, summary: true, signal });
    }
    while (history?.nextCursor && !history.events.some(event => accepts(event.entry))) {
      signal.throwIfAborted();
      history = await this.reader.history({ cursor: history.nextCursor, summary: true, signal });
    }
    const entryEvents = focused?.events ?? [];
    return {
      issues: overview.issues.map(value => issueOf({ issue: value })),
      entries: live?.entries.filter(accepts) ?? [],
      events: history?.events.filter(event => accepts(event.entry)) ?? [],
      cards: view === 'tasks' ? taskCards(overview.events, taskIssues) : [],
      nextCursor: live?.nextCursor ?? history?.nextCursor,
      activityHead: initialHistory && !cursor ? activityHead(initialHistory) : undefined,
      focused: focus?.operation
        ? entryEvents.find(event => event.operation === focus.operation)
        : entryEvents.find(event => event.operation === 'take') ?? entryEvents[0],
    };
  }
}
