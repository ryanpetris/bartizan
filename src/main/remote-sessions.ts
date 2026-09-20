import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { execFile } from 'node:child_process';
import discoveryProgram from './remote-discovery.py';
import { backends, type RemoteSession } from '../shared';
import type { Spec } from '../core/config';

export const quoteShell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** Every channel must use the existing master, including when its socket disappears. */
export function channelArgs(socket: string, spec: Spec): string[] {
  return ['-F', 'none', '-S', socket, '-o', 'ControlMaster=no', '-o', 'ProxyCommand=/bin/false', '-o', 'BatchMode=yes', '-o', `ForwardAgent=${spec.ssh?.ForwardAgent ? 'yes' : 'no'}`, '-p', String(spec.port ?? 22), ...(spec.username ? ['-l', spec.username] : [])];
}
export const sessionError = (output: string) => stripVTControlCharacters(output).split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-3).join('\n').slice(-1024).replace(/^[\uDC00-\uDFFF]/, '');
export function loginCommand(command: string): string {
  const script = `exec sh -c ${quoteShell(command)}`;
  return `exec sh -c ${quoteShell(`case "\${SHELL##*/}" in csh|tcsh) session_shell_flags=-ic ;; *) session_shell_flags=-ilc ;; esac; exec "$SHELL" "$session_shell_flags" ${quoteShell(script)}`)}`;
}
/**
 * Runs a command on the host through its login shell, and answers with everything the command wrote. `input` is fed to
 * the command over the session and ends it. No terminal is allocated: these commands never drive one, and a terminal
 * would read the input back out again as its own output.
 */
export function remoteCommand(socket: string, spec: Spec, command: string, input?: string): Promise<string> {
  const marker = `bartizan-${randomUUID()}`;
  const framed = loginCommand(`printf '%s\\n' ${quoteShell(marker)}; export LC_ALL=C; ${command}`);
  return new Promise((resolve, reject) => {
    const child = execFile('ssh', [...channelArgs(socket, spec), '-T', '--', spec.host!, framed], { timeout: 8000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout, stderr) => {
      const output = stdout.replace(/\r\n/g, '\n');
      const start = output.indexOf(marker + '\n');
      const result = start < 0 ? '' : output.slice(start + marker.length + 1);
      if (error) reject(new Error((error as NodeJS.ErrnoException & { killed?: boolean }).killed
        ? 'The session command timed out' : sessionError(result || stderr || output) || 'The session command failed'));
      else if (start < 0) reject(new Error('The session command did not run'));
      else resolve(result);
    });
    if (input === undefined) return;
    // A command that ends before it has read its input leaves the stream broken, which is not a fault of its own.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
/** env finds the interpreter on PATH without a shell function or alias standing in for it. */
export const discoveryCommand = 'exec /usr/bin/env python3 -';
export { discoveryProgram };
const unsafe = '\\x00-\\x1f\\x7f-\\x9f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069';
const control = /[\x00-\x1f\x7f-\x9f]/;
const controls = new RegExp(`[${unsafe}]`, 'g');
/** Failure text keeps the line breaks it is written with, and loses everything else that moves the cursor. */
const failure = new RegExp(`[${unsafe.replace('\\x00-\\x1f', '\\x00-\\x09\\x0b-\\x1f')}]`, 'g');
const text = (value: unknown, limit: number) => (typeof value === 'string' ? value.slice(0, limit) : undefined);
const exact = (value: unknown, limit: number) => (typeof value === 'string' && value.length <= limit ? value : undefined);
/** A host describes its own sessions, so the listing it is allowed to fill the interface with is bounded. */
const LIMIT = 100;
const label = (value: unknown, limit: number) => text(value, limit)?.replace(controls, ' ');
const count = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined);
/**
 * Reads a discovery listing, which arrives from a host that is not trusted to describe itself: an entry that fails to
 * name a backend, or gives an identifier that could not be used as one, is dropped rather than shown.
 */
export function parseDiscovery(output: string): { sessions: RemoteSession[]; failures: Partial<Record<RemoteSession['backend'], string>> } {
  // The listing is the last line written, so a warning printed ahead of it does not lose every session.
  const listing: unknown = JSON.parse(output.split('\n').map(line => line.trim()).filter(Boolean).at(-1) ?? '');
  const listed = listing && typeof listing === 'object' ? (listing as Record<string, unknown>) : undefined;
  if (!listed || !Array.isArray(listed.sessions)) throw new Error('Invalid session listing');
  const sessions: RemoteSession[] = [];
  const seen = new Set<string>();
  for (const value of listed.sessions) {
    if (sessions.length >= LIMIT) break;
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    const backend = backends.find(name => name === entry.backend);
    const id = exact(entry.id, 4096);
    const name = label(entry.name, 4096);
    if (!backend || !id || name === undefined || control.test(id) || id.startsWith('-')) continue;
    const key = `${backend}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sessions.push({ key, backend, id, name, clients: count(entry.clients) ?? 0, windows: count(entry.windows), activity: count(entry.activity), where: label(entry.where, 512), doing: label(entry.doing, 128) });
  }
  const reported = listed.errors && typeof listed.errors === 'object' ? (listed.errors as Record<string, unknown>) : {};
  const failures: Partial<Record<RemoteSession['backend'], string>> = {};
  for (const backend of backends) {
    const reason = text(reported[backend], 1024)?.replace(/\r\n?/g, '\n').replace(failure, ' ').trim();
    if (reason) failures[backend] = reason;
  }
  return { sessions, failures };
}
export function attachCommand(session: RemoteSession, takeover: boolean): string {
  const id = quoteShell(session.id);
  switch (session.backend) {
    case 'tmux': return takeover ? `exec tmux attach-session -d -t ${id}` :
      `attached=$(tmux display-message -p -t ${id} '#{session_attached}') || exit; if [ "$attached" != 0 ]; then printf '%s\\n' 'Session is attached' >&2; exit 1; fi; exec tmux attach-session -t ${id}`;
    case 'screen': return `exec screen ${takeover ? '-d -r' : '-r'} ${id}`;
    case 'herdr': return `exec herdr session attach ${id}`;
  }
}
export function killCommand(session: RemoteSession): string {
  const id = quoteShell(session.id);
  switch (session.backend) {
    case 'tmux': return `tmux kill-session -t ${id}`;
    case 'screen': return `screen -S ${id} -X quit`;
    case 'herdr': return `herdr session stop ${id}`;
  }
}
