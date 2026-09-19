import { execFileSync } from 'node:child_process';
import { hostKeyPins } from './host-keys';
import type { Spec } from './config';

const quoteArgument = (value: string) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
const quoteOption = (value: string) => quoteArgument(value.replaceAll('%', '%%'));

export function sshArgs(spec: Spec, knownHosts: string, socksPort?: number, hostKeyHelper = '<host-key helper>'): string[] {
  const args = ['-F', 'none', '-tt', '-e', 'none'];
  const option = (key: string, value: string | number | boolean) => args.push('-o', `${key}=${typeof value === 'boolean' ? (value ? 'yes' : 'no') : value}`);
  if (knownHosts.includes('${')) throw new Error('Unsupported trust storage path');
  const pinned = Boolean(hostKeyPins(spec.host_keys).length);
  option('UserKnownHostsFile', pinned ? 'none' : quoteOption(spec.host_keys?.policy === 'off' ? '/dev/null' : knownHosts));
  option('GlobalKnownHostsFile', 'none'); option('UpdateHostKeys', false); option('CheckHostIP', false);
  option('StrictHostKeyChecking', pinned || spec.host_keys?.policy === 'strict' ? 'yes' : spec.host_keys?.policy ?? 'ask');
  if (pinned) {
    option('KnownHostsCommand', `${quoteArgument(hostKeyHelper)} %I %t %K`);
    option('VerifyHostKeyDNS', false);
  }
  option('PermitLocalCommand', false);
  option('ForwardX11', false); option('EscapeChar', 'none');
  const auth = spec.auth ?? {};
  const method = auth.method ?? 'auto';
  option('PubkeyAuthentication', ['auto', 'agent', 'key'].includes(method));
  option('PasswordAuthentication', ['auto', 'password'].includes(method));
  option('KbdInteractiveAuthentication', ['auto', 'keyboard-interactive'].includes(method));
  option('GSSAPIAuthentication', false); option('HostbasedAuthentication', false);
  // A configured password is tried before keyboard-interactive prompts.
  const preferred = auth.password && auth.password.source !== 'prompt' ? ['publickey', 'password', 'keyboard-interactive'] : ['publickey', 'keyboard-interactive', 'password'];
  option('PreferredAuthentications', method === 'auto' ? preferred.join(',') : method === 'agent' || method === 'key' ? 'publickey' : method);
  if (method === 'agent') {
    option('IdentityFile', 'none'); option('IdentitiesOnly', false);
    option('IdentityAgent', quoteOption(auth.agent ?? 'SSH_AUTH_SOCK'));
  } else {
    option('IdentitiesOnly', Boolean(auth.identity_files?.length));
    option('IdentityAgent', method === 'auto' ? quoteOption(auth.agent ?? 'SSH_AUTH_SOCK') : 'none');
    if (method !== 'auto' || auth.identity_files?.length) option('IdentityFile', 'none');
    if (auth.identity_files?.length) for (const file of auth.identity_files) option('IdentityFile', quoteOption(file));
  }
  for (const [key, value] of Object.entries(spec.ssh ?? {})) {
    if (value !== undefined && value !== '') option(key, value);
  }
  if (socksPort !== undefined) { args.push('-D', `127.0.0.1:${socksPort}`); option('ExitOnForwardFailure', true); }
  args.push('-p', String(spec.port ?? 22));
  if (spec.username) args.push('-l', spec.username);
  args.push('--', spec.host!);
  return args;
}
export function masterArgs(spec: Spec, knownHosts: string, socksPort: number, socket: string, hostKeyHelper?: string): string[] {
  const args = sshArgs(spec, knownHosts, socksPort, hostKeyHelper);
  args.splice(args.indexOf('-tt'), 1);
  return ['-M', '-N', '-S', socket, '-o', 'ControlPersist=no', ...args];
}
export function preflight(spec: Spec, knownHosts: string, hostKeyHelper?: string): void {
  execFileSync('ssh', ['-G', ...sshArgs(spec, knownHosts, undefined, hostKeyHelper)], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 1024 * 1024 });
}
