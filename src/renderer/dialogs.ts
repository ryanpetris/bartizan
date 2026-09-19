import { dialogHost, dialogOpen } from './store';

let sync: () => void = () => {};
let refocusView: () => void = () => {};
export function onDialogChange(callback: () => void) { sync = callback; }
export function onRefocusView(callback: () => void) { refocusView = callback; }

/** A dialog open in the modal overlay leaves this page unable to take input, as a modal in this page does. */
export function holdPage() {
  const app = document.getElementById('app');
  if (app) app.inert = dialogHost.document !== document && dialogOpen();
}
const managed = new WeakSet<HTMLDialogElement>();
const restore = new WeakMap<HTMLDialogElement, Element | null>();
/** Opens a modal above the native page view and returns focus to where it was once no modal remains. */
export function openModal(dialog: HTMLDialogElement, focus?: HTMLElement) {
  if (!managed.has(dialog)) { managed.add(dialog); dialog.addEventListener('close', () => closed(dialog)); }
  if (!dialog.open) {
    if (!restore.has(dialog)) restore.set(dialog, document.activeElement);
    dialog.showModal();
    holdPage();
    sync();
  }
  focus?.focus();
}
function closed(dialog: HTMLDialogElement) {
  holdPage();
  sync();
  if (dialog.open) return;
  const previous = restore.get(dialog);
  restore.delete(dialog);
  if (dialogOpen()) return;
  const target = previous instanceof HTMLElement && previous.isConnected && previous !== document.body && !previous.closest('dialog') && !previous.closest('[hidden]') ? previous : undefined;
  target?.focus();
  if (!target || document.activeElement !== target) refocusView();
}
