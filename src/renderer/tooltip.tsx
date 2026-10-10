import { useEffect, useLayoutEffect, useReducer, useState } from 'react';
import { Popup, popupOpen, windowRect } from './popup';
import { watchOverlays } from './overlay';
import { useStore } from './store';

/**
 * Tooltips name a control by its `data-tooltip` attribute, drawn in the tooltip layer, which shows over pages and dialogs
 * and never takes the keyboard. A tooltip shows once the pointer or keyboard focus has rested on its control for `delay`,
 * or at once while another has just gone; focus counts only shortly after a key, and not after one pressed in a popup,
 * which returns focus to the control the popup opened from as the popup closes. It goes on a press, a key, a scroll
 * that moves its control from under the pointer, the window resizing or losing focus, or the control going, and as the
 * pointer leaves the control or reaches the tooltip, or focus leaves the control. It shows below its control, or above
 * where there is no room, or beside a control inside an element with `data-tooltip-side`. It does not show where the
 * control's text already says the same in full.
 */
const delay = 500,
  grace = 400;
type Tip = { anchor: HTMLElement; text: string };
let shown: Tip | undefined;
let update: ((tip: Tip | undefined) => void) | undefined;
/** The control whose tooltip waits for the delay, and the timer that shows it. */
let pending: HTMLElement | undefined, timer: ReturnType<typeof setTimeout> | undefined;
/** The control under the pointer, and the control that keyboard focus reached. */
let hovered: HTMLElement | undefined, focused: HTMLElement | undefined;
/** When a tooltip last went as the pointer or focus moved on, and when a key was last pressed. */
let left = -Infinity,
  keyed = -Infinity;
/** Whether the last key was pressed while a popup was open. */
let keyedInPopup = false;
/** How soon after a key focus reaching a control counts as the keyboard's; focus moved by the page alone shows nothing. */
const keyFocus = 1000;

const anchorOf = (target: EventTarget | null) =>
  ((target as Element | null)?.closest?.('[data-tooltip]') as HTMLElement | null | undefined) ?? undefined;
function set(tip: Tip | undefined) {
  shown = tip;
  update?.(tip);
}
function hide(moving = false) {
  clearTimeout(timer);
  pending = undefined;
  if (!shown) return;
  if (moving) left = performance.now();
  set(undefined);
}
/** Whether the control's text, shown in full, already says what its tooltip would, ignoring spacing and commas. */
function saysSame(anchor: HTMLElement, text: string) {
  const squash = (value: string) => value.replace(/[\s,]+/g, '');
  const parts: string[] = [];
  const walker = anchor.ownerDocument.createTreeWalker(anchor, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    let visible = true;
    for (let element = node.parentElement; element && visible; element = element === anchor ? null : element.parentElement) {
      // Text clipped out of sight, as a label kept for assistive technology is, does not show; text cut short needs the tooltip.
      // An overlay's elements belong to its own window, so they are not instances of this window's classes.
      if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || ('offsetWidth' in element && ((element as HTMLElement).offsetWidth <= 1 || (element as HTMLElement).offsetHeight <= 1))) visible = false;
      else if (getComputedStyle(element).overflow !== 'visible' && (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)) return false;
    }
    if (visible) parts.push(node.textContent);
  }
  return squash(parts.join('')) === squash(text);
}
function show(anchor: HTMLElement) {
  const text = anchor.dataset.tooltip;
  if (!text || !anchor.isConnected || !anchor.getClientRects().length || popupOpen() || saysSame(anchor, text)) return hide();
  clearTimeout(timer);
  pending = undefined;
  set({ anchor, text });
}
/** Shows a control's tooltip after the delay, or at once while one is showing or has just gone; without one, hides it. */
function want(anchor: HTMLElement | undefined) {
  if (!anchor) return hide(true);
  if (shown?.anchor === anchor || pending === anchor) return;
  clearTimeout(timer);
  if (shown || performance.now() - left < grace) return show(anchor);
  pending = anchor;
  timer = setTimeout(() => show(anchor), delay);
}
/**
 * The pointer or focus moving to a control, or off one. A tooltip that a press or Escape put away stays away until one
 * of them moves on.
 */
function moved(anchor: HTMLElement | undefined, previous: HTMLElement | undefined) {
  if (anchor) want(anchor);
  else if (previous && (shown?.anchor === previous || pending === previous)) want(undefined);
}

