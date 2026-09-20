import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { execFile } from 'node:child_process';
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
