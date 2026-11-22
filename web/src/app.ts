import {
  APIError, BoardAPI, jsonObject,
  type Board, type BoardEvent, type Entry, type Payload, type Permission,
} from './api';
import {
  collectTaskIssues, issueLabel, issueOf, matchesTask, relatedIssue, taskCards,
  type TaskIssues, type TaskRef,
} from './tasks';

type View = 'tasks' | 'entries' | 'activity';

interface Session {
  api: BoardAPI;
  board: Board;
  view: View;
  issue: string;
  task?: TaskRef;
  pattern: string;
  entries: Entry[];
  events: BoardEvent[];
  taskEvents: BoardEvent[];
  issues: unknown[];
  taskIssues: TaskIssues;
  pages: string[];
  nextCursor?: string;
  disclosure?: AbortController;
  refresh?: AbortController;
  loaded: boolean;
  mutating: boolean;
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error('Missing element: ' + id);
  return found as T;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const result = document.createElement(tag);
  result.className = className;
  result.textContent = text;
  return result;
}

function button(label: string, action: (button: HTMLButtonElement) => void, className = '') {
  const result = node('button', className, label);
  result.type = 'button';
  result.onclick = () => action(result);
  return result;
}

function message(target: HTMLElement, value = '') {
  target.textContent = value;
  target.hidden = value === '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The whiteboard request failed.';
}

const login = element('login');
const loginForm = element<HTMLFormElement>('login-form');
const loginError = element('login-error');
const slugInput = element<HTMLInputElement>('slug');
const tokenInput = element<HTMLInputElement>('token');
const workspace = element('workspace');
const boardName = element('board-name');
const sessionBar = element('session');
const status = element('board-status');
const boardError = element('board-error');
const refreshButton = element<HTMLButtonElement>('refresh');
const browseButton = element<HTMLButtonElement>('browse');
const postButton = element<HTMLButtonElement>('open-composer');
const takeId = element<HTMLInputElement>('entry-id');
const issue = element<HTMLSelectElement>('issue');
const viewButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('nav [data-view]'));
const lanes = Array.from(document.querySelectorAll<HTMLElement>('[data-lane]'));
const entryList = element('entry-list');
const eventList = element('event-list');
const pattern = element<HTMLTextAreaElement>('pattern');
const composer = element<HTMLDialogElement>('composer');
const postError = element('post-error');
const payloadEditor = element<HTMLTextAreaElement>('payload');
const takenEntry = element<HTMLDialogElement>('taken-entry');
const takenPayload = element('taken-payload');
const takenLinks = element('taken-links');
const clockFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

let active: Session | undefined;

function has(session: Session, permission: Permission) {
  return session.board.permissions.includes(permission);
}

function announce(success = '', failure = '') {
  message(status, success);
  message(boardError, failure);
}

function disconnect(reason = '') {
  active?.refresh?.abort();
  active?.disclosure?.abort();
  active = undefined;
  workspace.hidden = true;
  sessionBar.hidden = true;
  login.hidden = false;
  composer.close();
  takenEntry.close();
  entryList.replaceChildren();
  eventList.replaceChildren();
  for (const lane of lanes) lane.querySelector('.cards')!.replaceChildren();
  payloadEditor.value = '{}';
  takenPayload.textContent = '';
  takenLinks.replaceChildren();
  takenLinks.hidden = true;
  takeId.value = '';
  document.title = 'Agentic Whiteboard';
  announce();
  message(loginError, reason);
  tokenInput.focus();
}

function report(session: Session, error: unknown, target = boardError) {
  if (active !== session) return;
  if (error instanceof APIError && error.status === 401) {
    disconnect(error.message);
  } else {
    message(target, errorMessage(error));
  }
}

function refreshIssueOptions(session: Session) {
  const values = new Set<string>(session.issue ? [session.issue] : []);
  for (const value of session.issues) values.add(issueOf({ issue: value }));
  values.delete('');
  issue.replaceChildren(
    new Option('All issues', ''),
    ...Array.from(values).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map(value => new Option(issueLabel(value), value)),
  );
  issue.value = session.issue;
}

function matchesIssue(payload: Payload, issue: string, taskIssues: TaskIssues) {
  return issue === '' || relatedIssue(payload, taskIssues) === issue;
}

