import { useLayoutEffect } from 'react';
import { Icon, Button } from './ui';
import { api, store } from './store';
import { openModal } from './dialogs';

let dialog: HTMLDialogElement | null = null,
  requested = false;
const attach = (element: HTMLDialogElement | null) => {
  dialog = element;
};
/** Opens the dialog, or keeps it open; a request made before the dialog is in the page opens it once it is. */
export function openQuit() {
  requested = true;
  show();
}
// Cancel takes the focus, so an Enter already on its way does not quit.
function show() {
  if (!requested || !dialog) return;
  requested = false;
  if (!dialog.open) openModal(dialog, dialog.querySelector('button')!);
  api.askingToQuit();
}
/** Asks before the window closes on live connections. */
export function Quit() {
  const live = store.state.connections.filter((connection) => connection.status !== 'closed').length;
  useLayoutEffect(show, []);
  return (
    <dialog
      ref={attach}
      id="quit-dialog"
      className="prompt-dialog"
      aria-labelledby="quit-title"
    >
      <div className="dialog-form">
        <header className="dialog-header">
          <span className="dialog-icon warning">
            <Icon name="alert" />
          </span>
          <div className="dialog-titles">
            <h2 id="quit-title">Quit Bartizan?</h2>
            <p className="dialog-context">
              {live} active {live === 1 ? 'connection' : 'connections'}
            </p>
          </div>
        </header>
        <footer className="dialog-actions">
          <Button onClick={() => dialog!.close()}>Cancel</Button>
          <Button className="primary" onClick={() => api.quit()}>
            Quit
          </Button>
        </footer>
      </div>
    </dialog>
  );
}
