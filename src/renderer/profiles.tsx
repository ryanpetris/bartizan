import { useLayoutEffect, useRef, useState } from 'react';
import type { PublicProfile as Profile } from '../core/config';
import { Icon, IconButton, Button, Tags, moveFocus } from './ui';
import {
  api,
  store,
  render,
  describeError,
  statusText,
  profileName,
  profileEndpoint,
  activeConnection,
  matchProfiles,
} from './store';
import { openModal } from './dialogs';
import { openConnection, connectProfile } from './connection-form';

let opened = false;
export function openProfiles() {
  if (!opened) {
    opened = true;
    render();
  }
}
export function ProfileSummary({ profile }: { profile: Profile }) {
  const active = activeConnection(profile.id);
  return (
    <>
      <span className="profile-titles">
        <span className="profile-label">{profileName(profile)}</span>
        <span className="profile-endpoint mono">{profileEndpoint(profile)}</span>
        <Tags tags={profile.tags} />
      </span>
      <span className="status-dot" hidden={!active} data-status={active?.status} />
    </>
  );
}
export const profileDescription = (profile: Profile) => {
  const active = activeConnection(profile.id);
  return active ? statusText(active) : undefined;
};
export function Profiles() {
  return opened ? <ProfilesDialog /> : <dialog id="profiles-dialog" className="profiles-dialog" />;
}
function ProfilesDialog() {
  const dialog = useRef<HTMLDialogElement>(null),
    search = useRef<HTMLInputElement>(null),
    list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState(''),
    [failure, setFailure] = useState<unknown>();
  const matches = matchProfiles(query);
  const message = failure || store.state.configError ? describeError(failure || store.state.configError).message : '';
  useLayoutEffect(() => {
    openModal(dialog.current!, search.current!);
  }, []);
  const close = () => dialog.current!.close();
  const targets = () => [...list.current!.querySelectorAll<HTMLButtonElement>('.profile-item')];
  return (
    <dialog
      ref={dialog}
      id="profiles-dialog"
      className="profiles-dialog"
      aria-labelledby="profiles-title"
      onClose={() => {
        opened = false;
        render();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing && query) {
          event.preventDefault();
          setQuery('');
          search.current!.focus();
        }
      }}
    >
      <div className="profiles" data-focus-group="profiles">
        <header className="dialog-header">
          <span className="dialog-icon">
            <Icon name="profiles" />
          </span>
          <div className="dialog-titles">
            <h2 id="profiles-title">Profiles</h2>
          </div>
          <span className="spacer" />
          <IconButton
            icon="reload"
            label="Reload Configuration"
            onClick={() => void api.reloadConfig().then(() => setFailure(undefined), setFailure)}
          />
        </header>
        <label className="profiles-search">
          <Icon name="search" />
          <input
            ref={search}
            className="input"
            type="text"
            aria-label="Search Profiles"
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
                targets()[0]?.click();
              }
            }}
          />
        </label>
        <div className="profiles-body">
          <ul
            ref={list}
            className="profile-list"
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp' && event.currentTarget.ownerDocument.activeElement === targets()[0]) search.current!.focus();
              else if (!moveFocus(targets(), event.key)) return;
              event.preventDefault();
            }}
          >
            {matches.map((profile) => (
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
                  aria-description={profileDescription(profile)}
                  onClick={() => {
                    close();
                    connectProfile(profile.id);
                  }}
                >
                  <ProfileSummary profile={profile} />
                </button>
                <span className="row-actions">
                  <IconButton
                    icon="sliders"
                    label={`Edit ${profileName(profile)}`}
                    title="Edit"
                    className="profile-edit"
                    onClick={() => {
                      close();
                      openConnection(profile.id);
                    }}
                  />
                </span>
              </li>
            ))}
          </ul>
          <p className="section-empty" hidden={store.state.profiles.length !== 0}>
            No Profiles
          </p>
          <p className="section-empty" hidden={!store.state.profiles.length || !!matches.length}>
            No Results Found
          </p>
        </div>
        <footer className="dialog-actions">
          <Button
            icon="plus"
            onClick={() => {
              close();
              openConnection();
            }}
          >
            New Connection
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
