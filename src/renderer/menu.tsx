import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Event, MenuEntry } from '../shared';
import { api, render, store, useStore } from './store';
import { Icon, isIcon, type IconName } from './ui';
import { Popup, closedByPress, windowRect, type Point } from './popup';

export type MenuItem =
  | { label: string; action?: () => void; icon?: IconName; shortcut?: string; disabled?: boolean; checked?: boolean; submenu?: MenuItem[] }
  | { separator: true };
type Item = Exclude<MenuItem, { separator: true }>;

const isElement = (anchor: Element | Point): anchor is HTMLElement => typeof (anchor as Element).getBoundingClientRect === 'function';
/** The open menu; `closed` is called once it has closed, and `previous` is what had focus in this page as it opened. */
let shown: { anchor: HTMLElement | Point; items: MenuItem[]; closed?: () => void; stale?: () => boolean; previous: Element | null; key: number } | undefined;
let count = 0;

/**
 * Opens a menu below an element, or at a point of this window. It takes the keyboard with no item highlighted, until
 * a key or the pointer moves to one. The menu replaces any other; `closed` is called once it has closed,
 * after the action of the item chosen. The menu closes once `stale` says that what its items act on has changed.
 */
export function openMenu(
  anchor: Element | Point,
  items: MenuItem[],
  { closed, stale }: { closed?: () => void; stale?: () => boolean } = {},
) {
  if (isElement(anchor) && closedByPress(anchor)) return;
  const focused = document.activeElement,
    previous = focused?.closest('.popup') ? (shown?.previous ?? null) : focused;
  finish();
  shown = { anchor: anchor as HTMLElement | Point, items, closed, stale, previous, key: ++count };
  render();
}
/**
 * Closes the open menu, returning focus with `refocus` to the element it opened below, and then runs `action`. A menu
 * drawn in this page, as in a browser, took the focus from it, and one opened at a point returns it to where it was.
 */
function finish(refocus = false, action?: () => void) {
  const menu = shown;
  if (!menu) return;
  shown = undefined;
  render();
  const target = isElement(menu.anchor) ? menu.anchor : store.state.capabilities.embeddedBrowser ? null : menu.previous;
  if (refocus && target?.isConnected) (target as HTMLElement).focus?.({ preventScroll: true });
  action?.();
  menu.closed?.();
}
/** A `stale` for a menu whose items depend on whether a connection is connected: it says when that has changed. */
export function connectionChanges(connectionId: string) {
  const status = () => store.state.connections.find((connection) => connection.id === connectionId)?.status;
  const opened = status();
  return () => status() !== opened;
}
/** Shows the menu of a `menu` event, which the main process or the web client acts on. */
export function showMenu({ id, items, x, y, connectionId }: Extract<Event, { type: 'menu' }>) {
  let reported = false;
  const report = (item: number | null) => {
    if (reported) return;
    reported = true;
    api.menuChosen(id, item);
  };
  const convert = (entries: MenuEntry[]): MenuItem[] =>
    entries.map((entry) =>
      'separator' in entry
        ? entry
        : {
            label: entry.label,
            icon: isIcon(entry.icon) ? entry.icon : undefined,
            shortcut: entry.shortcut,
            disabled: entry.disabled,
            checked: entry.checked,
            submenu: entry.submenu && convert(entry.submenu),
            action: entry.disabled || entry.submenu ? undefined : () => report(entry.id),
          },
    );
  openMenu({ x, y }, convert(items), { closed: () => report(null), stale: connectionId === undefined ? undefined : connectionChanges(connectionId) });
}

/** The open menu, drawn in the popup layer. */
export function Menus() {
  useStore();
  const anchor = shown?.anchor;
  useLayoutEffect(() => {
    if (shown?.stale?.()) finish();
  });
  // A button that opens a menu says whether it is open.
  useLayoutEffect(() => {
    if (!anchor || !isElement(anchor) || !anchor.hasAttribute('aria-haspopup')) return;
    anchor.setAttribute('aria-expanded', 'true');
    return () => anchor.setAttribute('aria-expanded', 'false');
  }, [anchor]);
  return shown ? <Panel key={shown.key} items={shown.items} anchor={shown.anchor} depth={0} focused /> : null;
}

