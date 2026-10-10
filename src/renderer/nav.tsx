import { remoteVisible } from './store';
import { createContext, useContext, useLayoutEffect, useRef, type CSSProperties, type DragEvent, type HTMLAttributes, type ReactNode, type SyntheticEvent } from 'react';
import { browserSessionName, pageAddress, type BrowserAction, type Workspace, type BrowserTab, type TerminalSession } from '../shared';
import { Icon, IconButton, Tags, colorStyle, moveFocus } from './ui';
import {
  api,
  store,
  run,
  select,
  selectTab,
  activateTab,
  activeTab,
  groups,
  connectionOf,
  terminalName,
  sessionColor,
  statusText,
  openTerminal,
  openBrowser,
  openApplication,
  applicationIcon,
  openBrowserTab,
  render,
  reconnect,
  removeConnection,
  onFocusRequest,
  dialogOpen,
  scopeKeys,
  moveKey,
  sessionTabs,
  revisit,
  activeManifest,
  type Group,
} from './store';
import { openMenu, connectionChanges, type MenuItem } from './menu';
import { faviconOf, dropFavicon } from './tab-state';
import { hasCurrent } from './errors';
import { openDetails } from './details';
import { Identicon, destinationSeed } from './identicon';

const actionsStyle = (count: number) => ({ '--actions': count }) as CSSProperties;
/** Whether rows show their labels as their titles, for a theme that lays the rows out without their labels in sight. */
export const LabelTitles = createContext(false);
/** The unit being dragged, and the unit marked where it would land with the key it would land before. */
let dragged: { scope: string; key: string; element: HTMLElement } | undefined;
let marked: { element: HTMLElement; before?: string } | undefined;
const dragType = 'application/x-bartizan-order';
function mark(element?: HTMLElement, after = false, before?: string) {
  marked?.element.classList.remove('drop-before', 'drop-after');
  marked = element && { element, before };
  element?.classList.add(after ? 'drop-after' : 'drop-before');
}
// A drop anywhere in the window moves the dragged unit to the marked place.
document.addEventListener('dragover', (event) => {
  if (marked && event.dataTransfer?.types.includes(dragType)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }
});
document.addEventListener('drop', (event) => {
  if (!event.dataTransfer?.types.includes(dragType)) return;
  event.preventDefault();
  if (dragged && marked) moveKey(dragged.scope, dragged.key, marked.before);
  mark();
});
/** The focusable items of navigation, all draggable but Home; row buttons belong to the item before them. */
export const navItems = '.nav-item, .connection-titles, .home-button';
/** Whether the theme's lists run across the window. */
const horizontal = () => activeManifest().axis === 'horizontal';
const handleOf = (event: SyntheticEvent<HTMLElement>) => {
  const handle = (event.target as Element).closest<HTMLElement>(navItems);
  return handle?.closest('[data-order-key]') === event.currentTarget ? handle : undefined;
};
/**
 * Lets a unit of navigation move among the units of its scope by dragging its main button or from its context menu,
 * which starts with `actions`; the menu closes as connection `connectionId`, which they depend on, connects or
 * disconnects. Nested units see events first; a unit leaves events for other scopes to the unit around it.
 */
