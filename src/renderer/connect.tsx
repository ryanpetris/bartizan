import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PublicProfile as Profile } from '../core/config';
import { parseDestination } from '../shared';
import { Icon } from './ui';
import { api, run, matchProfiles, focusConnection, store } from './store';
import { connectProfile } from './connection-form';
import { ProfileSummary, profileDescription } from './profiles';

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

export function Connect() {
  const [query, setQuery] = useState(''),
    [active, setActive] = useState(0),
    [dismissed, setDismissed] = useState(false);
  const reveal = useRef(true),
    launching = useRef(false),
    currentQuery = useRef(query);
  const destination = parseDestination(query);
  const results: Result[] = query.trim()
    ? [
        ...matchProfiles(query).map((profile): Result => ({ kind: 'profile', profile })),
        ...(destination ? [{ kind: 'destination' as const, destination }] : []),
      ]
    : [];
  const unmatched = !results.length && !!query.trim();
  const visible = !dismissed && (results.length > 0 || unmatched) && document.activeElement === input;
  const previous = useRef<string | undefined>(undefined);
  const selected = Math.max(0, Math.min(active, results.length - 1));
  function clear() {
    currentQuery.current = '';
    setQuery('');
    setActive(0);
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
    currentQuery.current = value;
    setQuery(value);
    setActive(0);
    setDismissed(false);
  }
  useLayoutEffect(() => {
    if (!list || !input) return;
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
      if (Math.max(0, index) !== active) setActive(Math.max(0, index));
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
          aria-expanded={visible}
          aria-controls="connect-results"
          aria-activedescendant={visible && results[selected] ? optionId(results[selected]) : undefined}
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
              if (!resultsOpen()) {
                setDismissed(false);
                return;
              }
              setActive(Math.min(results.length - 1, Math.max(0, selected + (event.key === 'ArrowDown' ? 1 : -1))));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const result = results[resultsOpen() ? selected : 0];
              if (result) choose(result);
            } else if (event.key === 'Escape') {
              if (resultsOpen()) {
                event.preventDefault();
                setDismissed(true);
              } else if (query) {
                event.preventDefault();
                clear();
              }
            } else if (event.key === 'Tab') setDismissed(true);
          }}
        />
      </label>
      {createPortal(
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
          {results.map((result, index) => (
            <div
              key={optionId(result)}
              className={
                result.kind === 'profile' ? 'connect-option profile-item' : 'connect-option connect-destination'
              }
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
                <ProfileSummary profile={result.profile} />
              ) : (
                <>
                  <Icon name="terminal" />
                  <span className="connect-target mono">{target(result.destination)}</span>
                </>
              )}
            </div>
          ))}
          {unmatched && (
            <div
              className="section-empty"
              id="connect-no-results"
              role="option"
              aria-disabled="true"
              onPointerDown={(e) => e.preventDefault()}
            >
              No Results Found
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
