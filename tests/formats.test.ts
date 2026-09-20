import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadCatalog, resolveSpec } from '../src/core/config';
import { sshArgs, masterArgs } from '../src/core/ssh';

test('YAML profiles share defaults, tags, aliases and path resolution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bartizan-formats-'));
  try {
    const file = join(dir, 'config.yaml');
    writeFileSync(file, 'version: 1\ndefaults:\n  port: 2222\nprofiles:\n  example: &profile\n    host: example.invalid\n    tags: [" Team ", team]\n    auth:\n      identity_files: [key]\n  copy: *profile\n');
    const catalog = loadCatalog(file);
    assert.deepEqual(catalog.defaults, { port: 2222 });
    for (const profile of catalog.profiles) {
      assert.deepEqual(profile.tags, ['Team']);
      assert.deepEqual(profile.spec, { host: 'example.invalid', auth: { identity_files: [join(dir, 'key')] } });
    }
  } finally { rmSync(dir, { recursive: true }); }
});

test('format errors are bounded and do not disclose source credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bartizan-formats-'));
  try {
    for (const [name, source] of [
      ['broken.yaml', 'version: 1\nprofiles: [private-value'],
      ['duplicate.yaml', 'version: 1\nversion: 1'],
      ['complex-key.yaml', 'version: 1\nprofiles: {[example]: {}}'],
      ['documents.yml', 'version: 1\n---\nversion: 1'],
      ['cycle.yaml', 'version: 1\nprofiles: &cycle\n  cycle: *cycle'],
      ['custom.yaml', 'version: 1\nprofiles: !private-value {}'],
      ['reserved.yaml', 'version: 1\nprofiles:\n  __proto__: {}'],
      ['scalar.yaml', 'version=1'],
      ['null.yaml', 'null'],
    ]) {
      const file = join(dir, name); writeFileSync(file, source);
      assert.throws(() => loadCatalog(file), error => error instanceof Error && !error.message.includes('private-value'));
    }
  } finally { rmSync(dir, { recursive: true }); }
});

test('omitted and blank usernames defer to OpenSSH, including cleared inherited users', () => {
  const catalog = { defaults: {}, profiles: [], file: '', settings: { appearance: 'dark' as const, theme: 'rail' as const, interfaceFont: 'Inter', terminalLigatures: true, remoteSessionIntegration: true, terminalFont: '', terminalFontSize: 13 } };
  const host = 'example.invalid';
  for (const overrides of [{ host }, { host, username: '' }]) {
    const spec = resolveSpec(catalog, undefined, overrides);
    assert.equal(Boolean(spec.username), false);
    assert.equal(sshArgs(spec, '/tmp/known_hosts').includes('-l'), false);
    assert.equal(masterArgs(spec, '/tmp/known_hosts', 12000, '/tmp/socket').includes('-l'), false);
    const options = execFileSync('ssh', ['-G', ...sshArgs(spec, '/tmp/known_hosts')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const baseline = execFileSync('ssh', ['-G', '-F', 'none', host], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(options.match(/^user .*$/m)?.[0], baseline.match(/^user .*$/m)?.[0]);
  }
  const inherited = { ...catalog, defaults: { username: 'configured' } };
  assert.equal(resolveSpec(inherited, undefined, { host }).username, 'configured');
  assert.equal(resolveSpec(inherited, undefined, { host, username: '' }).username, '');
});
