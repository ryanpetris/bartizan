import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { HelperMessages } from '../helper-messages';
import type { Spec } from '../core/config';
import type { Configuration } from '../core/configuration';
import { ConnectionController } from './connection';
import type { Askpass } from './askpass';
import type { TerminalController } from './terminal';

/** Routes requests and collects snapshots; each controller owns its connection's resources. */
export class Sessions {
  readonly terminals = new Map<string, TerminalController>();
  readonly entries = new Map<string, ConnectionController>();
  readonly messages = new HelperMessages(async (id, message) => { await this.get(id).sendHelperMessage(message); });
  added?: (connection: ConnectionController) => void;
  constructor(private directory: string, private askpass: Askpass, private askpassHelper: string, private changed: () => void,
    private data: (id: string, chunk: string) => void, private diagnostic: (message: string, connectionId: string, label: string) => void,
    private configuration: Configuration) { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  get(id: string) {
    const connection = this.entries.get(id);
    if (!connection) throw new Error('Unknown connection');
    return connection;
  }
  terminalOwner(id: string) { return this.terminals.get(id)?.connection; }
  async create(overrides: Spec, profileId?: string, retainedId?: string, initialTerminal = true): Promise<string> {
    const existing = [...this.entries.values()].find(connection => profileId && connection.info.profileId === profileId && connection.info.status !== 'closed');
    if (existing) return existing.info.id;
    const id = retainedId ?? randomUUID();
    let connection = this.entries.get(id);
    const created = !connection;
    if (!connection) {
      connection = new ConnectionController(id, overrides, profileId, this.configuration, this.directory, this.askpass, this.askpassHelper,
        this.changed, this.data, this.diagnostic, message => this.messages.publish(id, message), this.terminals);
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
