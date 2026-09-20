import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import program from './remote-helper.py';
import type { Spec } from '../core/config';
import type { HelperMessage, HelperRequest } from '../helper-messages';
import { channelArgs, loginCommand, quoteShell, sessionError } from './remote-sessions';

const key = z.string().min(1).max(4096);
const printable = (max: number) => z.string().max(max).transform(s => s.replace(/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/g, ' '));
const command = z.string().min(1).max(32768).refine(s => !s.includes('\0'));
const session = z.object({
  source: key, key, label: printable(4096), group: printable(128), detail: printable(4096), attached: z.boolean(),
  commands: z.object({ resume: command.optional(), takeover: command.optional(), stop: command.optional() }),
});
const schema = z.discriminatedUnion('type', [
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
  private delay = 1000;
  constructor(private socket: string, private spec: Spec, private receive: (message: HelperMessage) => void) { this.start(); }
  send(message: HelperRequest): Promise<void> {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) return Promise.reject(new Error('Remote helper is disconnected'));
    return new Promise((resolve, reject) => child.stdin.write(JSON.stringify(message) + '\n', error => error ? reject(error) : resolve()));
  }
  private start() {
    if (this.stopped) return;
    const marker = `bartizan-${randomUUID()}`;
    const command = loginCommand(`printf '%s\\n' ${quoteShell(marker)}; exec /usr/bin/env python3 -u -c ${quoteShell(program)}`);
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
          if (message.type === 'sessions.snapshot') { this.delay = 1000; arm(90000); }
          this.receive(message);
        } catch (error) { fail(error instanceof Error ? error.message : 'Invalid helper message'); return; }
      }
    });
    child.on('error', error => { failure = error.message; });
    child.on('close', () => {
      if (!active()) return;
      this.child = undefined;
      clearTimeout(this.watchdog);
      this.receive({ type: 'helper.error', message: failure || sessionError(diagnostic) || 'Remote helper disconnected' });
      this.retry = setTimeout(() => this.start(), this.delay);
      this.delay = Math.min(this.delay * 2, 30000);
    });
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.retry); clearTimeout(this.watchdog);
    this.child?.stdin.end(); this.child?.kill(); this.child = undefined;
  }
}