export function orderable(scope: string, key: string, actions: MenuItem[] = [], connectionId?: string) {
  const place = (event: DragEvent<HTMLElement>) => {
    const keys = scopeKeys(scope),
      box = event.currentTarget.getBoundingClientRect();
    const after = horizontal() ? event.clientX > box.left + box.width / 2 : event.clientY > box.top + box.height / 2;
    const before = after ? keys[keys.indexOf(key) + 1] : key;
    return { after, before, unchanged: before === dragged!.key || keys[keys.indexOf(dragged!.key) + 1] === before };
  };
  const ours = (event: DragEvent<HTMLElement>) =>
    dragged?.scope === scope && event.dataTransfer.types.includes(dragType);
  const moveBy = (offset: -1 | 1) => {
    const keys = scopeKeys(scope),
      index = keys.indexOf(key);
    if (index >= 0 && keys[index + offset] !== undefined) moveKey(scope, key, keys[offset < 0 ? index - 1 : index + 2]);
  };
  return {
    'data-order-key': key,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      if (!handleOf(event)) return;
      mark();
      dragged?.element.classList.remove('dragging');
      dragged = { scope, key, element: event.currentTarget };
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(dragType, key);
      event.currentTarget.classList.add('dragging');
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!ours(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      const { after, before, unchanged } = place(event);
      mark(unchanged ? undefined : event.currentTarget, after, before);
    },
    onDragEnd: () => {
      dragged?.element.classList.remove('dragging');
      dragged = undefined;
      mark();
    },
    onContextMenu: (event: SyntheticEvent<HTMLElement>) => {
      const handle = handleOf(event);
      if (!handle) return;
      event.preventDefault();
      const keys = scopeKeys(scope),
        index = keys.indexOf(key);
      openMenu(handle, [
        ...actions,
        { label: horizontal() ? 'Move Left' : 'Move Up', disabled: index <= 0, action: () => moveBy(-1) },
        { label: horizontal() ? 'Move Right' : 'Move Down', disabled: index < 0 || index >= keys.length - 1, action: () => moveBy(1) },
      ], { stale: connectionId === undefined ? undefined : connectionChanges(connectionId) });
    },
  } as HTMLAttributes<HTMLElement>;
}
function Row({
  kind,
  id,
  label,
  current,
  meta = '',
  icon,
  actions,
  persistent,
  onSelect,
  tag: Tag = 'li',
  className = '',
  outer = {},
  tooltip,
  ...props
}: {
  draggable?: boolean;
  kind: string;
  id: string;
  label: string;
  current?: 'page' | 'true';
  meta?: string;
  icon: ReactNode;
  /** Buttons shown beside the row while it is hovered, focused or current; ones with the `persistent` class always show. */
  actions: ReactNode[];
  persistent?: boolean;
  onSelect(): void;
  tag?: 'li' | 'div';
  className?: string;
  outer?: React.HTMLAttributes<HTMLElement>;
  /** The tooltip, where the theme shows the label; a theme that leaves the label out of sight shows it as the tooltip. */
  tooltip?: string;
  'aria-description'?: string;
  'data-status'?: string;
  'data-state'?: string;
  'data-workspace'?: string;
}) {
  const titled = useContext(LabelTitles);
  return (
    <Tag
      className={`row ${current ? 'current' : ''} ${persistent ? 'has-persistent' : ''} ${actions.some(Boolean) ? 'has-actions' : ''} ${className}`.replace(/\s+/g, ' ').trim()}
      {...outer}
      style={{ ...actionsStyle(actions.filter(Boolean).length), ...outer.style }}
    >
      <button
        type="button"
        className="nav-item"
        draggable
        data-kind={kind}
        data-id={id}
        aria-current={current}
        onClick={onSelect}
        data-tooltip={titled ? label : tooltip}
        {...props}
      >
        <span className="nav-icon">{icon}</span>
        <span className="nav-label">{label}</span>
        <span className="nav-meta">{meta}</span>
      </button>
      <span className="row-actions">{actions}</span>
    </Tag>
  );
}
function TerminalRow({ terminal }: { terminal: TerminalSession }) {
  const name = terminalName(terminal);
  return (
    <Row
      tag="div"
      kind="terminal"
      id={terminal.id}
      label={name}
      current={store.selection?.kind === 'terminal' && store.selection.id === terminal.id ? 'page' : undefined}
      meta={
        terminal.status === 'closed' && connectionOf(terminal.connectionId)?.status === 'connected' ? 'Closed' : ''
      }
      data-status={terminal.status}
      icon={<Icon name="terminal" />}
      onSelect={() => select({ kind: 'terminal', id: terminal.id })}
      actions={[
        terminal.status === 'closed' && connectionOf(terminal.connectionId)?.status === 'connected' && <IconButton
          key="reconnect"
          icon="reload"
          label={`Reconnect ${name}`}
          onClick={() => void run('session', api.reconnectTerminal(terminal.id), terminal.connectionId)}
        />,
        <IconButton
          key="close"
          icon="close"
          label={`Close ${name}`}
          tooltip="Close Terminal"
          className="row-close"
          onClick={() => void run('session', api.closeTerminal(terminal.id), terminal.connectionId)}
        />,
      ]}
    />
  );
}
const toggleMute = (workspace: Workspace, tab: BrowserTab) =>
  void run('browser', api.browser(workspace.id, 'mute', tab.id), workspace.connectionId);
