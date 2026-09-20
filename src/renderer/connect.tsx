import { useLayoutEffect, useRef, useState } from 'react';
import type { PublicProfile as Profile } from '../core/config';
import { parseDestination } from '../shared';
import { Icon, IconButton, Button, Tags } from './ui';
import {
  api,
  store,
  render,
  run,
  describeError,
  statusText,
  profileName,
  profileEndpoint,
  activeConnection,
  matchProfiles,
  focusConnection,
} from './store';
import { openModal } from './dialogs';
import { openConnection, connectProfile } from './connection-form';
import { Identicon, destinationSeed } from './identicon';

let opened = false;
export function openConnect() {
  if (!opened) {
    opened = true;
    render();
  }
}
export function Connect() {
  return opened ? <ConnectDialog /> : <dialog id="connect-dialog" className="connect-dialog" />;
}
/** A profile's identicon and status, its name and tags over its endpoint. */
function ProfileSummary({ profile }: { profile: Profile }) {
  const active = activeConnection(profile.id);
  return (
    <>
      <span className="tile" aria-hidden="true">
        <Identicon seed={profile.id} />
        <span className="status-dot" hidden={!active} data-status={active?.status} />
      </span>
      <span className="item-titles">
        <span className="item-label">{profileName(profile)}</span>
        <Tags tags={profile.tags} />
        <span className="item-detail mono">{profileEndpoint(profile)}</span>
      </span>
    </>
  );
}
type Result = { kind: 'profile'; profile: Profile } | { kind: 'destination'; destination: NonNullable<ReturnType<typeof parseDestination>> };
const resultKey = (result: Result) => (result.kind === 'profile' ? `profile:${result.profile.id}` : 'destination');
const cellId = (result: Result) => (result.kind === 'profile' ? `connect-profile-${result.profile.id}` : 'connect-destination');
/**
 * The profiles that match the search, each with Edit, then a direct connection when the search names a destination, as
 * a grid. One result is current: the first once the search has text, until Up and Down in the search or a moving pointer
 * choose another. Tab takes focus to the current result, and in the grid Up and Down move through the results and Right
 * and Left between a profile and its Edit. Enter in the search connects the current result.
 */
