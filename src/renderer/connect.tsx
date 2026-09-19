import { useLayoutEffect, useRef, useState } from 'react';
import type { PublicProfile as Profile } from '../core/config';
import { parseDestination } from '../shared';
import { Icon, IconButton, Button, Tags, moveFocus } from './ui';
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
      <span className="connect-tile" aria-hidden="true">
        <Identicon seed={profile.id} />
        <span className="status-dot" hidden={!active} data-status={active?.status} />
      </span>
      <span className="profile-titles">
        <span className="profile-label">{profileName(profile)}</span>
        <Tags tags={profile.tags} />
        <span className="profile-endpoint mono">{profileEndpoint(profile)}</span>
      </span>
    </>
  );
}
/**
 * The profiles that match the search, each with Edit, then a direct connection when the search names a destination.
 * Once the search has text, its first result is chosen: Enter in the search connects it.
 */
function ConnectDialog() {
  const dialog = useRef<HTMLDialogElement>(null),
    search = useRef<HTMLInputElement>(null),
    body = useRef<HTMLDivElement>(null),
    list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState(''),
    [failure, setFailure] = useState<unknown>();
  const matches = matchProfiles(query),
    destination = parseDestination(query),
    chosen = query.trim() ? 0 : -1;
  const message = failure || store.state.configError ? describeError(failure || store.state.configError).message : '';
  useLayoutEffect(() => {
    openModal(dialog.current!, search.current!);
  }, []);
  // The chosen result is the first, so each search shows the results from the top.
  useLayoutEffect(() => {
    body.current!.scrollTop = 0;
  }, [query]);
  const close = () => dialog.current!.close();
  /** Closes the dialog, then does `next` once the page has taken focus back from it. */
  const closeThen = (next: () => void) => {
    dialog.current!.addEventListener('close', next, { once: true });
    close();
  };
  const targets = () => [...list.current!.querySelectorAll<HTMLButtonElement>('.profile-item, .destination-item')];
  const target = destination && (destination.username ? `${destination.username}@${destination.host}` : destination.host);
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
        if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.keyCode !== 229 && query) {
          event.preventDefault();
          setQuery('');
          search.current!.focus();
        }
      }}
    >
      <div className="connect" data-focus-group="connect">
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
        <label className="connect-search">
          <Icon name="search" />
          <input
            ref={search}
            className="input"
            type="text"
            aria-label="Profile or Host"
            placeholder="Search"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                targets()[0]?.focus();
              } else if (event.key === 'Enter') {
                event.preventDefault();
                list.current!.querySelector<HTMLButtonElement>('[data-chosen]')?.click();
              }
            }}
          />
        </label>
        <div ref={body} className="connect-body">
          <ul
            ref={list}
            className="connect-list"
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp' && event.currentTarget.ownerDocument.activeElement === targets()[0]) search.current!.focus();
              else if (!moveFocus(targets(), event.key)) return;
              event.preventDefault();
            }}
          >
            {matches.map((profile, index) => {
              const active = activeConnection(profile.id);
              return (
                <li
                  key={profile.id}
                  className="row profile-row"
                  data-id={profile.id}
                  style={{ '--actions': 1 } as React.CSSProperties}
                >
                  <button
                    type="button"
                    className="profile-item"
                    data-id={profile.id}
                    data-chosen={index === chosen || undefined}
                    aria-description={active && statusText(active)}
                    onClick={() => closeThen(() => connectProfile(profile.id))}
                  >
                    <ProfileSummary profile={profile} />
                  </button>
                  <span className="row-actions">
                    <IconButton
                      icon="sliders"
                      label={`Edit ${profileName(profile)}`}
                      title="Edit"
                      className="profile-edit"
                      onClick={() => closeThen(() => openConnection(profile.id))}
                    />
                  </span>
                </li>
              );
            })}
            {destination && (
              <li className="row destination-row">
                <button
                  type="button"
                  className="destination-item"
                  data-chosen={matches.length === chosen || undefined}
                  onClick={() =>
                    closeThen(() => void run('session', api.connect(destination)).then((id) => id && focusConnection(id)))
                  }
                >
                  <span className="connect-tile" aria-hidden="true">
                    <Identicon seed={destinationSeed(destination.host, destination.username ?? store.state.defaults.username)} />
                  </span>
                  <span className="destination-label">
                    Connect to <span className="destination-target mono">{target}</span>
                  </span>
                </button>
              </li>
            )}
          </ul>
          <p className="section-empty" hidden={!!store.state.profiles.length || !!query.trim()}>
            No Profiles
          </p>
          <p className="section-empty" hidden={!query.trim() || !!matches.length || !!destination}>
            No Results Found
          </p>
        </div>
        <footer className="dialog-actions">
          <Button
            icon="plus"
            onClick={() => closeThen(() => openConnection())}
          >
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
