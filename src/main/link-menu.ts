import { clipboard, shell, type ContextMenuParams, type WebContents } from 'electron';
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { browserSessionName, shortcutLabel, systemLink, type PageShortcut } from '../shared';
import type { BrowserWindowController } from './browser-window';
import type { Menus, MenuItem } from './menus';
import type { Sessions } from './sessions';

const onPath = (program: string) => (process.env.PATH ?? '').split(delimiter).some(directory => {
  try { accessSync(join(directory, program), constants.X_OK); return true; } catch { return false; }
});
/** macOS opens links through Launch Services; Linux needs `xdg-open` on PATH. */
export function externalBrowserAvailable() {
  return process.platform === 'darwin' || onPath('xdg-open');
}

export function linkURL(input: string) {
  if (input.length > 8192 || /[\u0000-\u0020\u007f]/.test(input)) throw new Error('Invalid link');
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('Enter an HTTP or HTTPS URL');
  return input;
}

/** Whether an address is one a link may open: HTTP or HTTPS, without credentials. */
export const webAddress = (url: string) => { try { linkURL(url); return true; } catch { return false; } };

export class LinkMenus {
  constructor(private menus: Menus, private sessions: Sessions, private browsers: BrowserWindowController,
    private serialize: <T>(action: () => Promise<T>) => Promise<T>, private selected: (id: string) => void, private error: (message: string, connectionId: string, label?: string) => void) {}

