import { randomUUID } from 'node:crypto';
import type { BrowserWindow, ContextMenuParams } from 'electron';
import type { BrowserShortcut, Event, Workspace } from '../shared';
import type { ConnectionController } from './connection';
import type { BrowserWindowController } from './browser-window';
import { BrowserSession } from './browser-session';

/** Browser sessions owned by one connection. */
export class Browsers {
  readonly entries = new Map<string, BrowserSession>();
  /** The keys of the connection's items in navigation order; sessions it does not name follow in the order they opened. */
  order: string[] = [];
  readonly retiring = new Set<Promise<void>>();
  openPopup?: (connectionId: string, url: string, from: string) => void;
  openExternal?: (connectionId: string, url: string) => void;
  pageMenu?: (workspaceId: string, tabId: string, params: ContextMenuParams) => void;
  added?: () => void;
  constructor(readonly connection: ConnectionController, readonly host: BrowserWindowController, readonly window: BrowserWindow,
    readonly shortcut: (id: string, action: Exclude<BrowserShortcut, 'devtools'> | 'find') => void, readonly send: (event: Event) => void) {}
  async open(url?: string, session?: string, fallback = false, application?: Pick<Workspace, 'name' | 'application'>) {
    const named = session ? this.entries.get(session) : undefined;
    const usable = named && !named.info.application ? named : undefined;
    if (session && session !== 'new' && !usable && !fallback) throw new Error('Browser session is closed');
    const existing = session === 'new' ? undefined : usable ?? this.sessions()[0];
    const entry = existing ?? await this.create(application);
    try { await entry.action('new', undefined, url, true, application?.name); }
    catch (error) { if (!existing) await entry.close(true); throw error; }
    return entry.info.id;
  }
  private rank(entry: BrowserSession) { const index = this.order.indexOf(`session:${entry.info.id}`); return index < 0 ? Infinity : index; }
  /** The ordinary sessions, in navigation order. */
  sessions() { return [...this.entries.values()].filter(entry => !entry.info.application).sort((a, b) => this.rank(a) - this.rank(b)); }
  /** The ordinary session nearest after navigation item `from`, or else nearest before it, or else the first. */
  nearest(from?: string) {
    const sessions = this.sessions(), origin = from ? this.order.indexOf(from) : -1;
    if (origin < 0) return sessions[0];
    return sessions.find(entry => this.rank(entry) > origin) ?? sessions.filter(entry => this.rank(entry) < origin).at(-1);
  }
  private async create(application?: Pick<Workspace, 'name' | 'application'>) {
    if (this.connection.info.status !== 'connected') throw new Error('Connection is not connected');
    await Promise.all(this.retiring);
    // Only ordinary sessions take a color; an application is shown as itself.
    const siblings = [...this.entries.values()].filter(entry => !entry.info.application);
    const used = new Set(siblings.map(entry => entry.info.color));
    const color = application ? undefined : Array.from({ length: 9 }, (_, index) => index).find(index => !used.has(index)) ?? siblings.length % 9;
    const entry = new BrowserSession(this, { id: randomUUID(), connectionId: this.connection.info.id, ...color !== undefined && { color }, tabs: [], downloads: [], closedTabs: 0, ...application });
    await entry.start();
    this.entries.set(entry.info.id, entry); this.host.entries.set(entry.info.id, entry);
    entry.sync();
    this.connection.changed();
    return entry;
  }
  sync() { for (const entry of this.entries.values()) entry.sync(); }
  async closeConnection() { await Promise.all([...this.retiring, ...[...this.entries.values()].map(entry => entry.close(true))]); }
}