function inIssue(session: Session, entry: Entry) {
  return matchesIssue(entry.payload, session.issue, session.taskIssues);
}

function titleOf(entry: Entry): string {
  const { title, task } = entry.payload;
  if (typeof title === 'string' && title.trim()) return title;
  if (typeof task === 'string' && task.trim()) return task;
  return 'Entry ' + entry.id;
}

function tag(text: string, isIssue = false) {
  return node('span', isIssue ? 'tag issue-tag' : 'tag', text);
}

function renderTasks(session: Session) {
  const visible = session.view === 'tasks';
  const cards = visible && session.loaded ? taskCards(session.taskEvents, session.taskIssues) : [];
  for (const lane of lanes) {
    const container = lane.querySelector('.cards')!;
    const count = lane.querySelector('.count')!;
    container.replaceChildren();
    if (!visible) continue;
    const matches = cards.filter(card => card.lane === lane.dataset.lane && inIssue(session, card.entry));
    count.textContent = String(matches.length);
    count.setAttribute('aria-label', matches.length + ' tasks');
    if (!matches.length) {
      const empty = session.loaded ? 'No tasks' : session.refresh ? 'Loading tasks…' : 'Tasks unavailable';
      container.append(node('p', 'empty', empty));
    }
    for (const card of matches) {
      const control = button('', () => {
        session.task = card.ref;
        session.pattern = pattern.value = '{}';
        void showView(session, 'entries', true);
        viewButtons.find(item => item.dataset.view === 'entries')?.focus();
      }, 'task-card');
      const title = titleOf(card.entry);
      control.setAttribute('aria-label', title);
      const keys = node('span', 'task-key');
      if (card.ref.issue) keys.append(tag(issueLabel(card.ref.issue), true));
      keys.append(tag(card.ref.id));
      control.append(keys, node('strong', '', title), node('span', 'attribution', card.attribution));
      container.append(control);
    }
  }
}

function timestamp(iso: string) {
  const time = node('time');
  time.dateTime = iso;
  time.title = iso;
  const date = new Date(iso);
  time.textContent = Number.isNaN(date.valueOf()) ? iso : clockFormat.format(date);
  return time;
}

function renderPayload(raw: HTMLElement, links: HTMLElement, payload: Payload) {
  const urls = new Set<string>();
  raw.textContent = JSON.stringify(payload, (_key, value: unknown) => {
    if (typeof value === 'string' && /^https:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if (!url.username && !url.password) urls.add(url.href);
      } catch {
        // Malformed URLs stay visible as text.
      }
    }
    return value;
  }, 2);
  const items = document.createDocumentFragment();
  for (const url of urls) {
    const link = node('a', '', 'Open ' + url);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const item = node('li');
    item.append(link);
    items.append(item);
  }
  links.replaceChildren(items);
  links.hidden = urls.size === 0;
}

function record(session: Session, entry: Entry, openId: string | undefined,
  action?: (full: Entry) => HTMLButtonElement, event?: BoardEvent) {
  const details = node('details', 'record');
  details.dataset.id = event?.id ?? entry.id;
  details.name = event ? 'activity-record' : 'live-record';
  const summary = node('summary');
  const label = node('span', 'summary-label');
  if (event) {
    label.append(
      node('strong', 'event-actor', event.actor),
      node('span', 'event-verb', event.operation === 'take' ? 'took' : 'posted'),
    );
  }
  label.append(node('strong', 'record-title', titleOf(entry)));
  if (typeof entry.payload.kind === 'string') label.append(tag(entry.payload.kind));
  const meta = node('span', 'summary-meta');
  const issueKey = issueOf(entry.payload);
  if (issueKey) meta.append(tag(issueLabel(issueKey), true));
  meta.append(tag('ID ' + entry.id), timestamp(event?.at ?? entry.postedAt));
  summary.append(label, meta);
  details.append(summary);

  const body = node('div', 'record-body');
  let request: AbortController | undefined;
  let full: Entry | undefined;
  function showPayload(payload: Entry) {
    const raw = node('pre');
    raw.setAttribute('aria-label', 'Entry JSON');
    const links = node('ul', 'entry-links');
    renderPayload(raw, links, payload.payload);
    body.replaceChildren(raw, links);
    if (action) body.append(action(payload));
  }
  function syncDisclosure() {
    if (!details.open) {
      request?.abort();
      request = undefined;
      body.remove();
      return;
    }
    if (body.parentElement) return;
    details.append(body);
    if (full) {
      showPayload(full);
      return;
    }
    session.disclosure?.abort();
    const load = new AbortController();
    request = session.disclosure = load;
    const loading = node('p', '', 'Loading entry…');
    loading.setAttribute('role', 'status');
    body.replaceChildren(loading);
    void session.api.entry(entry.id, load.signal).then(payload => {
      if (load.signal.aborted || !details.open) return;
      full = payload;
      showPayload(payload);
    }).catch(error => {
      if (load.signal.aborted) return;
      if (error instanceof APIError && error.status === 401) report(session, error);
      else loading.textContent = errorMessage(error);
    });
  }
  details.ontoggle = syncDisclosure;
  details.open = details.dataset.id === openId;
  syncDisclosure();
  return details;
}

