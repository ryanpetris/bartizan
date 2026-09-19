import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { PublicProfile as Profile } from '../core/config';
import { parseDestination } from '../shared';
import { Icon, IconButton, Tags } from './ui';
import { api, run, matchProfiles, focusConnection, store, profileName, profileEndpoint, activeConnection } from './store';
import { connectProfile, openConnection } from './connection-form';
import { profileDescription } from './profiles';
import { Identicon, destinationSeed } from './identicon';

type Destination = NonNullable<ReturnType<typeof parseDestination>>;
type Result = { kind: 'profile'; profile: Profile } | { kind: 'destination'; destination: Destination };
let input: HTMLInputElement | null = null;
export const focus = () => input?.focus();
const optionId = (result: Result) =>
  result.kind === 'profile' ? `connect-profile-${result.profile.id}` : 'connect-destination';
const target = ({ host, username }: Destination) => (username ? `${username}@${host}` : host);

/** A profile row with its identicon and status, its name and tags over its endpoint, and Edit. */
function ListedProfile({ profile }: { profile: Profile }) {
  const active = activeConnection(profile.id),
    name = profileName(profile);
  return (
    <>
      <span className="connect-tile" aria-hidden="true">
        <Identicon seed={profile.id} />
        <span className="status-dot" hidden={!active} data-status={active?.status} />
      </span>
      <span className="profile-titles">
        <span className="profile-label">{name}</span>
        <Tags tags={profile.tags} />
        <span className="profile-endpoint mono">{profileEndpoint(profile)}</span>
      </span>
      {/* The pointer's way to a profile's settings; Profiles offers Edit to the keyboard. */}
      <IconButton
        icon="sliders"
        label={`Edit ${name}`}
        title="Edit"
        className="connect-edit"
        tabIndex={-1}
        aria-hidden="true"
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation();
          openConnection(profile.id);
        }}
      />
    </>
  );
}

/**
 * The home page's Connect field over its results: the profiles that match its text, every profile while it is empty,
 * then a direct connection when the text names a destination. Nothing is chosen while the field is empty until the
 * arrow keys or the pointer choose a result.
 */
export function Connect() {
  const [query, setQuery] = useState(''),
    [active, setActive] = useState(-1);
  const reveal = useRef(true),
    revealed = useRef<string | undefined>(undefined),
    launching = useRef(false),
    currentQuery = useRef(query);
  const destination = parseDestination(query);
  const results: Result[] = [
    ...matchProfiles(query).map((profile): Result => ({ kind: 'profile', profile })),
    ...(destination ? [{ kind: 'destination' as const, destination }] : []),
  ];
  const unmatched = !results.length && !!query.trim();
  const previous = useRef<string | undefined>(undefined);
  /** The first result is chosen while there is text; an empty field chooses none. */
  const least = (text: string) => (text.trim() ? 0 : -1);
  const selected = Math.max(least(query), Math.min(active, results.length - 1));
  function clear() {
    currentQuery.current = '';
    setQuery('');
    setActive(-1);
  }
  function choose(result: Result) {
    if (result.kind === 'profile') {
      clear();
      connectProfile(result.profile.id);
      return;
    }
    if (launching.current) return;
    launching.current = true;
    const original = currentQuery.current;
    void run('session', api.connect(result.destination)).then((id) => {
      launching.current = false;
      if (!id) return;
      if (currentQuery.current === original) clear();
      focusConnection(id);
    });
  }
  function change(value: string) {
    reveal.current = true;
    revealed.current = undefined;
    currentQuery.current = value;
    setQuery(value);
    setActive(least(value));
  }
  // The results scroll in a box of their own; the chosen one is brought into view only when it changes.
  useLayoutEffect(() => {
    const id = results[selected] && optionId(results[selected]);
    if (reveal.current && id && id !== revealed.current) document.getElementById(id)?.scrollIntoView({ block: 'nearest' });
    revealed.current = id;
  });
  useLayoutEffect(() => {
    const key = previous.current;
    if (key) {
      const index = results.findIndex((r) => optionId(r) === key);
      const kept = Math.max(least(query), index);
      if (kept !== active) setActive(kept);
    }
  }, [store.state.profiles, store.state.connections]);
  useLayoutEffect(() => {
    previous.current = results[selected] && optionId(results[selected]);
  });
  const empty = (text: string, id?: string) => (
    <div className="section-empty" id={id} role="option" aria-disabled="true" onPointerDown={(e) => e.preventDefault()}>
      {text}
    </div>
  );
  return (
    <>
      <label className="connect">
        <Icon name="search" />
        <input
          ref={(node) => {
            input = node;
          }}
          className="connect-input"
          type="text"
          role="combobox"
          aria-label="Connect"
          placeholder="Connect"
          aria-autocomplete="list"
          aria-expanded
          aria-controls="connect-results"
          aria-activedescendant={results[selected] ? optionId(results[selected]) : undefined}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onInput={(e) => change(e.currentTarget.value)}
          onChange={() => {}}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              reveal.current = true;
              event.preventDefault();
              const last = results.length - 1,
                down = event.key === 'ArrowDown';
              setActive(selected < 0 ? (down ? 0 : last) : Math.min(last, Math.max(0, selected + (down ? 1 : -1))));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const result = results[selected];
              if (result) choose(result);
            } else if (event.key === 'Escape') {
              if (query) {
                event.preventDefault();
                clear();
              } else if (selected >= 0) {
                event.preventDefault();
                setActive(-1);
              }
            }
          }}
        />
      </label>
      <div
        className="connect-list"
        id="connect-results"
        role="listbox"
        aria-label="Profiles"
        // The box keeps room for every profile and a destination, however many it shows.
        style={{ '--connect-rows': store.state.profiles.length + 1 } as CSSProperties}
      >
        {results.map((result, index) => (
          <div
            key={optionId(result)}
            className={`connect-option ${result.kind === 'profile' ? 'profile-item' : 'connect-destination'}`}
            role="option"
            id={optionId(result)}
            aria-selected={index === selected}
            aria-description={result.kind === 'profile' ? profileDescription(result.profile) : undefined}
            aria-label={result.kind === 'destination' ? `Connect to ${target(result.destination)}` : undefined}
            onPointerDown={(e) => e.preventDefault()}
            onPointerMove={(event) => {
              // Rows that appear under a still pointer get a move with no movement; only a moving pointer chooses.
              if (!event.movementX && !event.movementY) return;
              reveal.current = false;
              setActive(index);
            }}
            onClick={() => choose(result)}
          >
            {result.kind === 'profile' ? (
              <ListedProfile profile={result.profile} />
            ) : (
              <>
                <span className="connect-tile" aria-hidden="true">
                  <Identicon seed={destinationSeed(result.destination.host, result.destination.username ?? store.state.defaults.username)} />
                </span>
                <span className="connect-target mono">{target(result.destination)}</span>
              </>
            )}
          </div>
        ))}
        {unmatched && empty('No Results Found', 'connect-no-results')}
        {!store.state.profiles.length && !query.trim() && empty('No Profiles')}
      </div>
    </>
  );
}
