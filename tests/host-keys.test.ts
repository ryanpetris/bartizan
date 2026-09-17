import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pinnedHostKey } from '../src/core/host-keys';
import { loadCatalog, resolveSpec, specSchema } from '../src/core/config';
import { sshArgs } from '../src/core/ssh';

const wrong = `SHA256:${'A'.repeat(43)}`;
test('pinned helper trusts only configured public keys and fails closed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bartizan-pins-'));
  try {
    const file = join(directory, 'host');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file]);
    const [type, key] = readFileSync(`${file}.pub`, 'utf8').split(' ');
    const fingerprint = execFileSync('ssh-keygen', ['-lf', `${file}.pub`, '-E', 'sha256'], { encoding: 'utf8' }).split(' ')[1];
    assert.equal(pinnedHostKey([wrong, fingerprint], ['HOSTNAME', type!, key!]), `* ${type} ${key}\n`);
    assert.equal(pinnedHostKey([fingerprint], ['ORDER', 'NONE', 'NONE']), '');
    assert.throws(() => pinnedHostKey([wrong], ['HOSTNAME', type!, key!]), /does not match/);
    for (const args of [['HOSTNAME', type!, 'bad'], ['OTHER', type!, key!], ['HOSTNAME', 'ssh-rsa', key!], ['HOSTNAME', 'ssh-ed25519-cert-v01@openssh.com', key!]]) assert.throws(() => pinnedHostKey([fingerprint], args));
    for (const pins of [[], null, ['MD5:aa']]) assert.throws(() => pinnedHostKey(pins, ['ORDER']));
    const failed = spawnSync(process.execPath, ['--import', 'tsx', resolve('src/main/host-key-helper.ts'), 'HOSTNAME', type!, key!], { env: { ...process.env, BARTIZAN_HOST_KEY_PINS: JSON.stringify([wrong]) }, encoding: 'utf8' });
    assert.equal(failed.status, 1); assert.equal(failed.stdout, ''); assert.match(failed.stderr, /does not match/);
  } finally { rmSync(directory, { recursive: true }); }
});

test('pins merge from defaults and override every permissive host trust policy', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bartizan-pins-'));
  try {
    const file = join(directory, 'config.yaml');
    writeFileSync(file, `version: 1\ndefaults:\n  host_keys:\n    fingerprints: ["${wrong}"]\nprofiles:\n  example:\n    host: example.invalid\n`);
    const catalog = loadCatalog(file);
    assert.deepEqual(resolveSpec(catalog, 'example', {}).host_keys?.fingerprints, [wrong]);
    assert.deepEqual(resolveSpec(catalog, 'example', { host_keys: { fingerprints: [] } }).host_keys?.fingerprints, []);
    for (const policy of ['ask', 'strict', 'accept-new', 'off'] as const) {
      const args = sshArgs({ host: 'example.invalid', host_keys: { policy, fingerprints: [wrong] } }, '/tmp/trust', undefined, '/tmp/a space%/helper');
      const effective = execFileSync('ssh', ['-G', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      assert.match(effective, /^stricthostkeychecking true$/m);
      assert.match(effective, /^userknownhostsfile none$/m);
      assert.match(effective, /^globalknownhostsfile none$/m);
      assert.match(effective, /^verifyhostkeydns false$/m);
      assert.match(effective, /^knownhostscommand .*helper.*%I %t %K$/m);
    }
    assert.equal(sshArgs({ host: 'example.invalid', host_keys: { fingerprints: [] } }, '/tmp/trust').some(arg => arg.startsWith('KnownHostsCommand=')), false);
    for (const fingerprint of ['SHA256:short', wrong + '=', wrong.slice(0, -1) + 'B', 'MD5:00', wrong + '\n']) assert.equal(specSchema.safeParse({ host_keys: { fingerprints: [fingerprint] } }).success, false);
  } finally { rmSync(directory, { recursive: true }); }
});
