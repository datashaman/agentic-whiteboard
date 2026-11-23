import {
  APIError, BoardAPI, createBoard, jsonObject,
  type BoardEvent, type Entry, type Payload, type Permission,
} from './api';
import { BoardView, type ActivityFocus, type View, type ViewAction } from './board-view';
import { issueLabel, issueOf } from './tasks';

interface Session {
  api: BoardAPI;
  view: BoardView;
  disclosure?: AbortController;
  activityCheck?: AbortController;
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
const archivedBanner = element('board-archived');
const refreshButton = element<HTMLButtonElement>('refresh');
const browseButton = element<HTMLButtonElement>('browse');
const postButton = element<HTMLButtonElement>('open-composer');
const takeId = element<HTMLInputElement>('entry-id');
const issue = element<HTMLSelectElement>('issue');
const viewButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('nav [data-view]'));
const tasks = element('tasks');
const taskFilters = Array.from(tasks.querySelectorAll<HTMLButtonElement>('[data-task-filter]'));
const lanes = Array.from(document.querySelectorAll<HTMLElement>('[data-lane]'));
const entryList = element('entry-list');
const eventList = element('event-list');
const createBoardDialog = element<HTMLDialogElement>('create-board');
const createBoardForm = element<HTMLFormElement>('create-board-form');
const createBoardFields = element<HTMLFieldSetElement>('create-board-fields');
const createBoardServer = element<HTMLInputElement>('create-board-server');
const createBoardError = element('create-board-error');
const createdBoard = element('created-board');
const createdBoardToken = element<HTMLInputElement>('created-board-token');
const createdBoardTokenId = element('created-board-token-id');
const createdBoardLink = element<HTMLAnchorElement>('created-board-link');
const createdBoardStatus = element('created-board-status');
const newActivity = element<HTMLButtonElement>('new-activity');
const activityStatus = element('activity-status');
const pattern = element<HTMLTextAreaElement>('pattern');
const composer = element<HTMLDialogElement>('composer');
const postError = element('post-error');
const payloadEditor = element<HTMLTextAreaElement>('payload');
const expiryInput = element<HTMLInputElement>('expires-at');
const takenEntry = element<HTMLDialogElement>('taken-entry');
const takenPayload = element('taken-payload');
const takenLinks = element('taken-links');
const clockFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

let active: Session | undefined;

type BoardConnection = { slug: string; token: string };
const boardConnectionKey = 'whiteboard:board-connection';

function savedConnection(): BoardConnection | undefined {
  try {
    const stored = JSON.parse(sessionStorage.getItem(boardConnectionKey) ?? 'null') as Partial<BoardConnection> | null;
    if (typeof stored?.slug === 'string' && typeof stored.token === 'string' && stored.token) {
      return { slug: stored.slug, token: stored.token };
    }
  } catch {
    // The board can still be opened manually if tab storage is unavailable.
  }
}

function saveConnection(connection?: BoardConnection) {
  try {
    if (connection) sessionStorage.setItem(boardConnectionKey, JSON.stringify(connection));
    else sessionStorage.removeItem(boardConnectionKey);
  } catch {
    // A connected session can still work in memory.
  }
}

function has(session: Session, permission: Permission) {
  return session.view.can(permission);
}

function isEntryId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
}

function boardHref(slug: string, focus?: ActivityFocus) {
  const path = '/boards/' + encodeURIComponent(slug);
  if (!focus) return path;
  const query = new URLSearchParams({ entry: focus.entryId });
  if (focus.operation) query.set('event', focus.operation);
  return path + '?' + query;
}

function serverOrigin(value: string) {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const supported = url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
    if (supported && url.href === url.origin + '/') return url.origin;
  } catch {
    // Use the same validation message for malformed and unsupported URLs.
  }
  throw new Error('Enter a server origin such as https://boards.example.com. Localhost may use HTTP.');
}

function recordLink(session: Session, label: string, focus: ActivityFocus) {
  const link = node('a', '', label);
  link.href = boardHref(session.view.board.id, focus);
  const item = node('li');
  item.append(link);
  return item;
}

function announce(success = '', failure = '') {
  message(status, success);
  message(boardError, failure);
}

function disconnect(reason = '') {
  active?.view.cancel();
  active?.disclosure?.abort();
  active?.activityCheck?.abort();
  saveConnection();
  active = undefined;
  workspace.hidden = true;
  sessionBar.hidden = true;
  login.hidden = false;
  composer.close();
  takenEntry.close();
  entryList.replaceChildren();
  eventList.replaceChildren();
  renderActivityNotice(false);
  for (const lane of lanes) lane.querySelector('.cards')!.replaceChildren();
  payloadEditor.value = '{}';
  expiryInput.value = '';
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
    if (error instanceof APIError && (error.code === 'board_archived' || error.code === 'entry_expired')) {
      void refresh(session);
    }
  }
}

