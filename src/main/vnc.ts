import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { specSchema } from '../core/config';
import { vncLimits, type VncDestination, type VncSession } from '../shared';
import { channelArgs, sessionError } from './remote-sessions';
import type { ConnectionController } from './connection';
import type { SshConnection } from './ssh-connection';

export const vncDestinationSchema = z.strictObject({
  host: specSchema.shape.host.unwrap().default('localhost'),
  port: specSchema.shape.port.unwrap().default(5900),
});

/** Opens a direct TCP channel through the master. The SSH server resolves the destination. */
export function vncArgs(transport: Pick<SshConnection, 'socket' | 'spec'>, destination: VncDestination) {
  const { host, port } = destination;
  return [...channelArgs(transport.socket, transport.spec), '-T', '-W', `${host.includes(':') ? `[${host}]` : host}:${port}`, '--', transport.spec.host!];
}

/** One tab and its current pipe-based SSH channel. Each read supplies at most one IPC payload. */
export class VncController {
  readonly info: VncSession;
  reconnectOnConnect = false;
  private child?: ChildProcessWithoutNullStreams;
  private reading?: (data: Uint8Array | null) => void;
  private pull?: () => void;
  private cleanup?: () => void;
  private exitChecked = false;
  private exited = false;
  constructor(readonly connection: ConnectionController, destination: Partial<VncDestination>) {
    this.info = { ...vncDestinationSchema.parse(destination), id: randomUUID(), connectionId: connection.info.id, attempt: randomUUID(), status: 'connecting' };
  }
  start(transport: SshConnection) {
    this.stop();
    this.exitChecked = this.exited = false;
    Object.assign(this.info, { attempt: randomUUID(), status: 'connecting', error: undefined, exitCode: undefined });
    try {
      const child = this.child = spawn('ssh', vncArgs(transport, this.info), { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } });
      let stderr = '', pipeError = '', result: { code: number } | undefined, closed = false;
      let probe: ReturnType<typeof execFile> | undefined;
      const failPipe = (error: Error) => {
        if (this.child !== child || pipeError) return;
        // A broken pipe can precede the master's exit callback. Keep the attempt until its master check and output drain.
        pipeError = error.message;
        child.stdin.destroy(); child.kill();
      };
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (text: string) => { stderr = (stderr + text).slice(-4096); });
      child.stdin.on('error', failPipe);
      child.stdout.on('error', failPipe);
      child.stderr.on('error', failPipe);
      child.once('error', error => { if (this.child === child) this.failure(stderr || error.message); });
      child.once('spawn', () => {
        if (this.child !== child) return;
        this.info.status = 'connected'; this.connection.changed();
      });
      const pull = this.pull = () => {
        const resolve = this.reading;
        if (!resolve) return;
        const data: Buffer | null = child.stdout.read(Math.min(child.stdout.readableLength, vncLimits.chunk) || 1);
        if (data) {
          this.reading = undefined; resolve(Uint8Array.from(data));
        } else if (result && closed && (child.stdout.readableEnded || child.stdout.destroyed)) {
          this.child = undefined; this.reading = undefined; this.pull = undefined;
          this.cleanup?.(); this.cleanup = undefined;
          this.info.status = 'closed'; this.info.exitCode = result.code;
          if (pipeError || result.code !== 0) this.info.error = this.diagnostic(stderr || pipeError) || `VNC channel exited with code ${result.code}`;
          this.connection.changed(); resolve(null);
        }
      };
      // Node resumes child stdout on exit. A permanent readable listener keeps unread RFB bytes buffered and bounded.
      child.stdout.on('readable', pull); child.stdout.on('end', pull); child.stdout.on('close', pull);
      this.cleanup = () => { child.stdout.off('readable', pull); child.stdout.off('end', pull); child.stdout.off('close', pull); probe?.kill(); };
      child.once('exit', code => {
        if (this.child !== child) return;
        this.exited = true;
        // A mux stdio channel exits with zero even when its master dies. Check the local master to distinguish server EOF.
        probe = execFile('ssh', ['-F', 'none', '-S', transport.socket, '-O', 'check', '--', transport.spec.host!],
          { timeout: 1000, env: { ...process.env, LC_ALL: 'C' } }, error => {
            if (this.child !== child) return;
            this.exitChecked = true;
            this.reconnectOnConnect = !transport.connected || Boolean(error && typeof error.code === 'number' && error.code !== 0 && !error.killed);
            result = { code: code ?? 255 };
            pull();
          });
      });
      child.once('close', () => { if (this.child === child) { closed = true; pull(); } });
    } catch (error) { this.failure(String(error)); }
    this.connection.changed();
  }
  private diagnostic(text: string) { return sessionError(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim(); }
  failure(message: string) {
    this.stop(); this.info.error = this.diagnostic(message); this.info.exitCode = undefined; this.connection.changed();
  }
  private current(attempt: string) {
    if (attempt !== this.info.attempt) throw new Error('VNC attempt is no longer current');
    return this.child;
  }
  read(attempt: string): Promise<Uint8Array | null> {
    const child = this.current(attempt);
    if (!child) return Promise.resolve(null);
    if (this.reading) throw new Error('A VNC read is already pending');
    return new Promise(resolve => {
      this.reading = resolve; this.pull!();
    });
  }
  async write(attempt: string, data: Uint8Array) {
    const child = this.current(attempt);
    if (!child || this.exited || child.stdin.destroyed) throw new Error('VNC channel is closed');
    // A blocked server must not grow the stdin queue or leave a partially delivered RFB stream in use.
    if (!(data instanceof Uint8Array) || data.byteLength > vncLimits.chunk || child.stdin.writableLength + data.byteLength > vncLimits.input) {
      this.failure('VNC input limit exceeded'); throw new Error('VNC input limit exceeded');
    }
    if (!data.byteLength) return;
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(Buffer.from(data), error => { if (error) reject(error); else resolve(); });
    });
  }
  stop(interrupted = false) {
    if (!interrupted) this.reconnectOnConnect = false;
    else if (this.child && !this.exitChecked) this.reconnectOnConnect = true;
    const child = this.child; this.child = undefined;
    this.reading?.(null); this.reading = undefined; this.pull = undefined;
    this.cleanup?.(); this.cleanup = undefined;
    this.info.status = 'closed';
    child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy(); child?.kill();
  }
  close() { this.stop(); this.connection.vncs.delete(this.info.id); this.connection.changed(); }
}
