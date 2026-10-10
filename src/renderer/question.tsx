import { useLayoutEffect, useRef, type MouseEvent } from 'react';
import type { Question } from '../shared';
import { api, render, focusView } from './store';
import { Button, Icon } from './ui';
import { openModal } from './dialogs';
import { dismissPopups } from './popup';

type Asked = { id: string; question: Question; withdrawn?: boolean };
/** Questions from the main process, asked one at a time in the order they came. */
const asked: Asked[] = [];
/** Asks a question, which closes any open popup as Escape would, so that the question has the keyboard. */
export function ask(id: string, question: Question) {
  if (asked.some((entry) => entry.id === id)) return;
  asked.push({ id, question });
  dismissPopups('escape');
  render();
}
/** Drops a question that no longer needs an answer, closing it if it is being asked. */
export function withdraw(id: string) {
  const index = asked.findIndex((entry) => entry.id === id);
  if (index > 0) asked.splice(index, 1);
  else if (index === 0) asked[0]!.withdrawn = true;
  render();
}
/** How long after a question appears a click on its buttons is taken as the end of one meant for the page. */
const settling = 500;
const wording = {
  leave: { title: 'Leave Page?', icon: 'alert', proceed: 'Leave', decline: 'Stay' },
  'hand-off': { title: 'Open in Another Application?', icon: 'external', proceed: 'Open', decline: 'Cancel' },
} as const;
/** Asks whether to leave a page that asks before it is left, or to open a link in another application. */
export function Questions() {
  const current = asked[0];
  return current ? <QuestionDialog key={current.id} entry={current} /> : null;
}
function QuestionDialog({ entry }: { entry: Asked }) {
  const {
    id,
    question: { kind, detail },
  } = entry;
  const dialog = useRef<HTMLDialogElement>(null),
    proceeded = useRef(false),
    opened = useRef(0);
  const { title, icon, proceed, decline } = wording[kind];
  // Leave is the default for a page, and Cancel for another application; Escape and a click outside decline either.
  useLayoutEffect(() => {
    // The question is on show from the frame after it opens.
    opened.current = Date.now();
    dialog.current!.ownerDocument.defaultView!.requestAnimationFrame(() => {
      opened.current = Date.now();
    });
    openModal(dialog.current!, dialog.current!.querySelector<HTMLElement>(kind === 'leave' ? '.primary' : 'button')!);
  }, []);
  useLayoutEffect(() => {
    if (entry.withdrawn) dialog.current?.close();
  });
  // A click from the pointer, unlike one from the keyboard, counts once the question has been on show for a moment; until
  // then a press leaves the keyboard on the default button.
  const early = () => Date.now() - opened.current < settling;
  const answer = (value: boolean) => (event: MouseEvent) => {
    if (event.detail && early()) return;
    proceeded.current = value;
    dialog.current!.close();
  };
  const hold = (event: MouseEvent) => {
    if (early()) event.preventDefault();
  };
  return (
    <dialog
      ref={dialog}
      id="question-dialog"
      className="prompt-dialog"
      aria-labelledby="question-title"
      aria-describedby="question-detail"
      onClose={() => {
        if (!entry.withdrawn) api.answerQuestion(id, proceeded.current);
        asked.shift();
        render();
        // A page that had the keyboard takes it back, unless another dialog is open.
        if (entry.question.page) focusView();
      }}
    >
      <div className="dialog-form">
        <header className="dialog-header">
          <span className={`dialog-icon${kind === 'leave' ? ' warning' : ''}`}>
            <Icon name={icon} />
          </span>
          <div className="dialog-titles">
            <h2 id="question-title">{title}</h2>
            <p id="question-detail" className="dialog-context question-detail">
              {detail}
            </p>
          </div>
        </header>
        <footer className="dialog-actions">
          <Button onMouseDown={hold} onClick={answer(false)}>
            {decline}
          </Button>
          <Button className="primary" onMouseDown={hold} onClick={answer(true)}>
            {proceed}
          </Button>
        </footer>
      </div>
    </dialog>
  );
}
