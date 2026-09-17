import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { API } from '../shared';
import { Icon, Button } from './ui';
import { api, render, connectionOf, endpoint, reporter, statusText } from './store';
import { openModal } from './dialogs';
type ConnectionInfo = Awaited<ReturnType<API['details']>>;
let opening = false;
let shown: { id: string; info: ConnectionInfo } | undefined;
let inFlight: Promise<unknown> = Promise.resolve();
function request(id: string) {
  const next = inFlight.then(() => api.details(id));
  inFlight = next.catch(() => {});
  return next;
}
export async function openDetails(id: string) {
  if (shown || opening) return;
  opening = true;
  const failed = reporter('session', id);
  try {
    const info = await request(id);
    if (connectionOf(id)) {
      shown = { id, info };
      render();
    }
  } catch (error) {
    failed(error);
  } finally {
    opening = false;
  }
}
const rows: [label: string, value: (info: ConnectionInfo) => string | undefined, mono?: boolean][] = [
  ['Status', (info) => statusText(info)],
  ['Username', (info) => info.username, true],
  ['Duration', (info) => info.duration],
  ['Endpoints', (info) => info.endpoints, true],
  ['Key Exchange', (info) => info.kex, true],
  ['Host Key Algorithm', (info) => info.hostKey, true],
  ['Cipher', (info) => info.cipher, true],
  ['MAC', (info) => info.mac, true],
  ['Compression', (info) => info.compression],
  ['Received', (info) => info.received],
  ['Sent', (info) => info.sent],
];

export function Details() {
  return shown ? <DetailsDialog initial={shown} /> : <dialog id="details-dialog" className="details-dialog" />;
}
function DetailsDialog({ initial }: { initial: NonNullable<typeof shown> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [observed, setObserved] = useState(initial.info);
  const connection = connectionOf(initial.id),
    status = connection?.status ?? 'closed';
  const context = useRef('');
  if (connection) context.current = `${connection.label} · ${endpoint(connection)}`;
  const { duration, received, sent, ...rest } = observed;
  const info = {
    ...(status === 'connected' ? observed : rest),
    status,
    exitCode: connection ? connection.exitCode : observed.exitCode,
  };
  useLayoutEffect(() => {
    openModal(dialog.current!, dialog.current!.querySelector('button')!);
  }, []);
  useEffect(() => {
    if (!connection || observed.status === 'closed') return;
    let cancelled = false;
    const timer = setTimeout(
      () => {
        void request(initial.id).then(
          (result) => {
            if (!cancelled) setObserved(result);
          },
          () => {},
        );
      },
      status === 'closed' ? 0 : 2000,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [status, !!connection, observed]);
  return (
    <dialog
      ref={dialog}
      id="details-dialog"
      className="details-dialog"
      aria-labelledby="details-title"
      onClose={() => {
        shown = undefined;
        render();
      }}
    >
      <div className="details">
        <header className="dialog-header">
          <span className="dialog-icon">
            <Icon name="info" />
          </span>
          <div className="dialog-titles">
            <h2 id="details-title">Connection Details</h2>
            <p className="dialog-context">{context.current}</p>
          </div>
        </header>
        <div className="details-body">
          <dl className="details-list">
            {rows.map(([label, read, mono]) => {
              const value = read(info);
              return value ? (
                <div className="details-row" key={label}>
                  <dt>{label}</dt>
                  <dd className={mono ? 'mono' : ''}>{value}</dd>
                </div>
              ) : null;
            })}
          </dl>
        </div>
        <footer className="dialog-actions">
          <Button onClick={() => dialog.current!.close()}>Close</Button>
        </footer>
      </div>
    </dialog>
  );
}
