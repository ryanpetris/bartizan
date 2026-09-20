import { useSyncExternalStore } from 'react';
import {
  defaultSettings,
  type State,
  type Connection,
  type Workspace,
  type TerminalSession,
  type RemoteSession,
} from '../shared';
import type { PublicProfile as Profile } from '../core/config';
import { themes } from '../themes';

import { createWebAPI } from './web-api';
export const api = (window.bartizan ??= createWebAPI());
export type Selection = { kind: 'connect' } | { kind: 'terminal' | 'browser' | 'connection' | 'remote'; id: string } | undefined;
/** A terminal or a browser session, keyed as in the navigation order. */
type Entry = { key: string; terminal?: TerminalSession; workspace?: Workspace };
export type Group = { connection: Connection; entries: Entry[] };

export const store = {
  state: {
    capabilities: { embeddedBrowser: false, nativeFilePicker: false },
    settings: defaultSettings,
    profiles: [],
    defaults: {},
    file: '',
    connections: [],
    terminals: [],
    workspaces: [],
    challenges: [],
  } as State,
  selection: undefined as Selection,
};

/** What both processes know of the chosen theme. */
export const activeManifest = () => themes[store.state.settings.theme];

const renderers = new Set<() => void>();
let revision = 0;
const snapshot = () => revision;
export const useStore = () => {
  useSyncExternalStore(onRender, snapshot);
  return store;
};
let scheduled = false;
function onRender(callback: () => void) {
  renderers.add(callback);
  return () => {
    renderers.delete(callback);
  };
}
export function render() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    revision++;
    for (const callback of renderers) callback();
  });
}

const focusRequests: (() => void)[] = [];
export function onFocusRequest(callback: () => void) {
  focusRequests.push(callback);
  return () => {
    const index = focusRequests.indexOf(callback);
    if (index >= 0) focusRequests.splice(index, 1);
  };
}
/** Moves focus into the selected view once it has rendered. */
export function focusView() {
  requestAnimationFrame(() => {
    for (const callback of focusRequests) callback();
  });
}
/** Increases with every explicit selection, so a selection waiting for state yields to a later choice. */
let choice = 0;
export function select(selection: Selection, focus = true) {
  choice++;
  store.selection = selection;
  render();
  if (focus) focusView();
}
/** Shows the Connect page, which takes the focus back when it is chosen while already in view. */
export function showConnect() {
  if (store.selection?.kind === 'connect') focusView();
  else select({ kind: 'connect' });
}
/** Whether a selection can be shown; a browser session without tabs has nothing to show. */
export const exists = (state: State, selection: NonNullable<Selection>) =>
  selection.kind === 'connect'
    ? true
    : selection.kind === 'terminal'
      ? state.terminals.some((t) => t.id === selection.id)
      : selection.kind === 'connection' || selection.kind === 'remote'
        ? state.connections.some((c) => c.id === selection.id && (selection.kind !== 'remote' || remoteVisible(c)))
        : state.workspaces.some((w) => w.id === selection.id && w.tabs.length > 0);
/** The connection a selection belongs to. */
const selectionConnection = (selection: Selection) =>
  !selection || selection.kind === 'connect'
    ? undefined
    : (selection.kind === 'connection' || selection.kind === 'remote')
      ? selection.id
      : selection.kind === 'terminal'
        ? store.state.terminals.find((t) => t.id === selection.id)?.connectionId
        : store.state.workspaces.find((w) => w.id === selection.id)?.connectionId;

/** What each connection last showed. */
const lastShown = new Map<string, NonNullable<Selection>>();
onRender(() => {
  const connectionId = selectionConnection(store.selection);
  if (connectionId && store.selection && store.selection.kind !== 'connection') lastShown.set(connectionId, store.selection);
});
/** Shows what a connection last showed, or else its first terminal or browser session with tabs, or the connection itself; it opens nothing. */
export function revisit(connectionId: string) {
  const last = lastShown.get(connectionId);
  const first = groups()
    .find((group) => group.connection.id === connectionId)
    ?.entries.find((entry) => entry.terminal || entry.workspace?.tabs.length);
  select(
    last && exists(store.state, last)
      ? last
      : first?.terminal
        ? { kind: 'terminal', id: first.terminal.id }
        : first?.workspace
          ? { kind: 'browser', id: first.workspace.id }
          : { kind: 'connection', id: connectionId },
  );
}
/** The connection in view: the one the selection belongs to. */
export const currentConnection = () => selectionConnection(store.selection);

