import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type CSSProperties, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { store, dialogHost, useStore } from './store';
import { Overlay, documentOrigins } from './overlay';
import { topModal } from './dialogs';

export type Point = { x: number; y: number };
export type Rect = Point & { width: number; height: number };
/** An element, a rectangle in this window, or a point in it. */
export type Anchor = Element | Rect | Point;
/**
 * Why a popup is asked to close: a press outside it, Escape, focus leaving the window, the window resizing, what holds
 * its anchor scrolling, its anchor going, or the main process.
 */
export type DismissReason = 'press' | 'escape' | 'blur' | 'resize' | 'scroll' | 'gone' | 'closed';
/** Whether an anchor is an element, of this page or of an overlay, whose elements belong to another window. */
const isElement = (anchor: unknown): anchor is Element => typeof (anchor as Element | null)?.getBoundingClientRect === 'function';

/**
 * A layer of popups: `pad` is the room around them for their shadows, `placed` each open popup's place in this window
 * and whether it takes input, `bounds` where the layer starts and its size, and `covers` whether it covers the window
 * below its start; popups are drawn at their place less its start. Menus and other popups share one layer; tooltips have
 * their own.
 */
type Layer = { pad: { left: number; top: number; right: number; bottom: number }; placed: Map<HTMLElement, Rect & { interactive: boolean }>; bounds: Rect; covers: boolean; host: HTMLElement | null; attach: (node: HTMLDivElement | null) => void };
function createLayer(pad: Layer['pad']): Layer {
  const created: Layer = {
    pad,
    placed: new Map(),
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    covers: false,
    host: null,
    attach: (node) => {
      if (created.host === node) return;
      created.host = node;
      changed();
    },
  };
  return created;
}
const popups = createLayer({ left: 16, top: 8, right: 16, bottom: 24 }),
  tooltips = createLayer({ left: 5, top: 5, right: 5, bottom: 5 });
let revision = 0;
const listeners = new Set<() => void>();
const changed = () => {
  revision++;
  for (const listener of listeners) listener();
};
const useLayer = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => revision,
  );
const overlaid = () => store.state.capabilities.embeddedBrowser;
/**
 * The layer covers the popups and the room for their shadows. While an interactive popup is open it covers the window
 * below the title bar, as a dialog does, and the dialog's overlay where one is open, so a press beside the popup closes it
 * and reaches nothing below, as with a native menu. Its start then follows the interactive popups alone, and the popups
 * that open beside them, such as submenus, keep below it, so the layer keeps its place as they open: a view that moves
 * shows its last frame out of place. Returns whether the layer changed, which redraws the popups.
 */
function relayout(layer: Layer) {
  const rects = [...layer.placed.values()],
    pad = layer.pad;
  let bounds: Rect = { x: 0, y: 0, width: 0, height: 0 },
    covers = false;
  if (rects.length && overlaid()) {
    let left = Math.min(...rects.map((r) => r.x - pad.left)),
      top = Math.min(...rects.map((r) => r.y - pad.top)),
      right = Math.max(...rects.map((r) => r.x + r.width + pad.right)),
      bottom = Math.max(...rects.map((r) => r.y + r.height + pad.bottom));
    const modal = dialogHost.document !== document && documentOrigins.get(dialogHost.document);
    if (modal && rects.some((r) => r.interactive)) {
      covers = true;
      left = 0;
      right = innerWidth;
      top = Math.min(modal.y, ...rects.filter((r) => r.interactive).map((r) => r.y - pad.top));
      bottom = innerHeight;
    }
    left = Math.max(0, Math.floor(left));
    top = Math.max(0, Math.floor(top));
    bounds = { x: left, y: top, width: Math.min(innerWidth, Math.ceil(right)) - left, height: Math.min(innerHeight, Math.ceil(bottom)) - top };
  }
  if (covers === layer.covers && JSON.stringify(bounds) === JSON.stringify(layer.bounds)) return false;
  layer.bounds = bounds;
  layer.covers = covers;
  changed();
  return true;
}

/** Where an element is in this window, whether it is in this page, an overlay or a popup. */
export function windowRect(element: Element): Rect {
  const box = element.getBoundingClientRect();
  const panel = element.closest<HTMLElement>('.popup'),
    at = panel && (popups.placed.get(panel) ?? tooltips.placed.get(panel));
  if (panel && at) {
    const start = panel.getBoundingClientRect();
    return { x: at.x + box.x - start.x, y: at.y + box.y - start.y, width: box.width, height: box.height };
  }
  const origin = documentOrigins.get(element.ownerDocument) ?? { x: 0, y: 0 };
  return { x: origin.x + box.x, y: origin.y + box.y, width: box.width, height: box.height };
}

