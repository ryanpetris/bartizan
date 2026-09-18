import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Toaster, toast } from 'sonner';
import type { ErrorEntry, ErrorLog } from '../shared';
import { Button, Icon } from './ui';
import { api, render, run } from './store';
import { openModal } from './dialogs';

const visible = 3;

let log: ErrorLog = { current: [], history: [] };
/** Whether a connection has a current problem. */
export const hasCurrent = (connectionId: string) => log.current.some((entry) => entry.connectionId === connectionId);

/** Shown toasts, oldest first. Each showing has its own toast id, so one still leaving never takes a newer one with it. */
type Shown = { key: string; entry: ErrorEntry };
let shown: Shown[] = [];
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
  const time = Date.now();
  receive({ ...log, history: [...log.history, { id: -time, source: 'transport', kind: 'event', label: 'App', message, time, lastTime: time, count: 1 }] }, !seen);
}
export function receive(next: ErrorLog, initial = false) {
  log = next;
  const current = new Set(next.current.map((entry) => entry.id));
  const live = (entry: ErrorEntry) => entry.kind !== 'current' || current.has(entry.id);
  for (const item of shown) if (!live(item.entry)) hide(item);
  const entries = new Map<number, ErrorEntry>();
  for (const entry of [...next.history, ...next.current]) entries.set(entry.id, entry);
  const arrivals =
    seen && !initial
      ? [...entries.values()].filter((entry) => live(entry) && seen!.get(entry.id) !== signature(entry))
      : [];
  if (seen || initial) seen = new Map([...entries.values()].map((entry) => [entry.id, signature(entry)]));
  for (const entry of arrivals.sort((a, b) => a.lastTime - b.lastTime || a.id - b.id).slice(-visible)) show(entry);
  render();
}
/** Shows an entry as the newest toast, replacing its earlier showing; the oldest toast gives way. */
function show(entry: ErrorEntry) {
  for (const item of shown) if (item.entry.id === entry.id) hide(item);
  const key = `error-toast-${++keys}`;
  const forget = () => {
    shown = shown.filter((item) => item.key !== key);
  };
  shown.push({ key, entry });
  toast.error(entry.count > 1 ? `${entry.label} ×${entry.count}` : entry.label, {
    id: key,
    className: key,
    description: entry.message,
    onDismiss: forget,
    onAutoClose: forget,
  });
  while (shown.length > visible) hide(shown[0]);
}
/** Removes a toast; focus inside it moves to the newest toast left, or to the Errors button. */
function hide(item: Shown) {
  shown = shown.filter((other) => other !== item);
  if (document.querySelector(`.${item.key}`)?.contains(document.activeElement))
    (
      shown
        .map((other) => document.querySelector<HTMLElement>(`.${other.key} [data-close-button]`))
        .reverse()
        .find(Boolean) ?? button
    )?.focus();
  toast.dismiss(item.key);
}
/** Toasts sit above Connect in the sidebar, which a native page view never covers. Alt+T is left to terminal sessions. */
export function Toasts() {
  return (
    <Toaster
      className="error-toaster"
      position="bottom-left"
      theme="system"
      duration={6000}
      visibleToasts={visible}
      closeButton
      hotkey={[]}
      customAriaLabel="Notifications"
      offset={{ bottom: 60, left: 12 }}
      style={{ '--width': 'calc(var(--sidebar-width) - 24px)' } as CSSProperties}
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

const newestFirst = (a: ErrorEntry, b: ErrorEntry) => b.lastTime - a.lastTime || b.id - a.id;
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
    <li className="error-row" data-kind={entry.kind} data-active={active || undefined}>
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
  for (const entry of [...log.current, ...log.history].sort(newestFirst))
    if (entry.connectionId && !connections.has(entry.connectionId)) connections.set(entry.connectionId, entry.label);
  const selected = scope === 'all' || scope === 'app' || connections.has(scope) ? scope : 'all';
  const matches = (entry: ErrorEntry) =>
    selected === 'all' || (selected === 'app' ? !entry.connectionId : entry.connectionId === selected);
  const current = log.current.filter(matches).sort(newestFirst),
    history = log.history.filter(matches).sort(newestFirst);
  useLayoutEffect(() => {
    openModal(dialog.current!, dialog.current!);
  }, []);
  useLayoutEffect(() => {
    // Clearing disables the focused button; focus stays in the dialog.
    if (clear.current?.disabled && document.activeElement === clear.current) filter.current?.focus();
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
            onClick={() => void run('errors', api.clearErrors())}
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