  /**
   * Shows the link menu of a terminal in `origin`, the application page, at a point of it. Several links each have a
   * submenu.
   */
  show(origin: WebContents, connectionId: string, url: string | string[], at: { x: number; y: number }) {
    const urls = Array.isArray(url) ? [...new Set(url)].map(linkURL) : [linkURL(url)];
    if (!urls.length) return;
    const items = urls.length === 1 ? this.items(connectionId, urls[0]!) : urls.map(target => ({
      label: target.replace(/[\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 160),
      icon: 'link',
      submenu: this.items(connectionId, target),
    }));
    this.menus.open(origin, items, at.x, at.y, connectionId);
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
    const web = webAddress;
    const address = contents.getURL(), ordinary = !entry.info.application;
    const groups: MenuItem[][] = [];
    if (web(params.linkURL)) groups.push(this.items(connectionId, params.linkURL, ordinary ? workspaceId : undefined));
    const system = systemLink(params.linkURL);
    if (system) groups.push([
      ...externalBrowserAvailable() ? [{ label: 'Open Link', icon: 'external', click: () => { const tab = this.browsers.tabs.get(tabId); tab?.allowPrompts(); tab?.handOff(params.linkURL); } }] : [],
      { label: 'Copy Link', icon: 'link', click: run(() => clipboard.writeText(params.linkURL)) },
    ]);
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
    const own = !groups.some(group => group.length);
    const shortcut = (name: PageShortcut) => shortcutLabel(name, process.platform === 'darwin');
    if (own) groups.push([
      { label: 'Back', icon: 'back', shortcut: shortcut('back'), enabled: contents.navigationHistory.canGoBack(), click: act('back') },
      { label: 'Forward', icon: 'forward', shortcut: shortcut('forward'), enabled: contents.navigationHistory.canGoForward(), click: act('forward') },
      { label: 'Reload', icon: 'reload', shortcut: shortcut('reload'), click: act('reload') },
    ], ordinary ? [
      { label: 'Copy Page Address', icon: 'link', enabled: Boolean(address) && address !== 'about:blank', click: run(() => clipboard.writeText(address)) },
      ...web(address) && externalBrowserAvailable() ? [{ label: 'Open Page in External Browser', icon: 'external', click: run(() => shell.openExternal(address)) }] : [],
    ] : [], [
      { label: 'Save as PDF…', click: act('pdf') },
      { label: 'Print…', shortcut: shortcut('print'), click: act('print') },
    ]);
    groups.push([
      ...own && ordinary ? [{ label: 'View Page Source', enabled: web(address), click: run(() => entry.open({ url: `view-source:${address}` })) }] : [],
      { label: 'Inspect Element', icon: 'code', click: run(() => this.browsers.inspect(workspaceId, tabId, params.x, params.y)) },
    ]);
    const items = groups.filter(group => group.length).flatMap((group, index): MenuItem[] => index ? [{ type: 'separator' }, ...group] : group);
    this.menus.show(contents, items, params.x, params.y, connectionId);
  }
  /** Shows a text field's menu in the application; the address field's adds Paste and Go and copies the address it shows. */
  async field(contents: WebContents, params: ContextMenuParams, address?: { url: string; go(text: string): void }) {
    const flags = params.editFlags, pasted = async () => (await clipboard.readText()).trim();
    const pasteable = address && Boolean(await pasted());
    const items: MenuItem[] = [
      { label: 'Undo', enabled: flags.canUndo, click: () => contents.undo() },
      { label: 'Redo', enabled: flags.canRedo, click: () => contents.redo() },
      { type: 'separator' },
      { label: 'Cut', enabled: flags.canCut, click: () => contents.cut() },
      { label: 'Copy', enabled: flags.canCopy, click: () => contents.copy() },
      { label: 'Paste', enabled: flags.canPaste, click: () => contents.paste() },
      ...address ? [{ label: 'Paste and Go', enabled: pasteable, click: () => void pasted().then(text => { if (text) address.go(text); }) }] : [],
      { label: 'Delete', enabled: flags.canDelete, click: () => contents.delete() },
      { type: 'separator' },
      { label: 'Select All', enabled: flags.canSelectAll, click: () => contents.selectAll() },
      ...address ? [{ type: 'separator' as const }, { label: 'Copy Address', icon: 'link', enabled: Boolean(address.url), click: () => void clipboard.writeText(address.url) }] : [],
    ];
    this.menus.show(contents, items, params.x, params.y);
  }
  /**
   * Opens a link in browser session `session` of the connection and shows it. Without one, or for an application's
   * session, it opens in the session nearest after navigation item `from`, or else before it, or else in a new one.
   */
  open(connectionId: string, url: string, session?: string, from?: string) {
    if (session && this.browsers.entries.get(session)?.info.application) { from = `session:${session}`; session = undefined; }
    const target = linkURL(url);
    const label = this.sessions.entries.get(connectionId)?.info.label;
    void this.serialize(async () => {
      const connection = this.sessions.entries.get(connectionId);
      if (!connection) throw new Error('Connection is closed');
      this.selected(await this.browsers.open(connection, target, session ?? connection.browsers?.nearest(from)?.info.id ?? 'new'));
    }).catch(error => this.error(String(error), connectionId, label));
  }
  /**
   * Opens an address `systemLink` gave with the system's default application for its scheme: through Launch Services on
   * macOS, and elsewhere `xdg-open`, which runs apart from Bartizan and fails when nothing opens it.
   */
  external(connectionId: string, target: string) {
    const label = this.sessions.entries.get(connectionId)?.info.label;
    let reported = false;
    const failed = () => { if (!reported) this.error(`No application opens ${new URL(target).protocol} links`, connectionId, label); reported = true; };
    if (process.platform === 'darwin') shell.openExternal(target).catch(failed);
    else if (!onPath('xdg-open')) failed();
    else {
      const child = spawn('xdg-open', [target], { stdio: 'ignore', detached: true, env: { ...process.env, MM_NOTTTY: '1' } });
      // xdg-open reports a missing handler at once; a handler it runs itself may exit with any status much later.
      const started = Date.now();
      child.on('error', failed).on('exit', code => { if (code !== 0 && Date.now() - started < 5000) failed(); });
      child.unref();
    }
  }
  /** The items for a link in a terminal, or in a page of ordinary session `currentId` or of an application. */
  private items(connectionId: string, url: string, currentId?: string): MenuItem[] {
    const target = linkURL(url);
    const connection = this.sessions.entries.get(connectionId);
    if (!connection) return [];
    if (currentId && !connection.browsers?.entries.has(currentId)) return [];
    const label = connection.info.label;
    const sessions = connection.browsers?.sessions() ?? [];
    const connected = connection.info.status === 'connected';
    const run = (action: () => Promise<unknown>) => { void action().catch(error => this.error(String(error), connectionId, label)); };
    const current = sessions.find(entry => entry.info.id === currentId);
    const items: MenuItem[] = [
      ...current ? [{ label: 'Open Link in New Tab', click: () => run(() => current.open({ url: target, background: true })) }] : [],
      { label: 'Open in New Browser', icon: 'window', enabled: connected, click: () => this.open(connectionId, target, 'new') },
      ...sessions.filter(e => e.info.id !== currentId).map(entry => ({ label: `Open in ${browserSessionName(entry.info)}`, icon: 'window', color: entry.info.color, click: () => this.open(connectionId, target, entry.info.id) })),
    ];
    if (externalBrowserAvailable()) items.push({ label: 'Open in External Browser', icon: 'external', click: () => run(() => shell.openExternal(target)) });
    items.push({ type: 'separator' }, { label: 'Copy Link', icon: 'link', click: () => run(async () => { await clipboard.writeText(target); }) });
    return items;
  }
}