/** How long the pointer rests on an item before its submenu opens, or another's closes. */
const restDelay = 250;
function Panel({
  items,
  anchor,
  depth,
  focused,
  onBack,
  onEnter,
}: {
  items: MenuItem[];
  anchor: HTMLElement | Point;
  depth: number;
  /** Whether the menu takes the keyboard as it shows, with no item highlighted: a menu, and a submenu a key opened. */
  focused: boolean;
  /** Closes this submenu, returning focus to its item. */
  onBack?: () => void;
  /** Tells the menu above that the pointer has reached this submenu. */
  onEnter?: () => void;
}) {
  const [open, setOpen] = useState<{ index: number; focus: boolean }>();
  const panel = useRef<HTMLDivElement>(null),
    timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const later = (change: () => void) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(change, restDelay);
  };
  const enabled = () => [...(panel.current?.querySelectorAll<HTMLElement>(':scope > [role^="menuitem"]:not([aria-disabled="true"])') ?? [])];
  const itemAt = (element: Element | null | undefined) => {
    const index = Number((element as HTMLElement | null)?.dataset?.index);
    const item = Number.isInteger(index) ? items[index] : undefined;
    return item && !('separator' in item) ? { item, index } : undefined;
  };
  const activate = (item: Item, index: number, keyboard: boolean) => {
    if (item.disabled) return;
    clearTimeout(timer.current);
    if (item.submenu) setOpen({ index, focus: keyboard });
    else finish(true, item.action);
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const list = enabled(),
      focused = panel.current?.ownerDocument.activeElement as HTMLElement | null,
      at = focused ? list.indexOf(focused) : -1,
      current = at < 0 ? undefined : itemAt(focused);
    const go = (target: HTMLElement | undefined) => {
      event.preventDefault();
      target?.focus({ preventScroll: false });
    };
    switch (event.key) {
      case 'ArrowDown':
        return go(list[(at + 1) % list.length]);
      case 'ArrowUp':
        return go(list[at < 0 ? list.length - 1 : (at - 1 + list.length) % list.length]);
      case 'Home':
        return go(list[0]);
      case 'End':
        return go(list.at(-1));
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (current) activate(current.item, current.index, true);
        return;
      case 'ArrowRight':
        if (current?.item.submenu) {
          event.preventDefault();
          activate(current.item, current.index, true);
        }
        return;
      case 'ArrowLeft':
        if (depth) {
          event.preventDefault();
          onBack?.();
        }
        return;
      case 'Escape':
        event.preventDefault();
        if (depth) onBack?.();
        else finish(true);
        return;
      case 'Tab':
        event.preventDefault();
        finish(true);
        return;
    }
    // A letter moves to the next item that starts with it.
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
    const letter = event.key.toLowerCase();
    const match = [...list.slice(at + 1), ...list.slice(0, at + 1)].find((element) => itemAt(element)?.item.label.toLowerCase().startsWith(letter));
    if (match) go(match);
  };
  const icons = items.some((item) => !('separator' in item) && (item.icon || item.checked !== undefined));
  const opened = open && itemAt(panel.current?.querySelector(`:scope > [data-index="${open.index}"]`));
  const opener = opened && panel.current?.querySelector<HTMLElement>(`:scope > [data-index="${open.index}"]`);
  const box = opener ? windowRect(opener) : undefined;
  // A submenu's first item lines up with the item it opened from.
  const style = panel.current && panel.current.ownerDocument.defaultView?.getComputedStyle(panel.current);
  const inset = style ? parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth) : 0;
  return (
    <>
      <Popup
        ref={panel}
        anchor={anchor}
        side={depth > 0}
        className="menu"
        role="menu"
        tabIndex={-1}
        onDismiss={depth ? undefined : (reason) => finish(reason === 'escape')}
        onShown={(surface) => {
          if (focused) surface.focus({ preventScroll: true });
        }}
        onKeyDown={keys}
        onPointerEnter={() => onEnter?.()}
        // A submenu goes as its item scrolls away from it, and focus in it returns to the item.
        onScroll={() => {
          if (!open) return;
          const focused = panel.current?.ownerDocument.activeElement;
          setOpen(undefined);
          if (!panel.current?.contains(focused ?? null)) opener?.focus({ preventScroll: true });
        }}
      >
        {items.map((item, index) =>
          'separator' in item ? (
            <div key={index} role="separator" className="menu-separator" />
          ) : (
            <div
              key={index}
              data-index={index}
              role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={item.checked}
              aria-disabled={item.disabled || undefined}
              aria-haspopup={item.submenu ? 'menu' : undefined}
              aria-expanded={item.submenu ? open?.index === index : undefined}
              tabIndex={-1}
              className="menu-item"
              onPointerMove={(event) => {
                // An item that appears under a still pointer gets a move with no movement; only a moving pointer acts on it.
                if (!event.movementX && !event.movementY) return;
                const element = event.currentTarget;
                if (item.disabled) panel.current?.focus({ preventScroll: true });
                else if (element.ownerDocument.activeElement !== element) element.focus({ preventScroll: true });
                if (item.submenu && !item.disabled) {
                  if (open?.index === index) clearTimeout(timer.current);
                  else later(() => setOpen({ index, focus: false }));
                } else if (open) later(() => setOpen(undefined));
              }}
              onClick={() => activate(item, index, false)}
            >
              {icons && (
                <span className="menu-icon" data-icon={item.checked ? 'check' : item.icon}>
                  {item.checked ? <Icon name="check" /> : item.icon && <Icon name={item.icon} />}
                </span>
              )}
              <span className="menu-label">{item.label}</span>
              {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
              {item.submenu && <Icon name="right" className="icon menu-arrow" />}
            </div>
          ),
        )}
      </Popup>
      {opened && opened.item.submenu && box && (
        <Panel
          key={`${open.index} ${open.focus}`}
          items={opened.item.submenu}
          anchor={{ ...box, y: box.y - inset }}
          depth={depth + 1}
          focused={open.focus}
          onEnter={() => clearTimeout(timer.current)}
          onBack={() => {
            setOpen(undefined);
            opener?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}
