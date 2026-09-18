import { useLayoutEffect, useRef, type CSSProperties, type DragEvent, type HTMLAttributes, type ReactNode, type SyntheticEvent } from 'react';
import { browserSessionName, type Workspace, type BrowserTab, type TerminalSession } from '../shared';
import { Icon, IconButton, Tags, colorStyle, moveFocus } from './ui';
import {
  api,
  store,
  run,
  select,
  selectTab,
  activeTab,
  groups,
  endpoint,
  connectionOf,
  terminalName,
  sessionColor,
  tabTitle,
  statusText,
  openTerminal,
  openBrowser,
  openBrowserTab,
  render,
  reconnect,
  removeConnection,
  onFocusRequest,
  dialogOpen,
  scopeKeys,
  moveKey,
  sessionTabs,
  type Group,
} from './store';
import { openMenu, type MenuItem } from './menu';
import { faviconOf, dropFavicon } from './tab-state';
import { Connect } from './connect';
import { openConnection } from './connection-form';
import { Toasts, ErrorsButton, hasCurrent } from './errors';

const actionsStyle = (count: number) => ({ '--actions': count }) as CSSProperties;
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
  if (marked && event.dataTransfer?.types.includes(dragType)) event.preventDefault();
});
document.addEventListener('drop', (event) => {
  if (!event.dataTransfer?.types.includes(dragType)) return;
  event.preventDefault();
  if (dragged && marked) moveKey(dragged.scope, dragged.key, marked.before);
  mark();
});
/** The sidebar's focusable and draggable items; row buttons belong to the item before them. */
const sidebarItems = '.nav-item, .connection-titles';
const handleOf = (event: SyntheticEvent<HTMLElement>) => {
  const handle = (event.target as Element).closest<HTMLElement>(sidebarItems);
  return handle?.closest('[data-order-key]') === event.currentTarget ? handle : undefined;
};
/**
 * Lets a sidebar unit move among the units of its scope by dragging its main button or from its context menu, which
 * starts with `actions`. Nested units see events first; a unit leaves events for other scopes to the unit around it.
 */
function orderable(scope: string, key: string, actions: MenuItem[] = []) {
  const place = (event: DragEvent<HTMLElement>) => {
    const keys = scopeKeys(scope),
      box = event.currentTarget.getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2;
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
        { label: 'Move Up', disabled: index <= 0, action: () => moveBy(-1) },
        { label: 'Move Down', disabled: index < 0 || index >= keys.length - 1, action: () => moveBy(1) },
      ]);
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
  ...props
}: {
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
  title?: string;
  'data-status'?: string;
  'data-state'?: string;
  'data-workspace'?: string;
}) {
  return (
    <Tag
      className={`row ${current ? 'current' : ''} ${persistent ? 'has-persistent' : ''} ${className}`.replace(/\s+/g, ' ').trim()}
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
        <IconButton
          key="close"
          icon="close"
          label={`Close ${name}`}
          title="Close Terminal"
          className="row-close"
          onClick={() => void run('session', api.closeTerminal(terminal.id), terminal.connectionId)}
        />,
      ]}
    />
  );
}
const toggleMute = (workspace: Workspace, tab: BrowserTab) =>
  void run('browser', api.browser(workspace.id, 'mute', tab.id), workspace.connectionId);
