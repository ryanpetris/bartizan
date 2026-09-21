import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import program from './remote-helper.pyz';
import helperLoader from './remote-helper/loader.py';
export { helperLoader };
import type { ProcessReport } from '../shared';
import type { Spec } from '../core/config';
import type { HelperMessage, HelperRequest } from '../helper-messages';
import { channelArgs, loginCommand, quoteShell, sessionError } from './remote-sessions';


const source = Buffer.from(program, 'base64');

const key = z.string().min(1).max(4096);
const printable = (max: number) => z.string().max(max).transform(s => s.replace(/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/g, ' '));
const command = z.string().min(1).max(32768).refine(s => !s.includes('\0'));
const session = z.object({
  source: key, key, label: printable(4096), group: printable(128), detail: printable(4096), attached: z.boolean(),
  commands: z.object({ resume: command.optional(), takeover: command.optional(), stop: command.optional() }),
});
const launchId = z.string().regex(/^[A-Za-z0-9-]{1,128}$/);
export const applicationRequest = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('applications.launch'), launchId, application: z.string().min(1).max(64), options: z.record(z.string().max(64), z.unknown()).optional() }),
  z.strictObject({ type: z.literal('applications.respond'), launchId, consentId: key, accepted: z.boolean() }),
  z.strictObject({ type: z.literal('applications.stop'), launchId }),
]);
const pid = z.number().int().positive().max(2147483647);
const schema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('helper.ready'), pid }),
  z.object({ type: z.literal('applications.spawned'), launchId, pid }),
  z.object({ type: z.literal('applications.progress'), launchId, phase: z.enum(['checking', 'downloading', 'extracting', 'starting', 'loading']), component: z.string().min(1).pipe(printable(128)).optional(), release: key.optional(), usingCachedRelease: z.boolean().optional(), transfer: z.object({ receivedBytes: z.number().int().nonnegative(), totalBytes: z.number().int().nonnegative().optional() }).optional() }),
  z.object({ type: z.literal('applications.consent'), launchId, consentId: key, content: z.object({ text: z.string().min(1).max(32768), prompt: z.string().max(4096).optional() }) }),
  z.object({ type: z.literal('applications.ready'), launchId, release: key.optional(), view: z.object({ kind: z.literal('browser'), url: z.string().max(8192).refine(value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) && !url.username && !url.password; } catch { return false; } }) }) }),
  z.object({ type: z.literal('applications.ended'), launchId, reason: z.enum(['cancelled', 'stopped', 'exited', 'failed']), exitCode: z.number().int().optional(), error: z.object({ code: key, message: printable(2048) }).optional() }),
  z.object({ type: z.literal('sessions.upsert'), source: key, session }),
  z.object({ type: z.literal('sessions.remove'), source: key, key }),
  z.object({ type: z.literal('sessions.snapshot'), sources: z.array(key).max(1024), sessions: z.array(session).max(100),
    errors: z.array(z.object({ source: key.optional(), message: printable(1024) })).max(1024) }),
]);
export function parseHelperMessage(line: string): HelperMessage {
  const message = schema.parse(JSON.parse(line));
  if (message.type === 'sessions.upsert' && message.source !== message.session.source) throw new Error('Session source does not match');
  if (message.type === 'sessions.snapshot') {
    const sources = new Set(message.sources), keys = new Set<string>();
    for (const session of message.sessions) {
      if (!sources.has(session.source) || keys.has(session.key)) throw new Error('Invalid session snapshot');
      keys.add(session.key);
    }
  }
  return message;
}

