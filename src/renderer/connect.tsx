import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PublicProfile as Profile } from '../core/config';
import { parseDestination } from '../shared';
import { Icon, IconButton, Tags } from './ui';
import { api, run, matchProfiles, focusConnection, store, profileName, profileEndpoint, activeConnection } from './store';
import { connectProfile, openConnection } from './connection-form';
import { ProfileSummary, profileDescription } from './profiles';
import { initials } from './nav';

type Destination = NonNullable<ReturnType<typeof parseDestination>>;
type Result = { kind: 'profile'; profile: Profile } | { kind: 'destination'; destination: Destination };
let input: HTMLInputElement | null = null,
  list: HTMLDivElement | null = null;
let toggled = () => {};
export const onToggle = (callback: () => void) => {
  toggled = callback;
};
export const resultsOpen = () => Boolean(list?.matches(':popover-open'));
export const resultsBounds = () => list?.getBoundingClientRect() ?? new DOMRect();
export const close = () => {
  if (!resultsOpen()) return;
  list!.hidePopover();
  toggled();
};
export const focus = () => input?.focus();
const optionId = (result: Result) =>
  result.kind === 'profile' ? `connect-profile-${result.profile.id}` : 'connect-destination';
const target = ({ host, username }: Destination) => (username ? `${username}@${host}` : host);

/** A profile as a row of the listed results: its initials and status, its name and tags over its endpoint, and Edit. */
function ListedProfile({ profile }: { profile: Profile }) {
  const active = activeConnection(profile.id),
    name = profileName(profile);
  return (
    <>
      <span className="connect-tile" aria-hidden="true">
        {initials(name)}
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
 * The Connect field and its results: the profiles that match its text, then a direct connection when the text names a
 * destination. By default the results open over the window while the field has focus and text. `listed` shows them
 * below the field instead, every profile while the field is empty, with none chosen until the arrow keys or the pointer
 * choose one. One Connect is shown at a time.
 */
export function Connect({ listed = false }: { listed?: boolean }) {
  const [query, setQuery] = useState(''),
    [active, setActive] = useState(listed ? -1 : 0),
    [dismissed, setDismissed] = useState(false);
  const reveal = useRef(true),
    revealed = useRef<string | undefined>(undefined),
    launching = useRef(false),
    currentQuery = useRef(query);
  const destination = parseDestination(query);
  const results: Result[] =
    listed || query.trim()
      ? [
          ...matchProfiles(query).map((profile): Result => ({ kind: 'profile', profile })),
          ...(destination ? [{ kind: 'destination' as const, destination }] : []),
        ]
      : [];
  const unmatched = !results.length && !!query.trim();
  const visible = !listed && !dismissed && (results.length > 0 || unmatched) && document.activeElement === input;
  const previous = useRef<string | undefined>(undefined);
  /** The first result is chosen while there is text; listed results start with none. */
  const least = (text: string) => (listed && !text.trim() ? -1 : 0);
  const selected = Math.max(least(query), Math.min(active, results.length - 1));
  function clear() {
    currentQuery.current = '';
    setQuery('');
    setActive(least(''));
    setDismissed(false);
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
    setDismissed(true);
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
    setDismissed(false);
  }
  useLayoutEffect(() => {
    if (!list || !input) return;
    // Listed results scroll with the page, so the chosen one is brought into view only when it changes.
    if (listed) {
      const id = results[selected] && optionId(results[selected]);
      if (reveal.current && id && id !== revealed.current) document.getElementById(id)?.scrollIntoView({ block: 'nearest' });
      revealed.current = id;
      return;
    }
    if (!visible) {
      close();
      return;
    }
    if (!resultsOpen()) list.showPopover();
    if (reveal.current && results[selected])
      document.getElementById(optionId(results[selected]))?.scrollIntoView({ block: 'nearest' });
    toggled();
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
  useLayoutEffect(() => {
    const dismiss = () => setDismissed(true);
    const outside = (event: PointerEvent) => {
      if (resultsOpen() && !list?.contains(event.target as Node) && event.target !== input) dismiss();
    };
    addEventListener('pointerdown', outside, true);
    addEventListener('resize', dismiss);
    return () => {
      removeEventListener('pointerdown', outside, true);
      removeEventListener('resize', dismiss);
    };
  }, []);
  const options = results.map((result, index) => (
    <div
      key={optionId(result)}
      className={`connect-option ${result.kind === 'profile' ? 'profile-item' : 'connect-destination'}`}
      role="option"
      id={optionId(result)}
      aria-selected={index === selected}
      aria-description={result.kind === 'profile' ? profileDescription(result.profile) : undefined}
      aria-label={result.kind === 'destination' ? `Connect to ${target(result.destination)}` : undefined}
      onPointerDown={(e) => e.preventDefault()}
      onPointerMove={() => {
        reveal.current = false;
        setActive(index);
      }}
      onClick={() => choose(result)}
    >
      {result.kind === 'profile' ? (
        listed ? (
          <ListedProfile profile={result.profile} />
        ) : (
          <ProfileSummary profile={result.profile} />
        )
      ) : (
        <>
          {listed ? (
            <span className="connect-tile" aria-hidden="true">
              <Icon name="terminal" />
            </span>
          ) : (
            <Icon name="terminal" />
          )}
          <span className="connect-target mono">{target(result.destination)}</span>
        </>
      )}
    </div>
  ));
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
          aria-expanded={listed || visible}
          aria-controls="connect-results"
          aria-activedescendant={(listed || visible) && results[selected] ? optionId(results[selected]) : undefined}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onInput={(e) => change(e.currentTarget.value)}
          onChange={() => {}}
          onBlur={() => setDismissed(true)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              reveal.current = true;
              event.preventDefault();
              if (!listed && !resultsOpen()) {
                setDismissed(false);
                return;
              }
              const last = results.length - 1,
                down = event.key === 'ArrowDown';
              setActive(selected < 0 ? (down ? 0 : last) : Math.min(last, Math.max(0, selected + (down ? 1 : -1))));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const result = results[listed || resultsOpen() ? selected : 0];
              if (result) choose(result);
            } else if (event.key === 'Escape') {
              if (resultsOpen()) {
                event.preventDefault();
                setDismissed(true);
              } else if (query) {
                event.preventDefault();
                clear();
              } else if (selected >= 0 && listed) {
                event.preventDefault();
                setActive(-1);
              }
            } else if (event.key === 'Tab') setDismissed(true);
          }}
        />
      </label>
      {listed ? (
        <div
          ref={(node) => {
            list = node;
          }}
          className="connect-list"
          id="connect-results"
          role="listbox"
          aria-label="Profiles"
        >
          {options}
          {unmatched && empty('No Results Found', 'connect-no-results')}
          {!store.state.profiles.length && !query.trim() && empty('No Profiles')}
        </div>
      ) : (
        createPortal(
          <div
            ref={(node) => {
              list = node;
            }}
            className="connect-results"
            id="connect-results"
            role="listbox"
            aria-label="Profiles"
            popover="manual"
          >
            {options}
            {unmatched && empty('No Results Found', 'connect-no-results')}
          </div>,
          document.body,
        )
      )}
    </>
  );
}
