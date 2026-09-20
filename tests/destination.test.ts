import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog, resolveSpec, specSchema } from '../src/core/config';
import { parseDestination } from '../src/shared';
import { sshArgs } from '../src/core/ssh';

test('destinations share hostname and IP validation with profiles and SSH arguments', () => {
  for (const host of ['localhost', 'dev_box', 'dev.example.internal', 'host.example.', '192.0.2.1', '::1', '2001:db8::1', '::ffff:192.0.2.1', 'fe80::1%eth0', 'fe80::1%1']) {
    assert.deepEqual(parseDestination(host), { host });
    assert.deepEqual(parseDestination(` user@${host} `), { host, username: 'user' });
    assert.equal(specSchema.parse({ host }).host, host);
  }
  for (const input of ['', ' ', '@host', 'user@', 'a@@host', '-host', '-user@host', 'a b', 'ssh://host', 'host/path', 'host?x', 'host#x', 'bad..host', 'bad.-host', 'host-.local', '[localhost]', '[192.0.2.1]', '[::1', '::1]', '[[::1]]', '999.1.1.1', '127.00.0.1', '1.2.3', '1:2:3', 'fe80::1%', 'fe80::1%bad%scope', 'fe80::1%bad/scope', '\nlocalhost', 'localhost\u0085', 'a'.repeat(64) + '.local']) {
    assert.equal(parseDestination(input), undefined, input);
  }
  assert.deepEqual(parseDestination('user@[fe80::1%eth0]'), { host: 'fe80::1%eth0', username: 'user' });
  const directory = mkdtempSync(join(tmpdir(), 'bartizan-destinations-'));
  try {
    const file = join(directory, 'profiles.yaml');
    writeFileSync(file, 'version: 1\nprofiles:\n  example:\n    host: "[::1]"\n');
    assert.equal(resolveSpec(loadCatalog(file), 'example', {}).host, '::1');
    const catalog = { defaults: {}, profiles: [], file: '', settings: { appearance: 'dark' as const, theme: 'rail' as const, interfaceFont: 'Inter', terminalLigatures: true, remoteSessionIntegration: true, terminalFont: '', terminalFontSize: 13 } };
    const spec = resolveSpec(catalog, undefined, parseDestination('user@[fe80::1%eth0]:222'));
    const args = sshArgs(spec, join(directory, 'trust'));
    assert.deepEqual(args.slice(-2), ['--', 'fe80::1%eth0']);
    assert.equal(args[args.indexOf('-l') + 1], 'user');
    const effective = execFileSync('ssh', ['-G', ...args], { encoding: 'utf8' });
    assert.match(effective, /^hostname fe80::1%eth0$/m);
    assert.match(effective, /^user user$/m);
    assert.match(effective, /^port 222$/m);
    assert.equal(resolveSpec({ ...catalog, defaults: { port: 2200 } }, undefined, parseDestination('::1')).port, 2200);
    assert.equal(resolveSpec({ ...catalog, defaults: { port: 2200 } }, undefined, parseDestination('[::1]:222')).port, 222);
    assert.equal(resolveSpec(catalog, undefined, { host: '[::1]' }).username, undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('destination ports require brackets for IPv6 and integers from 1 to 65535', () => {
  for (const [input, host] of [['192.0.2.1', '192.0.2.1'], ['example.com', 'example.com'], ['[2001:db8::1]', '2001:db8::1'], ['[fe80::1%eth0]', 'fe80::1%eth0']]) {
    for (const port of [1, 222, 65535]) {
      assert.deepEqual(parseDestination(`${input}:${port}`), { host, port });
      assert.deepEqual(parseDestination(` user@${input}:${port} `), { host, port, username: 'user' });
    }
  }
  assert.deepEqual(parseDestination('2001:db8::1:222'), { host: '2001:db8::1:222' });
  for (const suffix of ['', '0', '65536', '-1', '+22', '1.5', '1e2', 'abc', '22:33', ' 22']) {
    for (const host of ['example.com', '192.0.2.1', '[::1]']) {
      assert.equal(parseDestination(`${host}:${suffix}`), undefined, `${host}:${suffix}`);
    }
  }
  for (const input of ['[localhost]:22', '[192.0.2.1]:22', '[::1:22', '::1]:22']) {
    assert.equal(parseDestination(input), undefined, input);
  }
});
