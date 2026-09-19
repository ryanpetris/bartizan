import { useLayoutEffect, useRef, type ReactNode } from 'react';

const tabs = '.terminal-entry > .row, .tab-items > .row';
/** How far from an end of the strip what it brings into sight stays, which is the room the strip's fading ends take. */
const margin = 28;
/**
 * A row of navigation that scrolls sideways. The wheel scrolls it, and it carries `data-overflows` while it has more
 * than it shows. The item in view, or a name being edited, is brought into sight when it changes and when the strip's
 * width does, and so is whatever the keyboard focuses. With `fit`, its tabs share the room that the rest of the row
 * leaves them: the stylesheet bounds the width this gives them as `--tab-width`, and names the least width of the tab
 * in view as `--tab-current-min`.
 */
export function Strip({ className, label, fit = false, children }: { className: string; label?: string; fit?: boolean; children: ReactNode }) {
  const strip = useRef<HTMLDivElement>(null),
    shown = useRef<string | undefined>(undefined);
  const share = (element: HTMLElement) => {
    const list = element.querySelector<HTMLElement>('.connection-items'),
      items = element.querySelectorAll<HTMLElement>(tabs);
    if (!list) return;
    const style = getComputedStyle(element),
      length = (name: string) => parseFloat(style.getPropertyValue(name)),
      current = length('--tab-current-min'),
      inView = list.querySelector('.row.current:not(.session-row)');
    // What the strip holds besides its tabs: its padding, the sessions' names and buttons, and the gaps.
    let rest = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + list.getBoundingClientRect().width;
    for (const item of items) rest -= item.getBoundingClientRect().width;
    if (!items.length) return;
    // The tab in view keeps a width of its own once an equal share falls below it.
    const room = element.clientWidth - rest,
      alone = items.length > 1 && room / items.length < current && inView;
    const width = `${Math.max(0, Math.floor(alone ? (room - current) / (items.length - 1) : room / items.length))}px`;
    if (element.style.getPropertyValue('--tab-width') !== width) element.style.setProperty('--tab-width', width);
  };
  const measure = () => {
    const element = strip.current;
    if (!element) return;
    if (fit) share(element);
    element.toggleAttribute('data-overflows', element.scrollWidth > element.clientWidth);
  };
  /** Scrolls the strip by the least that clears `target` of its fading ends. */
  const bring = (target: Element) => {
    const element = strip.current;
    if (!element) return;
    const box = element.getBoundingClientRect(),
      place = target.getBoundingClientRect();
    if (place.left < box.left + margin) element.scrollLeft -= box.left + margin - place.left;
    else if (place.right > box.right - margin) element.scrollLeft += place.right - box.right + margin;
  };
  const reveal = (always: boolean) => {
    const target =
      strip.current?.querySelector<HTMLElement>('input') ??
      strip.current?.querySelector<HTMLElement>('[aria-current="page"]') ??
      strip.current?.querySelector<HTMLElement>('[aria-current]');
    const id = target ? `${target.localName} ${target.dataset.id} ${Array.from(strip.current!.querySelectorAll('.nav-item, .connection-titles')).indexOf(target)}` : undefined;
    if (!always && id === shown.current) return;
    shown.current = id;
    if (target) bring(target);
  };
  useLayoutEffect(() => {
    // The strip's width follows the window, and the names beside the tabs take their width from fonts that load late.
    const sizes = new ResizeObserver(() => {
      measure();
      reveal(true);
    });
    sizes.observe(strip.current!);
    document.fonts.addEventListener('loadingdone', measure);
    return () => {
      sizes.disconnect();
      document.fonts.removeEventListener('loadingdone', measure);
    };
  }, []);
  useLayoutEffect(() => {
    measure();
    reveal(false);
  });
  return (
    <div
      ref={strip}
      className={className}
      role="navigation"
      aria-label={label}
      onWheel={(event) => {
        if (!event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY;
      }}
      // A pointer's focus leaves the strip where it is, so what is under the pointer stays there until it lets go.
      onFocus={(event) => {
        if (event.target.matches(':focus-visible')) bring(event.target.closest('.row:not(.session-row), .connection-chip') ?? event.target);
      }}
    >
      {children}
    </div>
  );
}