/**
 * Places a popup of `size`: below an element or rectangle, or above it where there is no room below; beside it, with
 * `side`, or on its other side where there is no room; or at a point, or up and to its left where there is no room. It
 * keeps within the window below `top`. A `centered` popup is centred on the rectangle's other axis.
 */
export function placePopup(anchor: Rect | Point, size: { width: number; height: number }, side = false, centered = false, top = 0): Point {
  const width = Math.min(size.width, innerWidth),
    height = Math.min(size.height, innerHeight - top);
  const box = 'width' in anchor ? anchor : { ...anchor, width: 0, height: 0 };
  const point = !('width' in anchor);
  let x: number, y: number;
  if (side) {
    x = box.x + box.width + width <= innerWidth ? box.x + box.width : box.x - width;
    y = centered ? box.y + (box.height - height) / 2 : box.y;
  } else {
    x = centered ? box.x + (box.width - width) / 2 : box.x + width <= innerWidth ? box.x : point ? box.x - width : box.x + box.width - width;
    const below = box.y + box.height;
    y = below + height <= innerHeight ? below : box.y - height >= top ? box.y - height : below;
  }
  return {
    x: Math.round(Math.max(0, Math.min(x, innerWidth - width))),
    y: Math.round(Math.max(top, Math.min(y, innerHeight - height))),
  };
}

/** Whether the press under way closed a popup anchored at `element`; the element's click then leaves it closed. */
export const closedByPress = (element: Element) => pressedAnchor === element;
let pressedAnchor: Element | undefined;
addEventListener('pointerdown', () => { pressedAnchor = undefined; }, true);
addEventListener('keydown', () => { pressedAnchor = undefined; }, true);
addEventListener('click', () => setTimeout(() => { pressedAnchor = undefined; }), true);
/** Each open root popup's dismissal. */
const roots = new Set<(reason: DismissReason) => void>();
/** Whether a root popup, such as a menu, is open. */
export const popupOpen = () => roots.size > 0;
/** Asks every open popup to close, as when the main process reports a press in a page. */
export function dismissPopups(reason: DismissReason = 'closed') {
  for (const dismiss of [...roots]) dismiss(reason);
}

/**
 * The layers popups draw in, mounted once: in Electron, the popup overlay and above it the tooltip overlay, which show
 * over pages and dialogs; in a browser, layers of this page, inside the dialog on top so that they stay above it.
 */
export function PopupLayer() {
  useLayer();
  // A dialog opening or closing moves the layers of this page into it or out, and changes what the popup overlay covers.
  useStore();
  useLayoutEffect(() => {
    relayout(popups);
    relayout(tooltips);
  });
  if (!overlaid()) {
    const parent = topModal() ?? document.body;
    return createPortal(
      <>
        <div ref={popups.attach} className="popup-layer" />
        <div ref={tooltips.attach} className="popup-layer tooltip-layer" />
      </>,
      parent,
    );
  }
  return (
    <>
      <Overlay
        name="popup"
        overDialogs
        onLeave={() => dismissPopups('blur')}
        place={(size) => (popups.placed.size ? { x: popups.bounds.x, y: popups.bounds.y, ...size } : undefined)}
      >
        <div ref={popups.attach} className="popup-layer" style={{ width: popups.bounds.width, height: popups.bounds.height }} />
      </Overlay>
      <Overlay name="tooltip" overDialogs place={(size) => (tooltips.placed.size ? { x: tooltips.bounds.x, y: tooltips.bounds.y, ...size } : undefined)}>
        <div ref={tooltips.attach} className="popup-layer tooltip-layer" style={{ width: tooltips.bounds.width, height: tooltips.bounds.height }} />
      </Overlay>
    </>
  );
}

/**
 * A surface drawn above everything else, pages and dialogs included, at a place `placePopup` gives from its `anchor` and
 * size. It is the base of menus and other popups:
 * - `onDismiss` makes it a root popup, which takes input and is asked to close, with the reason, on a press outside every
 *   popup, Escape that its content leaves alone, focus leaving the window, the window resizing, a turn of the wheel
 *   outside every popup, a scroll of what holds its anchor element, the anchor leaving the document, or the main
 *   process's word, which comes with a press or a turn of the wheel in a page. A turn of the wheel in the first moments
 *   after it opens is a scroll still coasting and leaves it open. The owner closes it by no longer rendering it, and
 *   returns focus to the anchor where that suits; a popup rendered alongside a root popup, such as a submenu, goes with
 *   it.
 * - `onShown` is told of the surface once it has its place, which is the time to move focus into it.
 * - In Electron the popup overlay takes the keyboard as it appears, and while a root popup is open it covers the window
 *   below the title bar.
 * - `tooltip` draws it centred on its anchor in the tooltip layer, which never takes the keyboard, and in a browser lets
 *   the pointer through.
 */
