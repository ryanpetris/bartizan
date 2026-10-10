import { ApplicationStatus } from './application-status';
import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { applicationShowsPage, shortcutLabel, type BrowserAction, type BrowserShortcut, type Bounds, type PageShortcut } from '../shared';
import { Icon, IconButton, Button, colorStyle } from './ui';
import { api, store, run, render, describeError, dialogOpen, onFocusRequest, focusView, sessionColor, activeManifest, sessionTabs, selectTab } from './store';
import type { BrowserTab, CertificateChallenge } from '../shared';
import { currentTab as current, findText, setFindText, targetOf } from './tab-state';
import { openMenu } from './menu';
import { FindBar, focusFind } from './browser-find';
import { DownloadsButton, DownloadsPopover } from './browser-downloads';
import { LinkStatus } from './browser-status';
import { AddressSuggestions, refreshPorts, remember, suggestionId, suggestionLimit, suggestions } from './browser-suggestions';

const shortcutHint = (name: PageShortcut) => shortcutLabel(name, /^Mac/.test(navigator.platform));
const actionErrors = new Map<string, string>();
function act(workspaceId: string, action: BrowserAction, tabId?: string, url?: string) {
  return api.browser(workspaceId, action, tabId, url).then(
    () => {
      actionErrors.delete(workspaceId);
      render();
      return true;
    },
    (error) => {
      actionErrors.set(workspaceId, describeError(error).message);
      render();
      return false;
    },
  );
}
let view: HTMLElement | null = null,
  body: HTMLDivElement | null = null,
  slot: HTMLDivElement | null = null,
  toolsSlot: HTMLDivElement | null = null,
  address: HTMLInputElement | null = null;
