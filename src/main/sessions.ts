import * as pty from 'node-pty';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { connectionInfo, type ConnectionInfo } from './connection-info';
import { dirname, join } from 'node:path';
import type { Spec } from '../core/config';
import type { Connection, TerminalSession } from '../shared';
import { masterArgs, preflight } from '../core/ssh';
import { unusedPort } from '../core/relay';
import { Askpass } from './askpass';
export type LiveConnection = { info: Connection; spec: Spec; process?: ChildProcess; port: number; socket: string; cleanup: () => void; ended: Promise<void>; observed: Partial<ConnectionInfo>; detailsPending?: Promise<ConnectionInfo> };
export class Sessions {
  entries = new Map<string, LiveConnection>();
  terminals = new Map<string, { info: TerminalSession; process?: pty.IPty; cols: number; rows: number; repaint?: ReturnType<typeof setTimeout> }>();
  constructor(private directory: string, private askpass: Askpass, private askpassHelper: string, private changed: () => void, private data: (id: string, chunk: string) => void, private diagnostic: (message: string, connectionId: string, label: string) => void) { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  async create(spec: Spec, profileId?: string, retainedId?: string, initialTerminal = true): Promise<string> {
    const existing = [...this.entries.values()].find(e => profileId && e.info.profileId === profileId && e.info.status !== 'closed');
    if (existing) return existing.info.id;
    const id = retainedId ?? randomUUID();
    const previous = this.entries.get(id);
    if (previous) { if (previous.info.status !== 'closed') throw new Error('Disconnect before reconnecting'); await previous.ended; }
    const temporary = mkdtempSync(join(tmpdir(), 'bartizan-ssh-'));
    const trust = join(this.directory, 'known_hosts');
    const hostKeyHelper = spec.host_keys?.fingerprints?.length ? join(temporary, 'host-key') : undefined;
    let probe: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => { clearInterval(probe); this.askpass.unregister(id); rmSync(temporary, { recursive: true, force: true }); };
    try {
      if (hostKeyHelper) writeFileSync(hostKeyHelper, '#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "$BARTIZAN_EXEC" "$BARTIZAN_HOST_KEY_JS" "$@"\n', { mode: 0o700 });
      preflight(spec, trust, hostKeyHelper);
      const port = await unusedPort();
      const info: Connection = { id, profileId, label: spec.label ?? profileId ?? spec.host!, host: spec.host!, username: spec.username, status: 'connecting', terminal: spec.terminal ?? {} };
      let ended!: () => void;
      const entry: LiveConnection = { info, spec, port, observed: {}, socket: join(temporary, 'mux'), cleanup, ended: new Promise(resolve => { ended = resolve; }) };
      let stderr = '';
      let failure = false;
      let diagnosticTerminal: string | undefined;
      const openTerminal = () => [...this.terminals.values()].find(t => t.info.connectionId === id && t.info.status !== 'closed');
      const diagnostic = (message: string) => {
        stderr = (stderr + message).slice(-4096);
        const terminal = openTerminal() ?? this.terminals.get(diagnosticTerminal ?? '');
        if (terminal) this.data(terminal.info.id, message);
      };
      this.entries.set(id, entry);
      const initial = initialTerminal ? this.allocateTerminal(id) : undefined;
      const environment = this.askpass.register(id, spec, process.execPath, this.askpassHelper);
      const child = spawn('ssh', [...masterArgs(spec, trust, port, entry.socket, hostKeyHelper)], { env: { ...process.env, ...environment, BARTIZAN_HOST_KEY_JS: join(dirname(this.askpassHelper), 'host-key.cjs'), BARTIZAN_HOST_KEY_PINS: JSON.stringify(spec.host_keys?.fingerprints ?? []), LC_ALL: 'C' }, stdio: ['ignore', 'ignore', 'pipe'] });
      entry.process = child;
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', diagnostic);
      let finished = false;
      const finish = (exitCode: number) => {
        if (finished) return; finished = true;
        failure = info.status !== 'closed' && exitCode !== 0;
        diagnosticTerminal = openTerminal()?.info.id;
        info.status = 'closed'; info.exitCode = exitCode; entry.process = undefined;
        if (this.entries.get(id) === entry) this.stopTerminals(id);
        cleanup(); ended(); this.changed();
      };
      child.once('error', error => { diagnostic(`${error.message}\r\n`); finish(255); });
      child.once('exit', code => finish(code ?? 255));
      child.once('close', () => {
        if (failure && stderr && !this.terminals.has(diagnosticTerminal ?? '')) this.diagnostic(stderr.trim().split(/\r?\n/).slice(-4).join('\n'), info.id, info.label);
      });
      let probing = false;
      probe = setInterval(() => {
        if (probing || info.status !== 'connecting') return;
        probing = true;
        execFile('ssh', ['-F', 'none', '-S', entry.socket, '-O', 'check', '--', spec.host!], { timeout: 1000, env: { ...process.env, LC_ALL: 'C' } }, error => {
          probing = false;
          if (error || info.status !== 'connecting' || this.entries.get(id) !== entry) return;
          info.status = 'connected'; clearInterval(probe);
          if (initial && this.terminals.has(initial) && this.terminals.get(initial)!.info.status !== 'closed') this.startTerminal(entry, initial);
          this.changed();
        });
      }, 100);
      this.changed(); return id;
    } catch (error) { cleanup(); if (previous) this.entries.set(id, previous); else this.entries.delete(id); throw error; }
  }
  private allocateTerminal(connectionId: string): string {
    const id = randomUUID();
    this.terminals.set(id, { info: { id, connectionId, status: 'connecting' }, cols: 100, rows: 30 });
    return id;
  }
  private startTerminal(entry: LiveConnection, id: string) {
    const terminal = this.terminals.get(id)!;
    try {
      // A missing master must fail, never create an independent transport.
      terminal.process = pty.spawn('ssh', ['-F', 'none', '-S', entry.socket, '-o', 'ControlMaster=no', '-o', 'ProxyCommand=/bin/false', '-o', 'BatchMode=yes', '-o', `ForwardAgent=${entry.spec.ssh?.ForwardAgent ? 'yes' : 'no'}`, '-tt', '-e', 'none', '-p', String(entry.spec.port ?? 22), ...(entry.spec.username ? ['-l', entry.spec.username] : []), '--', entry.spec.host!], { name: 'xterm-256color', cols: terminal.cols, rows: terminal.rows, env: { ...process.env, LC_ALL: 'C', TERM: 'xterm-256color' } });
      terminal.info.status = 'connected';
      terminal.process.onData(chunk => this.data(id, chunk));
      terminal.process.onExit(({ exitCode }) => { clearTimeout(terminal.repaint); terminal.repaint = undefined; terminal.info.status = 'closed'; terminal.info.exitCode = exitCode; terminal.process = undefined; this.changed(); });
    } catch (error) { terminal.info.status = 'closed'; this.data(id, `${String(error)}\r\n`); }
    this.changed();
  }
  newTerminal(connectionId: string): string {
    const entry = this.entries.get(connectionId);
    if (!entry || entry.info.status !== 'connected') throw new Error('Connection is not connected');
    const id = this.allocateTerminal(connectionId); this.startTerminal(entry, id); this.changed(); return id;
  }
  async details(id: string): Promise<ConnectionInfo> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Unknown connection');
    if (entry.detailsPending) return entry.detailsPending;
    const read = async (): Promise<ConnectionInfo> => {
      const metrics = entry.info.status === 'connected' ? await connectionInfo(entry.socket, entry.spec.host!) : {};
      const { duration, received, sent, ...negotiated } = metrics;
      Object.assign(entry.observed, negotiated);
      return { ...entry.observed, ...(entry.info.status === 'connected' ? metrics : {}), status: entry.info.status, exitCode: entry.info.exitCode, username: entry.spec.username || userInfo().username };
    };
    entry.detailsPending = read().finally(() => { entry.detailsPending = undefined; });
    return entry.detailsPending;
  }
  input(id: string, data: string) { this.terminals.get(id)?.process?.write(data); }
  resize(id: string, cols: number, rows: number, repaint = false) {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    terminal.cols = cols; terminal.rows = rows;
    if (terminal.repaint || !terminal.process) return;
    if (repaint) {
      // An unchanged PTY size does not deliver SIGWINCH. Keep columns fixed to avoid line reflow,
      // and allow SSH to deliver the temporary row count before restoring the requested geometry.
      terminal.process.resize(cols, rows > 1 ? rows - 1 : 2);
      terminal.repaint = setTimeout(() => this.finishResize(id), 100);
    } else terminal.process.resize(cols, rows);
  }
  private finishResize(id: string) {
    const terminal = this.terminals.get(id);
    if (!terminal?.repaint) return;
    clearTimeout(terminal.repaint); terminal.repaint = undefined;
    terminal.process?.resize(terminal.cols, terminal.rows);
  }
  closeTerminal(id: string) {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    clearTimeout(terminal.repaint); terminal.process?.kill(); this.terminals.delete(id); this.changed();
  }
  remove(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.info.status !== 'closed' || entry.process) throw new Error('Disconnect before removing a connection');
    for (const [terminalId, terminal] of this.terminals) if (terminal.info.connectionId === id) { clearTimeout(terminal.repaint); terminal.process?.kill(); this.terminals.delete(terminalId); }
    this.entries.delete(id); this.changed();
  }
  private stopTerminals(id: string) {
    for (const terminal of this.terminals.values()) if (terminal.info.connectionId === id) {
      clearTimeout(terminal.repaint); terminal.repaint = undefined;
      const child = terminal.process; terminal.process = undefined;
      terminal.info.status = 'closed'; child?.kill();
    }
  }
  async disconnect(id: string) {
    const entry = this.entries.get(id);
    if (!entry || !entry.process) return;
    entry.info.status = 'closed'; this.stopTerminals(id); this.changed();
    const child = entry.process;
    child.kill();
    const timeout = setTimeout(() => child.kill('SIGKILL'), 1000);
    await entry.ended; clearTimeout(timeout);
  }
  async close() { await Promise.all([...this.entries.keys()].map(id => this.disconnect(id))); }
}