function refreshIssueOptions(session: Session) {
  const selected = session.view.current.issue;
  const values = new Set(session.view.issues);
  values.add(selected);
  values.delete('');
  issue.replaceChildren(
    new Option('All issues', ''),
    ...Array.from(values).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map(value => new Option(issueLabel(value), value)),
  );
  issue.value = selected;
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
  const { current, data, loading } = session.view;
  const visible = current.view === 'tasks';
  const cards = data?.cards ?? [];
  tasks.dataset.filter = current.filter;
  for (const filter of taskFilters) {
    filter.setAttribute('aria-pressed', String(filter.dataset.taskFilter === current.filter));
  }
  for (const lane of lanes) {
    const container = lane.querySelector('.cards')!;
    const count = lane.querySelector('.count')!;
    container.replaceChildren();
    lane.hidden = (lane.dataset.lane === 'result') !== (current.filter === 'result');
    if (!visible || lane.hidden) continue;
    const matches = cards.filter(card => card.lane === lane.dataset.lane && (!current.issue || card.ref.issue === current.issue));
    count.textContent = String(matches.length);
    count.setAttribute('aria-label', matches.length + ' tasks');
    if (!matches.length) {
      const empty = data ? 'No tasks' : loading ? 'Loading tasks…' : 'Tasks unavailable';
      container.append(node('p', 'empty', empty));
    }
    for (const card of matches) {
      const control = button('', () => {
        if (card.takenAt) {
          void focusActivity(session, { entryId: card.entry.id, operation: 'take' });
          return;
        }
        pattern.value = '{}';
        void navigate(session, { type: 'view', view: 'entries', task: card.ref });
        viewButtons.find(item => item.dataset.view === 'entries')?.focus();
      }, 'task-card');
      const title = titleOf(card.entry);
      control.setAttribute('aria-label', title);
      const keys = node('span', 'task-key');
      if (card.ref.issue) keys.append(tag(issueLabel(card.ref.issue), true));
      keys.append(tag(card.ref.id));
      const attribution = node('span', 'attribution', card.attribution);
      if (card.takenAt) attribution.append(' · ', timestamp(card.takenAt));
      control.append(keys, node('strong', '', title), attribution);
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
  action?: () => HTMLButtonElement, event?: BoardEvent) {
  const details = node('details', 'record');
  details.dataset.id = event?.id ?? entry.id;
  details.name = event ? 'activity-record' : 'live-record';
  const summary = node('summary');
  if (event) summary.onclick = () => {
    if (!session.view.current.focus) return;
    session.view.dismissFocus();
    history.replaceState(null, '', boardHref(session.view.board.id));
  };
  const label = node('span', 'summary-label');
  if (event) {
    label.append(
      node('strong', 'event-actor', event.actor),
      node('span', 'event-verb', event.operation === 'take' ? 'took' : 'posted'),
    );
  }
  label.append(node('strong', 'record-title', titleOf(entry)));
  if (typeof entry.payload.kind === 'string') label.append(tag(entry.payload.kind));
  const expired = tag('Expired');
  expired.hidden = !entry.expired;
  label.append(expired);
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
    expired.hidden = !payload.expired;
    const raw = node('pre');
    raw.setAttribute('aria-label', 'Entry JSON');
    const links = node('ul', 'entry-links');
    renderPayload(raw, links, payload.payload);
    const source = payload.payload.sourceEntryId;
    if (isEntryId(source) && source !== entry.id) {
      links.prepend(recordLink(session, 'View source work (entry ' + source + ')', { entryId: source }));
    }
    links.prepend(recordLink(session, event ? 'Link to this event' : 'Link to this entry', {
      entryId: entry.id, operation: event?.operation,
    }));
    links.hidden = false;
    body.replaceChildren(raw, links);
    if (payload.expiresAt) {
      const deadline = node('p', 'hint', 'Available until ');
      deadline.append(timestamp(payload.expiresAt));
      body.append(deadline);
    }
    if (event?.repostedFrom) {
      const entryId = event.repostedFrom;
      body.append(button('View original take (entry ' + entryId + ')',
        () => void focusActivity(session, { entryId, operation: 'take' })));
    }
    if (event?.latestRepost) {
      const entryId = event.latestRepost;
      body.append(button('View latest repost (entry ' + entryId + ')',
        () => void focusActivity(session, { entryId, operation: 'post' })));
    }
    if (action && (event || !payload.expired)) body.append(action());
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

function renderRecords(session: Session) {
  const { current, data, loading, focusedRecord } = session.view;
  const list = current.view === 'activity' ? eventList : entryList;
  const restoreFocus = list.contains(document.activeElement);
  const openId = list.querySelector<HTMLElement>('details[open]')?.dataset.id;
  session.disclosure?.abort();
  entryList.replaceChildren();
  eventList.replaceChildren();
  if (current.view === 'tasks' || !has(session, 'read')) return;

  if (!data) {
    list.append(node('p', 'empty', loading ? 'Loading entries…' : 'Entries unavailable'));
  } else if (current.view === 'activity') {
    const selected = focusedRecord?.id ?? openId;
    const events = session.view.activity;
    if (current.focus && !loading && !focusedRecord) {
      const unavailable = node('p', 'empty', 'The linked Activity record is unavailable on this board.');
      unavailable.setAttribute('role', 'status');
      list.append(unavailable);
    }
    for (const event of events) {
      const action = event.operation === 'take' && has(session, 'post')
        ? () => button('Repost', control => void repost(session, event.entry.id, control))
        : undefined;
      list.append(record(session, event.entry, selected, action, event));
    }
    if (!events.length) list.append(node('p', 'empty', 'No activity for this selection on this page.'));
  } else {
    const entries = data.entries;
    for (const entry of entries) {
      const action = has(session, 'take')
        ? () => button('Take', control => void take(session, entry.id, control))
        : undefined;
      list.append(record(session, entry, openId, action));
    }
    if (!entries.length) list.append(node('p', 'empty', 'No live entries match this selection on this page.'));
  }

  if (current.pages.length || data?.nextCursor) {
    const pages = node('div', 'record-pages');
    const previous = button('Previous page', () => void navigate(session, { type: 'page', direction: 'previous' }));
    previous.disabled = loading || !current.pages.length;
    const next = button('Next page', () => void navigate(session, { type: 'page', direction: 'next' }));
    next.disabled = loading || !data?.nextCursor;
    pages.append(previous, node('span', '', 'Page ' + (current.pages.length + 1)), next);
    list.append(pages);
  }
  if (restoreFocus) list.querySelector<HTMLElement>('details[open] > summary')?.focus();
}

function renderActivityNotice(available: boolean) {
  if (newActivity.hidden === !available) return;
  newActivity.hidden = !available;
  activityStatus.textContent = available ? 'New activity is available.' : '';
}

function render(session: Session) {
  const { current, board, loading } = session.view;
  const read = has(session, 'read');
  const view = read || has(session, 'take') ? current.view : undefined;
  archivedBanner.hidden = !board.archived;
  if (board.archived && composer.open) {
    composer.close();
    boardName.focus();
  }
  element('view-bar').hidden = !view;
  for (const item of viewButtons) {
    item.hidden = !read && item.dataset.view !== 'entries';
    item.setAttribute('aria-pressed', String(item.dataset.view === view));
    element(item.dataset.view!).hidden = item.dataset.view !== view;
  }
  element('issue-filter').hidden = !read;
  element('post-access').hidden = Boolean(view) || board.archived;
  element('browse-form').hidden = !read;
  element('take-form').hidden = read || !has(session, 'take');
  element('task-scope').hidden = !current.task;
  element('task-scope-id').textContent = current.task?.id ?? '';
  postButton.hidden = !has(session, 'post');
  refreshButton.disabled = loading;
  browseButton.disabled = loading;
  newActivity.disabled = loading;
  renderActivityNotice(view === 'activity' && session.view.hasNewActivity);
  if (loading) workspace.setAttribute('aria-busy', 'true');
  else workspace.removeAttribute('aria-busy');
  refreshIssueOptions(session);
  renderTasks(session);
  renderRecords(session);
}

async function navigate(session: Session, action: ViewAction) {
  const previous = session.view.current.focus;
  const reload = session.view.select(action);
  const { focus } = session.view.current;
  if (previous !== focus) history.replaceState(null, '', boardHref(session.view.board.id, focus));
  if (reload) await refresh(session);
  else if (active === session) render(session);
}

async function focusActivity(session: Session, focus: ActivityFocus) {
  await navigate(session, { type: 'focus', focus });
  if (active === session && session.view.current.focus === focus && session.view.focusedRecord) {
    eventList.querySelector<HTMLElement>('details[open] > summary')?.focus();
  }
}

async function refresh(session: Session) {
  session.activityCheck?.abort();
  try {
    await session.view.refresh(() => {
      if (active === session) render(session);
    });
  } catch (error) {
    report(session, error);
  }
}

async function checkActivity(session: Session) {
  const { view } = session;
  if (document.hidden || view.current.view !== 'activity' || !has(session, 'read') || session.activityCheck) return;
  const check = new AbortController();
  session.activityCheck = check;
  const signal = AbortSignal.any([check.signal, AbortSignal.timeout(10_000)]);
  try {
    const updated = await view.checkActivity(signal, () =>
      !document.hidden && !session.mutating && !createBoardDialog.open && !composer.open && !takenEntry.open &&
      !eventList.querySelector('details[open]') && !eventList.contains(document.activeElement));
    if (active !== session || signal.aborted) return;
    if (updated) render(session);
    else if (view.current.view === 'activity') renderActivityNotice(view.hasNewActivity);
  } catch (error) {
    if (!signal.aborted && error instanceof APIError && error.status === 401) report(session, error);
  } finally {
    session.activityCheck = undefined;
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
        await focusActivity(session, { entryId, operation: 'take' });
        if (active !== session) return;
        const event = session.view.focusedRecord;
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

async function repost(session: Session, entryId: string, control: HTMLButtonElement) {
  await mutate(session, control, async () => {
    try {
      const entry = await session.api.repost(entryId);
      if (active !== session) return;
      announce('Reposted entry ' + entryId + ' as entry ' + entry.id + '.');
      if (session.view.current.view === 'activity') await focusActivity(session, { entryId: entry.id, operation: 'post' });
      else await refresh(session);
    } catch (error) {
      report(session, error);
    }
  });
}

const boardPath = /^\/boards\/([^/]+)\/?$/.exec(location.pathname)?.[1];
let urlBoardSlug: string | undefined;
try {
  if (boardPath) slugInput.value = urlBoardSlug = decodeURIComponent(boardPath);
} catch {
  message(loginError, 'Enter a valid board slug.');
}

async function connect({ slug, token }: BoardConnection) {
  const submit = loginForm.querySelector<HTMLButtonElement>('button')!;
  if (submit.disabled) return;
  submit.disabled = true;
  message(loginError);
  try {
    const api = new BoardAPI(slug, token);
    const board = await api.board();
    const session: Session = { api, view: new BoardView(api, board), mutating: false };
    const query = new URLSearchParams(urlBoardSlug === board.id ? location.search : '');
    let focus: ActivityFocus | undefined;
    let linkError = '';
    if (query.has('entry') || query.has('event')) {
      const entryId = query.get('entry');
      const operation = query.get('event');
      if (isEntryId(entryId) && (operation === null || operation === 'post' || operation === 'take')) {
        focus = { entryId, operation: operation ?? undefined };
        if (!has(session, 'read')) linkError = 'Read access is required to open this Activity link.';
      } else {
        linkError = 'This Activity link is invalid.';
      }
    }
    history.replaceState(null, '', boardHref(board.id, focus));
    urlBoardSlug = board.id;
    saveConnection({ slug: board.id, token });
    tokenInput.value = '';
    boardName.textContent = board.name;
    document.title = board.name + ' · Agentic Whiteboard';
    element('board-path').textContent = '/boards/' + board.id;
    const actor = element('actor');
    actor.textContent = actor.title = board.actor;
    pattern.value = session.view.current.pattern;
    active = session;
    login.hidden = true;
    workspace.hidden = false;
    sessionBar.hidden = false;
    boardName.focus();
    announce('', linkError);
    if (focus && has(session, 'read')) void focusActivity(session, focus);
    else void refresh(session);
  } catch (error) {
    if (error instanceof APIError && error.status === 401) {
      const saved = savedConnection();
      if (saved?.slug === slug && saved.token === token) saveConnection();
    }
    message(loginError, errorMessage(error));
  } finally {
    submit.disabled = false;
  }
}

loginForm.onsubmit = event => {
  event.preventDefault();
  const slug = slugInput.value.trim();
  const token = tokenInput.value.trim();
  if (!slug || slug.includes('/') || slug === '.' || slug === '..' || !token) {
    message(loginError, 'Enter a board slug and its access token.');
    return;
  }
  void connect({ slug, token });
};

const remembered = savedConnection();
if (boardPath && remembered?.slug === slugInput.value) void connect(remembered);

createBoardServer.defaultValue = location.origin;
for (const control of document.querySelectorAll<HTMLButtonElement>('[data-create-board]')) {
  control.onclick = () => createBoardDialog.showModal();
}
element('cancel-create-board').onclick = () => createBoardDialog.close();
element('done-create-board').onclick = () => createBoardDialog.close();
createBoardDialog.oncancel = event => {
  if (createBoardFields.disabled) event.preventDefault();
};
createBoardDialog.onclose = () => {
  const server = createBoardServer.value;
  createBoardForm.reset();
  createBoardServer.value = server;
  createBoardForm.hidden = false;
  createdBoard.hidden = true;
  createdBoardToken.value = '';
  createdBoardTokenId.textContent = '';
  createdBoardLink.removeAttribute('href');
  createdBoardStatus.textContent = '';
  message(createBoardError);
};
createBoardForm.onsubmit = async event => {
  event.preventDefault();
  if (createBoardFields.disabled) return;
  const data = new FormData(createBoardForm);
  const field = (name: string) => String(data.get(name) ?? '').trim();
  const details = { slug: field('slug'), name: field('name'), actor: field('actor') };
  createBoardFields.disabled = true;
  message(createBoardError);
  try {
    if (!isSecureContext) throw new Error('Open this interface over HTTPS to create a whiteboard.');
    const origin = serverOrigin(field('server'));
    const created = await createBoard(origin, field('token'), details);
    createBoardForm.reset();
    createBoardServer.value = origin;
    createdBoardToken.value = created.token;
    createdBoardTokenId.textContent = 'Token ID ' + created.tokenId;
    createdBoardLink.href = origin + boardHref(created.id);
    createdBoardLink.textContent = 'Open whiteboard on ' + new URL(origin).host;
    createBoardForm.hidden = true;
    createdBoard.hidden = false;
    element('create-board-title').focus();
  } catch (error) {
    message(createBoardError, errorMessage(error));
  } finally {
    createBoardFields.disabled = false;
  }
};
element('copy-created-token').onclick = async () => {
  try {
    await navigator.clipboard.writeText(createdBoardToken.value);
    createdBoardStatus.textContent = 'Token copied.';
  } catch {
    createdBoardToken.focus();
    createdBoardToken.select();
    createdBoardStatus.textContent = 'Copy the selected token.';
  }
};

element('disconnect').onclick = () => disconnect();
window.setInterval(() => {
  if (active) void checkActivity(active);
}, 5_000);
document.addEventListener('visibilitychange', () => {
  if (!active) return;
  if (document.hidden) active.activityCheck?.abort();
  else void checkActivity(active);
});
newActivity.onclick = async () => {
  if (!active) return;
  const session = active;
  await navigate(session, { type: 'latest-activity' });
  if (active !== session || session.view.current.view !== 'activity' || document.activeElement !== document.body) return;
  if (!newActivity.hidden) {
    newActivity.focus();
    return;
  }
  const record = eventList.querySelector<HTMLElement>('details[open] > summary')
    ?? eventList.querySelector<HTMLElement>('details > summary');
  (record ?? refreshButton).focus();
};
refreshButton.onclick = () => {
  if (!active) return;
  announce();
  void refresh(active);
};
for (const item of viewButtons) {
  item.onclick = () => {
    if (!active) return;
    announce();
    void navigate(active, { type: 'view', view: item.dataset.view as View });
  };
}
for (const filter of taskFilters) {
  filter.onclick = () => {
    if (!active) return;
    const value = filter.dataset.taskFilter === 'result' ? 'result' : 'open';
    void navigate(active, { type: 'filter', filter: value });
  };
}
issue.onchange = () => {
  if (active) void navigate(active, { type: 'issue', issue: issue.value });
};
element('clear-task').onclick = () => {
  if (active) {
    announce();
    void navigate(active, { type: 'view', view: 'entries' });
    pattern.focus();
  }
};
element<HTMLFormElement>('browse-form').onsubmit = event => {
  event.preventDefault();
  if (!active || !has(active, 'read')) return;
  announce();
  try {
    void navigate(active, { type: 'pattern', pattern: jsonObject(pattern.value || '{}') });
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
    expiryInput.readOnly = true;
    message(postError);
    try {
      const expiresAt = expiryInput.value ? new Date(expiryInput.value).toISOString() : undefined;
      const entry = await session.api.post(jsonObject(payloadEditor.value), expiresAt);
      if (active !== session) return;
      payloadEditor.value = '{}';
      expiryInput.value = '';
      composer.close();
      announce('Posted entry ' + entry.id + (entry.expired ? '. Its deadline has passed.' : '.'));
      await refresh(session);
    } catch (error) {
      report(session, error, postError);
    } finally {
      cancel.disabled = false;
      payloadEditor.readOnly = false;
      expiryInput.readOnly = false;
    }
  });
};
