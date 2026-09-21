import { useState } from 'react';
import { applicationShowsPage, formatBytes, type Workspace } from '../shared';
import { api, run, store, select } from './store';
import { Button, Icon } from './ui';

/** Remote notices are text; only HTTP links become controls, opening through the connection. */
function notice(text: string, workspace: Workspace) {
  return text.split(/(https?:\/\/[^\s<>"')]+)/g).map((part, index) => /^https?:\/\//.test(part)
    ? <button className="application-link" key={index} onClick={() => void run('application', api.newBrowser(workspace.connectionId).then(async id => {
      await api.browser(id, 'navigate', undefined, part);
      // A consent notice stays in its tab while its terms open in another session.
      select({ kind: 'browser', id });
    }), workspace.connectionId)}>{part}<Icon name="external" /></button>
    : part);
}
const verbs = { checking: 'Checking for updates', downloading: 'Downloading', extracting: 'Unpacking', starting: 'Starting', loading: 'Opening' };
export function ApplicationStatus({ workspace }: { workspace: Workspace }) {
  const [pending, setPending] = useState<string>();
  const application = workspace.application!;
  const event = application.event;
  const tab = workspace.tabs[0];
  const connection = store.state.connections.find(c => c.id === workspace.connectionId);
  const connected = connection?.status === 'connected';
  const answer = (accepted: boolean) => {
    if (event.type !== 'applications.consent') return;
    setPending(event.consentId);
    void run('application', api.respondApplication(workspace.id, event.consentId, accepted).catch(error => { setPending(undefined); throw error; }), workspace.connectionId);
  };
  if (applicationShowsPage(application, tab)) return null;
  const failure = event.type === 'applications.ended' ? event.error?.message : event.type === 'applications.ready' ? tab?.error : undefined;
  const state = event.type === 'applications.consent' ? 'consent' : failure ? 'failed' : event.type === 'applications.ended' ? 'ended' : 'progress';
  const progress = event.type === 'applications.progress' ? event : undefined;
  const transfer = progress?.transfer;
  const label = progress ? `${verbs[progress.phase]}${progress.phase === 'checking' || !progress.component ? '' : ` ${progress.component}`}` : `Opening ${workspace.name}`;
  const measure = transfer && (transfer.totalBytes ? `${formatBytes(transfer.receivedBytes)} of ${formatBytes(transfer.totalBytes)}` : formatBytes(transfer.receivedBytes));
  const facts = [connection?.label, progress?.release, progress?.usingCachedRelease && 'cached'].filter(Boolean);
  return <section className="application-status" data-state={state} aria-labelledby="application-title">
    <div className="application-card">
      <header className="dialog-header">
        <span className="dialog-icon session-badge"><Icon name="code" /></span>
        <div className="dialog-titles">
          <h2 id="application-title">{workspace.name}</h2>
          <p className="dialog-context">{facts.join(' · ')}</p>
        </div>
      </header>
      {state === 'consent' && event.type === 'applications.consent' ? <>
        <div className="application-notice">{notice(event.content.text, workspace)}</div>
        {event.content.prompt && <p className="application-prompt">{notice(event.content.prompt, workspace)}</p>}
        <footer className="dialog-actions">
          <Button disabled={pending === event.consentId || !connected} onClick={() => answer(false)}>Cancel</Button>
          <Button className="primary" disabled={pending === event.consentId || !connected} onClick={() => answer(true)}>Accept and Continue</Button>
        </footer>
      </> : state === 'failed' ? <>
        <div className="notice" role="alert">
          <Icon name="alert" />
          <div className="notice-body">
            <div className="notice-title">{event.type === 'applications.ended' ? `Couldn't Start ${workspace.name}` : "Couldn't Load Page"}</div>
            <p className="notice-message">{failure}</p>
          </div>
        </div>
        <footer className="dialog-actions">
          <Button disabled={!connected} onClick={() => void run('application', event.type === 'applications.ended' ? api.retryApplication(workspace.id) : api.browser(workspace.id, 'reload', tab!.id), workspace.connectionId)}>Retry</Button>
        </footer>
      </> : state === 'ended' && event.type === 'applications.ended' ? <>
        <p className="application-ended" role="status">{event.reason === 'cancelled' ? 'Cancelled' : 'Stopped'}</p>
        <footer className="dialog-actions">
          <Button disabled={!connected} onClick={() => void run('application', api.retryApplication(workspace.id), workspace.connectionId)}>Retry</Button>
        </footer>
      </> : <>
        <div className="application-progress">
          <progress aria-labelledby="application-phase" value={transfer?.totalBytes ? transfer.receivedBytes : undefined} max={transfer?.totalBytes} />
          <p className="application-phase">
            <span id="application-phase" role="status">{label}</span>
            <span className="application-measure mono">{measure}</span>
          </p>
        </div>
        <footer className="dialog-actions">
          <Button disabled={!tab} onClick={() => { if (tab) void run('browser', api.browser(workspace.id, 'close', tab.id), workspace.connectionId); }}>Cancel</Button>
        </footer>
      </>}
    </div>
  </section>;
}
