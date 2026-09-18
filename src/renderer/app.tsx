import '@xterm/xterm/css/xterm.css';
import { Component, useLayoutEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { browserShortcut, type State } from '../shared';
import {
  api,
  store,
  render,
  useStore,
  select,
  exists,
  stateApplied,
  focusView,
  dialogOpen,
  rows,
  sameRow,
  selectedRow,
  activateTab,
  renumber,
  tabIntents,
} from './store';
import * as terminals from './terminals';
import * as browser from './browser';
import * as tabState from './tab-state';
import { Sidebar } from './sidebar';
import * as errors from './errors';
import { Titlebar } from './titlebar';
import { Challenges } from './challenges';
import { Settings } from './settings';
import * as connect from './connect';
import { Profiles } from './profiles';
import { Details } from './details';
import { chooseMenuItem } from './menu';
import { ConnectionForm, openConnection } from './connection-form';
import { onDialogChange, onRefocusView } from './dialogs';
const refocus = () => {
  if (store.selection) focusView();
  else connect.focus();
};
onDialogChange(() => {
  if (dialogOpen()) connect.close();
  browser.syncNativeView();
  // Interface drawn over the pages gives way to a dialog.
  render();
});
// Connect reports on every render; interface drawn over the pages renders again only when the results open or close.
let resultsShown = false;
connect.onToggle(() => {
  browser.syncNativeView();
  if (resultsShown === connect.resultsOpen()) return;
  resultsShown = connect.resultsOpen();
  render();
});
onRefocusView(refocus);
let loaded = false;
/** State comes only from state events, which arrive in order; the main process sends one whenever the page loads. */
function applyState(state: State) {
  const earlier = store.state;
  const selection = store.selection;
  const shown = selection && selectedRow(earlier, selection);
  store.state = state;
  renumber();
  tabState.prune(state);
  for (const [workspaceId, tabId] of tabIntents) {
    const workspace = state.workspaces.find((w) => w.id === workspaceId);
    if (!workspace?.tabs.some((t) => t.id === tabId) || workspace.activeTab === tabId) tabIntents.delete(workspaceId);
  }
  const after = rows(state);
  if (shown && !after.some((row) => sameRow(row, shown))) {
    // The shown row, or a browser session's active tab, went away: show the row that took its place in sidebar order, or
    // the one before it, within the same connection.
    const before = rows(earlier);
    const index = before.findIndex((row) => sameRow(row, shown));
    const candidates = [...before.slice(index + 1), ...before.slice(0, index).reverse()];
    const next = candidates.find(
      (row) => row.connectionId === shown.connectionId && after.some((a) => sameRow(a, row)),
    );
    store.selection = next && { kind: next.kind, id: next.id };
    if (next?.tab) activateTab(next.id, next.tab);
  }
  render();
  stateApplied();
  if (!loaded) {
    loaded = true;
    // The first state completes the initial load; focus Connect once it has rendered unless something else took focus.
    queueMicrotask(() => {
      if (!dialogOpen() && (!document.activeElement || document.activeElement === document.body)) connect.focus();
    });
  }
}

const focusables = (container: HTMLElement) =>
  [
    ...container.querySelectorAll<HTMLElement>(
      container.dataset.focusItems ?? 'button:not(:disabled), input:not(:disabled)',
    ),
  ].filter((item) => item.offsetParent !== null);
/**
 * Captures focus before React changes the DOM. When the focused control disappears, focus moves to the item with the
 * same ID in its `data-focus-group`, or else to its own item, the nearest following item or the nearest preceding one
 * that remains; otherwise to the selected view. A group's `data-focus-items` selects its items, and any other control
 * belongs to the item before it.
 */
class FocusRecovery extends Component<{ children: ReactNode }> {
  getSnapshotBeforeUpdate() {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement)) return undefined;
    const group = focused.closest<HTMLElement>('[data-focus-group]');
    const items = group ? focusables(group) : [];
    const index = items.reduce(
      (found, item, position) =>
        item === focused || item.compareDocumentPosition(focused) & Node.DOCUMENT_POSITION_FOLLOWING ? position : found,
      -1,
    );
    const nearest = index < 0 ? items : [...items.slice(index), ...items.slice(0, index).reverse()];
    return { focused, id: focused.dataset.id, group: group?.dataset.focusGroup, nearest };
  }
  componentDidUpdate(_props: unknown, _state: unknown, snapshot: ReturnType<FocusRecovery['getSnapshotBeforeUpdate']>) {
    const lost =
      snapshot &&
      (!snapshot.focused.isConnected || snapshot.focused.closest('[hidden]')) &&
      (document.activeElement === document.body || document.activeElement === snapshot.focused);
    if (lost) {
      const group = document.querySelector<HTMLElement>(`[data-focus-group="${snapshot.group}"]`);
      const items = group ? focusables(group) : [];
      const target =
        items.find((item) => snapshot.id && item.dataset.id === snapshot.id) ??
        snapshot.nearest.find((item) => items.includes(item));
      if (target) target.focus();
      else if (!dialogOpen()) refocus();
    }
    browser.syncNativeView();
  }
  render() {
    return this.props.children;
  }
}
function App() {
  useStore();
  useLayoutEffect(() => {
    const unsubscribe = api.onEvent((event) => {
      switch (event.type) {
        case 'state':
          applyState(event.state);
          break;
        case 'data':
          terminals.write(event.id, event.data);
          break;
        case 'menu':
          chooseMenuItem(event.index);
          break;
        case 'errors':
          errors.receive(event.log, event.initial);
          break;
        case 'select-browser':
          if (!dialogOpen() && exists(store.state, { kind: 'browser', id: event.id }))
            select({ kind: 'browser', id: event.id });
          break;
        case 'browser-shortcut':
          if (store.selection?.kind !== 'browser' || store.selection.id !== event.id || dialogOpen()) break;
          if (event.action === 'new-connection') openConnection();
          else browser.shortcut(event.action);
          break;
        case 'favicon':
        case 'found':
        case 'target-url':
          tabState.receive(event);
          break;
      }
    });

    const keydown = (event: KeyboardEvent) => {
      const { key, code, ctrlKey: control, metaKey: meta, altKey: alt, shiftKey: shift } = event;
      const shortcut = browserShortcut({ key, code, control, meta, alt, shift });
      if (shortcut === 'new-connection') {
        event.preventDefault();
        event.stopPropagation();
        if (!dialogOpen()) openConnection();
      } else if (shortcut && store.selection?.kind === 'browser' && !dialogOpen()) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) browser.shortcut(shortcut);
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => {
      unsubscribe();
      window.removeEventListener('keydown', keydown, true);
    };
  }, []);
  return (
    <FocusRecovery>
      <Titlebar />
      <Sidebar />
      <main className="main">
        <terminals.Terminals />
        <browser.Browser />
        <section
          className="view empty-view"
          aria-label="Nothing Selected"
          hidden={!!store.selection && store.selection.kind !== 'connection'}
        >
          <svg className="empty-mark" viewBox="0 0 32 32" width="72" height="72" aria-hidden="true" focusable="false">
            <path
              d="M8 9V5h4v3h2V5h4v3h2V5h4v4l-2 3v10l-6 6-6-6V12ZM10 12h12M10 22h12M13 14v5m6-5v5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            />
          </svg>
          <p>Nothing Selected</p>
        </section>
      </main>
      <ConnectionForm />
      <Challenges />
      <Details />
      <Settings />
      <Profiles />
      <errors.Errors />
    </FocusRecovery>
  );
}
// Subscribe to IPC before the page finishes loading and the main process sends its initial state.
flushSync(() => createRoot(document.getElementById('app')!).render(<App />));