/** Each connection's shown terminals, most recent first. */
const recentTerminals = new Map<string, string[]>();
onRender(() => {
  const selection = store.selection;
  const terminal =
    selection?.kind === 'terminal' ? store.state.terminals.find((t) => t.id === selection.id) : undefined;
  const recent = terminal && recentTerminals.get(terminal.connectionId);
  if (!terminal || recent?.[0] === terminal.id) return;
  recentTerminals.set(terminal.connectionId, [terminal.id, ...(recent ?? []).filter((id) => id !== terminal.id)]);
});

export function describeError(error: unknown): { message: string; fields: Record<string, string> } {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replace(/^Error invoking remote method '[^']+': /, '').replace(/^(Error|TypeError): /, '');
  const fields: Record<string, string> = {};
  if (message.trimStart().startsWith('[')) {
    try {
      const issues = JSON.parse(message) as { path?: (string | number)[]; message?: string }[];
      for (const issue of issues)
        fields[(issue.path ?? []).filter((part) => typeof part === 'string').join('.')] ??=
          issue.message ?? 'Invalid value';
      message = Object.entries(fields)
        .map(([path, text]) => (path ? `${path}: ${text}` : text))
        .join('\n');
    } catch {
      /* not an issue list */
    }
  }
  const lines = message.split('\n');
  if (lines[0].startsWith('Command failed:') && lines.length > 1) message = lines.slice(1).join('\n').trim();
  return { message, fields };
}

/** Cuts text to a length without splitting a character. */
const cut = (text: string, length: number) =>
  text.length > length ? text.slice(0, /[\uD800-\uDBFF]/.test(text[length - 1]) ? length - 1 : length) : text;
/** Reports an action's failures under the connection, and its label, as they are when the action starts. */
export function reporter(source: string, connectionId?: string) {
  const name = connectionId === undefined ? undefined : connectionOf(connectionId)?.label;
  const label = name === undefined ? undefined : cut(name, 4096);
  return (error: unknown) => {
    const text = describeError(error).message;
    const message = text.trim() ? cut(text, 16384) : 'Unknown error';
    // A report that cannot be delivered is dropped rather than reported again.
    api.reportError({ source, message, connectionId, label }).catch(() => {});
  };
}
export const report = (source: string, error: unknown, connectionId?: string) =>
  reporter(source, connectionId)(error);
/** Settles an action, reporting its failure; the connection's scope is taken before the action can change it. */
export function run<T>(source: string, work: Promise<T>, connectionId?: string): Promise<T | undefined> {
  const failed = reporter(source, connectionId);
  return work.catch((error: unknown) => {
    failed(error);
    return undefined;
  });
}

/** Numbers terminals per connection in creation order; numbers stay fixed while a terminal exists. */
const numbers = new Map<string, number>();
function number(id: string, siblings: { id: string }[]) {
  let value = numbers.get(id);
  if (value === undefined) {
    value = Math.max(0, ...siblings.map((item) => numbers.get(item.id) ?? 0)) + 1;
    numbers.set(id, value);
  }
  return value;
}
/** Titles terminal applications set, by terminal. */
const terminalTitles = new Map<string, string>();
/** Records a terminal application's title, cut to the length of a native window title; an empty title returns the terminal to its numbered name. */
export function setTerminalTitle(id: string, value: string) {
  const title = cut(value, 4096);
  if ((terminalTitles.get(id) ?? '') === title) return;
  if (title) terminalTitles.set(id, title);
  else terminalTitles.delete(id);
  render();
}
/** A terminal's application title, the remote session it holds, or Terminal, Terminal 2 and so on; its number stays reserved while it has a title. */
export function terminalName(terminal: TerminalSession) {
  const value = number(
    terminal.id,
    store.state.terminals.filter((t) => t.connectionId === terminal.connectionId),
  );
  const title = terminalTitles.get(terminal.id);
  const session = terminal.remoteSession;
  if (title?.trim()) return title;
  // Attaching execs straight into the multiplexer, which sets no title of its own, so the session names the terminal.
  if (session) return `${session.group}: ${session.label}`;
  return value === 1 ? 'Terminal' : `Terminal ${value}`;
}
/** Each browser session has its own colour. */
export const sessionColor = (workspace: Workspace) => `var(--session-${workspace.color % 9})`;
export const tabTitle = (tab: { url: string; title: string }) => (tab.url ? tab.title || tab.url : 'New Tab');
export const statusText = (item: Pick<Connection, 'status' | 'exitCode'>) =>
  item.status === 'connecting'
    ? 'Connecting'
    : item.status === 'connected'
      ? 'Connected'
      : item.exitCode
        ? `Closed · exit ${item.exitCode}`
        : 'Closed';