function ConnectDialog() {
  const dialog = useRef<HTMLDialogElement>(null),
    search = useRef<HTMLInputElement>(null),
    body = useRef<HTMLDivElement>(null),
    list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(''),
    [current, setCurrent] = useState<{ key: string; edit: boolean }>(),
    [pointing, setPointing] = useState(false),
    [failure, setFailure] = useState<unknown>();
  const destination = parseDestination(query);
  const results: Result[] = [
    ...matchProfiles(query).map((profile): Result => ({ kind: 'profile', profile })),
    ...(destination ? [{ kind: 'destination' as const, destination }] : []),
  ];
  // The result made current, while it remains; otherwise the first once the search has text.
  const found = current ? results.findIndex((result) => resultKey(result) === current.key) : -1;
  const chosen = found >= 0 ? found : query.trim() && results.length ? 0 : -1;
  // Tab reaches the current result, or its Edit if that had focus last; with none, the first result.
  const stop = Math.max(chosen, 0),
    stopEdit = found >= 0 && current!.edit;
  const message = failure || store.state.configError ? describeError(failure || store.state.configError).message : '';
  useLayoutEffect(() => {
    openModal(dialog.current!, search.current!);
  }, []);
  // The first result is current as the search changes, so each search shows the results from the top.
  useLayoutEffect(() => {
    body.current!.scrollTop = 0;
  }, [query]);
  // A result that becomes current comes into view, unless the pointer chose it where it is.
  const chosenKey = results[chosen] && resultKey(results[chosen]);
  const pointed = useRef(false);
  useLayoutEffect(() => {
    if (pointed.current) pointed.current = false;
    else list.current!.querySelector('[data-chosen]')?.scrollIntoView({ block: 'nearest' });
  }, [chosenKey]);
  const close = () => dialog.current!.close();
  /** Closes the dialog, then does `next` once the page has taken focus back from it. */
  const closeThen = (next: () => void) => {
    dialog.current!.addEventListener('close', next, { once: true });
    close();
  };
  const choose = (result: Result) => {
    if (result.kind === 'profile') closeThen(() => connectProfile(result.profile.id));
    else closeThen(() => void run('session', api.connect(result.destination)).then((id) => id && focusConnection(id)));
  };
  /** The button of a row's result, or of its Edit where it has one. */
  const button = (row: Element | undefined, edit: boolean) =>
    (edit && row?.querySelector<HTMLElement>('.profile-edit')) || row?.querySelector<HTMLElement>('.picker-item');
  return (
    <dialog
      ref={dialog}
      id="connect-dialog"
      className="connect-dialog"
      aria-labelledby="connect-title"
      onClose={() => {
        opened = false;
        render();
      }}
      onKeyDown={(event) => {
        if (pointing) setPointing(false);
        if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.keyCode === 229) return;
        // Escape returns from the results to the search, then clears it, then closes the dialog.
        if (list.current!.contains(event.target as Node)) search.current!.focus();
        else if (query) {
          setQuery('');
          setCurrent(undefined);
          search.current!.focus();
        } else return;
        event.preventDefault();
      }}
    >
      <div className="picker connect" data-focus-group="connect" data-focus-items=".picker-search .input, .picker-item">
        <header className="dialog-header">
          <span className="dialog-icon">
            <Icon name="plus" />
          </span>
          <div className="dialog-titles">
            <h2 id="connect-title">Connect</h2>
          </div>
          <span className="spacer" />
          <IconButton
            icon="reload"
            label="Reload Configuration"
            onClick={() => void api.reloadConfig().then(() => setFailure(undefined), setFailure)}
          />
        </header>
        <label className="picker-search">
          <Icon name="search" />
          <input
            ref={search}
            className="input"
            type="text"
            role="combobox"
            aria-label="Profile or Host"
            aria-haspopup="grid"
            aria-expanded={results.length > 0}
            aria-controls="connect-results"
            aria-autocomplete="list"
            aria-activedescendant={results[chosen] && cellId(results[chosen])}
            placeholder="Search"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCurrent(undefined);
            }}
            // Back in the search, Tab returns to the current result itself.
            onFocus={() => current?.edit && setCurrent({ ...current, edit: false })}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
              const last = results.length - 1;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                if (last < 0) return;
                const down = event.key === 'ArrowDown';
                const next = chosen < 0 ? (down ? 0 : last) : Math.min(last, Math.max(0, chosen + (down ? 1 : -1)));
                setCurrent({ key: resultKey(results[next]!), edit: false });
              } else if (event.key === 'Enter') {
                if (results[chosen]) choose(results[chosen]);
              } else return;
              event.preventDefault();
            }}
          />
        </label>
        <div ref={body} className="picker-body">
          <div
            ref={list}
            className="picker-list"
            id="connect-results"
            role="grid"
            aria-labelledby="connect-title"
            hidden={!results.length}
            // The pointer hides the focus ring until a key is pressed.
            data-pointing={pointing || undefined}
            onPointerDown={() => setPointing(true)}
            onPointerLeave={() => {
              if (pointing && !query.trim() && !list.current!.contains(list.current!.ownerDocument.activeElement)) setCurrent(undefined);
            }}
            onPointerMove={(event) => {
              // Rows that appear under a still pointer get a move with no movement; only a moving pointer chooses.
              if (!event.movementX && !event.movementY) return;
              const row = (event.target as Element).closest<HTMLElement>('[role="row"]');
              if (!row) return;
              setPointing(true);
              if (row.dataset.key !== chosenKey) pointed.current = true;
              if (current?.key !== row.dataset.key) setCurrent({ key: row.dataset.key!, edit: false });
              // Focus in the results follows the pointer to the result or Edit under it, so keys act on what it chose.
              const focused = list.current!.ownerDocument.activeElement,
                target = button(row, !!(event.target as Element).closest('.row-actions'));
              if (list.current!.contains(focused) && target !== focused) target?.focus({ preventScroll: true });
            }}
            // The result or Edit that takes focus becomes current.
            onFocus={(event) => {
              const row = (event.target as Element).closest<HTMLElement>('[role="row"]');
              if (row) setCurrent({ key: row.dataset.key!, edit: !!(event.target as Element).closest('.row-actions') });
            }}
            onKeyDown={(event) => {
              if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
              const rows = [...list.current!.querySelectorAll(':scope > [role="row"]')];
              const row = (event.target as Element).closest('[role="row"]')!,
                index = rows.indexOf(row),
                edit = !!(event.target as Element).closest('.row-actions');
              const to = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: rows.length - 1 }[event.key];
              let target: HTMLElement | null | undefined;
              if (to !== undefined) target = button(rows[Math.min(rows.length - 1, Math.max(0, to))], edit);
              else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') target = button(row, event.key === 'ArrowRight');
              else return;
              event.preventDefault();
              target?.focus();
            }}
          >
            {results.map((result, index) => {
              const shown = index === chosen,
                key = resultKey(result);
              if (result.kind === 'destination') {
                const { host, username, port } = result.destination;
                const endpoint = port === undefined ? host : `${host.includes(':') ? `[${host}]` : host}:${port}`;
                return (
                  <div key={key} role="row" className="row picker-row destination-row" data-key={key}>
                    <div role="gridcell" id={cellId(result)} aria-selected={shown || undefined}>
                      <button
                        type="button"
                        className="picker-item destination-item"
                        data-chosen={shown || undefined}
                        tabIndex={index === stop ? 0 : -1}
                        onClick={() => choose(result)}
                      >
                        <span className="tile" aria-hidden="true">
                          <Identicon seed={destinationSeed(host, username ?? store.state.defaults.username)} />
                        </span>
                        <span className="destination-label">
                          Connect to <span className="destination-target mono">{username ? `${username}@${endpoint}` : endpoint}</span>
                        </span>
                      </button>
                    </div>
                  </div>
                );
              }
              const { profile } = result,
                connection = activeConnection(profile.id);
              return (
                <div
                  key={key}
                  role="row"
                  className="row picker-row profile-row"
                  data-id={profile.id}
                  data-key={key}
                  style={{ '--actions': 1 } as React.CSSProperties}
                >
                  <div role="gridcell" id={cellId(result)} aria-selected={shown || undefined}>
                    <button
                      type="button"
                      className="picker-item profile-item"
                      data-chosen={shown || undefined}
                      aria-description={connection && statusText(connection)}
                      tabIndex={index === stop && !stopEdit ? 0 : -1}
                      onClick={() => choose(result)}
                    >
                      <ProfileSummary profile={profile} />
                    </button>
                  </div>
                  <span role="gridcell" className="row-actions">
                    <IconButton
                      icon="sliders"
                      label={`Edit ${profileName(profile)}`}
                      title="Edit"
                      className="profile-edit"
                      tabIndex={index === stop && stopEdit ? 0 : -1}
                      onClick={() => closeThen(() => openConnection(profile.id))}
                    />
                  </span>
                </div>
              );
            })}
          </div>
          <p className="section-empty" hidden={!!store.state.profiles.length || !!query.trim()}>
            No Profiles
          </p>
          <p className="section-empty" hidden={!query.trim() || !!results.length}>
            No Results Found
          </p>
        </div>
        <footer className="dialog-actions">
          <Button icon="plus" onClick={() => closeThen(() => openConnection())}>
            New Profile
          </Button>
          <p className="dialog-error" role="alert" hidden={!message}>
            {message}
          </p>
          <Button onClick={close}>Close</Button>
        </footer>
      </div>
    </dialog>
  );
}
