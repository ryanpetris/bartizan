import { useEffect, useRef, useState } from 'react';
import type { PublicProfile as Profile } from '../core/config';
import { parseDestination } from '../shared';
import { IconButton, Tags } from './ui';
import { Notice, Picker, type PickerRow } from './picker';
import {
  api,
  store,
  run,
  describeError,
  statusText,
  profileName,
  profileEndpoint,
  activeConnection,
  matchProfiles,
  focusConnection,
} from './store';
import { pageName } from './chrome';
import { openConnection, connectProfile } from './connection-form';
import { Identicon, destinationSeed } from './identicon';

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
/** A direct connection to what the search names, with its endpoint as it will be used. */
function DestinationSummary({ destination }: { destination: NonNullable<ReturnType<typeof parseDestination>> }) {
  const { host, username, port } = destination;
  const endpoint = port === undefined ? host : `${host.includes(':') ? `[${host}]` : host}:${port}`;
  return (
    <>
      <span className="tile" aria-hidden="true">
        <Identicon seed={destinationSeed(host, username ?? store.state.defaults.username)} />
      </span>
      <span className="destination-label">
        Connect to <span className="destination-target mono">{username ? `${username}@${endpoint}` : endpoint}</span>
      </span>
    </>
  );
}
/**
 * How long a connection that was made has to take the view before the page offers itself again: long enough for a new
 * terminal to open over SSH, which is what the page can be waiting on once the connection itself is there.
 */
const hold = 1500;
/** The page stands while it is in view, so each visit to it starts from the whole list. */
export function Connect() {
  return store.selection?.kind === 'connect' ? <ConnectPage /> : null;
}
/**
 * The page the New Connection button shows: the profiles that match the search, each with Edit, then a direct
 * connection when the search names a destination. Choosing a row connects to it.
 */
function ConnectPage() {
  const [query, setQuery] = useState(''),
    [connecting, setConnecting] = useState(false),
    [failure, setFailure] = useState<unknown>();
  // The page takes one choice at a time, held by a ref because a second press can land before the first has rendered.
  // A connection that was made takes the view from the page; one that failed, and one that has not shown anything
  // within `hold`, leave the page ready for the next choice.
  const pending = useRef(false),
    held = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(held.current), []);
  const start = (connect: () => Promise<boolean>) => {
    if (pending.current) return;
    pending.current = true;
    setConnecting(true);
    const ready = () => {
      pending.current = false;
      setConnecting(false);
    };
    void connect().then((made) => (made ? (held.current = setTimeout(ready, hold)) : ready()), ready);
  };
  const destination = parseDestination(query);
  const rows: PickerRow[] = [
    ...matchProfiles(query).map((profile): PickerRow => {
      const connection = activeConnection(profile.id);
      return {
        key: `profile:${profile.id}`,
        className: 'profile-row',
        disabled: connecting,
        row: { 'data-id': profile.id },
        item: { className: 'profile-item', 'aria-description': connection && statusText(connection) },
        content: <ProfileSummary profile={profile} />,
        choose: () => start(() => connectProfile(profile.id)),
        action: (tabIndex) => (
          <IconButton
            icon="sliders"
            label={`Edit ${profileName(profile)}`}
            title="Edit"
            className="profile-edit"
            tabIndex={tabIndex}
            onClick={() => openConnection(profile.id)}
          />
        ),
      };
    }),
    ...(destination
      ? [
          {
            key: 'destination',
            className: 'destination-row',
            disabled: connecting,
            item: { className: 'destination-item' },
            content: <DestinationSummary destination={destination} />,
            choose: () =>
              start(() =>
                run('session', api.connect(destination)).then((id) => {
                  if (id) focusConnection(id);
                  return Boolean(id);
                }),
              ),
          } satisfies PickerRow,
        ]
      : []),
  ];
  const message = failure || store.state.configError ? describeError(failure || store.state.configError).message : '';
  return (
    <Picker
      name="connect"
      className="connect"
      title={pageName.connect}
      searchLabel="Profile or Host"
      query={query}
      onQuery={setQuery}
      rows={rows}
      busy={connecting}
      notices={message ? <Notice>{message}</Notice> : undefined}
      empty={
        <p className="section-empty" hidden={!!store.state.profiles.length || !!query.trim()}>
          No Profiles
        </p>
      }
      actions={
        <>
          <IconButton
            icon="reload"
            label="Reload Configuration"
            onClick={() => void api.reloadConfig().then(() => setFailure(undefined), setFailure)}
          />
          <IconButton icon="plus" label="New Profile" onClick={() => openConnection()} />
        </>
      }
    />
  );
}
