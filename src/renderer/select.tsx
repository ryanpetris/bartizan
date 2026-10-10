import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type KeyboardEvent, type Ref } from 'react';
import { Popup, closedByPress } from './popup';
import { Icon } from './ui';

export type SelectOption = { value: string; label: string; style?: CSSProperties };

/** How long a pause in typing starts a new search for an option. */
const typingPause = 500;

/**
 * A choice of one option, shown as a button with the chosen option's label that opens the options as a list below it, in
 * the popup layer. The list takes focus with no option highlighted and the chosen one checked and in view. Enter, Space,
 * Up or Down opens it from the button, and Home, End or typing opens it at the first, last or matching option. In the
 * list, Up and Down move on from the highlighted option, or else from the checked one; Home, End, Page Up, Page Down and
 * typing move too. Enter, Space, Alt+Up and Alt+Down choose the highlighted option, or close the list when none is, and
 * Escape and Tab close it unchanged. `onChange` is told of a choice that changes the value. Where the button's width is
 * its own, it is that of the longest option. With `fixedWidth` the list keeps the button's width and draws only the
 * options in view, so that a long list of fonts in their own faces neither loads them all nor moves as they load.
 */
export function Select({
  value,
  options,
  onChange,
  ref,
  fixedWidth = false,
  className = '',
  ...props
}: {
  value: string;
  options: SelectOption[];
  onChange(value: string): void;
  ref?: Ref<HTMLButtonElement>;
  fixedWidth?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'onChange' | 'children'>) {
  const trigger = useRef<HTMLButtonElement | null>(null),
    list = useRef<HTMLDivElement>(null),
    typed = useRef({ text: '', at: 0 }),
    labelled = useRef(false),
    keyed = useRef(false),
    valueId = useId();
  /** Whether the list is open, and the option highlighted as it opens, if any. */
  const [open, setOpen] = useState<{ at?: number }>();
  const chosen = options.findIndex((option) => option.value === value);
  // A click on the button's label reaches the button as a click of its own, which only focuses it.
  useEffect(() => {
    const node = trigger.current;
    if (!node) return;
    const note = (event: MouseEvent) => {
      if (![...(node.labels ?? [])].some((label) => label.contains(event.target as Node))) return;
      labelled.current = true;
      setTimeout(() => (labelled.current = false));
    };
    node.ownerDocument.addEventListener('click', note, true);
    return () => node.ownerDocument.removeEventListener('click', note, true);
  }, []);
  /** The option that typing `key` leads to from `from`: a repeated letter steps through the options starting with it. */
  const search = (key: string, from: number) => {
    const now = Date.now();
    const text = (now - typed.current.at < typingPause ? typed.current.text : '') + key.toLowerCase();
    typed.current = { text, at: now };
    const repeated = [...text].every((letter) => letter === text[0]),
      prefix = repeated ? text[0]! : text;
    const start = repeated ? from + 1 : Math.max(from, 0);
    for (let step = 0; step < options.length; step++) {
      const index = (start + step) % options.length;
      if (options[index]!.label.toLowerCase().startsWith(prefix)) return index;
    }
    return -1;
  };
  const typing = (event: KeyboardEvent) =>
    event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && (event.key !== ' ' || Date.now() - typed.current.at < typingPause);
  const show = (at?: number) => {
    if (!props.disabled && options.length) setOpen({ at });
  };
  const close = (refocus: boolean) => {
    setOpen(undefined);
    typed.current.at = 0;
    if (refocus) trigger.current?.focus({ preventScroll: true });
  };
  const choose = (index: number, keyboard = false) => {
    // Focus returns to the button as the key goes down, and a browser may click it as the key comes up, which follows
    // soon after.
    keyed.current = keyboard;
    if (keyboard) setTimeout(() => (keyed.current = false), 500);
    close(true);
    const option = options[index];
    if (option && option.value !== value) onChange(option.value);
  };
  const items = () => [...(list.current?.querySelectorAll<HTMLElement>(':scope > [role="option"]') ?? [])];
  /** Scrolls the list to an option, to its middle where `center`, and focuses it where `focus`. */
  const reveal = (index: number, { focus = true, center = false } = {}) => {
    const all = items(),
      item = all[Math.min(all.length - 1, Math.max(0, index))],
      box = list.current;
    if (!item || !box) return;
    if (focus) item.focus({ preventScroll: true });
    const top = item.offsetTop,
      bottom = top + item.offsetHeight;
    if (center) box.scrollTop = top - (box.clientHeight - item.offsetHeight) / 2;
    else if (top < box.scrollTop) box.scrollTop = top;
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
  };
  const listKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    // The list is drawn elsewhere in the document tree; its keys are its own.
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    const all = items(),
      at = all.indexOf(event.target as HTMLElement),
      from = at >= 0 ? at : chosen,
      last = all.length - 1;
    const page = Math.max(1, Math.floor((list.current?.clientHeight ?? 0) / (all[0]?.offsetHeight || 1)) - 1);
    const to = {
      ArrowDown: from < 0 ? 0 : from + 1,
      ArrowUp: from < 0 ? last : from - 1,
      Home: 0,
      End: last,
      PageDown: from < 0 ? 0 : from + page,
      PageUp: from < 0 ? last : from - page,
    }[event.key];
    if (typing(event)) {
      const found = search(event.key, from);
      if (found >= 0) reveal(found);
    } else if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) choose(at, true);
    else if (to !== undefined) reveal(to);
    else if (event.key === 'Enter' || event.key === ' ') choose(at, true);
    else if (event.key === 'Escape' || event.key === 'Tab') close(true);
    else return;
    event.preventDefault();
  };
  const label = trigger.current?.labels?.[0]?.textContent ?? props['aria-label'];
  return (
    <>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open !== undefined}
        {...props}
        ref={(node) => {
          trigger.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) ref.current = node;
        }}
        // The button's name is its label; the chosen option's label describes it, before any error.
        aria-describedby={[valueId, props['aria-describedby']].filter(Boolean).join(' ')}
        className={`input select ${className}`.trim()}
        value={value}
        onPointerDown={() => (keyed.current = false)}
        onKeyUp={() => {
          if (keyed.current) setTimeout(() => (keyed.current = false));
        }}
        onClick={(event) => {
          if (keyed.current) keyed.current = false;
          else if (labelled.current) event.currentTarget.focus();
          else if (!closedByPress(event.currentTarget)) show();
        }}
        onKeyDown={(event) => {
          keyed.current = false;
          if (event.nativeEvent.isComposing) return;
          if (typing(event)) {
            const found = search(event.key, chosen);
            if (found >= 0) show(found);
          } else if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) show();
          else if (event.key === 'Home') show(0);
          else if (event.key === 'End') show(options.length - 1);
          else return;
          event.preventDefault();
        }}
      >
        <span className="select-value" id={valueId}>{options[chosen]?.label}</span>
        {!fixedWidth &&
          options.map((option) => <span key={option.value} className="select-size" data-label={option.label} />)}
      </button>
      {open && trigger.current && (
        <Popup
          ref={list}
          anchor={trigger.current}
          className={`menu select-list${fixedWidth ? ' fixed' : ''}`}
          role="listbox"
          tabIndex={-1}
          aria-label={label ?? undefined}
          style={{ [fixedWidth ? 'width' : 'minWidth']: trigger.current.offsetWidth }}
          // A press elsewhere returns focus to the button, unless the press takes it.
          onDismiss={(reason) => close(reason !== 'gone')}
          onShown={(surface) => {
            if (open.at !== undefined) return reveal(open.at, { center: true });
            surface.focus({ preventScroll: true });
            if (chosen >= 0) reveal(chosen, { focus: false, center: true });
          }}
          onKeyDown={listKeys}
          // A press between the options leaves focus where it is.
          onMouseDown={(event) => {
            if (!(event.target as Element).closest('[role="option"]')) event.preventDefault();
          }}
        >
          {options.map((option, index) => (
            <div
              key={option.value}
              role="option"
              aria-selected={index === chosen || undefined}
              tabIndex={-1}
              className="menu-item"
              data-value={option.value}
              onPointerMove={(event) => {
                // An option that appears under a still pointer gets a move with no movement; only a moving pointer focuses it.
                const item = event.currentTarget;
                if ((event.movementX || event.movementY) && item.ownerDocument.activeElement !== item) item.focus({ preventScroll: true });
              }}
              onClick={(event) => {
                event.stopPropagation();
                choose(index);
              }}
            >
              <span className="menu-icon">{index === chosen && <Icon name="check" />}</span>
              <span className="menu-label" style={option.style}>
                {option.label}
              </span>
            </div>
          ))}
        </Popup>
      )}
    </>
  );
}
