import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactNode, type RefObject } from 'react';
const paths: Record<string, string> = {
  fullscreen: '<path d="M5.5 2H2v3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5"/>',
  external: '<path d="M9 2h5v5M14 2 7 9M7 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V9"/>',
  link: '<path d="m6 10 4-4M6.5 4.5l1-1a3.2 3.2 0 0 1 4.5 4.5l-1 1M9.5 11.5l-1 1A3.2 3.2 0 0 1 4 8l1-1"/>',
  plus: '<path d="M8 3.25v9.5M3.25 8h9.5"/>',
  minus: '<path d="M3.25 8h9.5"/>',
  close: '<path d="m4.25 4.25 7.5 7.5m0-7.5-7.5 7.5"/>',
  terminal:
    '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75"/><path d="m4.5 6.25 2 1.75-2 1.75M8.25 10h3"/>',
  window:
    '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75"/><path d="M1.75 5.75h12.5"/><circle cx="3.9" cy="4.25" r=".2" fill="currentColor"/><circle cx="5.5" cy="4.25" r=".2" fill="currentColor"/>',
  globe:
    '<circle cx="8" cy="8" r="6.25"/><path d="M1.75 8h12.5M8 1.75c1.8 1.7 2.7 3.8 2.7 6.25S9.8 12.55 8 14.25C6.2 12.55 5.3 10.45 5.3 8S6.2 3.45 8 1.75Z"/>',
  back: '<path d="M13 8H3.25M7.25 4 3.25 8l4 4"/>',
  forward: '<path d="M3 8h9.75M8.75 4l4 4-4 4"/>',
  reload: '<path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71"/><path d="M12.25 1.75v2.75H9.5"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.4 10.4 3.35 3.35"/>',
  power: '<path d="M8 1.75v5.5M4.6 3.9a5.25 5.25 0 1 0 6.8 0"/>',
  key: '<circle cx="5.25" cy="10.75" r="3"/><path d="m7.4 8.6 6.1-6.1M11.25 4.75 13 6.5M9.5 6.5l1.25 1.25"/>',
  shield:
    '<path d="M8 1.75 13.25 3.6v4.05c0 3.05-2.2 5.55-5.25 6.6-3.05-1.05-5.25-3.55-5.25-6.6V3.6Z"/><path d="m5.75 8 1.6 1.6 2.9-3.1"/>',
  info: '<circle cx="8" cy="8" r="6.25"/><path d="M7 7.25h1v4M7 11.25h2"/><circle cx="7.9" cy="4.75" r=".35" fill="currentColor"/>',
  alert:
    '<circle cx="8" cy="8" r="6.25"/><path d="M8 4.75v3.9"/><circle cx="8" cy="11.1" r=".35" fill="currentColor"/>',
  lock: '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.25 7V5a2.75 2.75 0 0 1 5.5 0v2"/>',
  clock: '<circle cx="8" cy="8" r="6.25"/><path d="M8 4.75V8l2.25 1.5"/>',
  undo: '<path d="M3.75 6h6a3.25 3.25 0 0 1 0 6.5H6.5"/><path d="M6.5 3 3.5 6l3 3"/>',
  settings:
    '<path d="M6.73 3.27 6.98 1.58h2.04l.25 1.69 1.18.49 1.37-1.02 1.44 1.44-1.02 1.37.49 1.18 1.69.25v2.04l-1.69.25-.49 1.18 1.02 1.37-1.44 1.44-1.37-1.02-1.18.49-.25 1.69H6.98l-.25-1.69-1.18-.49-1.37 1.02-1.44-1.44 1.02-1.37-.49-1.18-1.69-.25V6.98l1.69-.25.49-1.18-1.02-1.37 1.44-1.44 1.37 1.02Z"/><circle cx="8" cy="8" r="2"/>',
  code: '<path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5l3.5 3.5-3.5 3.5"/>',
  agent: '<path d="M3.5 2.75h9a1.75 1.75 0 0 1 1.75 1.75v5a1.75 1.75 0 0 1-1.75 1.75H7.5l-3 2.5v-2.5h-1a1.75 1.75 0 0 1-1.75-1.75v-5A1.75 1.75 0 0 1 3.5 2.75Z"/><path d="m5.25 5.5 1.75 1.5-1.75 1.5M8.5 8.5h2.25"/>',
  volume: '<path d="M2.75 6.25h2.5L8.5 3.5v9L5.25 9.75h-2.5Z"/><path d="M10.75 5.75a3.2 3.2 0 0 1 0 4.5M12.4 4a5.6 5.6 0 0 1 0 8"/>',
  'volume-off': '<path d="M2.75 6.25h2.5L8.5 3.5v9L5.25 9.75h-2.5Z"/><path d="m10.75 6.25 3 3.5m0-3.5-3 3.5"/>',
  download: '<path d="M8 2.5v7.75M4.75 7.25 8 10.5l3.25-3.25M3 13.25h10"/>',
  folder:
    '<path d="M1.75 4.25a1.5 1.5 0 0 1 1.5-1.5h3l1.5 1.75h5a1.5 1.5 0 0 1 1.5 1.5v5.75a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5Z"/>',
  more: '<circle cx="8" cy="3.5" r=".5" fill="currentColor"/><circle cx="8" cy="8" r=".5" fill="currentColor"/><circle cx="8" cy="12.5" r=".5" fill="currentColor"/>',
  up: '<path d="m4.5 9.75 3.5-3.5 3.5 3.5"/>',
  right: '<path d="m6.25 4.5 3.5 3.5-3.5 3.5"/>',
  check: '<path d="m3.5 8.25 3 3 6-6.5"/>',
  down: '<path d="m4.5 6.25 3.5 3.5 3.5-3.5"/>',
  sidebar: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75"/><path d="M6.25 2.75v10.5"/>',
  sliders:
    '<path d="M2.25 4.75h6.5m3 0h2M2.25 11.25h2m3 0h6.5"/><circle cx="10.25" cy="4.75" r="1.5"/><circle cx="5.75" cy="11.25" r="1.5"/>',
};
export type IconName = keyof typeof paths;
export const isIcon = (name: string | undefined): name is IconName => name !== undefined && Object.hasOwn(paths, name);