/** Drops numbers and titles of terminals that no longer exist and numbers new terminals in state order. */
export function renumber() {
  const ids = new Set(store.state.terminals.map((terminal) => terminal.id));
  for (const id of numbers.keys()) if (!ids.has(id)) numbers.delete(id);
  for (const id of terminalTitles.keys()) if (!ids.has(id)) terminalTitles.delete(id);
  for (const terminal of store.state.terminals) terminalName(terminal);
}

export const connectionOf = (id: string) => store.state.connections.find((c) => c.id === id);
export const endpoint = (connection: Connection) =>
  connection.username ? `${connection.username}@${connection.host}` : connection.host;
export const profileName = (profile: Profile) => profile.spec.label ?? profile.id;
export function profileEndpoint(profile: Profile) {
  const spec = profile.spec,
    defaults = store.state.defaults;
  const host = spec.host ?? defaults.host,
    username = spec.username ?? defaults.username,
    port = spec.port ?? defaults.port;
  return host ? `${username ? `${username}@` : ''}${host}${port && port !== 22 ? `:${port}` : ''}` : '';
}
/** Profiles whose label, ID, endpoint, username or tags contain the query, in configuration order; an empty query matches every profile. */
export function matchProfiles(query: string, profiles = store.state.profiles) {
  const value = query.trim().toLowerCase();
  if (!value) return profiles;
  const username = (profile: Profile) => profile.spec.username ?? store.state.defaults.username ?? '';
  return profiles.filter((profile) =>
    [profileName(profile), profile.id, profileEndpoint(profile), username(profile), ...profile.tags].some((field) =>
      field.toLowerCase().includes(value),
    ),
  );
}
/** The document dialogs open in: the modal overlay's once it has opened, or this page's where there is none. */
export const dialogHost = { document };
export const dialogOpen = () => dialogHost.document.querySelector('dialog[open]') !== null;

/**
 * Navigation order the user chose, by scope: `connections`, `items:<connection>` and `tabs:<browser session>`. It lasts for
 * the application launch, including renderer reloads.
 */
const orders: Record<string, string[]> = (() => {
  try {
    return JSON.parse(sessionStorage.getItem('navigation-order') ?? '{}');
  } catch {
    return {};
  }
})();
/** Sorts items by their chosen order; items without one follow in their own order. */
function ordered<T>(scope: string, items: T[], key: (item: T) => string): T[] {
  const chosen = orders[scope] ?? [];
  const rank = (item: T) => {
    const index = chosen.indexOf(key(item));
    return index < 0 ? chosen.length : index;
  };
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => item);
}
/** The keys a scope currently shows, in navigation order. */
export function scopeKeys(scope: string): string[] {
  const [kind, id] = scope.split(':');
  if (kind === 'connections') return groups().map((group) => group.connection.id);
  if (kind === 'items') return groups().find((group) => group.connection.id === id)?.entries.map((entry) => entry.key) ?? [];
  const workspace = store.state.workspaces.find((w) => w.id === id);
  return workspace ? sessionTabs(workspace).map((tab) => tab.id) : [];
}
/** Moves a key before another one, or to the end, within its scope. */
export function moveKey(scope: string, key: string, before?: string) {
  const keys = scopeKeys(scope).filter((item) => item !== key);
  keys.splice(before === undefined ? keys.length : keys.indexOf(before), 0, key);
  orders[scope] = keys;
  try {
    sessionStorage.setItem('navigation-order', JSON.stringify(orders));
  } catch {
    /* The order still applies until the page reloads. */
  }
  render();
}
export const sessionTabs = (workspace: Workspace) => ordered(`tabs:${workspace.id}`, workspace.tabs, (tab) => tab.id);