/** Closes tabs of a session one after another; the one kept takes the place of the active tab if that closes. */
function closeTabs(workspace: Workspace, kept: BrowserTab, closing: BrowserTab[]) {
  if (closing.some((tab) => tab.id === activeTab(workspace)?.id)) activateTab(workspace.id, kept.id);
  void run('browser', (async () => { for (const tab of closing) await api.browser(workspace.id, 'close', tab.id); })(), workspace.connectionId);
}
/** The commands of a tab's row, ahead of those that move it. */
function tabActions(workspace: Workspace, tab: BrowserTab): MenuItem[] {
  const act = (action: BrowserAction, url?: string) => void run('browser', api.browser(workspace.id, action, tab.id, url), workspace.connectionId);
  const tabs = sessionTabs(workspace), below = tabs.slice(tabs.findIndex((item) => item.id === tab.id) + 1);
  return [
    { label: 'Reload', icon: 'reload', disabled: !tab.url, action: () => act('reload') },
    { label: 'Duplicate Tab', disabled: !pageAddress(tab.url), action: () => act('new', tab.url) },
    { label: 'Copy Address', icon: 'link', disabled: !tab.url, action: () => void run('browser', api.copy(tab.url), workspace.connectionId) },
    ...(store.state.capabilities.externalBrowser ? [{ label: 'Open in External Browser', icon: 'external' as const, disabled: !/^https?:/i.test(tab.url), action: () => act('external') }] : []),
    { separator: true },
    { label: tab.muted ? 'Unmute Tab' : 'Mute Tab', icon: tab.muted ? 'volume' : 'volume-off', action: () => toggleMute(workspace, tab) },
    { separator: true },
    { label: 'Close Tab', icon: 'close', action: () => act('close') },
    { label: 'Close Other Tabs', disabled: tabs.length < 2, action: () => closeTabs(workspace, tab, tabs.filter((item) => item.id !== tab.id)) },
    { label: horizontal() ? 'Close Tabs to the Right' : 'Close Tabs Below', disabled: !below.length, action: () => closeTabs(workspace, tab, below) },
    { label: 'Reopen Closed Tab', disabled: !workspace.closedTabs, action: () => act('reopen') },
    { separator: true },
  ];
}
function TabRow({
  workspace,
  tab,
  outer = {},
  tag,
}: {
  workspace: Workspace;
  tab: BrowserTab;
  outer?: React.HTMLAttributes<HTMLElement>;
  tag?: 'li' | 'div';
}) {
  const title = tab.title,
    state = tab.certificate ? 'certificate' : tab.loading ? 'loading' : tab.error ? 'error' : 'idle';
  const favicon = state === 'idle' ? faviconOf(tab.id) : undefined;
  const sound = tab.audible || tab.muted;
  return (
    <Row
      tag={tag}
      outer={outer}
      kind="tab"
      id={tab.id}
      data-workspace={workspace.id}
      label={title}
      tooltip={workspace.application ? undefined : tab.url || undefined}
      aria-description={workspace.application ? undefined : tab.url || undefined}
      data-state={state}
      current={
        store.selection?.kind === 'browser' &&
        store.selection.id === workspace.id &&
        activeTab(workspace)?.id === tab.id
          ? 'page'
          : undefined
      }
      icon={
        state === 'loading' ? (
          <span className="spinner" />
        ) : favicon ? (
          <img className="favicon" src={favicon} alt="" draggable={false} onError={() => dropFavicon(tab.id)} />
        ) : (
          <Icon name={state === 'error' || state === 'certificate' ? 'alert' : workspace.application ? applicationIcon(workspace.application.application) : 'globe'} />
        )
      }
      onSelect={() => selectTab(workspace.id, tab.id)}
      persistent={sound}
      actions={[
        sound && (
          <IconButton
            key="mute"
            icon={tab.muted ? 'volume-off' : 'volume'}
            label={`${tab.muted ? 'Unmute' : 'Mute'} ${title}`}
            tooltip={tab.muted ? 'Unmute Tab' : 'Mute Tab'}
            className="row-mute persistent"
            aria-pressed={tab.muted}
            onClick={() => toggleMute(workspace, tab)}
          />
        ),
        <IconButton
          key="close"
          icon="close"
          label={`Close Tab ${title}`}
          tooltip="Close Tab"
          className="row-close"
          onClick={() => void run('browser', api.browser(workspace.id, 'close', tab.id), workspace.connectionId)}
        />,
      ]}
    />
  );
}
/** The browser session whose name is being edited. */
let renaming: string | undefined;
export const renamingSession = () => renaming;
export function renameSession(id: string) {
  renaming = id;
  render();
}
function SessionName({ workspace }: { workspace: Workspace }) {
  const field = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  const finish = (name?: string) => {
    if (renaming !== workspace.id) return;
    renaming = undefined;
    render();
    if (name !== undefined && store.state.workspaces.some((w) => w.id === workspace.id))
      void run('browser', api.renameBrowser(workspace.id, name.replace(/[\x00-\x1f\x7f]/g, ' ')), workspace.connectionId);
  };
  return (
    <div className="row session-row">
      <input
        ref={field}
        className="input session-name"
        aria-label="Session Name"
        data-id={workspace.id}
        defaultValue={browserSessionName(workspace)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key !== 'Enter' && event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          finish(event.key === 'Enter' ? event.currentTarget.value : undefined);
        }}
        // Switching to another window keeps the field open.
        onBlur={(event) => document.hasFocus() && finish(event.currentTarget.value)}
      />
    </div>
  );
}
function Session({ workspace }: { workspace: Workspace }) {
  if (workspace.application) return <>{workspace.tabs.map(tab => <TabRow key={tab.id} tag="div" workspace={workspace} tab={tab} />)}</>;
  return (
    <>
      {renaming === workspace.id ? <SessionName workspace={workspace} /> : <Row
        tag="div"
        className="session-row"
        kind="browser"
        id={workspace.id}
        label={browserSessionName(workspace)}
        current={store.selection?.kind === 'browser' && store.selection.id === workspace.id ? 'true' : undefined}
        icon={<Icon name="window" />}
        onSelect={() => {
          const first = sessionTabs(workspace)[0];
          if (first) selectTab(workspace.id, first.id);
          else void openBrowserTab(workspace.connectionId, workspace.id);
        }}
        actions={[
          <IconButton
            key="new"
            icon="plus"
            label={`New Tab in ${browserSessionName(workspace)}`}
            tooltip="New Tab"
            className="row-new"
            onClick={() => void openBrowserTab(workspace.connectionId, workspace.id)}
          />,
          <IconButton
            key="close"
            icon="close"
            label={`Close ${browserSessionName(workspace)}`}
            tooltip="Close Browser Session"
            className="row-close"
            onClick={() =>
              void run('browser', api.browser(workspace.id, 'close-workspace'), workspace.connectionId)
            }
          />,
        ]}
      />}
      <ul className="tab-items">
        {sessionTabs(workspace).map((tab) => (
          <TabRow
            key={tab.id}
            workspace={workspace}
            tab={tab}
            outer={orderable(`tabs:${workspace.id}`, tab.id, tabActions(workspace, tab))}
          />
        ))}
      </ul>
    </>
  );
}
/** The buttons that act on a connection: add a terminal or browser session, disconnect or cancel, reconnect and remove. */
export function ConnectionTools({ connection }: { connection: Group['connection'] }) {
  const id = connection.id;
  const control = (label: string) => `${label} ${connection.label}`;
  const embeddedBrowser = store.state.capabilities.embeddedBrowser;
  return (
    <span key={id} className="connection-tools">
      <IconButton
        icon="plus"
        label={control(embeddedBrowser ? 'Add' : 'New Terminal')}
        tooltip={embeddedBrowser ? 'Add' : 'New Terminal'}
        className="connection-add"
        hidden={connection.status !== 'connected'}
        aria-haspopup={embeddedBrowser ? 'menu' : undefined}
        onClick={(event) => embeddedBrowser ?
          openMenu(event.currentTarget, [
            { label: 'Terminal', icon: 'terminal', action: () => void openTerminal(id) },
            { label: 'Browser Session', icon: 'window', action: () => void openBrowser(id) },
            { separator: true },
            ...(connection.installed?.includes('t3') ? [{ label: 'T3 Code', icon: applicationIcon('t3'), action: () => void openApplication(id, 't3') }] : []),
            { label: 'Visual Studio Code', icon: applicationIcon('vscode'), action: () => void openApplication(id, 'vscode') },
          ], { stale: connectionChanges(id) }) : void openTerminal(id)
        }
      />
      <IconButton
        icon="power"
        label={control(connection.status === 'connecting' ? 'Cancel' : 'Disconnect')}
        tooltip={connection.status === 'connecting' ? 'Cancel' : 'Disconnect'}
        className="connection-disconnect"
        hidden={connection.status === 'closed'}
        onClick={() => void run('session', api.disconnect(id), id)}
      />
      <IconButton
        icon="reload"
        label={control('Reconnect')}
        tooltip="Reconnect"
        className="connection-reconnect"
        hidden={connection.status !== 'closed'}
        onClick={() => void reconnect(id)}
      />
      <IconButton
        icon="close"
        label={control('Remove')}
        tooltip="Remove"
        className="connection-remove"
        hidden={connection.status !== 'closed'}
        onClick={() => void removeConnection(id)}
      />
    </span>
  );
}
/** A connection's terminals and browser sessions with their tabs, in the order the user gave them. */
export function ConnectionItems({ group: { connection, entries } }: { group: Group }) {
  return (
    <ul className="connection-items">
      {entries.map((entry) => (
        <li
          key={entry.key}
          className={entry.workspace && !entry.workspace.application ? 'session' : 'row-entry'}
          {...orderable(
            `items:${connection.id}`,
            entry.key,
            entry.workspace && !entry.workspace.application ? [{ label: 'Rename', action: () => renameSession(entry.workspace!.id) }] : [],
          )}
          style={colorStyle(entry.workspace && sessionColor(entry.workspace))}
        >
          {entry.terminal ? <TerminalRow terminal={entry.terminal} /> : <Session workspace={entry.workspace!} />}
        </li>
      ))}
      {remoteVisible(connection) && <li className="pinned-entry remote-entry">
        <Row tag="div" kind="remote" id={connection.id} label="Remote Sessions" icon={<Icon name="terminal" />}
          draggable={false} actions={[]}
          current={store.selection?.kind === 'remote' && store.selection.id === connection.id ? 'page' : undefined}
          onSelect={() => select({ kind: 'remote', id: connection.id })} />
      </li>}
      <li className="pinned-entry details-entry">
        <Row tag="div" kind="details" id={connection.id} label="Connection Details" icon={<Icon name="info" />}
          draggable={false} actions={[]}
          current={store.selection?.kind === 'details' && store.selection.id === connection.id ? 'page' : undefined}
          onSelect={() => openDetails(connection.id)} />
      </li>
    </ul>
  );
}
/** A connection's status, label and current problem, as the head of its entry shows them. */
export function ConnectionName({ connection }: { connection: Group['connection'] }) {
  return (
    <span className="connection-name">
      <span className="status-dot" role="img" aria-label={statusText(connection)} data-status={connection.status} />
      <span className="connection-label">{connection.label}</span>
      {hasCurrent(connection.id) && (
        <span className="connection-alert" role="img" aria-label="Error">
          <Icon name="alert" />
        </span>
      )}
    </span>
  );
}
/**
 * Every connection as a compact button, for themes that list a connection's items elsewhere. Choosing one returns to
 * what it last showed. Its menu holds the commands of a connection's entry. `current` is the connection in view.
 */