function renderRecords(session: Session, takenId?: string) {
  const list = session.view === 'activity' ? eventList : entryList;
  const restoreFocus = list.contains(document.activeElement);
  const openId = list.querySelector<HTMLElement>('details[open]')?.dataset.id;
  session.disclosure?.abort();
  entryList.replaceChildren();
  eventList.replaceChildren();
  if (session.view === 'tasks' || !has(session, 'read')) return;

  if (!session.loaded) {
    list.append(node('p', 'empty', session.refresh ? 'Loading entries…' : 'Entries unavailable'));
    return;
  }

  if (session.view === 'activity') {
    const events = session.events.filter(event => inIssue(session, event.entry) ||
      (event.operation === 'take' && event.entry.id === takenId));
    const selected = takenId ? events.find(event => event.operation === 'take' && event.entry.id === takenId)?.id : openId;
    for (const event of events) {
      const action = event.operation === 'take' && has(session, 'post')
        ? (full: Entry) => button('Repost', control => void repost(session, { ...event, entry: full }, control))
        : undefined;
      list.append(record(session, event.entry, selected, action, event));
    }
    if (!events.length) list.append(node('p', 'empty', 'No activity for this selection on this page.'));
  } else {
    const entries = session.entries.filter(entry =>
      inIssue(session, entry) && (!session.task || matchesTask(entry.payload, session.task, session.taskIssues)),
    );
    for (const entry of entries) {
      const action = has(session, 'take')
        ? () => button('Take', control => void take(session, entry.id, control))
        : undefined;
      list.append(record(session, entry, openId, action));
    }
    if (!entries.length) list.append(node('p', 'empty', 'No live entries match this selection on this page.'));
  }

  if (session.pages.length || session.nextCursor) {
    const pages = node('div', 'record-pages');
    const previous = button('Previous page', () => void refresh(session, undefined, session.pages.slice(0, -1)));
    previous.disabled = Boolean(session.refresh) || !session.pages.length;
    const next = button('Next page', () => {
      if (session.nextCursor) void refresh(session, undefined, [...session.pages, session.nextCursor]);
    });
    next.disabled = Boolean(session.refresh) || !session.nextCursor;
    pages.append(previous, node('span', '', 'Page ' + (session.pages.length + 1)), next);
    list.append(pages);
  }
  if (restoreFocus || takenId) list.querySelector<HTMLElement>('details[open] > summary')?.focus();
}

function render(session: Session, takenId?: string) {
  const read = has(session, 'read');
  const view = read || has(session, 'take') ? session.view : undefined;
  element('view-bar').hidden = !view;
  for (const item of viewButtons) {
    item.hidden = !read && item.dataset.view !== 'entries';
    item.setAttribute('aria-pressed', String(item.dataset.view === view));
    element(item.dataset.view!).hidden = item.dataset.view !== view;
  }
  element('issue-filter').hidden = !read;
  element('post-access').hidden = Boolean(view);
  element('browse-form').hidden = !read;
  element('take-form').hidden = read;
  element('task-scope').hidden = !session.task;
  element('task-scope-id').textContent = session.task?.id ?? '';
  postButton.hidden = !has(session, 'post');
  renderTasks(session);
  renderRecords(session, takenId);
}

