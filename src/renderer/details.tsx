import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { API, Connection, RemoteProcess } from '../shared';
import { api, store, select, connectionOf, endpoint, statusText, onFocusRequest, dialogOpen } from './store';
import { pageName } from './chrome';

type ConnectionDetails = Awaited<ReturnType<API['details']>>;
export const openDetails = (id: string) => select({ kind: 'details', id });
const rows: [label: string, value: (info: ConnectionDetails) => string | undefined, mono?: boolean][] = [
  ['Username', info => info.username, true],
  ['Duration', info => info.duration],
  ['Endpoints', info => info.endpoints, true],
  ['Received', info => info.received],
  ['Sent', info => info.sent],
];
const security: typeof rows = [
  ['Key Exchange', info => info.kex, true],
  ['Host Key Algorithm', info => info.hostKey, true],
  ['Cipher', info => info.cipher, true],
  ['MAC', info => info.mac, true],
  ['Compression', info => info.compression],
];
const processLabels = { starting: 'Starting', running: 'Running', retrying: 'Retrying', stopping: 'Stopping', failed: 'Failed' };
function InfoRows({ fields, info }: { fields: typeof rows; info: ConnectionDetails }) {
  return fields.map(([label, read, mono]) => {
    const value = read(info);
    return value ? <div className="details-row" key={label}><dt>{label}</dt><dd className={mono ? 'mono' : ''}>{value}</dd></div> : null;
  });
}
function ProcessRow({ process }: { process: RemoteProcess }) {
  return <li className="process-row" data-status={process.status} data-id={process.id}>
    <span className="process-name">{process.name}</span>
    <span className="process-status"><span className="status-dot" aria-hidden="true" />{processLabels[process.status]}</span>
    <span className="process-pid mono">{process.pid === undefined ? '' : `PID ${process.pid}`}</span>
    {process.message && <span className="process-message">{process.message}</span>}
  </li>;
}
export function Details() {
  const connection = store.selection?.kind === 'details' ? connectionOf(store.selection.id) : undefined;
  return connection ? <DetailsPage key={connection.id} connection={connection} /> : null;
}
function DetailsPage({ connection }: { connection: Connection }) {
  const page = useRef<HTMLElement>(null);
  const [info, setInfo] = useState<ConnectionDetails>();
  const [error, setError] = useState<string>();
  useLayoutEffect(() => {
    return onFocusRequest(() => { if (!dialogOpen()) page.current?.focus(); });
  }, []);
  useEffect(() => {
    let pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try { setInfo(await api.details(connection.id)); setError(undefined); }
      catch (error) { setError(error instanceof Error ? error.message : String(error)); }
      finally { pending = false; }
    };
    void read();
    const timer = setInterval(() => void read(), 2000);
    return () => clearInterval(timer);
  }, [connection.id, connection.status]);
  return <section ref={page} tabIndex={-1} className="view page connection-details" aria-label={pageName.details}>
    <div className="details-content">
      {error && <p className="form-error" role="alert">{error}</p>}
      <section aria-labelledby="connection-title">
        <h3 id="connection-title">Connection</h3>
        <dl className="details-list">
          <div className="details-row"><dt>Status</dt><dd className="details-status"><span className="status-dot" data-status={connection.status} aria-hidden="true" />{statusText(connection)}</dd></div>
          <div className="details-row"><dt>Host</dt><dd className="mono">{endpoint(connection)}</dd></div>
          {info && <InfoRows fields={rows} info={info.status === connection.status ? info : { ...info, duration: undefined, received: undefined, sent: undefined }} />}
        </dl>
      </section>
      {info && security.some(([, read]) => read(info)) && <section aria-labelledby="security-title"><h3 id="security-title">SSH</h3><dl className="details-list"><InfoRows fields={security} info={info} /></dl></section>}
      <section hidden={!connection.processes.length} className="details-processes" aria-labelledby="processes-title">
        <h3 id="processes-title">Remote Processes</h3>
        <ul className="process-list">
          {connection.processes.map(process => <ProcessRow key={process.id} process={process} />)}
        </ul>
      </section>
    </div>
  </section>;
}
