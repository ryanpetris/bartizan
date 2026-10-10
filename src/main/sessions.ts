import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { HelperMessages } from '../helper-messages';
import type { Spec } from '../core/config';
import type { Configuration } from '../core/configuration';
import { resolveSpec } from '../core/config';
import { ConnectionController, destination } from './connection';
import type { Askpass } from './askpass';
import type { TerminalController } from './terminal';

/** Routes requests and collects snapshots; each controller owns its connection's resources. */
export class Sessions {
  readonly terminals = new Map<string, TerminalController>();
  readonly entries = new Map<string, ConnectionController>();
  readonly messages = new HelperMessages(async (id, message) => { await this.get(id).sendHelperMessage(message); });
  added?: (connection: ConnectionController) => void;
  /** Clients receiving terminal output, each acknowledging what it has processed. */
  private clients = new Set<string>();
  constructor(private directory: string, private askpass: Askpass, private askpassHelper: string, private changed: () => void,
    private data: (id: string, chunk: string) => void, private diagnostic: (message: string, connectionId: string, label: string) => void,
    private configuration: Configuration) { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  get(id: string) {
    const connection = this.entries.get(id);
    if (!connection) throw new Error('Unknown connection');
    return connection;
  }
  terminalOwner(id: string) { return this.terminals.get(id)?.connection; }
  /** Starts counting a client's output afresh, as for a page that has just loaded. */
  attach(client: string) {
    this.clients.add(client);
    for (const terminal of this.terminals.values()) { terminal.unprocessed.set(client, 0); terminal.pace(); }
  }
  detach(client: string) {
    this.clients.delete(client);
    for (const terminal of this.terminals.values()) { terminal.unprocessed.delete(client); terminal.pace(); }
  }
  /** Records output sent to every attached client. */
  sent(id: string, size: number) {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    for (const client of this.clients) terminal.unprocessed.set(client, (terminal.unprocessed.get(client) ?? 0) + size);
    terminal.pace();
  }
  processed(client: string, id: string, size: number) {
    const terminal = this.terminals.get(id), unprocessed = terminal?.unprocessed.get(client);
    if (!terminal || unprocessed === undefined) return;
    terminal.unprocessed.set(client, Math.max(0, unprocessed - size));
    terminal.pace();
  }
  /** Whether a client has more than `limit` of some terminal's output unprocessed. */
  behind(client: string, limit: number) {
    for (const terminal of this.terminals.values()) if ((terminal.unprocessed.get(client) ?? 0) > limit) return true;
    return false;
  }
  /**
   * Connects to a profile, or to what the overrides describe. A profile has one entry, and so does a `destination`, whose
   * overrides are a host, username and port alone: a live one is returned as it is, and a disconnected one connects again.
   */
  async create(overrides: Spec, profileId?: string, { initialTerminal = true, destination: chosen = false } = {}): Promise<string> {
    const target = chosen && !profileId ? destination(resolveSpec(this.configuration.catalog, undefined, overrides)) : undefined;
    const same = profileId || target ? [...this.entries.values()].filter(connection => profileId ? connection.info.profileId === profileId : connection.destination === target) : [];
    const existing = same.find(connection => connection.info.status !== 'closed');
    if (existing) return existing.info.id;
    const id = same[0]?.info.id ?? randomUUID();
    let connection = this.entries.get(id);
    const created = !connection;
    if (!connection) {
      connection = new ConnectionController(id, overrides, profileId, this.configuration, this.directory, this.askpass, this.askpassHelper,
        this.changed, this.data, this.diagnostic, message => this.messages.publish(id, message), this.terminals);
      connection.chosen = Boolean(target);
      this.entries.set(id, connection);
      this.added?.(connection);
    }
    try { await connection.connect(initialTerminal); }
    catch (error) { if (created) { await connection.dispose(); this.entries.delete(id); this.changed(); } throw error; }
    return id;
  }
  async remove(id: string) {
    const connection = this.entries.get(id);
    if (!connection) return;
    if (connection.info.status !== 'closed') throw new Error('Disconnect before removing a connection');
    await connection.dispose(); this.entries.delete(id); this.changed();
  }
  async close() { await Promise.all([...this.entries.values()].map(connection => connection.dispose())); this.entries.clear(); }
}
