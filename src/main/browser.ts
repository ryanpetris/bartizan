import { randomUUID } from 'node:crypto';
import type { BrowserWindow, ContextMenuParams } from 'electron';
import type { Event, Workspace } from '../shared';
import type { ConnectionController } from './connection';
import type { BrowserWindowController } from './browser-window';
import { BrowserSession } from './browser-session';

/** Browser sessions owned by one connection. */
export class Browsers {
  readonly entries = new Map<string, BrowserSession>();
  readonly retiring = new Set<Promise<void>>();
  openPopup?: (connectionId: string, url: string) => void;
  pageMenu?: (workspaceId: string, tabId: string, params: ContextMenuParams) => void;
  added?: () => void;
  constructor(readonly connection: ConnectionController, readonly host: BrowserWindowController, readonly window: BrowserWindow,
    readonly shortcut: (id: string, action: 'focus-address' | 'new-connection' | 'find') => void, readonly send: (event: Event) => void) {}
  async open(url?: string, session?: string, fallback = false, application?: Pick<Workspace, 'name' | 'application'>) {
    const named = session ? this.entries.get(session) : undefined;
    const usable = named && !named.info.application ? named : undefined;
    if (session && session !== 'new' && !usable && !fallback) throw new Error('Browser session is closed');
    const existing = session === 'new' ? undefined : usable ?? [...this.entries.values()].find(entry => !entry.info.application);
    const entry = existing ?? await this.create(application);
    try { await entry.action('new', undefined, url, true, application?.name); }
    catch (error) { if (!existing) await entry.close(true); throw error; }
    return entry.info.id;
  }
  private async create(application?: Pick<Workspace, 'name' | 'application'>) {
    if (this.connection.info.status !== 'connected') throw new Error('Connection is not connected');
    await Promise.all(this.retiring);
    const siblings = [...this.entries.values()];
    const ordinal = Math.max(0, ...siblings.map(entry => entry.info.ordinal)) + 1;
    const used = new Set(siblings.map(entry => entry.info.color));
    const color = Array.from({ length: 9 }, (_, index) => index).find(index => !used.has(index)) ?? siblings.length % 9;
    const entry = new BrowserSession(this, { id: randomUUID(), connectionId: this.connection.info.id, color, ordinal, tabs: [], downloads: [], ...application });
    await entry.start();
    this.entries.set(entry.info.id, entry); this.host.entries.set(entry.info.id, entry);
    entry.sync();
    this.connection.changed();
    return entry;
  }
  sync() { for (const entry of this.entries.values()) entry.sync(); }
  async closeConnection() { await Promise.all([...this.retiring, ...[...this.entries.values()].map(entry => entry.close(true))]); }
}
