import '@xterm/xterm/css/xterm.css';
import { Component, useInsertionEffect, useLayoutEffect, type ReactNode } from 'react';
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
  dialogHost,
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
import * as errors from './errors';
import { activeTheme } from './themes';
import { windowTitle } from './chrome';
import { Challenges } from './challenges';
import { Settings } from './settings';
import { ModalLayer, Modal, modalReady } from './overlay';
import * as connect from './connect';
import { Profiles } from './profiles';
import { Details } from './details';
import { Home } from './home';
import { Icon } from './ui';
import { chooseMenuItem } from './menu';
import { ConnectionForm, openConnection } from './connection-form';
import { onDialogChange, onRefocusView } from './dialogs';
const refocus = () => {
  if (store.selection) focusView();
  else connect.focus();
};
// Interface drawn over the pages gives way to a dialog.
onDialogChange(render);
onRefocusView(refocus);
let loaded = false;
let startupError: string | undefined;
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
    // The shown row, or a browser session's active tab, went away: show the row that took its place in navigation order, or
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
  loaded = true;
  render();
  stateApplied();
}

const focusables = (container: HTMLElement) =>
  [
    ...container.querySelectorAll<HTMLElement>(
      container.dataset.focusItems ?? 'button:not(:disabled), input:not(:disabled)',
    ),
  ].filter((item) => item.offsetParent !== null);
/**
 * Captures focus before React changes the DOM, in the dialogs' document while a dialog is open. When the focused control
 * disappears, focus moves to the item with the same ID in its `data-focus-group`, or else to its own item, the nearest
 * following item or the nearest preceding one that remains; otherwise to the selected view. A group's
 * `data-focus-items` selects its items, and any other control belongs to the item before it.
 */
class FocusRecovery extends Component<{ children: ReactNode }> {
  getSnapshotBeforeUpdate() {
    const focused = (dialogOpen() ? dialogHost.document : document).activeElement;
    if (!(focused instanceof (focused?.ownerDocument.defaultView ?? window).HTMLElement)) return undefined;
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
    const root = snapshot?.focused.ownerDocument;
    const lost =
      snapshot &&
      root &&
      (!snapshot.focused.isConnected || snapshot.focused.closest('[hidden]')) &&
      (root.activeElement === root.body || root.activeElement === snapshot.focused);
    if (lost) {
      const group = root.querySelector<HTMLElement>(`[data-focus-group="${snapshot.group}"]`);
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
  useInsertionEffect(() => {
    const system = matchMedia('(prefers-color-scheme: dark)');
    const update = () => { document.documentElement.dataset.appearance = store.state.settings.appearance === 'system' ? (system.matches ? 'dark' : 'light') : store.state.settings.appearance; };
    update(); system.addEventListener('change', update);
    return () => system.removeEventListener('change', update);
  }, [store.state.settings.appearance]);
  const theme = store.state.settings.theme,
    { Chrome } = activeTheme();
  // The root element names the theme for its stylesheet before the views measure themselves.
  useInsertionEffect(() => {
    if (loaded) document.documentElement.dataset.theme = theme;
  }, [theme, loaded]);
  useLayoutEffect(() => {
    if (loaded) terminals.applyTheme();
  }, [theme, loaded, store.state.settings.appearance]);
  useLayoutEffect(() => {
    document.title = windowTitle();
  });
  const ready = loaded && modalReady();
  useLayoutEffect(() => {
    if (ready && !dialogOpen() && document.activeElement === document.body) connect.focus();
  }, [ready]);
  useLayoutEffect(() => {
    const unsubscribe = api.onEvent((event) => {
      switch (event.type) {
        case 'transport-error':
          if (!loaded) { startupError = event.message; render(); }
          else errors.transportError(event.message);
          break;
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
  if (!loaded && startupError) return <main className="startup-error" role="alert">{startupError}</main>;
  if (!loaded) return null;
  return (
    <ModalLayer>
      <FocusRecovery>
        <Chrome />
        <main className="main">
          <terminals.Terminals />
          <browser.Browser />
          <section className="view empty-view" aria-label="Nothing Open" hidden={store.selection?.kind !== 'connection'}>
            <span className="empty-mark">
              <Icon name="terminal" />
            </span>
            <p>Nothing Open</p>
          </section>
          {!store.selection && <Home />}
        </main>
        <errors.Toasts />
        <Modal>
          <ConnectionForm />
          <Challenges />
          <Details />
          <Settings />
          <Profiles />
          <errors.Errors />
        </Modal>
      </FocusRecovery>
    </ModalLayer>
  );
}
// Subscribe to IPC before the page finishes loading and the main process sends its initial state.
flushSync(() => createRoot(document.getElementById('app')!).render(<App />));
