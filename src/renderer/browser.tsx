import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import type { BrowserTab, Workspace } from '../shared';
import { Icon, IconButton, Button, colorStyle } from './ui';
import { api, store, render, describeError, activeTab, dialogOpen, onFocusRequest, sessionColor } from './store';
import { resultsOpen, resultsBounds } from './connect';
const actionErrors = new Map<string, string>();
function act(workspaceId: string, action: Parameters<typeof api.browser>[1], tabId?: string, url?: string) {
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
const current = (): { workspace?: Workspace; tab?: BrowserTab } => {
  const selection = store.selection;
  const workspace =
    selection?.kind === 'browser' ? store.state.workspaces.find((w) => w.id === selection.id) : undefined;
  return { workspace, tab: workspace && activeTab(workspace) };
};
let view: HTMLElement | null = null,
  slot: HTMLDivElement | null = null,
  address: HTMLInputElement | null = null;
function navigate(action: 'back' | 'forward' | 'reload' | 'stop') {
  const { workspace, tab } = current();
  if (workspace && tab) void act(workspace.id, action, tab.id);
}
export function openDevTools() {
  const { workspace, tab } = current();
  if (workspace && tab) void act(workspace.id, 'devtools', tab.id);
}
export function focusAddress() {
  if (!view?.hidden && !dialogOpen()) {
    address?.focus();
    address?.select();
  }
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
        <IconButton icon="back" label="Back" disabled={!tab?.canBack} onClick={() => navigate('back')} />
        <IconButton icon="forward" label="Forward" disabled={!tab?.canForward} onClick={() => navigate('forward')} />
        <IconButton
          icon={tab?.loading ? 'close' : 'reload'}
          label={tab?.loading ? 'Stop' : 'Reload'}
          data-loading={Boolean(tab?.loading)}
          disabled={!tab?.url}
          onClick={() => navigate(tab?.loading ? 'stop' : 'reload')}
        />
        <div className="address-field">
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
        </div>
        <IconButton icon="code" label="Developer Tools" disabled={!tab} onClick={openDevTools} />
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
      <div className="browser-error" role="alert" hidden={!actionError && !failure}>
        <Icon name="alert" />
        <div className="browser-error-text">
          <strong>{actionError ?? "Couldn't Load Page"}</strong>
          <span className="mono" hidden={!!actionError}>
            {actionError ? '' : (failure ?? '')}
          </span>
        </div>
        <Button hidden={!!actionError || !failure} onClick={() => navigate('reload')}>
          Retry
        </Button>
      </div>
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
    </section>
  );
}
const overlaps = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
let shown: string | null = null;
export function syncNativeView() {
  if (!slot || !view) return;
  const { workspace, tab } = current(),
    rect = slot.getBoundingClientRect();
  const visible =
    workspace &&
    tab &&
    (tab.url || tab.loading) &&
    !tab.certificate &&
    !dialogOpen() &&
    !view.hidden &&
    !(resultsOpen() && overlaps(resultsBounds(), rect));
  if (!visible) {
    if (shown !== null) {
      api.showBrowser(null);
      shown = null;
    }
    return;
  }
  const bounds = {
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.max(0, Math.floor(rect.width)),
    height: Math.max(0, Math.floor(rect.height)),
  };
  const key = JSON.stringify([workspace.id, bounds]);
  if (key !== shown) {
    shown = key;
    api.showBrowser(workspace.id, bounds);
  }
}
