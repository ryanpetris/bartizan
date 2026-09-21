import { webContents } from 'electron';
import type { Bounds, PageShortcut } from '../shared';
import type { ConnectionController } from './connection';
import type { Browsers } from './browser';
import type { BrowserSession } from './browser-session';
import type { BrowserTabController } from './browser-tab';

export type BrowserDisplay = { visible?: string; bounds: Bounds; toolsBounds?: Bounds };

/** Direct routing indexes and window-wide presentation. Connections own the indexed resources. */
export class BrowserWindowController {
  readonly display: BrowserDisplay = { bounds: { x: 250, y: 140, width: 700, height: 500 } };
  readonly entries = new Map<string, BrowserSession>();
  readonly certificates = new Map<string, BrowserSession>();
  readonly authentication = new Map<string, BrowserSession>();
  readonly tabs = new Map<string, BrowserTabController>();
  get challenges() { return [...this.entries.values()].flatMap(session => session.challenges); }
  owner(id: string) {
    const owner = this.entries.get(id);
    if (!owner) throw new Error('Browser session is closed');
    return owner;
  }
  open(connection: ConnectionController, ...args: Parameters<Browsers['open']>) {
    if (!connection.browsers) throw new Error('Embedded browsers are unavailable');
    return connection.browsers.open(...args);
  }
  action(id: string, ...args: Parameters<BrowserSession['action']>) { return this.owner(id).action(...args); }
  rename(id: string, name: string) { const session = this.owner(id); session.info.name = name.trim() || undefined; session.changed(); }
  find(id: string, tab: string, request: Parameters<BrowserTabController['find']>[0]) { return this.owner(id).tabs.get(tab)?.find(request); }
  download(id: string, ...args: Parameters<BrowserSession['download']>) { return this.owner(id).download(...args); }
  contents(id: string, tab: string) { const contents = this.entries.get(id)?.tabs.get(tab)?.view.webContents; return contents && !contents.isDestroyed() ? contents : undefined; }
  inspect(id: string, tab: string, x: number, y: number) { return this.owner(id).tabs.get(tab)?.inspect(x, y); }
  allowPrompts(id: string) { this.tabs.get(id)?.allowPrompts(); }
  answerCertificate(id: string, allow: boolean) { return this.certificates.get(id)?.certificates.answer(id, allow) ?? false; }
  answerAuthentication(id: string, value: unknown) { return this.authentication.get(id)?.answerAuthentication(id, value) ?? false; }
  target() {
    const contents = webContents.getFocusedWebContents();
    const visible = this.entries.get(this.display.visible ?? '');
    const tab = contents && visible?.contents.get(contents.id) || visible?.tabs.get(visible.info.activeTab ?? '');
    return tab ? { id: tab.owner.info.id, tabId: tab.info.id, connectionId: tab.owner.info.connectionId } : undefined;
  }
  pageShortcut(name: PageShortcut, target: { id: string; tabId: string }) { return this.owner(target.id).pageShortcut(name, target.tabId); }
  show(id: string | null, bounds?: Bounds, tools?: Bounds) {
    const previous = this.entries.get(this.display.visible ?? '');
    this.display.visible = id ?? undefined;
    if (bounds) this.display.bounds = bounds;
    this.display.toolsBounds = tools;
    previous?.render();
    if (id !== previous?.info.id) this.entries.get(id ?? '')?.render();
  }
  replay() { for (const tab of this.tabs.values()) tab.replay(); }
  forgetFavicons() { for (const tab of this.tabs.values()) tab.favicon = undefined; }
}
