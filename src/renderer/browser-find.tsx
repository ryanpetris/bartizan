import type { BrowserTab, Workspace } from '../shared';
import { Icon, IconButton } from './ui';
import { api, run } from './store';
import { findText, setFindText, foundIn } from './tab-state';

let field: HTMLInputElement | null = null;
/** Focuses the find bar once it has rendered. */
export function focusFind() {
  requestAnimationFrame(() => {
    field?.focus();
    field?.select();
  });
}
/** A tab's find bar, open while the tab has find text, which may be empty. */
export function FindBar({ workspace, tab }: { workspace: Workspace; tab: BrowserTab }) {
  const text = findText(tab.id),
    { active, matches } = foundIn(tab.id);
  const find = (value: string, forward: boolean, next: boolean) =>
    void run('browser', api.find(workspace.id, tab.id, { text: value, forward, next }), workspace.connectionId);
  /** Moves to another match; a page that has reported none yet is searched afresh. */
  const step = (forward: boolean) => {
    if (text) find(text, forward, matches > 0);
  };
  const close = () => {
    setFindText(tab.id, undefined);
    void run('browser', api.find(workspace.id, tab.id, null), workspace.connectionId);
  };
  return (
    <div
      className="find-bar"
      role="search"
      hidden={text === undefined}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <label className="find-field">
        <Icon name="search" />
        <input
          ref={(node) => {
            field = node;
          }}
          className="input find-input"
          type="text"
          aria-label="Find in Page"
          placeholder="Find"
          spellCheck={false}
          autoComplete="off"
          value={text ?? ''}
          onChange={(event) => {
            setFindText(tab.id, event.target.value);
            find(event.target.value, true, false);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229 || event.key !== 'Enter') return;
            event.preventDefault();
            step(!event.shiftKey);
          }}
        />
      </label>
      <span className="find-count" role="status" hidden={!text}>
        {active}/{matches}
      </span>
      <IconButton icon="up" label="Previous Match" disabled={!matches} onClick={() => step(false)} />
      <IconButton icon="down" label="Next Match" disabled={!matches} onClick={() => step(true)} />
      <IconButton icon="close" label="Close Find" onClick={close} />
    </div>
  );
}
