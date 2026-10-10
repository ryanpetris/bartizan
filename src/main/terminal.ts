import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { channelArgs, sessionError } from './remote-sessions';
import type { TerminalSession } from '../shared';
import type { ConnectionController } from './connection';
import type { SshConnection } from './ssh-connection';

// Return to normal output and reset input modes without clearing scrollback.
const freshOutput = '\x1b[?1049l\x1b[!p\x1b[?1000;1006;1016l\x1b[999;1H\r\n';
/** Output a client has received but not yet processed, in string length: the PTY pauses above `pause` and resumes at `resume`. */
export const flowLimits = { pause: 256 * 1024, resume: 64 * 1024 };

/** One terminal tab, including its PTY and optional remote-session association. */
export class TerminalController {
  readonly info: TerminalSession;
  process?: pty.IPty;
  cols = 100;
  rows = 30;
  private repaint?: ReturnType<typeof setTimeout>;
  reconnectOnConnect = false;
  private command?: string;
  private attempted = false;
  /** Output sent to each attached client that it has not yet processed. */
  readonly unprocessed = new Map<string, number>();
  private paused = false;
  private watch?: ReturnType<typeof setInterval>;
  constructor(readonly connection: ConnectionController, private data: (id: string, chunk: string) => void, remoteSession?: TerminalSession['remoteSession']) {
    this.info = { id: randomUUID(), connectionId: connection.info.id, status: 'connecting', remoteSession };
  }
  start(transport: SshConnection, command?: string) {
    if (this.attempted) this.data(this.info.id, freshOutput);
    this.attempted = true;
    this.reconnectOnConnect = false;
    this.command = command ?? this.command;
    this.info.exitCode = undefined;
    try {
      const child = this.process = pty.spawn('ssh', [...channelArgs(transport.socket, transport.spec), '-tt', '-e', 'none', '--', transport.spec.host!, ...(this.command ? [this.command] : [])], { name: 'xterm-256color', cols: this.cols, rows: this.rows, env: { ...process.env, LC_ALL: 'C', TERM: 'xterm-256color' } });
      if (this.paused) this.hold(true);
      this.info.status = 'connected';
      let output = '';
      child.onData(chunk => { if (this.process !== child) return; output = (output + chunk).slice(-4096); this.data(this.info.id, chunk); });
      child.onExit(({ exitCode }) => {
        if (this.process !== child) return;
        clearTimeout(this.repaint); this.repaint = undefined;
        clearInterval(this.watch); this.watch = undefined;
        this.info.status = 'closed'; this.info.exitCode = exitCode; this.process = undefined;
        this.reconnectOnConnect = false;
        this.connection.terminalEnded(this);
        if (exitCode !== 0) {
          const detail = this.info.remoteSession || exitCode === 255 ? sessionError(output) : '';
          this.failure(`Terminal exited with code ${exitCode}${detail ? `: ${detail}` : ''}`);
        }
        if (this.info.remoteSession && transport.connected) {
          const session = this.info.remoteSession;
          if (exitCode !== 0 && this.connection.info.remoteSessions) {
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
    } catch (error) { this.failure(`Could not open terminal: ${String(error)}`); this.connection.terminalEnded(this); }
    this.connection.changed();
  }
  input(data: string) { this.process?.write(data); }
  /** Pauses the PTY while every attached client is too far behind, so output keeps pace with the fastest client. */
  pace() {
    const paused = this.unprocessed.size > 0 && Math.min(...this.unprocessed.values()) > (this.paused ? flowLimits.resume : flowLimits.pause);
    if (paused === this.paused) return;
    this.paused = paused;
    this.hold(paused);
  }
  /**
   * Pauses or resumes the PTY. node-pty discards unread output shortly after its child exits, so a paused PTY reads on
   * once the child has gone, keeping the child's last output.
   */
  private hold(paused: boolean) {
    clearInterval(this.watch); this.watch = undefined;
    const child = this.process;
    if (!child) return;
    if (!paused) { child.resume(); return; }
    child.pause();
    this.watch = setInterval(() => {
      try { process.kill(child.pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
        clearInterval(this.watch); this.watch = undefined;
        child.resume();
      }
    }, 50);
  }
  resize(cols: number, rows: number, repaint = false) {
    this.cols = cols; this.rows = rows;
    if (this.repaint || !this.process) return;
    if (repaint) {
      // PTYs need a temporary row change to request repaint at unchanged geometry.
      this.process.resize(cols, rows > 1 ? rows - 1 : 2);
      this.repaint = setTimeout(() => { this.repaint = undefined; this.process?.resize(this.cols, this.rows); }, 100);
    } else this.process.resize(cols, rows);
  }
  failure(message: string) {
    this.reconnectOnConnect = false;
    this.info.status = 'closed';
    const text = sessionError(message).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replaceAll('\n', '\r\n');
    this.data(this.info.id, `${freshOutput}\x1b[31m${text}\x1b[0m\r\n`);
  }
  stop(interrupted = false) {
    if (this.info.status === 'connected') this.reconnectOnConnect = interrupted;
    clearTimeout(this.repaint); this.repaint = undefined;
    clearInterval(this.watch); this.watch = undefined;
    const process = this.process; this.process = undefined;
    this.info.status = 'closed'; process?.kill();
    this.connection.terminalEnded(this);
  }
  close() { this.stop(); this.connection.removeTerminal(this); this.connection.changed(); }
}
