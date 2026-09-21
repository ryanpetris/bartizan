import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { channelArgs, sessionError } from './remote-sessions';
import type { TerminalSession } from '../shared';
import type { ConnectionController } from './connection';
import type { SshConnection } from './ssh-connection';

/** One terminal tab, including its PTY and optional remote-session association. */
export class TerminalController {
  readonly info: TerminalSession;
  process?: pty.IPty;
  cols = 100;
  rows = 30;
  private repaint?: ReturnType<typeof setTimeout>;
  private closing = false;
  constructor(readonly connection: ConnectionController, private data: (id: string, chunk: string) => void, remoteSession?: TerminalSession['remoteSession']) {
    this.info = { id: randomUUID(), connectionId: connection.info.id, status: 'connecting', remoteSession };
  }
  start(transport: SshConnection, command?: string) {
    try {
      this.process = pty.spawn('ssh', [...channelArgs(transport.socket, transport.spec), '-tt', '-e', 'none', '--', transport.spec.host!, ...(command ? [command] : [])], { name: 'xterm-256color', cols: this.cols, rows: this.rows, env: { ...process.env, LC_ALL: 'C', TERM: 'xterm-256color' } });
      this.info.status = 'connected';
      let output = '';
      this.process.onData(chunk => { if (this.info.remoteSession) output = (output + chunk).slice(-4096); this.data(this.info.id, chunk); });
      this.process.onExit(({ exitCode }) => {
        clearTimeout(this.repaint); this.repaint = undefined;
        this.info.status = 'closed'; this.info.exitCode = exitCode; this.process = undefined;
        this.connection.terminalEnded(this);
        if (this.info.remoteSession && transport.connected) {
          const session = this.info.remoteSession;
          if (!this.closing && exitCode !== 0 && this.connection.info.remoteSessions) {
            const error = sessionError(output) || 'Could not attach to session';
            const listed = this.connection.remoteSessions.get(session.key);
            if (listed) listed.error = error;
            else this.connection.remoteSessions.set(session.key, { ...session, error });
            this.connection.publishRemoteSessions();
          }
          void this.connection.sendHelperMessage({ type: 'sessions.refresh' }).catch(() => {});
        }
        this.connection.changed();
      });
    } catch (error) { this.info.status = 'closed'; this.connection.terminalEnded(this); this.data(this.info.id, `${String(error)}\r\n`); }
    this.connection.changed();
  }
  input(data: string) { this.process?.write(data); }
  resize(cols: number, rows: number, repaint = false) {
    this.cols = cols; this.rows = rows;
    if (this.repaint || !this.process) return;
    if (repaint) {
      // PTYs need a temporary row change to request repaint at unchanged geometry.
      this.process.resize(cols, rows > 1 ? rows - 1 : 2);
      this.repaint = setTimeout(() => { this.repaint = undefined; this.process?.resize(this.cols, this.rows); }, 100);
    } else this.process.resize(cols, rows);
  }
  stop() {
    this.closing = true;
    clearTimeout(this.repaint); this.repaint = undefined;
    const process = this.process; this.process = undefined;
    this.info.status = 'closed'; process?.kill();
    this.connection.terminalEnded(this);
  }
  close() { this.stop(); this.connection.removeTerminal(this); this.connection.changed(); }
}