/** A connection's terminals and browser sessions, in navigation order. */
function entries(connection: Connection, state: State): Entry[] {
  const found = new Map<string, Entry>();
  for (const terminal of state.terminals)
    if (terminal.connectionId === connection.id)
      found.set(`terminal:${terminal.id}`, { key: `terminal:${terminal.id}`, terminal });
  for (const workspace of state.workspaces)
    if (workspace.connectionId === connection.id)
      found.set(`session:${workspace.id}`, { key: `session:${workspace.id}`, workspace });
  return ordered(`items:${connection.id}`, [...found.values()], (entry) => entry.key);
}
/** Each connection in navigation order with its entries. */
export function groups(state = store.state): Group[] {
  return ordered('connections', state.connections, (connection) => connection.id).map((connection) => ({
      connection,
      entries: entries(connection, state),
    }));
}
/** The connection's first browser session in navigation order. */
export const firstSession = (connectionId: string) =>
  groups()
    .find((group) => group.connection.id === connectionId)
    ?.entries.find((entry) => entry.workspace)?.workspace;
/** A profile's connecting or connected connection, whether or not it has children. */
export const activeConnection = (profileId?: string) =>
  profileId ? store.state.connections.find((c) => c.profileId === profileId && c.status !== 'closed') : undefined;

/** A visible navigation row: a connection, a terminal, or a browser tab. */
export type Row = { kind: 'connection' | 'terminal' | 'browser' | 'remote'; id: string; tab?: string; connectionId: string };
export const sameRow = (a: Row, b: Row) => a.kind === b.kind && a.id === b.id && a.tab === b.tab;
/** Visible rows in navigation order, each connection first; a browser session contributes its tabs in session order. */
export function rows(state = store.state): Row[] {
  return groups(state).flatMap(({ connection, entries }) => [
    { kind: 'connection' as const, id: connection.id, connectionId: connection.id },
    ...entries.flatMap((entry): Row[] =>
      entry.terminal
        ? [{ kind: 'terminal', id: entry.terminal.id, connectionId: connection.id }]
        : sessionTabs(entry.workspace!).map((tab) => ({
            kind: 'browser',
            id: entry.workspace!.id,
            tab: tab.id,
            connectionId: connection.id,
          })),
    ),
    ...(remoteVisible(connection) ? [{ kind: 'remote' as const, id: connection.id, connectionId: connection.id }] : []),
  ]);
}
/** The row a selection shows; a browser session shows its active tab. */
export function selectedRow(state: State, selection: NonNullable<Selection>): Row | undefined {
  if (selection.kind === 'connect') return undefined;
  const workspace = selection.kind === 'browser' ? state.workspaces.find((w) => w.id === selection.id) : undefined;
  const tab = workspace && activeTab(workspace)?.id;
  return rows(state).find((row) => row.kind === selection.kind && row.id === selection.id && row.tab === tab);
}

/** Tabs the user chose whose selection the main process has not confirmed yet. */
export const tabIntents = new Map<string, string>();
export const activeTab = (workspace: Workspace) =>
  workspace.tabs.find((t) => t.id === (tabIntents.get(workspace.id) ?? workspace.activeTab));
/** Makes a tab its browser session's active tab. */
export function activateTab(workspaceId: string, tabId: string) {
  const workspace = store.state.workspaces.find((w) => w.id === workspaceId);
  if (!workspace || tabId === (tabIntents.get(workspaceId) ?? workspace.activeTab)) return;
  tabIntents.set(workspaceId, tabId);
  void run('browser', api.browser(workspaceId, 'select', tabId), workspace.connectionId).finally(() => {
    if (tabIntents.get(workspaceId) === tabId) {
      tabIntents.delete(workspaceId);
      render();
    }
  });
}
export function selectTab(workspaceId: string, tabId?: string) {
  if (tabId) activateTab(workspaceId, tabId);
  select({ kind: 'browser', id: workspaceId });
}