function showView(session: Session, view: View, keepTask = false) {
  session.view = view;
  if (!keepTask) session.task = undefined;
  announce();
  session.loaded = false;
  const pending = refresh(session);
  render(session);
  return pending;
}

async function refresh(session: Session, takenId?: string, pages: string[] = []) {
  session.refresh?.abort();
  const request = new AbortController();
  session.refresh = request;
  refreshButton.disabled = true;
  browseButton.disabled = true;
  workspace.setAttribute('aria-busy', 'true');
  const view = session.view;
  const cursor = pages.at(-1);
  const selectedIssue = session.issue;
  const selectedTask = session.task;
  const requestedPattern = session.pattern;
  try {
    if (has(session, 'read')) {
      let [overview, live, history, focused] = await Promise.all([
        session.api.overview(view === 'tasks', request.signal),
        view === 'entries' ? session.api.browse(requestedPattern, request.signal, cursor) : undefined,
        view === 'activity' ? session.api.history(request.signal, cursor) : undefined,
        takenId ? session.api.history(request.signal, undefined, takenId) : undefined,
      ]);
      const taskIssues = collectTaskIssues(overview.events);
      // A scoped view can skip pages of unrelated summaries.
      if (selectedIssue || selectedTask) {
        const accepts = ({ payload }: Entry) => matchesIssue(payload, selectedIssue, taskIssues)
          && (!selectedTask || matchesTask(payload, selectedTask, taskIssues));
        while (live?.nextCursor && !live.entries.some(accepts)) {
          live = await session.api.browse(requestedPattern, request.signal, live.nextCursor);
        }
        while (!takenId && history?.nextCursor && !history.events.some(event => accepts(event.entry))) {
          history = await session.api.history(request.signal, history.nextCursor);
        }
      }
      if (active !== session || request.signal.aborted) return;
      session.events = history?.events ?? [];
      const take = focused?.events.find(event => event.operation === 'take');
      if (take && !session.events.some(event => event.id === take.id)) session.events.unshift(take);
      session.entries = live?.entries ?? [];
      session.taskEvents = overview.events;
      session.issues = overview.issues;
      session.taskIssues = taskIssues;
      session.pages = pages;
      session.nextCursor = live?.nextCursor ?? history?.nextCursor;
      refreshIssueOptions(session);
    } else {
      await session.api.board();
      if (active !== session || request.signal.aborted) return;
    }
    session.loaded = true;
  } catch (error) {
    if (!request.signal.aborted) report(session, error);
  } finally {
    if (active === session && session.refresh === request) {
      session.refresh = undefined;
      refreshButton.disabled = false;
      browseButton.disabled = false;
      workspace.removeAttribute('aria-busy');
      render(session, takenId);
    }
  }
}

async function mutate(session: Session, control: HTMLButtonElement, action: () => Promise<void>) {
  if (session.mutating) return;
  session.mutating = true;
  control.disabled = true;
  announce();
  try {
    await action();
  } finally {
    session.mutating = false;
    control.disabled = false;
  }
}

async function take(session: Session, entryId: string, control: HTMLButtonElement) {
  await mutate(session, control, async () => {
    let entry: Entry;
    try {
      entry = await session.api.take(entryId);
    } catch (error) {
      if (active !== session) return;
      if (error instanceof APIError && error.code === 'already_taken' && has(session, 'read')) {
        session.view = 'activity';
        session.task = undefined;
        await refresh(session, entryId);
        if (active !== session) return;
        const event = session.events.find(item => item.operation === 'take' && item.entry.id === entryId);
        announce(event ? 'Entry ' + entryId + ' was already taken by ' + event.actor + '.' : error.message);
      } else {
        report(session, error);
      }
      return;
    }
    if (active !== session) return;
    element('taken-entry-id').textContent = 'ID ' + entry.id;
    renderPayload(takenPayload, takenLinks, entry.payload);
    takenEntry.showModal();
    announce('Took entry ' + entry.id + '.');
    await refresh(session);
  });
}