export const colorStyle = (color: string | undefined) => ({ '--session-color': color }) as CSSProperties;
export function Icon({ name, className = 'icon' }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: paths[name] }}
    />
  );
}
/** A button that shows an icon, named by `label`; its tooltip is `tooltip`, or the label. */
export function IconButton({
  icon,
  label,
  tooltip = label,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; tooltip?: string }) {
  return (
    <button type="button" className={`icon-button ${className}`.trim()} aria-label={label} data-tooltip={tooltip} {...props}>
      <Icon name={icon} />
    </button>
  );
}
export function Button({
  children,
  icon,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: IconName }) {
  return (
    <button type="button" className={`button ${className}`.trim()} {...props}>
      {icon && <Icon name={icon} />}
      <span>{children}</span>
    </button>
  );
}
/** Whether text is something other than nothing or a decimal number within a float's range, as a number field reads one. */
export const notNumber = (text: string) =>
  !/^\s*(-?(\d+(\.\d+)?|\.\d+)(e[-+]?\d+)?)?\s*$/i.test(text) || Math.abs(Number(text)) > 3.4028234663852886e38;
/**
 * The whole number one step up or down takes text to, from `min` to `max`, as a number field's spin buttons step: a value
 * beyond the range steps to its nearer end, and text that is no number steps from zero. There is none where the value is
 * already at the end it steps towards.
 */
export function stepNumber(text: string, direction: 1 | -1, min: number, max: number): number | undefined {
  let value = text.trim() && !notNumber(text) ? Number(text) : NaN;
  if (!Number.isFinite(value)) value = Math.min(Math.max(0, min - direction), max - direction);
  if (direction > 0 ? value < min : value > max) return direction > 0 ? min : max;
  if (direction > 0 ? value >= max : value <= min) return undefined;
  return Math.min(max, Math.max(min, direction > 0 ? Math.floor(value) + 1 : Math.ceil(value) - 1));
}
/**
 * A field for a whole number from `min` to `max`, whose buttons and Up and Down keys step it as a number field's do.
 * `onValue` receives its text as it is typed, and each step's with `stepped`.
 */
