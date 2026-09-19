import { Menu, clipboard, shell, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { browserSessionName } from '../shared';
import type { Browsers } from './browser';
import type { Sessions } from './sessions';

/** Whether `xdg-open` is on PATH, as `which xdg-open` reports. */
export function externalBrowserAvailable() {
  return (process.env.PATH ?? '').split(delimiter).some(directory => {
    try { accessSync(join(directory, 'xdg-open'), constants.X_OK); return true; } catch { return false; }
  });
}
export function linkURL(input: string) {
  if (input.length > 8192 || /[\u0000-\u0020\u007f]/.test(input)) throw new Error('Invalid link');
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('Enter an HTTP or HTTPS URL');
  return input;
}

export class LinkMenus {
  constructor(private window: BrowserWindow, private sessions: Sessions, private browsers: Browsers,
    private serialize: <T>(action: () => Promise<T>) => Promise<T>, private selected: (id: string) => void, private error: (message: string, connectionId: string, label?: string) => void) {}

  /**
   * Shows the link menu for a page in the `current` session, or for a terminal, where Open Link uses the `first`
   * session in the navigation.
   */
  show(connectionId: string, url: string | string[], sessions: { current?: string; first?: string }) {
    const urls = Array.isArray(url) ? [...new Set(url)].map(linkURL) : [linkURL(url)];
    if (!urls.length) return;
    const items = urls.length === 1 ? this.items(connectionId, urls[0]!, sessions) : urls.map(target => ({
      label: target.replace(/[\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 160).replace(/&/g, '&&'),
      submenu: this.items(connectionId, target, sessions),
    }));
    if (items.length) Menu.buildFromTemplate(items).popup({ window: this.window });
  }
  /**
   * Shows a page's context menu: the items for the link, image, editable field or selection under the pointer, or else
   * the page's own, and then Inspect Element.
   */
  page(workspaceId: string, tabId: string, params: ContextMenuParams) {
    const entry = this.browsers.entries.get(workspaceId), contents = this.browsers.contents(workspaceId, tabId);
    if (!entry || !contents) return;
    const connectionId = entry.info.connectionId, label = this.sessions.entries.get(connectionId)?.info.label;
    const run = (action: () => unknown) => () => { void Promise.resolve().then(action).catch(error => this.error(String(error), connectionId, label)); };
    const act = (action: 'back' | 'forward' | 'reload' | 'print' | 'pdf') => run(() => this.browsers.action(workspaceId, action, tabId, undefined, true));
    const web = (url: string) => { try { linkURL(url); return true; } catch { return false; } };
    const groups: MenuItemConstructorOptions[][] = [];
    if (web(params.linkURL)) groups.push(this.items(connectionId, params.linkURL, { current: workspaceId }));
    if (params.mediaType === 'image') groups.push([
      { label: 'Open Image in New Tab', enabled: web(params.srcURL), click: run(() => this.open(connectionId, params.srcURL, workspaceId)) },
      { label: 'Save Image As…', enabled: web(params.srcURL), click: run(() => { this.browsers.allowPrompts(tabId); contents.downloadURL(params.srcURL); }) },
      { label: 'Copy Image', click: run(() => contents.copyImageAt(params.x, params.y)) },
      { label: 'Copy Image Address', enabled: web(params.srcURL), click: run(() => clipboard.writeText(params.srcURL)) },
    ]);
    const flags = params.editFlags;
    if (params.isEditable) groups.push([
      { label: 'Undo', enabled: flags.canUndo, click: run(() => contents.undo()) },
      { label: 'Redo', enabled: flags.canRedo, click: run(() => contents.redo()) },
      { type: 'separator' },
      { label: 'Cut', enabled: flags.canCut, click: run(() => contents.cut()) },
      { label: 'Copy', enabled: flags.canCopy, click: run(() => contents.copy()) },
      { label: 'Paste', enabled: flags.canPaste, click: run(() => contents.paste()) },
      { label: 'Select All', enabled: flags.canSelectAll, click: run(() => contents.selectAll()) },
    ]);
    else if (params.selectionText.trim()) groups.push([{ label: 'Copy', click: run(() => contents.copy()) }]);
    if (!groups.some(group => group.length)) groups.push([
      { label: 'Back', enabled: contents.navigationHistory.canGoBack(), click: act('back') },
      { label: 'Forward', enabled: contents.navigationHistory.canGoForward(), click: act('forward') },
      { label: 'Reload', click: act('reload') },
    ], [
      { label: 'Save as PDF…', click: act('pdf') },
      { label: 'Print…', click: act('print') },
    ]);
    groups.push([{ label: 'Inspect Element', click: run(() => this.browsers.inspect(workspaceId, tabId, params.x, params.y)) }]);
    const items = groups.filter(group => group.length).flatMap((group, index): MenuItemConstructorOptions[] => index ? [{ type: 'separator' }, ...group] : group);
    Menu.buildFromTemplate(items).popup({ window: this.window });
  }
  /** Opens a link in a browser session of the connection and shows it; see `Browsers.open` for `session` and `fallback`. */
  open(connectionId: string, url: string, session?: string, fallback = false) {
    const target = linkURL(url);
    const label = this.sessions.entries.get(connectionId)?.info.label;
    void this.serialize(async () => {
      const connection = this.sessions.entries.get(connectionId);
      if (!connection) throw new Error('Connection is closed');
      this.selected(await this.browsers.open(connection, target, session, fallback));
    }).catch(error => this.error(String(error), connectionId, label));
  }
  private items(connectionId: string, url: string, { current: currentId, first }: { current?: string; first?: string }): MenuItemConstructorOptions[] {
    const target = linkURL(url);
    if (!this.sessions.entries.has(connectionId)) return [];
    if (currentId && this.browsers.entries.get(currentId)?.info.connectionId !== connectionId) return [];
    const label = this.sessions.entries.get(connectionId)?.info.label;
    const sessions = [...this.browsers.entries.values()].filter(e => e.info.connectionId === connectionId);
    const connected = this.sessions.entries.get(connectionId)?.info.status === 'connected';
    const items: MenuItemConstructorOptions[] = [
      { label: 'Open Link', enabled: Boolean(currentId) || sessions.length > 0 || connected, click: () => this.open(connectionId, target, currentId ?? first, !currentId) },
      { label: 'Open in New Browser Session', enabled: connected, click: () => this.open(connectionId, target, 'new') },
      ...sessions.filter(e => e.info.id !== currentId).map(entry => ({ label: `Open in ${browserSessionName(entry.info).replace(/&/g, '&&')}`, click: () => this.open(connectionId, target, entry.info.id) })),
    ];
    const run = (action: () => Promise<unknown>) => { void action().catch(error => this.error(String(error), connectionId, label)); };
    if (externalBrowserAvailable()) items.push({ label: 'Open in External Browser', click: () => run(() => shell.openExternal(target)) });
    items.push({ type: 'separator' }, { label: 'Copy Link', click: () => run(async () => { await clipboard.writeText(target); }) });
    return items;
  }
}
