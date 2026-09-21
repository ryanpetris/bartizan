import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { hostKeyPins } from '../core/host-keys';
import type { Spec } from '../core/config';
import { masterArgs, preflight } from '../core/ssh';
import { unusedPort } from '../core/relay';
import { connectionInfo, type ConnectionInfo } from './connection-info';
import type { Askpass } from './askpass';

/** One SSH transport attempt. A connection controller may replace it on reconnect. */
export class SshConnection {
  port = 0;
  socket = '';
  connected = false;
  exitCode?: number;
  private child?: ChildProcess;
  private stopping = false;
  private probe?: ReturnType<typeof setInterval>;
  private cleanup = () => {};
  private finish!: () => void;
  readonly ended = new Promise<void>(resolve => { this.finish = resolve; });
  private observed: Partial<ConnectionInfo> = {};
  private pending?: Promise<ConnectionInfo>;
  constructor(readonly spec: Spec, private id: string, private directory: string, private askpass: Askpass, private askpassHelper: string,
    private ready: () => void, private closed: (code: number) => void, private diagnostic: (text: string) => void, private failure: (text: string) => void) {}
  async start() {
    const temporary = mkdtempSync(join(tmpdir(), 'bartizan-ssh-'));
    this.socket = join(temporary, 'mux');
    this.cleanup = () => { clearInterval(this.probe); this.askpass.unregister(this.id); rmSync(temporary, { recursive: true, force: true }); };
    try {
      const pins = hostKeyPins(this.spec.host_keys), trust = join(this.directory, 'known_hosts');
      const helper = pins.length ? join(temporary, 'host-key') : undefined;
      if (helper) writeFileSync(helper, '#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "$BARTIZAN_EXEC" "$BARTIZAN_HOST_KEY_JS" "$@"\n', { mode: 0o700 });
      preflight(this.spec, trust, helper);
      this.port = await unusedPort();
      const environment = this.askpass.register(this.id, this.spec, process.execPath, this.askpassHelper);
      const child = this.child = spawn('ssh', [...masterArgs(this.spec, trust, this.port, this.socket, helper)], {
        env: { ...process.env, ...environment, BARTIZAN_HOST_KEY_JS: join(dirname(this.askpassHelper), 'host-key.cjs'), BARTIZAN_HOST_KEY_PINS: JSON.stringify(pins), LC_ALL: 'C' }, stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '', failed = false, finished = false;
      const diagnostic = (text: string) => { stderr = (stderr + text).slice(-4096); this.diagnostic(text); };
      const finish = (code: number) => {
        if (finished) return;
        finished = true; failed = !this.stopping && code !== 0;
        this.connected = false; this.exitCode = code; this.child = undefined;
        this.cleanup(); this.finish(); this.closed(code);
      };
      child.stderr?.setEncoding('utf8'); child.stderr?.on('data', diagnostic);
      child.once('error', error => { diagnostic(`${error.message}\r\n`); finish(255); });
      child.once('exit', code => finish(code ?? 255));
      child.once('close', () => { if (failed && stderr) this.failure(stderr.trim().split(/\r?\n/).slice(-4).join('\n')); });
      let probing = false;
      this.probe = setInterval(() => {
        if (probing || finished || this.stopping) return;
        probing = true;
        execFile('ssh', ['-F', 'none', '-S', this.socket, '-O', 'check', '--', this.spec.host!], { timeout: 1000, env: { ...process.env, LC_ALL: 'C' } }, error => {
          probing = false;
          if (error || finished || this.stopping) return;
          this.connected = true; clearInterval(this.probe); this.ready();
        });
      }, 100);
    } catch (error) { this.cleanup(); this.finish(); throw error; }
  }
  async stop() {
    this.stopping = true; this.connected = false; clearInterval(this.probe);
    const child = this.child;
    if (!child) return;
    child.kill();
    const deadline = setTimeout(() => child.kill('SIGKILL'), 1000);
    try { await this.ended; } finally { clearTimeout(deadline); }
  }
  details(): Promise<ConnectionInfo> {
    if (this.pending) return this.pending;
    const read = async (): Promise<ConnectionInfo> => {
      const metrics = this.connected ? await connectionInfo(this.socket, this.spec.host!) : {};
      const { duration, received, sent, ...negotiated } = metrics;
      Object.assign(this.observed, negotiated);
      return { ...this.observed, ...(this.connected ? metrics : {}), status: this.connected ? 'connected' : this.exitCode === undefined && !this.stopping ? 'connecting' : 'closed', exitCode: this.exitCode, username: this.spec.username || userInfo().username };
    };
    return this.pending = read().finally(() => { this.pending = undefined; });
  }
}
