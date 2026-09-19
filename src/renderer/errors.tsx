import { useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties } from 'react';
import { Toaster, toast } from 'sonner';
import type { ErrorEntry, ErrorLog } from '../shared';
import { Errors as ErrorStore, newestErrorFirst } from '../core/errors';
import { Button, Icon } from './ui';
import { api, render, run, activeManifest, dialogOpen, store } from './store';
import { Overlay } from './overlay';
import { openModal } from './dialogs';
import { activeTheme } from './themes';

const visible = 3;

let remoteLog: ErrorLog = { current: [], history: [] };
let log: ErrorLog = remoteLog;
/** Graphics and transport problems belong to this page, independently of other backend clients. */
export const localErrors = new ErrorStore(() => applyLog());
/** Whether a connection has a current problem. */
export const hasCurrent = (connectionId: string) => log.current.some((entry) => entry.connectionId === connectionId);

/** Shown toasts, oldest first. Each showing has its own toast id, so one still leaving never takes a newer one with it. */
type Shown = { key: string; entry: ErrorEntry };
let shown: Shown[] = [];
const pending = new Map<number, ErrorEntry>();
const toastPlacement = () => {
  const placement = activeTheme().toasts?.() ?? activeManifest().toasts;
  return placement.overlay && !store.state.capabilities.embeddedBrowser
    ? { overlay: false as const, position: 'top-right' as const, offset: { top: 64, right: 16 }, width: '356px' }
    : placement;
};
const obscured = () => toastPlacement().overlay && dialogOpen();
function defer(entry: ErrorEntry) {
  pending.delete(entry.id);
  pending.set(entry.id, entry);
  while (pending.size > visible) pending.delete(pending.keys().next().value!);
}
let keys = 0;
/** Each logged entry's count and message in the last snapshot; unset until the initial snapshot arrives. */
let seen: Map<number, string> | undefined;
const signature = (entry: ErrorEntry) => `${entry.count}\n${entry.message}`;

/**
 * Applies a log snapshot. A problem that is no longer current leaves the toasts, and one that resolved before its
 * snapshot arrived stays in history only. Once the initial snapshot has been applied, any other entry that is new or
 * whose count or message changed arrives as a toast.
 */
export function transportError(message: string) {
  localErrors.report({ source: 'transport', label: 'App', message });
}
export function receive(next: ErrorLog, initial = false) {
  remoteLog = next;
  applyLog(initial);
}
function applyLog(initial = false) {
  const local = localErrors.snapshot();
  // Backend IDs are positive; page-local IDs are negative in the combined view.
  const entriesWithLocalIds = (entries: ErrorEntry[]) => entries.map(entry => ({ ...entry, id: -entry.id }));
  const next = {
    current: [...remoteLog.current, ...entriesWithLocalIds(local.current)],
    history: [...remoteLog.history, ...entriesWithLocalIds(local.history)],
  };
  log = next;
  const current = new Set(next.current.map((entry) => entry.id));
  const live = (entry: ErrorEntry) => entry.kind !== 'current' || current.has(entry.id);
  for (const item of shown) if (!live(item.entry)) hide(item);
  for (const [id, entry] of pending) if (!live(entry)) pending.delete(id);
  const entries = new Map<number, ErrorEntry>();
  for (const entry of [...next.history, ...next.current]) entries.set(entry.id, entry);
  const arrivals =
    seen && !initial
      ? [...entries.values()].filter((entry) => live(entry) && seen!.get(entry.id) !== signature(entry))
      : [];
  if (seen || initial) seen = new Map([...entries.values()].map((entry) => [entry.id, signature(entry)]));
  for (const entry of arrivals.sort((a, b) => newestErrorFirst(b, a)).slice(-visible)) show(entry);
  render();
}
/** Shows an entry as the newest toast, replacing its earlier showing; the oldest toast gives way. */
function show(entry: ErrorEntry) {
  for (const item of shown) if (item.entry.id === entry.id) hide(item);
  if (obscured()) { defer(entry); return; }
  const item = { key: `error-toast-${++keys}`, entry };
  shown.push(item);
  issue(item);
  while (shown.length > visible) hide(shown[0]);
}
/** Gives sonner a shown item's toast; for a toast already on show, sonner updates it and measures it again. */
function issue({ key, entry }: Shown) {
  const forget = () => {
    shown = shown.filter((item) => item.key !== key);
  };
  toast.error(<button className="error-toast-title" type="button" aria-haspopup="dialog" onClick={openToastErrors}>
    {entry.count > 1 ? `${entry.label} ×${entry.count}` : entry.label}
  </button>, {
    id: key,
    className: key,
    description: entry.message,
    onDismiss: forget,
    onAutoClose: forget,
  });
}
/** Removes a toast; focus inside it moves to the newest toast left, or to the Errors button. */
function hide(item: Shown) {
  shown = shown.filter((other) => other !== item);
  if (toastRoot.hasFocus() && toastRoot.querySelector(`.${item.key}`)?.contains(toastRoot.activeElement))
    (
      shown
        .map((other) => toastRoot.querySelector<HTMLElement>(`.${other.key} [data-close-button]`))
        .reverse()
        .find(Boolean) ?? button
    )?.focus();
  toast.dismiss(item.key);
}
/** The document the toasts are in: the application's, or an overlay's. */
let toastRoot: Document = document;
const toastWidth = 356,
  toastGap = 14,
  toastInset = 16;
