import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Bounds, OverlayName } from '../shared';
import { api, store, render, dialogOpen, dialogHost } from './store';
import { holdPage } from './dialogs';

/** Each overlay's document once its styles have loaded, or nothing when the overlay could not open. */
const documents = new Map<OverlayName, Promise<Document | undefined>>();
/**
 * An overlay is a blank child window that the main process shows as a transparent view above the pages. It shares this
 * window's process, so this window styles it and renders into it.
 */
function open(name: OverlayName) {
  let ready = documents.get(name);
  if (!ready) {
    const child = window.open('about:blank', `overlay-${name}`);
    ready = child ? prepare(child.document, name) : Promise.resolve(undefined);
    documents.set(name, ready);
  }
  return ready;
}
async function prepare(target: Document, name: OverlayName) {
  const root = target.documentElement;
  // The application sets its fonts and appearance on its root element.
  const mirror = () => {
    for (const { name } of [...root.attributes]) root.removeAttribute(name);
    for (const { name, value } of document.documentElement.attributes) root.setAttribute(name, value);
    root.classList.add('overlay', `overlay-${name}`);
  };
  mirror();
  new MutationObserver(mirror).observe(document.documentElement, { attributes: true });
  const loaded: Promise<unknown>[] = [];
  for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
    const copy = target.importNode(node, true);
    if (copy.nodeName === 'LINK')
      loaded.push(new Promise((resolve) => { copy.addEventListener('load', resolve); copy.addEventListener('error', resolve); }));
    target.head.append(copy);
  }
  await Promise.all(loaded);
  return target;
}

/**
 * Draws its children above the pages. `place` turns the children's size into a place in this window; its top left
 * corner should stay put while the size changes, because a view that moves as it resizes shows a frame out of place.
 * Without a place, and while a dialog is open, the overlay is hidden. `onLeave` is called when focus is neither in
 * this window nor in the overlay.
 */
export function Overlay({
  name,
  place,
  onLeave,
  children,
}: {
  name: OverlayName;
  place: (size: { width: number; height: number }) => Bounds | undefined;
  onLeave?: () => void;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<Document>();
  const surface = useRef<HTMLDivElement>(null),
    shown = useRef('null');
  const sync = () => {
    const node = surface.current;
    const bounds = node && node.offsetWidth && node.offsetHeight && !dialogOpen() ? place({ width: node.offsetWidth, height: node.offsetHeight }) : undefined;
    const rounded = bounds
      ? { x: Math.max(0, Math.round(bounds.x)), y: Math.max(0, Math.round(bounds.y)), width: Math.ceil(bounds.width), height: Math.ceil(bounds.height) }
      : null;
    const key = JSON.stringify(rounded);
    if (key === shown.current) return;
    shown.current = key;
    api.overlay(name, rounded);
  };
  const latest = useRef(sync),
    leave = useRef(onLeave);
  latest.current = sync;
  leave.current = onLeave;
  // The overlay opens once there is something to draw in it.
  const wanted = Boolean(children) || Boolean(target);
  useLayoutEffect(() => {
    if (!wanted) return;
    let live = true;
    void open(name).then((ready) => { if (live) setTarget(ready); });
    return () => {
      live = false;
    };
  }, [name, wanted]);
  useLayoutEffect(
    () => () => {
      if (shown.current !== 'null') api.overlay(name, null);
    },
    [name],
  );
  useLayoutEffect(() => latest.current());
  useLayoutEffect(() => {
    const view = target?.defaultView;
    if (!view || !surface.current) return;
    const resync = () => latest.current();
    const observer = new view.ResizeObserver(resync);
    observer.observe(surface.current);
    // Focus moves between this window and the overlay with a blur in one and, a little later, the focus in the other.
    const left = () => setTimeout(() => { if (!document.hasFocus() && !target.hasFocus()) leave.current?.(); }, 150);
    addEventListener('resize', resync);
    addEventListener('blur', left);
    view.addEventListener('blur', left);
    return () => {
      observer.disconnect();
      removeEventListener('resize', resync);
      removeEventListener('blur', left);
      view.removeEventListener('blur', left);
    };
  }, [target]);
  return target ? createPortal(<div ref={surface} className="overlay-surface">{children}</div>, target.body) : null;
}

/** The modal overlay's document: undefined while it opens, and null where there is none, as in a browser. */
let modalDocument: Document | null | undefined;
/**
 * Opens the modal overlay, where dialogs draw over the pages, and holds its children until it has opened. The overlay
 * is shown while one of its dialogs is open. It covers the window below the band where the title bar is, which the
 * application page keeps; `--chrome-top` marks that band.
 */
export function ModalLayer({ children }: { children: ReactNode }) {
  const overlaid = store.state.capabilities.embeddedBrowser;
  const probe = useRef<HTMLDivElement>(null),
    shown = useRef('null');
  useLayoutEffect(() => {
    if (!overlaid) {
      modalDocument = null;
      render();
      return;
    }
    let live = true;
    void open('modal').then((ready) => {
      if (!live) return;
      if (ready) dialogHost.document = ready;
      modalDocument = ready ?? null;
      render();
    });
    return () => {
      live = false;
    };
  }, [overlaid]);
  const sync = () => {
    // This page stops taking input as the overlay appears.
    holdPage();
    const top = Math.round(probe.current?.getBoundingClientRect().height ?? 0);
    const bounds = modalDocument?.querySelector('dialog[open]') ? { x: 0, y: top, width: innerWidth, height: innerHeight - top } : null;
    const key = JSON.stringify(bounds);
    if (key === shown.current) return;
    shown.current = key;
    api.overlay('modal', bounds);
  };
  const latest = useRef(sync);
  latest.current = sync;
  useLayoutEffect(() => latest.current());
  useLayoutEffect(() => {
    const resync = () => latest.current();
    // The title bar's band changes height with the window controls, which settle after the theme that sets them.
    const observer = new ResizeObserver(resync);
    if (probe.current) observer.observe(probe.current);
    addEventListener('resize', resync);
    return () => {
      observer.disconnect();
      removeEventListener('resize', resync);
    };
  }, [overlaid]);
  return (
    <>
      {overlaid && <div ref={probe} className="modal-probe" aria-hidden="true" />}
      {modalDocument !== undefined && children}
    </>
  );
}
/** Draws a dialog in the modal overlay, or in this page where there is none. */
export function Modal({ children }: { children: ReactNode }) {
  return modalDocument ? createPortal(children, modalDocument.body) : <>{children}</>;
}
