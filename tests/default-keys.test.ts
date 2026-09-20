import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolveSpec } from '../src/core/config';
import { sshArgs } from '../src/core/ssh';

test('automatic authentication uses OpenSSH default identity paths unless files are selected', () => {
  const catalog = { defaults: {}, profiles: [], file: '', settings: { appearance: 'dark' as const, theme: 'rail' as const, interfaceFont: 'Inter', terminalLigatures: true, remoteSessionIntegration: true, terminalFont: '', terminalFontSize: 13 } };
  const spec = resolveSpec(catalog, undefined, { host: 'example.invalid' });
  const identities = (args: string[]) => execFileSync('ssh', ['-G', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(line => line.startsWith('identityfile '));
  assert.deepEqual(identities(sshArgs(spec, '/tmp/trust')), identities(['-F', 'none', 'example.invalid']));
  assert.deepEqual(spec.auth?.identity_files, []);
  spec.auth!.identity_files = ['/tmp/selected-key'];
  const selected = identities(sshArgs(spec, '/tmp/trust'));
  assert.ok(selected.includes('identityfile /tmp/selected-key'));
  assert.ok(selected.every(line => !line.includes('~/.ssh/')));
  spec.auth!.method = 'agent'; spec.auth!.identity_files = [];
  assert.deepEqual(identities(sshArgs(spec, '/tmp/trust')), ['identityfile none']);
});