/** One streaming channel per SSH master. Reconnection never replays commands. */
export class RemoteHelper {
  private child?: ChildProcessWithoutNullStreams;
  private retry?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private needed = true;
  private initialized = false;
  private delay = 1000;
  private readonly id = randomUUID();
  private pid?: number;
  private ready?: Promise<void>;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;
  constructor(private socket: string, private spec: Spec, private receive: (message: HelperMessage) => void, private initialize: () => HelperRequest[], private report: (record: ProcessReport) => void) {
    this.report({ id: this.id, name: 'Bartizan Helper', status: 'starting' });
    this.start();
  }
  setNeeded(needed: boolean) {
    this.needed = needed;
    if (!needed) {
      clearTimeout(this.retry); this.retry = undefined;
      if (!this.child) this.report({ id: this.id, status: 'stopped' });
    } else if (!this.child && !this.retry) {
      this.report({ id: this.id, name: 'Bartizan Helper', status: 'starting' });
      this.start();
    }
  }
  async send(message: HelperRequest): Promise<void> {
    if (message.type.startsWith('applications.')) message = applicationRequest.parse(message);
    const child = this.child;
    await this.ready;
    if (!child || child !== this.child || child.killed || !child.stdin.writable) return Promise.reject(new Error('Remote helper is disconnected'));
    return new Promise((resolve, reject) => child.stdin.write(JSON.stringify(message) + '\n', error => error ? reject(error) : resolve()));
  }
  reconfigure() {
    if (!this.initialized || !this.child || this.child.killed) return;
    for (const request of this.initialize()) this.child.stdin.write(JSON.stringify(request) + '\n');
  }
  private start() {
    if (this.stopped || !this.needed) return;
    this.initialized = false;
    this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    void this.ready.catch(() => {});
    const marker = `bartizan-${randomUUID()}`;
    const command = loginCommand(`printf '%s\\n' ${quoteShell(marker)}; exec /usr/bin/env python3 -u -c ${quoteShell(helperLoader)} ${source.length}`);
    const child = this.child = spawn('ssh', [...channelArgs(this.socket, this.spec), '-T', '--', this.spec.host!, command], { stdio: 'pipe', env: { ...process.env, LC_ALL: 'C' } });
    let buffer = '', diagnostic = '', framed = false, failure = '';
    const active = () => !this.stopped && this.child === child;
    const fail = (message: string) => { failure = message; child.kill(); };
    const arm = (ms: number) => {
      clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => { if (active()) fail('Remote helper timed out'); }, ms);
    };
    arm(30000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => { diagnostic = (diagnostic + text).slice(-4096); });
    child.stdin.on('error', () => {});
    child.stdin.write(source);
    child.stdout.on('data', text => {
      if (!active()) return;
      buffer += text;
      if (Buffer.byteLength(buffer) > 1024 * 1024) { fail('Remote helper message is too large'); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
        if (!framed) { framed = line === marker; continue; }
        try {
          const message = parseHelperMessage(line);
          if (message.type === 'helper.ready') {
            this.initialized = true; this.delay = 1000; this.pid = message.pid; arm(90000);
            this.report({ id: this.id, name: 'Bartizan Helper', status: 'running', pid: message.pid });
            this.reconfigure(); this.resolveReady?.();
            continue;
          }
          if (message.type === 'sessions.snapshot') arm(90000);
          this.receive(message);
        } catch (error) { fail(error instanceof Error ? error.message : 'Invalid helper message'); return; }
      }
    });
    child.on('error', error => { failure = error.message; });
    child.on('close', () => {
      if (!active()) return;
      this.rejectReady?.(new Error(failure || 'Remote helper disconnected'));
      this.initialized = false; this.pid = undefined;
      clearTimeout(this.watchdog);
      const message = failure || sessionError(diagnostic) || 'Remote helper disconnected';
      this.receive({ type: 'helper.error', message });
      this.child = undefined;
      if (this.needed) {
        this.retry = setTimeout(() => { this.retry = undefined; this.start(); }, this.delay);
        this.delay = Math.min(this.delay * 2, 30000);
        this.report({ id: this.id, name: 'Bartizan Helper', status: 'retrying', message });
      } else this.report({ id: this.id, status: 'stopped' });
    });
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.rejectReady?.(new Error('Remote helper stopped'));
    clearTimeout(this.retry); clearTimeout(this.watchdog);
    const child = this.child;
    this.child = undefined;
    if (child) {
      this.report({ id: this.id, name: 'Bartizan Helper', status: 'stopping', pid: this.pid });
      child.stdin.end();
      const deadline = setTimeout(() => child.kill(), 25000);
      deadline.unref();
      child.once('close', () => { clearTimeout(deadline); this.report({ id: this.id, status: 'stopped' }); });
    } else this.report({ id: this.id, status: 'stopped' });
  }
}