/**
 * Runs an action once state events include what it needs. The main process sends the state containing a new item before
 * replying, but the reply can arrive first; state events are the only ordered source, so the renderer never applies
 * fetched state over them.
 */
const waiting = new Set<() => boolean>();
function whenPresent(ready: (state: State) => boolean, action: () => void) {
  const token = choice;
  const check = () => {
    if (token !== choice) return true;
    if (!ready(store.state)) return false;
    action();
    return true;
  };
  if (!check()) waiting.add(check);
}
/** Forgets terminals that no longer exist and runs waiting actions after each applied state. */
export function stateApplied() {
  for (const id of lastShown.keys()) if (!store.state.connections.some((c) => c.id === id)) lastShown.delete(id);
  for (const [connectionId, recent] of recentTerminals) {
    const kept = recent.filter((id) => store.state.terminals.some((t) => t.id === id));
    if (kept.length) recentTerminals.set(connectionId, kept);
    else recentTerminals.delete(connectionId);
  }
  for (const check of [...waiting]) if (check()) waiting.delete(check);
  if (store.selection?.kind === 'remote' && !exists(store.state, store.selection)) revisit(store.selection.id);
}
const selectCreated = (selection: NonNullable<Selection>) =>
  whenPresent(
    (state) => exists(state, selection),
    () => select(selection),
  );
/** Connections waiting for a requested terminal, with the selection count at the latest request. */
const requestedTerminals = new Map<string, number>();
/** Requests one terminal at a time per connection and shows it unless another selection is made after the latest request. */
function requestTerminal(connectionId: string) {
  const pending = requestedTerminals.has(connectionId);
  requestedTerminals.set(connectionId, choice);
  if (pending) return;
  // A request settles once state has included its terminal, even if the terminal closed before the reply arrived.
  const seen = new Set<string>();
  const watch = () => {
    for (const terminal of store.state.terminals) seen.add(terminal.id);
    return !requestedTerminals.has(connectionId);
  };
  watch();
  waiting.add(watch);
  void run('session', api.newTerminal(connectionId), connectionId).then((id) => {
    const finish = () => {
      if (id !== undefined && !seen.has(id) && store.state.connections.some((c) => c.id === connectionId)) return false;
      const token = requestedTerminals.get(connectionId);
      requestedTerminals.delete(connectionId);
      if (id !== undefined && token === choice && exists(store.state, { kind: 'terminal', id }))
        select({ kind: 'terminal', id });
      return true;
    };
    if (!finish()) waiting.add(finish);
  });
}
/**
 * Shows a connection's most recently shown live terminal or another live one. A connected connection without one gets a
 * new terminal. A connecting one shows what `revisit` would until it connects, then gets one unless another selection is
 * made first. Otherwise its most recent terminal, first browser session with tabs or the connection itself is shown.
 */
