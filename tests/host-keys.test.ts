import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pinnedHostKey, publicKeyFingerprint, hostKeyPins } from '../src/core/host-keys';
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

test('public key pins preserve SSH fingerprints across key types and reject malformed keys', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bartizan-public-pins-'));
  try {
    for (const [algorithm, bits] of [['ed25519', undefined], ['ecdsa', '256'], ['ecdsa', '384'], ['ecdsa', '521'], ['rsa', '2048']]) {
      const file = join(directory, `${algorithm}-${bits}`);
      execFileSync('ssh-keygen', ['-q', '-t', algorithm!, ...(bits ? ['-b', bits] : []), '-N', '', '-f', file]);
      const publicKey = readFileSync(`${file}.pub`, 'utf8').trim();
      const [type, encoded] = publicKey.split(' ');
      const fingerprint = execFileSync('ssh-keygen', ['-lf', `${file}.pub`, '-E', 'sha256'], { encoding: 'utf8' }).split(' ')[1]!;
      assert.equal(publicKeyFingerprint(publicKey), fingerprint);
      assert.equal(publicKeyFingerprint(`\t${type}\t${encoded} another comment `), fingerprint);
      const pins = hostKeyPins({ fingerprints: [wrong, fingerprint], public_keys: [publicKey] });
      assert.deepEqual(pins, [wrong, fingerprint]);
      assert.equal(pinnedHostKey(pins, ['HOSTNAME', type!, encoded!]), `* ${type} ${encoded}\n`);
      for (const policy of ['ask', 'strict', 'accept-new', 'off'] as const) {
        assert.ok(sshArgs({ host: 'example.invalid', host_keys: { policy, public_keys: [publicKey] } }, '/tmp/trust').includes('StrictHostKeyChecking=yes'));
      }
      const raw = Buffer.from(encoded!, 'base64');
      const truncated = raw.subarray(0, raw.length - 1).toString('base64');
      const appended = Buffer.concat([raw, Buffer.from([0])]).toString('base64');
      const badLength = Buffer.from(raw); badLength.writeUInt32BE(0xffffffff, 0);
      for (const invalid of [readFileSync(file, 'utf8'), `${publicKey}\n`, `host ${publicKey}`, `${type}-cert-v01@openssh.com ${encoded}`, `${type} ${truncated}`, `${type} ${appended}`, `${type} ${badLength.toString('base64')}`, `ssh-unknown ${encoded}`, `${type} bad`]) {
        assert.equal(specSchema.safeParse({ host_keys: { public_keys: [invalid] } }).success, false, invalid.slice(0, 60));
      }
      const config = join(directory, 'config.yaml');
      writeFileSync(config, `version: 1\ndefaults:\n  host_keys:\n    fingerprints: ["${wrong}"]\n    public_keys: ["${publicKey}"]\nprofiles:\n  example:\n    host: example.invalid\n`);
      const catalog = loadCatalog(config);
      assert.deepEqual(hostKeyPins(resolveSpec(catalog, 'example', {}).host_keys), [wrong, fingerprint]);
      assert.deepEqual(hostKeyPins(resolveSpec(catalog, 'example', { host_keys: { fingerprints: [] } }).host_keys), [fingerprint]);
      assert.deepEqual(hostKeyPins(resolveSpec(catalog, 'example', { host_keys: { public_keys: [] } }).host_keys), [wrong]);
      const cleared = resolveSpec(catalog, 'example', { host_keys: { fingerprints: [], public_keys: [] } });
      assert.deepEqual(hostKeyPins(cleared.host_keys), []);
      assert.equal(sshArgs(cleared, '/tmp/trust').some(arg => arg.startsWith('KnownHostsCommand=')), false);
    }
  } finally { rmSync(directory, { recursive: true }); }
});
