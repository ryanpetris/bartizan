import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import type { BrowserAction, BrowserShortcut, Bounds } from '../shared';
import { Icon, IconButton, Button, colorStyle } from './ui';
import { api, render, describeError, dialogOpen, onFocusRequest, sessionColor, activeManifest } from './store';
import { currentTab as current, findText, setFindText, targetOf } from './tab-state';
import { openMenu } from './menu';
import { FindBar, focusFind } from './browser-find';
import { DownloadsButton, DownloadsPopover } from './browser-downloads';
import { LinkStatus } from './browser-status';

const actionErrors = new Map<string, string>();
function act(workspaceId: string, action: BrowserAction, tabId?: string, url?: string) {
  return api.browser(workspaceId, action, tabId, url).then(
    () => {
      actionErrors.delete(workspaceId);
      render();
    },
    (error) => {
      actionErrors.set(workspaceId, describeError(error).message);
      render();
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
    address?.focus();
    address?.select();
  }
}
function openFind() {
  const { tab } = current();
  if (!tab?.url || view?.hidden || dialogOpen()) return;
  if (findText(tab.id) === undefined) setFindText(tab.id, '');
  focusFind();
}
/** Runs a shortcut on the selected session: one the application takes itself, or the find bar, which the main process asks for once a page has left its key alone. */
export function shortcut(name: Exclude<BrowserShortcut, 'new-connection'> | 'find') {
  if (name === 'focus-address') focusAddress();
  else if (name === 'find') openFind();
  else if (current().tab?.url) actOnTab(name);
}

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
export function Browser() {
  const { workspace, tab } = current();
  const [draft, setDraft] = useState<{ id: string | undefined; value: string }>();
  const [answered, setAnswered] = useState<string>();
  const pending = useRef<string | undefined>(undefined),
    frame = useRef<number | undefined>(undefined),
    cancel = useRef<HTMLButtonElement>(null);
  const editing = draft?.id === tab?.id && draft !== undefined;
  const challenge = tab?.certificate;
  const cancelSelection = () => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
  };
  useLayoutEffect(() => {
    setDraft(undefined);
  }, [tab?.id]);
  useLayoutEffect(
    () =>
      onFocusRequest(() => {
        const { tab } = current();
        if (tab && !tab.url && !dialogOpen()) focusAddress();
      }),
    [],
  );
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
        if (current().tab?.certificate?.id === challenge.id && !dialogOpen()) cancel.current?.focus();
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
  function answer(allow: boolean) {
    if (!workspace || !challenge || pending.current === challenge.id || answered === challenge.id) return;
    const id = challenge.id;
    pending.current = id;
    setAnswered(id);
    void api
      .answerCertificate(id, allow)
      .then(
        (result) => {
          actionErrors.delete(workspace.id);
          if (!result) setAnswered((previous) => (previous === id ? undefined : previous));
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
        className="browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          if (!workspace || !address?.value.trim()) return;
          const value = address.value;
          setDraft(undefined);
          void act(workspace.id, tab ? 'navigate' : 'new', tab?.id, value);
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
            spellCheck={false}
            autoComplete="off"
            value={editing ? draft.value : (tab?.url ?? '')}
            onInput={cancelSelection}
            onChange={(event) => {
              setDraft({ id: tab?.id, value: event.target.value });
              if (workspace && actionErrors.delete(workspace.id)) render();
            }}
            onBlur={cancelSelection}
            onFocus={() => {
              cancelSelection();
              frame.current = requestAnimationFrame(() => {
                frame.current = undefined;
                if (document.activeElement === address) address?.select();
              });
            }}
            onKeyDown={(event) => {
              cancelSelection();
              if (event.key === 'Escape' && (editing || address?.value !== (tab?.url ?? ''))) {
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
            title="Reset Zoom"
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
          onClick={(event) =>
            openMenu(event.currentTarget, [
              { label: 'Find in Page', disabled: !tab?.url, action: openFind },
              { separator: true },
              { label: 'Zoom In', disabled: !tab?.url, action: () => actOnTab('zoom-in') },
              { label: 'Zoom Out', disabled: !tab?.url, action: () => actOnTab('zoom-out') },
              { label: 'Reset Zoom', disabled: !zoomed, action: () => actOnTab('zoom-reset') },
              { separator: true },
              { label: 'Hard Reload', disabled: !tab?.url, action: () => actOnTab('hard-reload') },
              { label: 'Save as PDF…', disabled: !tab?.url, action: () => actOnTab('pdf') },
              { label: 'Print…', disabled: !tab?.url, action: () => actOnTab('print') },
              { separator: true },
              {
                label: horizontal ? 'Dock Developer Tools at Bottom' : 'Dock Developer Tools at Right',
                action: () => setDock({ side: horizontal ? 'bottom' : 'right' }),
              },
            ])
          }
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
          <div className="browser-empty" hidden={!(tab && !tab.url && !tab.loading && !challenge)}>
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
                  <h2 id="certificate-title">
                    {certificateTitles.find(([code]) => challenge?.error.includes(code))?.[1] ?? 'Certificate Error'}
                  </h2>
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
        <div
          ref={(node) => {
            toolsSlot = node;
          }}
          className="tools-slot"
          hidden={!tools}
          style={horizontal ? { width: dock.size } : { height: dock.size }}
        />
      </div>
      {workspace && <DownloadsPopover workspace={workspace} />}
      {tab && activeManifest().linkStatus !== 'inline' && (
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
/** Whether the selected tab's page can be shown: it has something to show and no interface of the application lies over it. */
function pageVisible() {
  const { workspace, tab } = current();
  return Boolean(
    slot &&
      view &&
      workspace &&
      tab &&
      (tab.url || tab.loading) &&
      !tab.certificate &&
      !dialogOpen() &&
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