export function NumberField({
  min,
  max,
  value,
  onValue,
  inputRef,
  onKeyDown,
  className = '',
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'min' | 'max' | 'onChange'> & {
  min: number;
  max: number;
  value: string;
  onValue(text: string, stepped: boolean): void;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const own = useRef<HTMLInputElement>(null),
    input = inputRef ?? own;
  // A held button steps on from the value its last step made.
  const latest = useRef({ value, onValue }),
    held = useRef<() => void>(undefined),
    over = useRef(true);
  latest.current = { value, onValue };
  const release = () => {
    held.current?.();
    held.current = undefined;
  };
  useEffect(() => release, []);
  /** Steps the value, returning whether it changed. */
  const step = (direction: 1 | -1) => {
    const next = stepNumber(latest.current.value, direction, min, max);
    if (next === undefined) return false;
    latest.current.value = String(next);
    latest.current.onValue(String(next), true);
    return true;
  };
  /**
   * Steps on while the button is held and the pointer is over it, until it is let go, the window loses focus or the range
   * ends. The button holds the pointer while pressed, so the pointer's moves tell whether it is still over it.
   */
  const hold = (button: HTMLElement, direction: 1 | -1) => {
    release();
    over.current = true;
    if (!step(direction)) return;
    const view = button.ownerDocument.defaultView!,
      stop = () => release(),
      hidden = () => {
        if (view.document.hidden) release();
      };
    let timer: ReturnType<typeof setTimeout>;
    const repeat = (delay: number) => {
      timer = setTimeout(() => {
        if (!over.current || step(direction)) repeat(50);
      }, delay);
    };
    view.addEventListener('blur', stop);
    view.document.addEventListener('visibilitychange', hidden);
    held.current = () => {
      clearTimeout(timer);
      view.removeEventListener('blur', stop);
      view.document.removeEventListener('visibilitychange', hidden);
    };
    repeat(400);
  };
  return (
    <span className="number-field">
      <input
        ref={input}
        autoComplete="off"
        spellCheck={false}
        {...props}
        className={`input ${className}`.trim()}
        type="text"
        inputMode="numeric"
        role="spinbutton"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value.trim() && !notNumber(value) ? Number(value) : undefined}
        value={value}
        onChange={(event) => onValue(event.target.value, false)}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
          event.preventDefault();
          step(event.key === 'ArrowUp' ? 1 : -1);
        }}
      />
      <span className="number-steps">
        {(
          [
            [-1, 'minus', 'Decrease'],
            [1, 'plus', 'Increase'],
          ] as const
        ).map(([direction, icon, label]) => (
          <button
            key={icon}
            type="button"
            className="number-step"
            tabIndex={-1}
            aria-label={label}
            disabled={props.disabled}
            // A button at the end of the range stays clickable, so a click there still leaves the keyboard in the field.
            aria-disabled={stepNumber(value, direction, min, max) === undefined || undefined}
            // As a number field's spin buttons do, the field keeps the keyboard, or takes it, and a held button repeats.
            onPointerDown={(event) => {
              if (event.button === 0) event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onMouseDown={(event) => {
              event.preventDefault();
              input.current?.focus();
              if (event.button === 0) hold(event.currentTarget, direction);
            }}
            onPointerMove={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              over.current = event.clientX >= box.left && event.clientX < box.right && event.clientY >= box.top && event.clientY < box.bottom;
            }}
            onMouseUp={release}
            onLostPointerCapture={release}
            onPointerCancel={release}
            // A click that comes without the pointer, as from assistive technology, steps once.
            onClick={(event) => {
              if (!event.detail) step(direction);
            }}
          >
            <Icon name={icon} />
          </button>
        ))}
      </span>
    </span>
  );
}
export function Tags({ tags }: { tags: string[] }) {
  return (
    <span className="tag-list" data-tooltip={tags.join(', ') || undefined}>
      {tags.map((tag) => (
        <span className="tag" key={tag}>
          {tag}
        </span>
      ))}
    </span>
  );
}
/** Moves focus among items with the arrow, Home and End keys; returns whether it handled the key. */
export function moveFocus(items: HTMLElement[], key: string, wrap = false): boolean {
  const index = items.indexOf((items[0]?.ownerDocument ?? document).activeElement as HTMLElement);
  const next =
    key === 'ArrowDown' ? index + 1 : key === 'ArrowUp' ? index - 1 : key === 'Home' ? 0 : key === 'End' ? items.length - 1 : NaN;
  if (index < 0 || Number.isNaN(next)) return false;
  items[wrap ? (next + items.length) % items.length : Math.min(items.length - 1, Math.max(0, next))]?.focus();
  return true;
}
/** A dialog's notice of unsaved changes, and `hold`, which shows it for three seconds when they keep a click outside from dismissing the dialog. */
export function useUnsavedNotice(): [notice: ReactNode, hold: () => void] {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const hold = useCallback(() => {
    setShown(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setShown(false), 3000);
  }, []);
  return [
    <p className="unsaved-notice" role="status">
      {shown ? 'Unsaved changes' : ''}
    </p>,
    hold,
  ];
}