function TabRow({
  workspace,
  tab,
  outer = {},
}: {
  workspace: Workspace;
  tab: BrowserTab;
  outer?: React.HTMLAttributes<HTMLElement>;
}) {
  const title = tabTitle(tab),
    state = tab.certificate ? 'certificate' : tab.loading ? 'loading' : tab.error ? 'error' : 'idle';
  const favicon = state === 'idle' ? faviconOf(tab.id) : undefined;
  const sound = tab.audible || tab.muted;
  return (
    <Row
      outer={outer}
      kind="tab"
      id={tab.id}
      data-workspace={workspace.id}
      label={title}
      title={tab.url || undefined}
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
          <Icon name={state === 'error' || state === 'certificate' ? 'alert' : 'globe'} />
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
            title={tab.muted ? 'Unmute Tab' : 'Mute Tab'}
            className="row-mute persistent"
            aria-pressed={tab.muted}
            onClick={() => toggleMute(workspace, tab)}
          />
        ),
        <IconButton
          key="close"
          icon="close"
          label={`Close Tab ${title}`}
          title="Close Tab"
          className="row-close"
          onClick={() => void run('browser', api.browser(workspace.id, 'close', tab.id), workspace.connectionId)}
        />,
      ]}
    />
  );
}
/** The browser session whose name is being edited. */
let renaming: string | undefined;
function renameSession(id: string) {
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
            title="New Tab"
            className="row-new"
            onClick={() => void openBrowserTab(workspace.connectionId, workspace.id)}
          />,
          <IconButton
            key="close"
            icon="close"
            label={`Close ${browserSessionName(workspace)}`}
            title="Close Browser Session"
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
            outer={orderable(`tabs:${workspace.id}`, tab.id, [
              { label: tab.muted ? 'Unmute Tab' : 'Mute Tab', action: () => toggleMute(workspace, tab) },
            ])}
          />
        ))}
      </ul>
    </>
  );
}
function Connection({ group: { connection, entries, profile } }: { group: Group }) {
  const id = connection.id;
  const control = (label: string) => `${label} ${connection.label}`;
  return (
    <li
      className="connection"
      data-kind="connection"
      data-id={id}
      data-status={connection.status}
      {...orderable('connections', id)}
    >
      <div className="connection-head" title={endpoint(connection)}>
        <button
          type="button"
          draggable
          className="connection-titles"
          aria-current={store.selection?.kind === 'connection' && store.selection.id === id ? 'true' : undefined}
          onClick={() => select({ kind: 'connection', id })}
        >
          <span className="connection-name">
            <span className="status-dot" data-status={connection.status} />
            <span className="connection-label">{connection.label}</span>
            {hasCurrent(id) && (
              <span className="connection-alert" role="img" aria-label="Error">
                <Icon name="alert" />
              </span>
            )}
          </span>
          <span className="connection-endpoint">
            {connection.status === 'connected'
              ? endpoint(connection)
              : `${statusText({ status: connection.status })} · ${endpoint(connection)}`}
          </span>
          <Tags tags={profile?.tags ?? []} />
        </button>
        <span className="connection-tools">
          <IconButton
            icon="plus"
            label={control('Add')}
            title="Add"
            className="connection-add"
            hidden={connection.status !== 'connected'}
            aria-haspopup="menu"
            onClick={(event) =>
              openMenu(event.currentTarget, [
                { label: 'Terminal', action: () => void openTerminal(id) },
                { label: 'Browser Session', action: () => void openBrowser(id) },
              ])
            }
          />
          <IconButton
            icon="power"
            label={control(connection.status === 'connecting' ? 'Cancel' : 'Disconnect')}
            title={connection.status === 'connecting' ? 'Cancel' : 'Disconnect'}
            className="connection-disconnect"
            hidden={connection.status === 'closed'}
            onClick={() => void run('session', api.disconnect(id), id)}
          />
          <IconButton
            icon="reload"
            label={control('Reconnect')}
            title="Reconnect"
            className="connection-reconnect"
            hidden={connection.status !== 'closed'}
            onClick={() => void reconnect(id)}
          />
          <IconButton
            icon="close"
            label={control('Remove')}
            title="Remove"
            className="connection-remove"
            hidden={connection.status !== 'closed'}
            onClick={() => void removeConnection(id)}
          />
        </span>
      </div>
      <ul className="connection-items">
        {entries.map((entry) => (
          <li
            key={entry.key}
            className={entry.terminal ? 'terminal-entry' : 'session'}
            {...orderable(
              `items:${id}`,
              entry.key,
              entry.workspace ? [{ label: 'Rename', action: () => renameSession(entry.workspace!.id) }] : [],
            )}
            style={colorStyle(entry.workspace && sessionColor(entry.workspace))}
          >
            {entry.terminal ? <TerminalRow terminal={entry.terminal} /> : <Session workspace={entry.workspace!} />}
          </li>
        ))}
      </ul>
    </li>
  );
}
let connectionList: HTMLUListElement | null = null;
export function Sidebar() {
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(
    () =>
      onFocusRequest(() => {
        const selection = store.selection;
        if (selection?.kind === 'connection' && !dialogOpen())
          connectionList
            ?.querySelector<HTMLElement>(`.connection[data-id="${CSS.escape(selection.id)}"] .connection-titles`)
            ?.focus();
      }),
    [],
  );
  return (
    <nav className="sidebar" aria-label="Connections">
      <div
        ref={scroller}
        className="sidebar-scroll"
        data-focus-group="sidebar"
        data-focus-items={sidebarItems}
        onKeyDown={(event) => {
          const items = [...scroller.current!.querySelectorAll<HTMLElement>(sidebarItems)].filter(
            (item) => item.offsetParent !== null,
          );
          if (moveFocus(items, event.key)) event.preventDefault();
        }}
      >
        <ul
          ref={(node) => {
            connectionList = node;
          }}
          className="connection-list"
        >
          {groups().map((group) => (
            <Connection key={group.connection.id} group={group} />
          ))}
        </ul>
        <div className="sidebar-empty" hidden={groups().length > 0}>
          <Icon name="terminal" className="icon sidebar-empty-icon" />
          <p>No Connections</p>
        </div>
      </div>
      <Toasts />
      <div className="sidebar-footer">
        <ErrorsButton />
        <Connect />
        <IconButton icon="plus" label="New Connection" aria-haspopup="dialog" onClick={() => openConnection()} />
      </div>
    </nav>
  );
}