export function focusConnection(id: string) {
  whenPresent(
    (state) => state.connections.some((c) => c.id === id),
    () => {
      const { terminals } = store.state;
      const recent = recentTerminals.get(id) ?? [];
      const rank = (terminal: TerminalSession) => {
        const index = recent.indexOf(terminal.id);
        return index < 0 ? recent.length : index;
      };
      const own = terminals.filter((t) => t.connectionId === id).sort((a, b) => rank(a) - rank(b));
      const live = own.find((t) => t.status !== 'closed');
      const workspace = groups()
        .find((group) => group.connection.id === id)
        ?.entries.find((entry) => entry.workspace?.tabs.length)?.workspace;
      const status = connectionOf(id)?.status;
      if (live) select({ kind: 'terminal', id: live.id });
      else if (status === 'connected') requestTerminal(id);
      else if (status === 'connecting') {
        if (selectionConnection(store.selection) !== id) revisit(id);
        whenPresent(
          (state) => state.connections.find((c) => c.id === id)?.status !== 'connecting',
          () => focusConnection(id),
        );
      } else if (own[0]) select({ kind: 'terminal', id: own[0].id });
      else if (workspace) select({ kind: 'browser', id: workspace.id });
      else select({ kind: 'connection', id });
    },
  );
}
/** Shows a connection as `revisit` does, keeping a selection that already belongs to it; it opens nothing. */
function showConnection(id: string) {
  whenPresent(
    (state) => state.connections.some((c) => c.id === id),
    () => {
      if (selectionConnection(store.selection) !== id) revisit(id);
    },
  );
}
/** Opens a tab in a browser session, by default the connection's first, and shows it once state includes the tab. */
export function openBrowserTab(connectionId: string, workspaceId = firstSession(connectionId)?.id) {
  const known = new Set(store.state.workspaces.flatMap((workspace) => workspace.tabs.map((tab) => tab.id)));
  return run(
    'browser',
    api.newBrowserTab(connectionId, workspaceId).then((id) =>
      whenPresent(
        (state) => Boolean(state.workspaces.find((w) => w.id === id)?.tabs.some((tab) => !known.has(tab.id))),
        () => select({ kind: 'browser', id }),
      ),
    ),
    connectionId,
  );
}
/** Opens a new browser session for a connection and shows it once state includes its tab, so the tab's view can take focus. */
export function openBrowser(connectionId: string) {
  return run(
    'browser',
    api.newBrowser(connectionId).then((id) =>
      whenPresent(
        (state) => Boolean(state.workspaces.find((w) => w.id === id)?.tabs.length),
        () => select({ kind: 'browser', id }),
      ),
    ),
    connectionId,
  );
}
export function openTerminal(connectionId: string) {
  return run(
    'session',
    api.newTerminal(connectionId).then((id) => selectCreated({ kind: 'terminal', id })),
    connectionId,
  );
}
/** Reconnects a closed connection in place and shows it without opening a terminal. */
export function reconnect(connectionId: string) {
  return run('session', api.reconnect(connectionId).then(showConnection), connectionId);
}
export const removeConnection = (connectionId: string) =>
  run('session', api.removeConnection(connectionId), connectionId);

export const remoteRefreshing = new Set<string>();
const finishRefresh = (connectionId: string) => { remoteRefreshing.delete(connectionId); render(); };
api.onHelperMessage('sessions.snapshot', ({ connectionId }) => finishRefresh(connectionId));
api.onHelperMessage('helper.error', ({ connectionId }) => finishRefresh(connectionId));
onRender(() => {
  for (const id of remoteRefreshing) if (!connectionOf(id)?.remoteSessions) remoteRefreshing.delete(id);
});
export async function refreshRemoteSessions(connectionId: string) {
  if (remoteRefreshing.has(connectionId)) return;
  remoteRefreshing.add(connectionId); render();
  try { await api.sendHelperMessage(connectionId, { type: 'sessions.refresh' }); }
  catch (error) { finishRefresh(connectionId); await run('session', Promise.reject(error), connectionId); }
}

export const remoteOpening = new Set<string>();
/** The live terminal of this connection showing a session, which is what makes it one already open here. */
export const remoteTerminal = (connectionId: string, session: RemoteSession) =>
  store.state.terminals.find(
    (t) => t.connectionId === connectionId && t.remoteSession?.key === session.key && t.status !== 'closed',
  );
export const remoteVisible = (connection: Connection) => Boolean(connection.remoteSessions &&
  (connection.remoteSessions.sessions.length || connection.remoteSessions.errors.length || remoteOpening.has(connection.id)));
export async function resumeRemoteSessions(connectionId: string, keys: string[], takeover: boolean) {
  if (remoteOpening.has(connectionId)) return;
  const token = choice;
  remoteOpening.add(connectionId); render();
  const opened = await run('session', api.resumeRemoteSessions(connectionId, keys, takeover), connectionId);
  remoteOpening.delete(connectionId);
  if (token === choice && opened?.length) selectCreated({ kind: 'terminal', id: opened[0] });
  else if (store.selection?.kind === 'remote' && store.selection.id === connectionId && connectionOf(connectionId) && !remoteVisible(connectionOf(connectionId)!)) revisit(connectionId);
  render();
}