/** Acts on the tab the selected session shows. */
function actOnTab(action: BrowserAction) {
  const { workspace, tab } = current();
  if (workspace && tab) void act(workspace.id, action, tab.id);
}
export function focusAddress() {
  if (!view?.hidden && !dialogOpen()) {
    if (current().workspace?.application) return;
    const focus = () => { address?.focus(); address?.select(); };
    if (store.fullscreen === 'content' && current().tab?.url) void run('window', api.setFullscreen('window')).then(() => requestAnimationFrame(focus));
    else focus();
  }
}
function openFind() {
  const { tab } = current();
  if (!tab?.url || view?.hidden || dialogOpen()) return;
  if (findText(tab.id) === undefined) setFindText(tab.id, '');
  focusFind();
}
/** Gives the keyboard to the selected tab's page, once the main process has it selected too. */
function focusPage() {
  const { workspace, tab } = current();
  if (!workspace || !tab?.url) return;
  // Focus left in a view that is no longer shown would come back to it with the window.
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused.closest('[hidden]')) focused.blur();
  syncNativeView();
  void act(workspace.id, 'focus', tab.id);
}
/** Runs a shortcut on the selected session: one the application takes itself, or the find bar, which the main process asks for once a page has left its key alone. */
export function shortcut(name: Exclude<BrowserShortcut, 'new-connection'> | 'find') {
  const { workspace, tab } = current();
  if (name === 'focus-address') focusAddress();
  else if (name === 'find') openFind();
  else if (name === 'devtools') { if (tab?.url) actOnTab(name); }
  // Tabs of an application's session are the application's own.
  else if (!workspace || workspace.application) return;
  else if (name === 'new-tab') void act(workspace.id, 'new').then(focusAddress);
  else if (name === 'close-tab') { if (tab) void act(workspace.id, 'close', tab.id).then(focusView); }
  else if (name === 'reopen-tab') void act(workspace.id, 'reopen').then(focusView);
  else {
    const tabs = sessionTabs(workspace), index = tabs.findIndex((item) => item.id === tab?.id);
    const next = tabs[(index + (name === 'next-tab' ? 1 : -1) + tabs.length) % tabs.length];
    if (next && next.id !== tab?.id) selectTab(workspace.id, next.id);
  }
}
/** The address the main process makes of what was entered in the address field, or nothing for one it would refuse. */
function typedAddress(value: string) {
  const text = value.trim();
  try {
    return new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`).href;
  } catch {
    return '';
  }
}
/** Sends the selected tab to an address, as Paste and Go does. */
export let go: (value: string) => void = () => {};

/** Where developer tools dock beside the page and how much room they take; this lasts for the application launch. */
const dock: { side: 'bottom' | 'right'; size: number } = (() => {
  try {
    const saved = JSON.parse(sessionStorage.getItem('devtools-dock') ?? '{}');
    return { side: saved.side === 'right' ? 'right' : 'bottom', size: Number.isFinite(saved.size) ? saved.size : 320 };
  } catch {
    return { side: 'bottom', size: 320 };
  }
})();
const minimumPane = 120;
function setDock(change: Partial<typeof dock>) {
  Object.assign(dock, change);
  const room = body ? (dock.side === 'bottom' ? body.clientHeight : body.clientWidth) : Infinity;
  dock.size = Math.round(Math.max(minimumPane, Math.min(dock.size, room - minimumPane)));
  try {
    sessionStorage.setItem('devtools-dock', JSON.stringify(dock));
  } catch {
    /* The dock still applies until the page reloads. */
  }
  render();
}

const certificateTitles = [
  ['ERR_CERT_AUTHORITY_INVALID', 'Untrusted Certificate'],
  ['ERR_CERT_DATE_INVALID', 'Certificate Date Invalid'],
  ['ERR_CERT_COMMON_NAME_INVALID', 'Certificate Name Mismatch'],
];
const certificateTitle = (challenge?: CertificateChallenge) => certificateTitles.find(([code]) => challenge?.error.includes(code))?.[1] ?? 'Certificate Error';
/** The blocked resource certificate the user has opened in the warning, in place of its page. */
let reviewing: string | undefined;
/** The warning a tab shows: the blocked resource certificate opened from its notice until it is answered, or its page's own. */
const shownChallenge = (tab?: BrowserTab) => (tab?.blockedCertificate && tab.blockedCertificate.id === reviewing ? tab.blockedCertificate : tab?.certificate);
export function Browser() {
  const { workspace, tab } = current();
  const [draft, setDraft] = useState<{ id: string | undefined; value: string }>();
  const [answered, setAnswered] = useState<string>();
  // The suggestions under the address field, and the one Up and Down have chosen.
  const [suggesting, setSuggesting] = useState(false),
    [highlighted, setHighlighted] = useState(-1);
  const pending = useRef<string | undefined>(undefined),
    frame = useRef<number | undefined>(undefined),
    // While an address chosen from the suggestions is sent, focus that returns to the field leaves them closed.
    settling = useRef(false),
    cancel = useRef<HTMLButtonElement>(null);
  const editing = draft?.id === tab?.id && draft !== undefined;
  const challenge = shownChallenge(tab),
    blocked = challenge ? undefined : tab?.blockedCertificate;
  const cancelSelection = () => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
  };
  useLayoutEffect(() => {
    setDraft(undefined);
    setSuggesting(false);
  }, [tab?.id]);
  // An address left in the field gives way to the page's own once the page moves on.
  useLayoutEffect(() => {
    if (document.activeElement !== address || !document.hasFocus()) setDraft(undefined);
  }, [tab?.url]);
  // An action's error stays while the address is typed, and gives way once the tab shown changes, moves on or loads.
  useLayoutEffect(() => {
    if (workspace && actionErrors.delete(workspace.id)) render();
  }, [tab?.id, tab?.url, tab?.loading]);
  useLayoutEffect(
    () =>
      onFocusRequest(() => {
        const { tab } = current();
        if (!tab || dialogOpen()) return;
        if (!tab.url) focusAddress();
        else focusPage();
      }),
    [],
  );
  const query = editing ? draft.value : '';
  const offered = suggesting && workspace && !workspace.application ? suggestions(workspace.connectionId, query) : [];
  // A dialog over the window, or a view out of sight, keeps the list from showing.
  const listed = view?.hidden || dialogOpen() ? [] : offered;
  const chosen = highlighted < listed.length ? highlighted : -1;
  /**
   * Sends the tab to an address, keeping it in the field until the tab takes it. The page takes the keyboard after, from
   * the field or, with `page`, from wherever it is.
   */
  const navigate = (value: string, page: boolean) => {
    if (!workspace || !value.trim()) return;
    setSuggesting(false);
    settling.current = true;
    void act(workspace.id, tab ? 'navigate' : 'new', tab?.id, value).then((navigated) => {
      settling.current = false;
      if (!navigated) return;
      setDraft(undefined);
      remember(workspace.connectionId, typedAddress(value));
      requestAnimationFrame(() => {
        const selected = current();
        if (selected.workspace?.id !== workspace.id || tab && selected.tab?.id !== tab.id || dialogOpen()) return;
        if (!page && (!document.hasFocus() || document.activeElement !== address)) return;
        syncNativeView();
        void act(workspace.id, 'focus', selected.tab?.id);
      });
    });
  };
  useLayoutEffect(() => {
    go = (value) => navigate(value, true);
  });
  useLayoutEffect(() => {
    if (!challenge) {
      setAnswered(undefined);
      return;
    }
    const focused = document.activeElement;
    if (
      !dialogOpen() &&
      (!focused || focused === document.body || (view?.contains(focused) && !(focused === address && editing)))
    ) {
      const request = requestAnimationFrame(() => {
        if (shownChallenge(current().tab)?.id === challenge.id && !dialogOpen()) cancel.current?.focus();
      });
      return () => cancelAnimationFrame(request);
    }
  }, [challenge?.id]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(syncNativeView);
    observer.observe(slot!);
    observer.observe(toolsSlot!);
    addEventListener('resize', syncNativeView);
    return () => {
      observer.disconnect();
      removeEventListener('resize', syncNativeView);
      cancelSelection();
    };
  }, []);
  function answer(allow: boolean, target = challenge) {
    if (!workspace || !target || pending.current === target.id || answered === target.id) return;
    const id = target.id,
      resource = target.id === tab?.blockedCertificate?.id;
    pending.current = id;
    setAnswered(id);
    void api
      .answerCertificate(id, allow)
      .then(
        (result) => {
          actionErrors.delete(workspace.id);
          if (!result) setAnswered((previous) => (previous === id ? undefined : previous));
          // The page comes back in place of the warning or notice, and takes the keyboard they held.
          const focused = document.activeElement;
          if (resource && result && (!focused || focused === document.body || view?.contains(focused))) focusView();
        },
        (error) => {
          actionErrors.set(workspace.id, describeError(error).message);
          setAnswered((previous) => (previous === id ? undefined : previous));
        },
      )
      .finally(() => {
        if (pending.current === id) pending.current = undefined;
        render();
      });
  }
  const actionError = workspace && actionErrors.get(workspace.id),
    failure = tab?.loading ? undefined : tab?.error;
  const facts = challenge
    ? [
        ['Address', challenge.url],
        ['Error', challenge.error],
        ['Subject', challenge.subject],
        ['Issuer', challenge.issuer],
        ['Valid From', challenge.validFrom],
        ['Valid To', challenge.validTo],
        ['Fingerprint', challenge.fingerprint],
      ]
    : [];
  const zoomed = !!tab && tab.zoom !== 100;
  // Developer tools take their room while their page shows.
  const tools = Boolean(tab?.devtools && (tab.url || tab.loading) && !challenge);
  const horizontal = dock.side === 'right';
  /** The room the developer tools take once the pointer, or a key, has moved their edge. */
  const resize = (event: { clientX: number; clientY: number }) => {
    const box = body!.getBoundingClientRect();
    setDock({ size: horizontal ? box.right - event.clientX : box.bottom - event.clientY });
  };
  return (
    <section
      ref={(node) => {
        view = node;
      }}
      className="view browser-view"
      hidden={!workspace}
      aria-labelledby="view-title"
      style={colorStyle(workspace && sessionColor(workspace))}
    >
      <form
        hidden={!!workspace?.application || store.fullscreen === 'content' && !!tab?.url}
        className="browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          navigate(listed[chosen]?.url ?? address?.value ?? '', false);
        }}
      >
        <IconButton icon="back" label="Back" disabled={!tab?.canBack} onClick={() => actOnTab('back')} />
        <IconButton icon="forward" label="Forward" disabled={!tab?.canForward} onClick={() => actOnTab('forward')} />
        <IconButton
          icon={tab?.loading ? 'close' : 'reload'}
          label={tab?.loading ? 'Stop' : 'Reload'}
          data-loading={Boolean(tab?.loading)}
          disabled={!tab?.url}
          onClick={(event) => actOnTab(tab?.loading ? 'stop' : event.shiftKey ? 'hard-reload' : 'reload')}
        />
        <div className={`address-field${zoomed ? ' zoomed' : ''}`}>
          <Icon name="globe" className="icon address-icon" />
          <input
            ref={(node) => {
              address = node;
            }}
            className="address mono"
            type="text"
            name="address"
            aria-label="Address"
            placeholder="Address"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={listed.length > 0}
            aria-controls="address-suggestions"
            aria-activedescendant={chosen >= 0 ? suggestionId(chosen) : undefined}
            data-url={tab?.url ?? ''}
            spellCheck={false}
            autoComplete="off"
            value={editing ? draft.value : (tab?.url ?? '')}
            onInput={cancelSelection}
            onChange={(event) => {
              setDraft({ id: tab?.id, value: event.target.value });
              setSuggesting(true);
              setHighlighted(-1);
            }}
            onBlur={() => {
              cancelSelection();
              if (editing && draft.value === (tab?.url ?? '')) setDraft(undefined);
              // Focus that leaves for the suggestions' own view returns, or the suggestions close as it leaves both.
              if (document.hasFocus() || !listed.length) setSuggesting(false);
            }}
            onFocus={() => {
              cancelSelection();
              if (workspace && !workspace.application && !settling.current) {
                refreshPorts(workspace.connectionId);
                setSuggesting(true);
                setHighlighted(-1);
              }
              frame.current = requestAnimationFrame(() => {
                frame.current = undefined;
                if (document.activeElement === address) address?.select();
              });
            }}
            onKeyDown={(event) => {
              cancelSelection();
              if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (!suggesting) { setSuggesting(true); setHighlighted(-1); return; }
                const last = listed.length - 1, down = event.key === 'ArrowDown';
                setHighlighted(last < 0 ? -1 : chosen < 0 ? (down ? 0 : last) : Math.min(last, Math.max(-1, chosen + (down ? 1 : -1))));
              } else if (event.key === 'Escape' && listed.length) {
                event.preventDefault();
                setSuggesting(false);
              } else if (event.key === 'Escape' && (editing || address?.value !== (tab?.url ?? ''))) {
                event.preventDefault();
                setDraft(undefined);
                requestAnimationFrame(() => address?.select());
              }
            }}
          />
          <button
            type="button"
            className="zoom-level"
            hidden={!zoomed}
            aria-label="Reset Zoom"
            data-tooltip="Reset Zoom"
            onClick={() => actOnTab('zoom-reset')}
          >
            {tab?.zoom}%
          </button>
        </div>
        {workspace && <DownloadsButton workspace={workspace} />}
        <IconButton
          icon="code"
          label="Developer Tools"
          aria-pressed={Boolean(tab?.devtools)}
          disabled={!tab?.url}
          onClick={() => actOnTab('devtools')}
        />
        <IconButton
          icon="more"
          label="Page Menu"
          aria-haspopup="menu"
          disabled={!tab}
          onClick={(event) => {
            // The menu belongs to the page on show as it opens, and closes once another tab shows or the page starts loading
            // another document.
            const opened = tab;
            let loading = tab?.loading;
            const onTab = (action: BrowserAction) => () => {
              if (workspace && opened) void act(workspace.id, action, opened.id);
            };
            openMenu(event.currentTarget, [
              { label: 'Find in Page', icon: 'search', shortcut: shortcutHint('find'), disabled: !tab?.url, action: openFind },
              { separator: true },
              { label: 'Zoom In', shortcut: shortcutHint('zoom-in'), disabled: !tab?.url, action: onTab('zoom-in') },
              { label: 'Zoom Out', shortcut: shortcutHint('zoom-out'), disabled: !tab?.url, action: onTab('zoom-out') },
              { label: 'Reset Zoom', shortcut: shortcutHint('zoom-reset'), disabled: !zoomed, action: onTab('zoom-reset') },
              { separator: true },
              { label: 'Hard Reload', icon: 'reload', shortcut: shortcutHint('hard-reload'), disabled: !tab?.url, action: onTab('hard-reload') },
              { label: 'Clear Site Data', disabled: !/^https?:/i.test(tab?.url ?? ''), action: onTab('clear-site-data') },
              { separator: true },
              { label: 'Save as PDF…', disabled: !tab?.url, action: onTab('pdf') },
              { label: 'Save Screenshot…', disabled: !tab?.url, action: onTab('screenshot') },
              { label: 'Print…', shortcut: shortcutHint('print'), disabled: !tab?.url, action: onTab('print') },
              { separator: true },
              {
                label: horizontal ? 'Dock Developer Tools at Bottom' : 'Dock Developer Tools at Right',
                icon: 'code',
                action: () => setDock({ side: horizontal ? 'bottom' : 'right' }),
              },
            ], {
              stale: () => {
                const now = current().tab;
                const started = Boolean(now?.loading && !loading);
                loading = now?.loading;
                return now?.id !== opened?.id || started;
              },
            });
          }}
        />
        <IconButton
          icon="plus"
          label="New Tab"
          onClick={() => {
            if (workspace) void act(workspace.id, 'new').then(focusAddress);
          }}
        />
        <IconButton
          icon="close"
          label="Close Tab"
          disabled={!tab}
          onClick={() => {
            if (workspace && tab) void act(workspace.id, 'close', tab.id);
          }}
        />
        <div className="progress" hidden={!tab?.loading} aria-hidden="true" />
      </form>
      {workspace && tab && <FindBar workspace={workspace} tab={tab} />}
      <div className="browser-error" role="alert" hidden={!actionError && !failure}>
        <Icon name="alert" />
        <div className="browser-error-text">
          <strong>{actionError ?? "Couldn't Load Page"}</strong>
          <span className="mono" hidden={!!actionError}>
            {actionError ? '' : (failure ?? '')}
          </span>
        </div>
        <Button hidden={!!actionError || !failure} onClick={() => actOnTab('reload')}>
          Retry
        </Button>
      </div>
      <div className="certificate-notice" role="status" hidden={!blocked}>
        <Icon name="alert" />
        <div className="browser-error-text">
          <strong>{certificateTitle(blocked)}</strong>
          <span className="mono">{blocked?.origin}</span>
        </div>
        <Button
          onClick={() => {
            reviewing = blocked?.id;
            render();
          }}
        >
          Review
        </Button>
        <IconButton icon="close" label="Dismiss" disabled={answered === blocked?.id} onClick={() => answer(false, blocked)} />
      </div>
      <div
        ref={(node) => {
          body = node;
        }}
        className="browser-body"
        data-dock={dock.side}
      >
        <div
          ref={(node) => {
            slot = node;
          }}
          className="browser-slot"
        >
          {workspace?.application && <ApplicationStatus workspace={workspace} />}
          <div className="browser-empty" hidden={!!workspace?.application || !(tab && !tab.url && !tab.loading && !challenge)}>
            <Icon name="globe" className="icon empty-icon" />
          </div>
          <section
            className="certificate-warning"
            aria-labelledby="certificate-title"
            hidden={!challenge}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && answered !== challenge?.id) {
                event.preventDefault();
                answer(false);
              }
            }}
          >
            <div className="certificate-card">
              <header className="dialog-header">
                <span className="dialog-icon warning">
                  <Icon name="alert" />
                </span>
                <div className="dialog-titles">
                  <h2 id="certificate-title">{certificateTitle(challenge)}</h2>
                  <p className="dialog-context mono">{challenge?.origin}</p>
                </div>
              </header>
              <dl className="facts">
                {facts
                  .filter(([, value]) => value)
                  .map(([term, value]) => (
                    <Fragment key={term}>
                      <dt>{term}</dt>
                      <dd className={term === 'Subject' || term === 'Issuer' ? '' : 'mono'}>{value}</dd>
                    </Fragment>
                  ))}
              </dl>
              <footer className="dialog-actions">
                <button
                  ref={cancel}
                  type="button"
                  className="button"
                  disabled={!!challenge && answered === challenge.id}
                  onClick={() => answer(false)}
                >
                  <span>Cancel</span>
                </button>
                <Button disabled={!!challenge && answered === challenge.id} onClick={() => answer(true)}>
                  Proceed
                </Button>
              </footer>
            </div>
          </section>
        </div>
        <div
          className="tools-splitter"
          role="separator"
          aria-label="Resize Developer Tools"
          aria-orientation={horizontal ? 'vertical' : 'horizontal'}
          aria-valuenow={dock.size}
          tabIndex={0}
          hidden={!tools}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event);
          }}
          onKeyDown={(event) => {
            const step = { ArrowUp: 16, ArrowLeft: 16, ArrowDown: -16, ArrowRight: -16 }[event.key];
            if (!step) return;
            event.preventDefault();
            setDock({ size: dock.size + step });
          }}
        />
        <div className="tools-dock" hidden={!tools} style={horizontal ? { width: dock.size } : { height: dock.size }}>
          <div className="tools-toolbar">
            <IconButton icon="close" label="Close Developer Tools" onClick={() => actOnTab('devtools')} />
          </div>
          <div ref={(node) => { toolsSlot = node; }} className="tools-slot" />
        </div>
      </div>
      {workspace && <DownloadsPopover workspace={workspace} />}
      {/*
        The list drawn over the page is in a document of its own, so assistive technology reads this copy of it. Its rows
        stay in place and carry their addresses as labels: text taken out of the document while Address is being typed in
        would end the typing that one Undo takes back.
      */}
      <ul className="visually-hidden" id="address-suggestions" role="listbox" aria-label="Suggestions" hidden={!listed.length}>
        {Array.from({ length: suggestionLimit }, (_, index) => (
          <li key={index} id={suggestionId(index)} role="option" aria-selected={index === chosen} aria-label={listed[index]?.url} hidden={index >= listed.length} />
        ))}
      </ul>
      <AddressSuggestions
        field={() => address}
        items={listed}
        highlighted={chosen}
        onChoose={(url) => navigate(url, true)}
        onLeave={() => setSuggesting(false)}
      />
      {tab && (activeManifest().linkStatus !== 'inline' || store.fullscreen === 'content') && (
        <LinkStatus tab={tab} visible={pageVisible()} area={() => slot?.getBoundingClientRect()} />
      )}
    </section>
  );
}
/** The address of the link under the pointer in the page on show, for a theme that shows it itself. */
export function hoveredLink() {
  const { tab } = current();
  return tab && pageVisible() ? targetOf(tab.id) : '';
}
/** Whether the selected tab's page can be shown: its view is on show, and the tab has a page to show rather than a certificate warning. */
function pageVisible() {
  const { workspace, tab } = current();
  return Boolean(
    slot &&
      view &&
      workspace &&
      tab &&
      (!workspace.application || applicationShowsPage(workspace.application, tab)) &&
      (tab.url || tab.loading) &&
      !shownChallenge(tab) &&
      !view.hidden,
  );
}
const boundsOf = (element: HTMLElement): Bounds => {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.max(0, Math.floor(rect.width)),
    height: Math.max(0, Math.floor(rect.height)),
  };
};
let shown: string | null = null;
export function syncNativeView() {
  if (!slot || !view) return;
  if (!pageVisible()) {
    if (shown !== null) {
      api.showBrowser(null);
      shown = null;
    }
    return;
  }
  const { workspace, tab } = current();
  const bounds = boundsOf(slot),
    tools = tab!.devtools && toolsSlot && !toolsSlot.hidden ? boundsOf(toolsSlot) : undefined;
  const key = JSON.stringify([workspace!.id, bounds, tools]);
  if (key !== shown) {
    shown = key;
    api.showBrowser(workspace!.id, bounds, tools);
  }
}
