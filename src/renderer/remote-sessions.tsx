import { useLayoutEffect, useRef, useState } from 'react';
import { backends, backendName, type RemoteSession } from '../shared';
import { api, store, render, connectionOf, run, remoteOpening, resumeRemoteSessions, remoteTerminal, onFocusRequest, select } from './store';
import { Button, Icon, IconButton, type IconName } from './ui';
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

export function RemoteSessions() {
  const search = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(''), [current, setCurrent] = useState<string>(), [pointing, setPointing] = useState(false);
  useLayoutEffect(() => onFocusRequest(() => {
    if (store.selection?.kind === 'remote') search.current?.focus();
  }), []);
  const connection = store.selection?.kind === 'remote' ? connectionOf(store.selection.id) : undefined;
  // The search belongs to the connection in view; another one starts from its whole list.
  const viewed = useRef<string>(undefined);
  useLayoutEffect(() => {
    if (!connection || viewed.current === connection.id) return;
    viewed.current = connection.id;
    setQuery('');
    setCurrent(undefined);
  });
  const state = connection?.remoteSessions;
  const pointed = useRef(false);
  const shown = state ? state.sessions.filter(session => matches(session, query.trim().toLowerCase())) : [];
  // The result made current, while it remains; otherwise the first once the search has text.
  const found = current ? shown.findIndex(session => session.key === current) : -1;
  const chosen = found >= 0 ? found : query.trim() && shown.length ? 0 : -1;
  const stop = Math.max(chosen, 0);
  const chosenKey = shown[chosen]?.key;
  useLayoutEffect(() => {
    if (pointed.current) pointed.current = false;
    else list.current?.querySelector('[data-chosen]')?.scrollIntoView({ block: 'nearest' });
  }, [chosenKey]);
  if (!connection || !state) return null;
  const busy = remoteOpening.has(connection.id) || state.loading;
  const open = (keys: string[], takeover: boolean) => void resumeRemoteSessions(connection.id, keys, takeover);
  const act = (session: RemoteSession) => {
    const terminal = remoteTerminal(connection.id, session);
    if (terminal) select({ kind: 'terminal', id: terminal.id });
    // Only a session shown as attached is taken over; retrying one that failed asks for it no more forcefully.
    else open([session.key], standingOf(connection.id, session) === 'attached');
  };
  const resumable = shown.filter(session => !remoteTerminal(connection.id, session));
  const ordinary = resumable.filter(session => session.clients === 0);
  const groups = backends.filter(backend => shown.some(session => session.backend === backend));
  const cellId = (index: number) => `remote-session-${index}`;
  const order = new Map(shown.map((session, index) => [session.key, index]));
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
  return <section className="view picker remote-sessions" aria-label="Remote Sessions" aria-busy={busy}
    data-focus-group="remote-sessions" data-focus-items=".picker-search .input, .picker-item"
    onKeyDown={() => { if (pointing) setPointing(false); }}>
    <header className="remote-toolbar">
      <h2 id="remote-sessions-title">Remote Sessions</h2>
      <label className="picker-search">
        <Icon name="search" />
        <input ref={search} className="input" type="text" role="combobox" aria-label="Search Sessions" aria-haspopup="grid"
          aria-expanded={shown.length > 0} aria-controls="remote-session-results" aria-autocomplete="list"
          aria-activedescendant={shown[chosen] && cellId(chosen)} placeholder="Search" autoComplete="off" spellCheck={false}
          value={query} onChange={event => { setQuery(event.target.value); setCurrent(undefined); }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
            const last = shown.length - 1;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              if (last < 0) return;
              const down = event.key === 'ArrowDown';
              setCurrent(shown[chosen < 0 ? (down ? 0 : last) : Math.min(last, Math.max(0, chosen + (down ? 1 : -1)))]!.key);
            } else if (event.key === 'Enter') {
              if (shown[chosen] && !busy) act(shown[chosen]);
            } else if (event.key === 'Escape') {
              if (!query) return;
              setQuery('');
              setCurrent(undefined);
            } else return;
            event.preventDefault();
          }} />
      </label>
      <div className="split-button">
        <Button disabled={busy || !ordinary.length} onClick={() => open(ordinary.map(s => s.key), false)}>Resume All</Button>
        <button type="button" className="button split-more" aria-label="More Session Actions" aria-haspopup="menu" disabled={busy || !resumable.length}
          onClick={event => openMenu(event.currentTarget, [{ label: 'Take Over All', action: () => open(resumable.map(s => s.key), true) }])}><Icon name="down" /></button>
      </div>
      <IconButton icon="reload" label="Refresh" disabled={busy}
        onClick={() => void run('session', api.discoverRemoteSessions(connection.id), connection.id)} />
    </header>
    <div className="picker-body">
      {!!state.errors.length && <div className="remote-notices">
        {state.errors.map(({ backend, message }) => <div className="notice" role="alert" key={(backend ?? '') + message}>
          <Icon name="alert" />
          <div className="notice-body">
            {backend && <div className="notice-title">{backendName(backend)}</div>}
            <p className="notice-message">{message}</p>
          </div>
        </div>)}
      </div>}
      <div ref={list} className="picker-list" id="remote-session-results" role="grid" aria-labelledby="remote-sessions-title"
        hidden={!shown.length} data-pointing={pointing || undefined}
        onPointerDown={() => setPointing(true)}
        onPointerLeave={() => {
          if (pointing && !query.trim() && !list.current!.contains(document.activeElement)) setCurrent(undefined);
        }}
        onPointerMove={event => {
          // Rows that appear under a still pointer get a move with no movement; only a moving pointer chooses.
          if (!event.movementX && !event.movementY) return;
          const row = (event.target as Element).closest<HTMLElement>('[role="row"]');
          if (!row) return;
          setPointing(true);
          if (row.dataset.key !== chosenKey) pointed.current = true;
          if (current !== row.dataset.key) setCurrent(row.dataset.key!);
          const item = row.querySelector<HTMLElement>('.picker-item');
          if (list.current!.contains(document.activeElement) && item !== document.activeElement) item?.focus({ preventScroll: true });
        }}
        onFocus={event => {
          const row = (event.target as Element).closest<HTMLElement>('[role="row"]');
          if (row) setCurrent(row.dataset.key!);
        }}
        onKeyDown={event => {
          if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
          if (event.key === 'Escape') { search.current!.focus(); event.preventDefault(); return; }
          const rows = [...list.current!.querySelectorAll(':scope > [role="row"]')];
          const index = rows.indexOf((event.target as Element).closest('[role="row"]')!);
          const to = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: rows.length - 1 }[event.key];
          if (to === undefined) return;
          event.preventDefault();
          rows[Math.min(rows.length - 1, Math.max(0, to))]?.querySelector<HTMLElement>('.picker-item')?.focus();
        }}>
        {groups.flatMap(backend => [
          ...(groups.length > 1 ? [<h3 key={`head-${backend}`} className="remote-group" aria-hidden="true">{backendName(backend)}</h3>] : []),
          ...shown.filter(session => session.backend === backend).map(session => {
            const standing = standingOf(connection.id, session), index = order.get(session.key)!;
            return <div key={session.key} role="row" className="row picker-row remote-row" data-key={session.key} data-standing={standing} data-error={session.error ? '' : undefined}
              onContextMenu={event => { event.preventDefault(); openMenu(event.currentTarget, menuFor(session)); }}>
              <div role="gridcell" id={cellId(index)} aria-selected={index === chosen || undefined}>
                <button type="button" className="picker-item remote-item" data-chosen={index === chosen || undefined}
                  data-id={session.key} tabIndex={index === stop ? 0 : -1} disabled={busy} onClick={() => act(session)}>
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
                </button>
              </div>
            </div>;
          }),
        ])}
      </div>
      <p className="section-empty" hidden={!!state.sessions.length || state.loading}>No Remote Sessions</p>
      <p className="section-empty" hidden={!query.trim() || !!shown.length}>No Results Found</p>
    </div>
  </section>;
}