async function repost(session: Session, event: BoardEvent, control: HTMLButtonElement) {
  await mutate(session, control, async () => {
    try {
      const entry = await session.api.post(JSON.stringify(event.entry.payload), 'repost:' + event.id);
      if (active !== session) return;
      announce('Reposted entry ' + event.entry.id + ' as entry ' + entry.id + '.');
      await refresh(session);
    } catch (error) {
      report(session, error);
    }
  });
}

const boardPath = /^\/boards\/([^/]+)\/?$/.exec(location.pathname)?.[1];
try {
  if (boardPath) slugInput.value = decodeURIComponent(boardPath);
} catch {
  message(loginError, 'Enter a valid board slug.');
}

loginForm.onsubmit = async event => {
  event.preventDefault();
  const slug = slugInput.value.trim();
  const token = tokenInput.value.trim();
  if (!slug || slug.includes('/') || slug === '.' || slug === '..' || !token) {
    message(loginError, 'Enter a board slug and its access token.');
    return;
  }
  const submit = loginForm.querySelector<HTMLButtonElement>('button')!;
  submit.disabled = true;
  message(loginError);
  try {
    const api = new BoardAPI(slug, token);
    const board = await api.board();
    const session: Session = {
      api, board, view: board.permissions.includes('read') ? 'tasks' : 'entries',
      issue: '', pattern: '{}', entries: [], events: [], taskEvents: [], issues: [],
      taskIssues: collectTaskIssues([]), pages: [],
      loaded: false, mutating: false,
    };
    history.replaceState(null, '', '/boards/' + encodeURIComponent(board.id));
    tokenInput.value = '';
    boardName.textContent = board.name;
    document.title = board.name + ' · Agentic Whiteboard';
    element('board-path').textContent = '/boards/' + board.id;
    const actor = element('actor');
    actor.textContent = actor.title = board.actor;
    pattern.value = session.pattern;
    active = session;
    refreshIssueOptions(session);
    login.hidden = true;
    workspace.hidden = false;
    sessionBar.hidden = false;
    void refresh(session);
    render(session);
    boardName.focus();
  } catch (error) {
    message(loginError, errorMessage(error));
  } finally {
    submit.disabled = false;
  }
};

element('disconnect').onclick = () => disconnect();
refreshButton.onclick = () => {
  if (!active) return;
  announce();
  void refresh(active);
};
for (const item of viewButtons) {
  item.onclick = () => {
    if (active) showView(active, item.dataset.view as View);
  };
}
issue.onchange = () => {
  if (!active) return;
  active.issue = issue.value;
  if (active.task && active.issue && active.task.issue !== active.issue) active.task = undefined;
  if (active.view === 'tasks') render(active);
  else void refresh(active);
};
element('clear-task').onclick = () => {
  if (active) {
    showView(active, 'entries');
    pattern.focus();
  }
};
element<HTMLFormElement>('browse-form').onsubmit = event => {
  event.preventDefault();
  if (!active || !has(active, 'read')) return;
  announce();
  try {
    active.pattern = jsonObject(pattern.value || '{}');
    void refresh(active);
  } catch (error) {
    report(active, error);
  }
};
element<HTMLFormElement>('take-form').onsubmit = event => {
  event.preventDefault();
  const id = takeId.value.trim();
  if (active && id && event.submitter instanceof HTMLButtonElement) {
    void take(active, id, event.submitter);
  }
};
postButton.onclick = () => {
  message(postError);
  composer.showModal();
};
element('cancel-post').onclick = () => composer.close();
composer.oncancel = event => {
  if (active?.mutating) event.preventDefault();
};
element<HTMLFormElement>('post-form').onsubmit = async event => {
  event.preventDefault();
  const session = active;
  if (!session || !has(session, 'post') || !(event.submitter instanceof HTMLButtonElement)) return;
  const cancel = element<HTMLButtonElement>('cancel-post');
  await mutate(session, event.submitter, async () => {
    cancel.disabled = true;
    payloadEditor.readOnly = true;
    message(postError);
    try {
      const entry = await session.api.post(jsonObject(payloadEditor.value), 'post');
      if (active !== session) return;
      payloadEditor.value = '{}';
      composer.close();
      announce('Posted entry ' + entry.id + '.');
      await refresh(session);
    } catch (error) {
      report(session, error, postError);
    } finally {
      cancel.disabled = false;
      payloadEditor.readOnly = false;
    }
  });
};
