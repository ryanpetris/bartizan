import { useState } from 'react';
import { backends, backendName, type Connection, type RemoteSession } from '../shared';
import { api, store, connectionOf, run, remoteOpening, resumeRemoteSessions, remoteTerminal, select } from './store';
import { Button, Icon, IconButton, type IconName } from './ui';
import { pageName } from './chrome';
import { Notice, Picker, type PickerRow } from './picker';
import { openMenu } from './menu';
import { openKill } from './kill-session';

/** What a session is doing for this connection, which decides its mark, its detail and its action. */
type Standing = 'open' | 'error' | 'attached' | 'detached';
const standingOf = (connectionId: string, session: RemoteSession): Standing =>
  remoteTerminal(connectionId, session) ? 'open' : session.clients > 0 ? 'attached' : session.error ? 'error' : 'detached';
/** The mark at the end of a row, which is what clicking it does. */
const actions: Record<Standing, { label: string; icon: IconName }> = {
  open: { label: 'Go To', icon: 'forward' },
  error: { label: 'Retry', icon: 'reload' },
  attached: { label: 'Take Over', icon: 'link' },
  detached: { label: 'Resume', icon: 'external' },
};
const plural = (count: number, noun: string) => `${count} ${count === 1 ? noun : noun + 's'}`;
function since(epoch: number) {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - epoch);
  if (seconds < 60) return 'active now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `active ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `active ${hours}h ago` : `active ${Math.floor(hours / 24)}d ago`;
}
/** What a session holds, where it is and what it is doing, to the depth its backend reports. */
function detailOf(session: RemoteSession, standing: Standing) {
  if (session.error) return session.error;
  const parts = [];
  if (session.windows) parts.push(plural(session.windows, session.backend === 'herdr' ? 'tab' : 'window'));
  if (session.where) parts.push(session.where);
  if (session.doing) parts.push(session.doing);
  if (standing === 'open') parts.push('open here');
  else if (session.clients > 0) parts.push(plural(session.clients, 'client'));
  else if (session.activity) parts.push(since(session.activity));
  return parts.join(' · ');
}
const matches = (session: RemoteSession, query: string) =>
  [session.name, session.where, backendName(session.backend)].some(field => field?.toLowerCase().includes(query));

/** The page belongs to the connection in view, so each visit to it starts from that connection's whole list. */
export function RemoteSessions() {
  const connection = store.selection?.kind === 'remote' ? connectionOf(store.selection.id) : undefined;
  const state = connection?.remoteSessions;
  return connection && state ? <RemoteSessionsPage key={connection.id} connection={connection} state={state} /> : null;
}
/** The sessions a connection's host is running, each in the state it is in, and what resuming it would do. */
function RemoteSessionsPage({ connection, state }: { connection: Connection; state: NonNullable<Connection['remoteSessions']> }) {
  const [query, setQuery] = useState('');
  const busy = remoteOpening.has(connection.id) || state.loading;
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
        { label: 'Resume', disabled: busy || session.clients > 0, action: () => open([session.key], false) },
        { label: 'Take Over', disabled: busy, action: () => open([session.key], true) },
      ]),
      { separator: true as const },
      { label: 'Kill Session', disabled: busy, action: () => openKill(connection.id, session) },
    ];
  };
  // Sessions stand under their backend, in the order the backends are listed.
  const shown = backends.flatMap(backend => state.sessions.filter(session => session.backend === backend && matches(session, narrowed)));
  const groups = new Set(shown.map(session => session.backend));
  const resumable = shown.filter(session => !remoteTerminal(connection.id, session));
  const ordinary = resumable.filter(session => session.clients === 0);
  const rows = shown.map((session): PickerRow => {
    const standing = standingOf(connection.id, session);
    return {
      key: session.key,
      group: groups.size > 1 ? backendName(session.backend) : undefined,
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
        <span className="hidden-text">{backendName(session.backend)}</span>
        <span className="item-titles">
          <span className="item-label">{session.name}</span>
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
    notices={state.errors.length ? state.errors.map(({ backend, message }) =>
      <Notice key={(backend ?? '') + message} title={backend && backendName(backend)}>{message}</Notice>) : undefined}
    empty={<p className="section-empty" hidden={!!state.sessions.length || state.loading}>No Remote Sessions</p>}
    actions={<>
      <div className="split-button">
        <Button disabled={busy || !ordinary.length} onClick={() => open(ordinary.map(s => s.key), false)}>Resume All</Button>
        <button type="button" className="button split-more" aria-label="More Session Actions" aria-haspopup="menu" disabled={busy || !resumable.length}
          onClick={event => openMenu(event.currentTarget, [{ label: 'Take Over All', action: () => open(resumable.map(s => s.key), true) }])}><Icon name="down" /></button>
      </div>
      <IconButton icon="reload" label="Refresh" disabled={busy}
        onClick={() => void run('session', api.discoverRemoteSessions(connection.id), connection.id)} />
    </>} />;
}