function openToastErrors() { button?.focus(); openErrors(); }
function ErrorToaster(props: ComponentProps<typeof Toaster>) {
  return (
    <div
      style={{ display: 'contents' }}
      onClick={(event) => {
        const target = event.target as Element;
        if (target.closest('[data-sonner-toast][data-removed="false"]:not([data-swiped="true"])') && !target.closest('button')) openToastErrors();
      }}
      onKeyDown={(event) => {
        if ((event.key === 'Enter' || event.key === ' ') && (event.target as Element).matches('[data-sonner-toast]')) {
          event.preventDefault();
          openToastErrors();
        }
      }}
    >
      <Toaster {...props} />
    </div>
  );
}
/** Toasts in an overlay's document, in a box as tall as they are; the overlay takes the box's size. */
function ToastSurface() {
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [compact, setCompact] = useState(() => window.matchMedia('(max-height: 560px)').matches);
  useLayoutEffect(() => {
    const query = window.matchMedia('(max-height: 560px)');
    const update = () => setCompact(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useLayoutEffect(() => {
    const root = box.current!.ownerDocument,
      view = root.defaultView!;
    toastRoot = root;
    // Toasts come and go as elements, and each can grow with its text. Sonner places each toast by the height it measured
    // as the toast mounted, so a toast mounted before its styles settled, or one that later becomes compact, is issued
    // again to be measured anew: once it is first seen and whenever its height changes.
    const heights = new WeakMap<Element, number>();
    const sizes = new view.ResizeObserver((entries) => {
      for (const { target } of entries) {
        const height = (target as HTMLElement).offsetHeight;
        if (heights.get(target) === height) continue;
        heights.set(target, height);
        const item = shown.find((other) => target.classList.contains(other.key));
        if (item) issue(item);
      }
      measure();
    });
    const measure = () => {
      const toasts = [...root.querySelectorAll<HTMLElement>('[data-sonner-toast]')];
      setHeight(toasts.length ? toasts.reduce((sum, toast) => sum + toast.offsetHeight, 0) + toastGap * (toasts.length - 1) + toastInset * 2 : 0);
    };
    const track = () => {
      sizes.disconnect();
      for (const toast of root.querySelectorAll('[data-sonner-toast]')) sizes.observe(toast);
      measure();
    };
    const elements = new view.MutationObserver(track);
    elements.observe(root.body, { childList: true, subtree: true });
    track();
    return () => {
      elements.disconnect();
      sizes.disconnect();
      toastRoot = document;
    };
  }, []);
  return (
    <div ref={box} data-compact={compact || undefined} style={{ width: toastWidth + toastInset * 2, height }}>
      <ErrorToaster
        className="error-toaster"
        position="top-right"
        theme="system"
        duration={6000}
        visibleToasts={visible}
        expand
        closeButton
        hotkey={[]}
        customAriaLabel="Notifications"
        offset={toastInset}
        mobileOffset={toastInset}
        gap={toastGap}
        style={{ '--width': `${toastWidth}px` } as CSSProperties}
        toastOptions={{ closeButtonAriaLabel: 'Dismiss' }}
      />
    </div>
  );
}
/**
 * Error notifications, where the theme puts them: inside the application page beside a corner that no page view
 * covers, or in an overlay over the top right corner of the view, or of the page in a browser session, from where
 * they grow downwards. Alt+T is left to terminal sessions.
 */
export function Toasts() {
  const placement = toastPlacement();
  useLayoutEffect(() => {
    if (obscured()) {
      for (const item of shown) { defer(item.entry); hide(item); }
    } else {
      const entries = [...pending.values()];
      pending.clear();
      for (const entry of entries) show(entry);
    }
  });
  // A toaster takes the toasts sonner counts as on show as it mounts, so they move with the placement. Sonner counts a
  // closed toast as gone only once it has faded, through the toaster that showed it; one closed just before the placement
  // changed is let go before the new toaster mounts.
  useLayoutEffect(() => {
    for (const { id } of toast.getToasts()) if (!shown.some((item) => item.key === id)) toast.dismiss(id);
  }, [placement.overlay]);
  if (placement.overlay)
    return (
      <Overlay
        name="toasts"
        place={(size) => {
          // Below a browser session's toolbar, whose controls stay in reach, and otherwise at the top of the view.
          const area = document.querySelector('.browser-view:not([hidden]) .browser-body') ?? document.querySelector('.main');
          const view = area?.getBoundingClientRect();
          return view ? { x: view.right - size.width - toastInset, y: view.top, ...size } : undefined;
        }}
      >
        <ToastSurface />
      </Overlay>
    );
  return (
    <ErrorToaster
      className="error-toaster"
      position={placement.position}
      theme="system"
      duration={6000}
      visibleToasts={visible}
      closeButton
      hotkey={[]}
      customAriaLabel="Notifications"
      offset={placement.offset}
      style={{ '--width': placement.width } as CSSProperties}
      toastOptions={{ closeButtonAriaLabel: 'Dismiss' }}
    />
  );
}

let opened = false,
  button: HTMLButtonElement | null = null;
export function openErrors() {
  if (opened) return;
  opened = true;
  render();
}
export function ErrorsButton() {
  const count = log.current.length;
  return (
    <button
      ref={(node) => {
        button = node;
      }}
      type="button"
      className="icon-button errors-button"
      aria-label="Errors"
      title="Errors"
      aria-haspopup="dialog"
      aria-describedby={count ? 'error-count' : undefined}
      onClick={openErrors}
    >
      <Icon name="alert" />
      <span className="error-count" id="error-count" hidden={!count}>
        {count}
      </span>
    </button>
  );
}

function clock(time: number) {
  const date = new Date(time);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
/** When an entry happened: a resolved problem spans to its resolution and a repeated event to its latest occurrence. */
function period(entry: ErrorEntry) {
  const start = clock(entry.time),
    last = entry.resolvedAt ?? (entry.count > 1 ? entry.lastTime : undefined),
    end = last === undefined ? start : clock(last);
  return end === start ? start : `${start}–${end}`;
}
function ErrorRow({ entry }: { entry: ErrorEntry }) {
  const active = entry.kind === 'current' && entry.resolvedAt === undefined;
  return (
    <li className="error-row" data-terminal-id={entry.terminalId} data-kind={entry.kind} data-active={active || undefined}>
      <div className="error-row-head">
        {active && <Icon name="alert" />}
        <span className="error-label">{entry.label}</span>
        <span className="error-repeat" hidden={entry.count < 2}>
          ×{entry.count}
        </span>
        <time dateTime={new Date(entry.time).toISOString()}>{period(entry)}</time>
      </div>
      <p className="error-text">{entry.message}</p>
    </li>
  );
}
function ErrorList({ entries, kind, title }: { entries: ErrorEntry[]; kind: 'current' | 'history'; title: string }) {
  return (
    <section className={`error-${kind}`} aria-labelledby={`error-${kind}-title`} hidden={!entries.length}>
      <h3 id={`error-${kind}-title`}>{title}</h3>
      <ul>
        {entries.map((entry) => (
          <ErrorRow key={entry.id} entry={entry} />
        ))}
      </ul>
    </section>
  );
}
export function Errors() {
  return opened ? <ErrorsDialog /> : <dialog id="errors-dialog" className="error-panel" />;
}
function ErrorsDialog() {
  const [scope, setScope] = useState('all');
  const dialog = useRef<HTMLDialogElement>(null),
    filter = useRef<HTMLSelectElement>(null),
    clear = useRef<HTMLButtonElement>(null);
  const connections = new Map<string, string>();
  for (const entry of [...log.current, ...log.history].sort(newestErrorFirst))
    if (entry.connectionId && !connections.has(entry.connectionId)) connections.set(entry.connectionId, entry.label);
  const selected = scope === 'all' || scope === 'app' || connections.has(scope) ? scope : 'all';
  const matches = (entry: ErrorEntry) =>
    selected === 'all' || (selected === 'app' ? !entry.connectionId : entry.connectionId === selected);
  const current = log.current.filter(matches).sort(newestErrorFirst),
    history = log.history.filter(matches).sort(newestErrorFirst);
  useLayoutEffect(() => {
    openModal(dialog.current!, dialog.current!);
  }, []);
  useLayoutEffect(() => {
    // Clearing disables the focused button; focus stays in the dialog.
    if (clear.current?.disabled && clear.current.ownerDocument.activeElement === clear.current) filter.current?.focus();
  });
  return (
    <dialog
      ref={dialog}
      id="errors-dialog"
      className="error-panel"
      tabIndex={-1}
      aria-labelledby="errors-title"
      onClose={() => {
        opened = false;
        render();
      }}
    >
      <div className="errors">
        <header className="dialog-header">
          <span className="dialog-icon">
            <Icon name="alert" />
          </span>
          <div className="dialog-titles">
            <h2 id="errors-title">Errors</h2>
          </div>
          <select
            ref={filter}
            className="input"
            aria-label="Filter"
            value={selected}
            onChange={(event) => setScope(event.target.value)}
          >
            <option value="all">All</option>
            <option value="app">App</option>
            {[...connections].map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </header>
        <div className="errors-body">
          <ErrorList entries={current} kind="current" title="Current" />
          <ErrorList entries={history} kind="history" title="History" />
          <p className="error-empty" hidden={current.length + history.length > 0}>
            No Errors
          </p>
        </div>
        <footer className="dialog-actions">
          <button
            ref={clear}
            type="button"
            className="button"
            disabled={!log.history.length}
            onClick={() => { localErrors.clear(); void run('errors', api.clearErrors()); }}
          >
            <span>Clear History</span>
          </button>
          <span className="spacer" />
          <Button onClick={() => dialog.current!.close()}>Close</Button>
        </footer>
      </div>
    </dialog>
  );
}