export function ConnectionChips({ current }: { current?: string }) {
  return (
    <ul className="connection-chips">
      {groups().map(({ connection }) => {
        const id = connection.id,
          connected = connection.status === 'connected',
          closed = connection.status === 'closed';
        return (
          <li
            key={id}
            className="connection-chip"
            data-kind="connection"
            data-id={id}
            data-status={connection.status}
            {...orderable('connections', id, [
              { label: 'New Terminal', icon: 'terminal', disabled: !connected, action: () => void openTerminal(id) },
              ...(store.state.capabilities.embeddedBrowser ? [{ label: 'New Browser Session', icon: 'window' as const, disabled: !connected, action: () => void openBrowser(id) }] : []),
              { separator: true },
              closed
                ? { label: 'Reconnect', icon: 'reload', action: () => void reconnect(id) }
                : { label: connected ? 'Disconnect' : 'Cancel', icon: 'power', action: () => void run('session', api.disconnect(id), id) },
              { label: 'Remove', icon: 'close', disabled: !closed, action: () => void removeConnection(id) },
              { label: 'Connection Details', icon: 'info', action: () => void openDetails(id) },
              { separator: true },
            ], id)}
          >
            <button
              type="button"
              draggable
              className="connection-titles"
              data-id={id}
              data-tooltip={connection.label}
              aria-current={current === id ? 'true' : undefined}
              onClick={() => revisit(id)}
            >
              <Identicon seed={connection.profileId ?? destinationSeed(connection.host, connection.username)} />
              <ConnectionName connection={connection} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
/**
 * A region of navigation: arrow keys along the theme's axis, Home and End move among its items, focus lost inside it
 * stays in it, and a selected connection's button takes focus when the view asks for it.
 */
export function NavGroup({ name, className, children }: { name: string; className?: string; children: ReactNode }) {
  const region = useRef<HTMLDivElement>(null);
  useLayoutEffect(
    () =>
      onFocusRequest(() => {
        const selection = store.selection;
        if (selection?.kind === 'connection' && !dialogOpen())
          region.current
            ?.querySelector<HTMLElement>(`[data-kind="connection"][data-id="${CSS.escape(selection.id)}"] .connection-titles`)
            ?.focus();
      }),
    [],
  );
  return (
    <div
      ref={region}
      className={className}
      data-focus-group={name}
      data-focus-items={navItems}
      onKeyDown={(event) => {
        const items = [...region.current!.querySelectorAll<HTMLElement>(navItems)].filter((item) => item.offsetParent !== null);
        const across = horizontal();
        const key = across ? ({ ArrowLeft: 'ArrowUp', ArrowRight: 'ArrowDown', ArrowUp: '', ArrowDown: '' }[event.key] ?? event.key) : event.key;
        if (key && moveFocus(items, key)) event.preventDefault();
      }}
    >
      {children}
    </div>
  );
}