const watched = new WeakSet<Document>();
function watch(target: Document) {
  if (watched.has(target)) return;
  watched.add(target);
  const hover = (anchor: HTMLElement | undefined) => {
    if (anchor === hovered) return;
    const previous = hovered;
    hovered = anchor;
    moved(anchor, previous);
  };
  const focus = (anchor: HTMLElement | undefined) => {
    if (anchor === focused) return;
    const previous = focused;
    focused = anchor;
    moved(anchor, previous);
  };
  // The tooltip overlay takes the pointer where it lies, so the pointer reaching it puts it away, whichever way it showed.
  if (target.documentElement.classList.contains('overlay-tooltip')) for (const type of ['pointerover', 'pointermove']) target.addEventListener(type, () => hide(true), true);
  target.addEventListener('pointerover', (event) => { if (event.pointerType === 'mouse') hover(anchorOf(event.target)); }, true);
  // The pointer leaves the document for a page view or an overlay above it.
  target.addEventListener('pointerout', (event) => { if (!event.relatedTarget && hovered?.ownerDocument === target) hover(undefined); }, true);
  target.addEventListener('pointerdown', () => hide(), true);
  // A key that presses or dismisses puts the tooltip away; another, which may move focus on, lets the next show at once.
  target.addEventListener('keydown', (event) => {
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
    keyed = performance.now();
    keyedInPopup = popupOpen();
    hide(!['Escape', 'Enter', ' '].includes(event.key));
  }, true);
  target.addEventListener('focusin', (event) => {
    const element = event.target as Element;
    const keyboard = element.matches?.(':focus-visible') && performance.now() - keyed < keyFocus && !(keyedInPopup && !element.closest?.('.popup'));
    focus(keyboard ? anchorOf(element) : undefined);
  }, true);
  target.addEventListener('focusout', (event) => { if (focused?.ownerDocument === target && !focused.contains(event.relatedTarget as Node | null)) focus(undefined); }, true);
  target.addEventListener('scroll', (event) => {
    const scrolled = event.target, anchor = shown?.anchor ?? pending;
    if (anchor?.ownerDocument !== target || (scrolled !== target && !(scrolled as Node).contains?.(anchor))) return;
    // Focus that scrolls its control into view keeps its tooltip, which moves with the control; the pointer's goes.
    if (anchor !== focused) hide();
    else if (shown) set({ ...shown });
  }, true);
  const mine = () => shown?.anchor.ownerDocument === target || pending?.ownerDocument === target;
  target.defaultView?.addEventListener('blur', () => { if (mine()) hide(); });
  target.defaultView?.addEventListener('resize', () => { if (mine()) hide(); });
}
watch(document);
watchOverlays(watch);

/** Room between a tooltip and its control, more than the tooltip layer leaves around it, so the layer stays off the control. */
const gap = 6;
/** The tooltip on show, drawn in the tooltip layer. */
export function Tooltip() {
  // The interface changing around the control, as a row added above it, can move it.
  useStore();
  const [tip, setTip] = useState(shown);
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  useLayoutEffect(() => {
    update = setTip;
    setTip(shown);
    return () => {
      update = undefined;
    };
  }, []);
  const anchor = tip?.anchor;
  useEffect(() => {
    if (!anchor) return;
    const view = anchor.ownerDocument.defaultView ?? window;
    // The control going, or losing its tooltip, takes the tooltip with it; a new one replaces it; one that resizes moves it.
    const resized = new view.ResizeObserver(() => {
      if (!anchor.isConnected || !anchor.getClientRects().length) hide();
      else redraw();
    });
    resized.observe(anchor);
    const changed = new view.MutationObserver(() => {
      if (shown?.anchor !== anchor) return;
      const text = anchor.dataset.tooltip;
      if (!text || saysSame(anchor, text)) hide();
      else if (text !== shown.text) set({ ...shown, text });
    });
    changed.observe(anchor, { attributes: true, attributeFilter: ['data-tooltip'] });
    return () => {
      resized.disconnect();
      changed.disconnect();
    };
  }, [anchor]);
  // A control hidden or removed by this render goes with its tooltip once the observer hears of it.
  if (!tip || !tip.anchor.isConnected || !tip.anchor.getClientRects().length) return null;
  const box = windowRect(tip.anchor),
    side = Boolean(tip.anchor.closest('[data-tooltip-side]'));
  const around = side
    ? { ...box, x: box.x - gap, width: box.width + 2 * gap }
    : { ...box, y: box.y - gap, height: box.height + 2 * gap };
  return (
    <Popup anchor={around} side={side} tooltip className="tooltip" role="tooltip">
      <span className="tooltip-text">{tip.text}</span>
    </Popup>
  );
}
