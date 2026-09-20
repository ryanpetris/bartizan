import { useState } from 'react';
import { type Connection, type RemoteSession } from '../shared';
import { store, connectionOf, remoteOpening, remoteRefreshing, refreshRemoteSessions, resumeRemoteSessions, remoteTerminal, select } from './store';
import { Button, Icon, IconButton, type IconName } from './ui';
import { pageName } from './chrome';
import { Notice, Picker, type PickerRow } from './picker';
import { openMenu } from './menu';
import { openKill } from './kill-session';

/** What a session is doing for this connection, which decides its mark, its detail and its action. */
type Standing = 'open' | 'error' | 'attached' | 'detached';
const standingOf = (connectionId: string, session: RemoteSession): Standing =>
  remoteTerminal(connectionId, session) ? 'open' : session.attached ? 'attached' : session.error ? 'error' : 'detached';
/** The mark at the end of a row, which is what clicking it does. */
const actions: Record<Standing, { label: string; icon: IconName }> = {
  open: { label: 'Go To', icon: 'forward' },
  error: { label: 'Retry', icon: 'reload' },
  attached: { label: 'Take Over', icon: 'link' },
  detached: { label: 'Resume', icon: 'external' },
};
function detailOf(session: RemoteSession, standing: Standing) {
  return session.error || [session.detail, standing === 'open' && 'open here'].filter(Boolean).join(' · ');
}
const matches = (session: RemoteSession, query: string) =>
  [session.label, session.detail, session.group].some(field => field.toLowerCase().includes(query));

/** The page belongs to the connection in view, so each visit to it starts from that connection's whole list. */
export function RemoteSessions() {
  const connection = store.selection?.kind === 'remote' ? connectionOf(store.selection.id) : undefined;
  const state = connection?.remoteSessions;
  return connection && state ? <RemoteSessionsPage key={connection.id} connection={connection} state={state} /> : null;
}
/** The sessions a connection's host is running, each in the state it is in, and what resuming it would do. */
function RemoteSessionsPage({ connection, state }: { connection: Connection; state: NonNullable<Connection['remoteSessions']> }) {
  const [query, setQuery] = useState('');
  const busy = remoteOpening.has(connection.id);
  const narrowed = query.trim().toLowerCase();
  const open = (keys: string[], takeover: boolean) => void resumeRemoteSessions(connection.id, keys, takeover);
  const act = (session: RemoteSession) => {
    const terminal = remoteTerminal(connection.id, session);
    if (terminal) select({ kind: 'terminal', id: terminal.id });
    // Only a session shown as attached is taken over; retrying one that failed asks for it no more forcefully.
    else open([session.key], standingOf(connection.id, session) === 'attached');
  };
  const menuFor = (session: RemoteSession) => {
    const terminal = remoteTerminal(connection.id, session);
    return [
      ...(terminal ? [{ label: 'Go To', action: () => select({ kind: 'terminal', id: terminal.id }) }] : [
        { label: 'Resume', disabled: busy || session.attached || !session.commands.resume, action: () => open([session.key], false) },
        { label: 'Take Over', disabled: busy || !session.commands.takeover, action: () => open([session.key], true) },
      ]),
      { separator: true as const },
      { label: 'Kill Session', disabled: busy || !session.commands.stop, action: () => openKill(connection.id, session) },
    ];
  };
  // Sessions are grouped and sorted by the labels supplied by the helper.
  const shown = state.sessions.filter(session => matches(session, narrowed)).sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
  const groups = new Set(shown.map(session => session.group));
  const resumable = shown.filter(session => !remoteTerminal(connection.id, session));
  const ordinary = resumable.filter(session => !session.attached && session.commands.resume);
  const rows = shown.map((session): PickerRow => {
    const standing = standingOf(connection.id, session);
    return {
      key: session.key,
      group: groups.size > 1 ? session.group : undefined,
      className: 'remote-row',
      disabled: busy,
      row: {
        'data-standing': standing,
        'data-error': session.error ? '' : undefined,
        onContextMenu: event => { event.preventDefault(); openMenu(event.currentTarget, menuFor(session)); },
      },
      item: { className: 'remote-item' },
      choose: () => act(session),
      content: <>
        <span className="tile" aria-hidden="true">
          <Icon name="terminal" />
          <span className="status-dot" data-standing={session.error ? 'error' : standing} />
        </span>
        <span className="hidden-text">{session.group}</span>
        <span className="item-titles">
          <span className="item-label">{session.label}</span>
          <span className="item-detail">{detailOf(session, standing)}</span>
        </span>
        <span className="remote-action" title={actions[standing].label}>
          <Icon name={actions[standing].icon} />
          <span className="hidden-text">{actions[standing].label}</span>
        </span>
      </>,
    };
  });
  return <Picker name="remote-sessions" className="remote-sessions" title={pageName.remote} searchLabel="Search Sessions"
    query={query} onQuery={setQuery} rows={rows} busy={busy}
    notices={state.errors.length ? state.errors.map(({ source, message }) =>
      <Notice key={(source ?? '') + message}>{message}</Notice>) : undefined}
    empty={<p className="section-empty" hidden={!!state.sessions.length || state.loading}>No Remote Sessions</p>}
    actions={<>
      <div className="split-button">
        <Button disabled={busy || !ordinary.length} onClick={() => open(ordinary.map(s => s.key), false)}>Resume All</Button>
        <button type="button" className="button split-more" aria-label="More Session Actions" aria-haspopup="menu" disabled={busy || !resumable.length}
          onClick={event => openMenu(event.currentTarget, [{ label: 'Take Over All', action: () => open(resumable.map(s => s.key), true) }])}><Icon name="down" /></button>
      </div>
      <IconButton icon="reload" label="Refresh" disabled={remoteRefreshing.has(connection.id)}
        onClick={() => void refreshRemoteSessions(connection.id)} />
    </>} />;
}
