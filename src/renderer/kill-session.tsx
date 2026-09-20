import { useLayoutEffect, useRef } from 'react';
import type { RemoteSession } from '../shared';
import { api, run, store, render, connectionOf } from './store';
import { Button, Icon } from './ui';
import { openModal } from './dialogs';

let asked: { connectionId: string; session: RemoteSession } | undefined;
export function openKill(connectionId: string, session: RemoteSession) {
  if (asked) return;
  asked = { connectionId, session };
  render();
}
/** Asks before a session on the host is ended, which no client can undo. */
export function KillSession() {
  return asked ? <KillDialog asked={asked} /> : <dialog id="kill-dialog" className="prompt-dialog" />;
}
function KillDialog({ asked: { connectionId, session } }: { asked: NonNullable<typeof asked> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const connection = connectionOf(connectionId);
  useLayoutEffect(() => {
    openModal(dialog.current!, dialog.current!.querySelector('button')!);
  }, []);
  // A session that goes away while the question stands leaves nothing to answer.
  useLayoutEffect(() => {
    if (!connection?.remoteSessions?.sessions.some(s => s.key === session.key)) dialog.current?.close();
  });
  const context = `${session.group} on ${connection?.label ?? ''}`.trim();
  return <dialog ref={dialog} id="kill-dialog" className="prompt-dialog" aria-labelledby="kill-title"
    onClose={() => { asked = undefined; render(); }}>
    <div className="dialog-form">
      <header className="dialog-header">
        <span className="dialog-icon warning"><Icon name="alert" /></span>
        <div className="dialog-titles">
          <h2 id="kill-title">Kill session “{session.label}”?</h2>
          <p className="dialog-context">{context}</p>
        </div>
      </header>
      <footer className="dialog-actions">
        <Button onClick={() => dialog.current!.close()}>Cancel</Button>
        <Button className="danger" onClick={() => {
          dialog.current!.close();
          void run('session', api.killRemoteSession(connectionId, session.key), connectionId);
        }}>Kill</Button>
      </footer>
    </div>
  </dialog>;
}