export function Popup({
  anchor,
  side = false,
  tooltip = false,
  onDismiss,
  onShown,
  ref,
  className = '',
  children,
  ...props
}: {
  anchor: Anchor;
  side?: boolean;
  tooltip?: boolean;
  onDismiss?: (reason: DismissReason) => void;
  onShown?: (surface: HTMLDivElement) => void;
  ref?: Ref<HTMLDivElement>;
  children: ReactNode;
} & HTMLAttributes<HTMLDivElement>) {
  useLayer();
  const surface = useRef<HTMLDivElement | null>(null),
    dismiss = useRef(onDismiss),
    shown = useRef(onShown),
    announced = useRef<HTMLDivElement | null>(null);
  dismiss.current = onDismiss;
  shown.current = onShown;
  const interactive = Boolean(onDismiss),
    layer = tooltip ? tooltips : popups,
    host = layer.host,
    // A popup beside an interactive one keeps within what the layer covers, and scrolls where it is taller.
    top = !interactive && layer.covers ? layer.bounds.y : 0;
  useLayoutEffect(() => {
    const node = surface.current;
    if (!node) return;
    if (isElement(anchor) && (!anchor.isConnected || !anchor.getClientRects().length)) {
      dismiss.current?.('gone');
      return;
    }
    const size = { width: node.offsetWidth, height: node.offsetHeight };
    const at = placePopup(isElement(anchor) ? windowRect(anchor) : anchor, size, side, tooltip, top);
    const rect = { ...at, ...size, interactive },
      previous = layer.placed.get(node);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(rect)) {
      layer.placed.set(node, rect);
      if (!relayout(layer)) changed();
    }
    if (announced.current !== node) {
      announced.current = node;
      shown.current?.(node);
    }
  });
  useLayoutEffect(() => {
    const node = surface.current;
    if (!node) return;
    // A popup that changes size, as when its font loads, takes its place again.
    const observer = new (node.ownerDocument.defaultView ?? window).ResizeObserver(changed);
    observer.observe(node);
    return () => {
      observer.disconnect();
      layer.placed.delete(node);
      relayout(layer);
    };
  }, [layer, host]);
  useEffect(() => {
    if (!interactive || !host) return;
    const close = (reason: DismissReason) => dismiss.current?.(reason);
    const press = (event: PointerEvent) => {
      const target = isElement(event.target) ? event.target : null;
      if (target?.closest('.popup')) return;
      if (isElement(anchor) && event.button === 0 && target && anchor.contains(target)) pressedAnchor = anchor;
      close('press');
    };
    const resize = () => close('resize');
    // A turn of the wheel outside every popup scrolls what is under it, which the popup no longer matches; a scroll still
    // coasting from before the popup opened is not one.
    const opened = performance.now();
    const wheel = (event: WheelEvent) => {
      if (performance.now() - opened >= 300 && !(isElement(event.target) && event.target.closest('.popup'))) close('scroll');
    };
    const scroll = (event: Event) => {
      const target = event.target;
      if (isElement(anchor) && (target === anchor.ownerDocument || (isElement(target) && target.contains(anchor)))) close('scroll');
    };
    const blur = () => close('blur');
    const documents = new Set([document, host.ownerDocument]);
    for (const target of documents) {
      target.addEventListener('pointerdown', press, true);
      target.addEventListener('wheel', wheel, { capture: true, passive: true });
    }
    addEventListener('resize', resize);
    if (isElement(anchor)) anchor.ownerDocument.addEventListener('scroll', scroll, true);
    // The popup overlay reports focus leaving it and this page; a layer of this page goes as the window loses focus.
    if (!overlaid()) addEventListener('blur', blur);
    roots.add(close);
    return () => {
      for (const target of documents) {
        target.removeEventListener('pointerdown', press, true);
        target.removeEventListener('wheel', wheel, true);
      }
      removeEventListener('resize', resize);
      if (isElement(anchor)) anchor.ownerDocument.removeEventListener('scroll', scroll, true);
      removeEventListener('blur', blur);
      roots.delete(close);
    };
  }, [interactive, anchor, host]);
  if (!host) return null;
  const at = surface.current && layer.placed.get(surface.current);
  return createPortal(
    <div
      {...props}
      ref={(node) => {
        surface.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      className={`popup ${className}`.trim()}
      style={{ ...props.style, left: (at?.x ?? 0) - layer.bounds.x, top: (at?.y ?? 0) - layer.bounds.y, '--window-width': `${innerWidth}px`, '--room-height': `${innerHeight - top}px` } as CSSProperties}
      onKeyDown={(event) => {
        props.onKeyDown?.(event);
        if (interactive && event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          dismiss.current?.('escape');
        }
      }}
    >
      {children}
    </div>,
    host,
  );
}
