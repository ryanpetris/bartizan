import { api, dialogHost, dialogOpen } from './store';

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
const dismissals = new WeakMap<HTMLDialogElement, () => void>();
// Where a select's list is drawn in the page, a press outside it closes the list and nothing more.
const openList = CSS.supports('selector(:open)') ? 'select:open' : undefined;
/**
 * How long before a press the window may have come to the front for the press to count as the one that brought it there;
 * it also allows for the time the question takes to reach the main process.
 */
const activation = 100;
/** Whether a pointer event is on the dialog's backdrop, outside its box. */
function onBackdrop(dialog: HTMLDialogElement, { target, clientX: x, clientY: y }: MouseEvent) {
  const box = dialog.getBoundingClientRect();
  return target === dialog && (x < box.left || x > box.right || y < box.top || y > box.bottom);
}
/**
 * Opens a modal above the native page view and returns focus to where it was once no modal remains. A click that starts
 * and ends on the backdrop calls `dismiss`, or closes the dialog when none is given, unless it brings the window to the
 * front, closes a select's list, or continues a run of clicks that did not start on the backdrop.
 */
export function openModal(dialog: HTMLDialogElement, focus?: HTMLElement, dismiss?: () => void) {
  if (!managed.has(dialog)) {
    managed.add(dialog);
    // A press on the backdrop leaves focus where it is. `pressed` is when it happened, by the clock of the dialog's document,
    // and `count` is the click count of the run of backdrop presses it continues.
    let pressed: number | undefined,
      count = 0;
    dialog.addEventListener('close', () => {
      pressed = undefined;
      count = 0;
      closed(dialog);
    });
    dialog.addEventListener('mousedown', (event) => {
      const continues = event.detail === 1 || event.detail === count + 1;
      pressed = undefined;
      count = 0;
      if (!onBackdrop(dialog, event)) return;
      event.preventDefault();
      if (!continues) return;
      count = event.detail;
      if (!(openList && dialog.querySelector(openList))) pressed = event.timeStamp;
    });
    dialog.addEventListener('click', (event) => {
      if (pressed === undefined || !onBackdrop(dialog, event)) return;
      const elapsed = dialog.ownerDocument.defaultView!.performance.now() - pressed;
      void api.activatedWithin(elapsed + activation).then(
        (activated) => { if (!activated && dialog.open) dismissals.get(dialog)!(); },
        () => {},
      );
    });
  }
  dismissals.set(dialog, dismiss ?? (() => dialog.close()));
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
