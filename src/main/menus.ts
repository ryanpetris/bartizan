import { WebContentsView, type BrowserWindow, type WebContents } from 'electron';
import type { Event, MenuEntry } from '../shared';
import type { Overlays } from './overlays';

/** An item of a menu the main process builds; `click` runs here once the item is chosen, and `icon` names an application icon. */
export type MenuItem =
  | { label: string; enabled?: boolean; icon?: string; shortcut?: string; checked?: boolean; click?: () => unknown; submenu?: MenuItem[] }
  | { type: 'separator' };

/**
 * Menus the main process builds, such as a page's context menu, which the application draws in its popup overlay. Their
 * actions stay here, keyed by the menu's ID and the item's, so only an item of the open menu runs. A menu belongs to the
 * web contents it opened for: the keyboard returns there as it closes, and that contents navigating closes it.
 */
export class Menus {
  private current?: { id: number; actions: Map<number, () => unknown>; origin: WebContents };
  private count = 0;
  /**
   * Where the keyboard goes back to once the window, left while a popup was open, is active again, unless a press or a
   * key comes first.
   */
  private returning?: WebContents;
  /** When the user last pressed or typed in any of the window's views. */
  private acted = 0;
  constructor(private window: BrowserWindow, private overlays: Overlays, private send: (event: Event) => void) {
    // Dragging the window by its title bar, which the application page does not see as a press, closes the popup.
    window.on('move', () => this.dismiss());
    // The window going to the back closes the popup. As the window comes back the keyboard goes to the application page,
    // or stays in the popup's hidden view, so unless a press or a key comes first it returns to where the menu opened.
    window.on('blur', () => {
      if (!overlays.visible('popup')) return;
      this.returning = this.current?.origin;
      this.dismiss();
    });
    window.on('focus', () => setTimeout(() => {
      const target = this.returning;
      this.returning = undefined;
      if (!target || target.isDestroyed() || window.isDestroyed() || !window.isFocused() || overlays.visible('popup')) return;
      if (window.webContents.isFocused() || overlays.contents('popup')?.isFocused()) target.focus();
    }, 100));
  }

  /** Shows a menu at a point of `origin`'s view, in that view's coordinates. */
  show(origin: WebContents, items: MenuItem[], x: number, y: number, connectionId?: string) {
    const view = this.window.contentView.children.find(child => child instanceof WebContentsView && child.webContents === origin);
    const offset = origin !== this.window.webContents && view ? view.getBounds() : { x: 0, y: 0 };
    const zoom = this.window.webContents.getZoomFactor();
    this.open(origin, items, (offset.x + x) / zoom, (offset.y + y) / zoom, connectionId);
  }
  /** Shows a menu at a point of the application page; it closes as connection `connectionId` connects or disconnects. */
  open(origin: WebContents, items: MenuItem[], x: number, y: number, connectionId?: string) {
    const actions = new Map<number, () => unknown>();
    let count = 0;
    const entries = (list: MenuItem[]): MenuEntry[] => list.map(item => {
      if ('type' in item) return { separator: true };
      const id = ++count;
      const { label, icon, shortcut, checked, submenu, click } = item, disabled = item.enabled === false;
      if (click && !disabled && !submenu) actions.set(id, click);
      return { id, label, ...icon && { icon }, ...shortcut && { shortcut }, ...disabled && { disabled: true }, ...checked !== undefined && { checked }, ...submenu && { submenu: entries(submenu) } };
    });
    const built = entries(items);
    if (!built.length) return;
    const id = ++this.count;
    this.current = { id, actions, origin };
    this.send({ type: 'menu', id, items: built, x, y, ...connectionId !== undefined && { connectionId } });
  }
  /**
   * Runs the item chosen from the open menu, after returning the keyboard to where the menu opened; `null` closes it. A
   * menu whose contents has gone runs nothing.
   */
  choose(id: number, item: number | null) {
    const menu = this.current;
    if (menu?.id !== id) return;
    this.current = undefined;
    if (menu.origin.isDestroyed()) return;
    if (this.overlays.contents('popup')?.isFocused()) menu.origin.focus();
    if (item !== null) menu.actions.get(item)?.();
  }
  /**
   * Notes presses and keys, and closes the popup, whichever opened it, on a press or a turn of the wheel in a view other
   * than the application page, which closes it itself, and the popup; closes a menu as the contents it belongs to
   * navigates or goes.
   */
  observe(contents: WebContents) {
    contents.on('before-input-event', (_event, input) => { if (input.type === 'keyDown') { this.returning = undefined; this.acted = Date.now(); } });
    contents.on('before-mouse-event', (_event, input) => {
      if (input.type === 'mouseDown') { this.returning = undefined; this.acted = Date.now(); }
      const outside = contents !== this.window.webContents && contents !== this.overlays.contents('popup');
      // A scroll still coasting from before the press or key that opened the menu does not close it.
      if (outside && (input.type === 'mouseDown' || input.type === 'mouseWheel' && Date.now() - this.acted >= 300)) this.dismiss();
    });
    contents.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) this.gone(contents); });
    contents.once('destroyed', () => this.gone(contents));
  }
  /** Closes the popup; the open menu's items no longer run, even when the renderer has already sent one. */
  private dismiss() {
    if (!this.current && !this.overlays.visible('popup')) return;
    this.current = undefined;
    this.send({ type: 'close-popup' });
  }
  private gone(contents: WebContents) {
    if (this.current?.origin === contents) this.dismiss();
  }
}
