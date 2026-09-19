import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { configurationFile, ensureConfiguration, builtins, loadCatalog, merge, resolveSpec, specSchema, redactSpec, readSecret, secretSchema } from '../src/core/config';
import { sshArgs, preflight } from '../src/core/ssh';

test('defaults, profile overrides and cleared lists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bartizan-test-'));
  try {
    const a = join(dir, 'a.yaml');
    writeFileSync(a, 'version: 1\ndefaults:\n  port: 2222\n  auth:\n    identity_files: [key]\nprofiles:\n  test:\n    host: example.invalid\n    username: test\n    port: 22\n');
    const c = loadCatalog(a);
    assert.equal(c.defaults.port, 2222);
    assert.equal(c.defaults.auth?.identity_files?.[0], join(dir, 'key'));
    const s = resolveSpec(c, 'test', { auth: { identity_files: [] } });
    assert.equal(s.port, 22);
    assert.deepEqual(s.auth?.identity_files, []);
  } finally { rmSync(dir, { recursive: true }); }
});
test('profile tags normalize and stay outside connection settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bartizan-test-'));
  try {
    const a = join(dir, 'a.yaml');
    writeFileSync(a, 'version: 1\nprofiles:\n  tagged:\n    host: example.invalid\n    username: test\n    tags: [" Backend ", backend, Team Blue, <b>literal</b>]\n  plain: {}\n  empty:\n    tags: []\n');
    const catalog = loadCatalog(a);
    assert.deepEqual(catalog.profiles.map(p => p.tags), [['Backend', 'Team Blue', '<b>literal</b>'], [], []]);
    assert.equal(Object.hasOwn(catalog.profiles[0].spec, 'tags'), false);
    const resolved = resolveSpec(catalog, 'tagged', {});
    assert.equal(Object.hasOwn(resolved, 'tags'), false);
    assert.deepEqual(sshArgs(resolved, '/tmp/known_hosts'), sshArgs(resolveSpec({ ...catalog, profiles: catalog.profiles.map(p => ({ ...p, tags: [] })) }, 'tagged', {}), '/tmp/known_hosts'));
    assert.throws(() => resolveSpec(catalog, 'tagged', { tags: ['override'] }));
    for (const tags of [[''], ['  '], ['bad\tlabel'], ['bad\nlabel'], ['bad\u0085label'], ['bad\u009blabel'], [42], 'backend']) {
      writeFileSync(a, `version: 1\nprofiles:\n  invalid:\n    tags: ${JSON.stringify(tags)}`);
      assert.throws(() => loadCatalog(a), /tags/);
    }
    writeFileSync(a, 'version: 1\ndefaults:\n  tags: [global]');
    assert.throws(() => loadCatalog(a), /defaults/);
  } finally { rmSync(dir, { recursive: true }); }
});
test('reject unknown fields, injected hosts and reserved options', () => {
  for (const input of [{ host: '-oProxyCommand=bad' }, { host: 'a\nb' }, { ssh: { ProxyCommand: 'bad' } }, { ssh: { UserKnownHostsFile: 'bad' } }]) assert.equal(specSchema.safeParse(input).success, false);
});
test('secret variants replace each other and literal secrets never enter previews', () => {
  const s = merge({ auth: { password: { source: 'literal', value: 'secret' } } }, { auth: { password: { source: 'prompt' } } } as any);
  assert.deepEqual(s.auth.password, { source: 'prompt' });
  assert.doesNotMatch(JSON.stringify(redactSpec({ auth: { password: { source: 'literal', value: 'secret' } } })), /secret/);
});
test('SSH preflight respects isolation, authentication and algorithm selection', () => {
  const spec = merge(builtins, { host: 'example.invalid', username: 'test', auth: { method: 'password' as const }, ssh: { Ciphers: 'aes128-ctr' } });
  const args = sshArgs(spec, '/tmp/bartizan test/known_hosts', 12345);
  assert.ok(args.includes('PasswordAuthentication=yes'));
  assert.ok(args.includes('PubkeyAuthentication=no'));
  assert.ok(args.includes('IdentityAgent=none'));
  assert.ok(args.includes('GlobalKnownHostsFile=none'));
  assert.ok(args.includes('Ciphers=aes128-ctr'));
  assert.deepEqual(args.slice(0, 2), ['-F', 'none']);
  preflight(spec, '/tmp/bartizan test/known_hosts');
});

test('malformed YAML never returns a literal credential in diagnostics', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bartizan-test-'));
  try {
    const file = join(dir, 'invalid.yaml');
    writeFileSync(file, 'version: 1\ndefaults:\n  auth:\n    password: {source: literal, value: "super-secret" trailing}\n');
    assert.throws(() => loadCatalog(file), error => error instanceof Error && !error.message.includes('super-secret') && /:4:/.test(error.message));
  } finally { rmSync(dir, { recursive: true }); }
});
test('agent paths with spaces and missing selected identities remain explicit', async () => {
  const { execFileSync } = await import('node:child_process');
  for (const method of ['agent', 'auto'] as const) preflight(merge(builtins, { host: 'example.invalid', username: 'test', auth: { method, agent: '/tmp/agent socket' } }), '/tmp/known_hosts');
  const s = merge(builtins, { host: 'example.invalid', username: 'test', auth: { method: 'key' as const, identity_files: ['/nonexistent/bartizan-key'] } });
  const output = execFileSync('ssh', ['-G', ...sshArgs(s, '/tmp/known_hosts')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.doesNotMatch(output, /identityfile ~\//);
});

test('algorithm lists use OpenSSH syntax and an empty list keeps OpenSSH defaults', () => {
  for (const value of ['', 'aes128-ctr', 'aes128-ctr,chacha20-poly1305@openssh.com', '+ssh-rsa', '^aes256-gcm@openssh.com', '-*-cbc']) assert.equal(specSchema.safeParse({ ssh: { Ciphers: value } }).success, true, value);
  for (const value of [['aes128-ctr'], 'a b', 'a,,b', ',a', '+', '++a', 'a;b', 'a\nb', 'a,+b']) assert.equal(specSchema.safeParse({ ssh: { Ciphers: value } }).success, false, String(value));
  const args = (Ciphers: string) => sshArgs(merge(builtins, { host: 'example.invalid', ssh: { Ciphers } }), '/tmp/trust');
  assert.ok(args('-*-cbc').includes('Ciphers=-*-cbc'));
  assert.ok(!args('').some(arg => arg.startsWith('Ciphers=')));
  preflight(merge(builtins, { host: 'example.invalid', ssh: { Ciphers: '-*-cbc' } }), '/tmp/trust');
});
test('automatic identity policy constrains selected files and permits agent-only authentication', () => {
  const catalog = { defaults: {}, profiles: [], file: '', settings: { appearance: 'dark' as const, theme: 'rail' as const, interfaceFont: 'Inter', terminalLigatures: true, terminalFont: '', terminalFontSize: 13 } };
  const auto = resolveSpec(catalog, undefined, { host: 'example.invalid', username: 'test' });
  assert.ok(sshArgs(auto, '/tmp/trust').includes('IdentitiesOnly=no'));
  auto.auth!.identity_files = ['/tmp/selected-key'];
  assert.ok(sshArgs(auto, '/tmp/trust').includes('IdentitiesOnly=yes'));
});
test('reserved profile IDs are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bartizan-test-'));
  try {
    const a = join(dir, 'a.yaml');
    writeFileSync(a, 'version: 1\nprofiles:\n  __proto__:\n    host: example.invalid\n');
    assert.throws(() => loadCatalog(a), /Invalid profile ID/);
  } finally { rmSync(dir, { recursive: true }); }
});
test('literal path tokens cannot redirect trust storage', async () => {
  const { execFileSync } = await import('node:child_process');
  const s = merge(builtins, { host: 'example.invalid', username: 'test' });
  const output = execFileSync('ssh', ['-G', ...sshArgs(s, '/tmp/100%trust/known_hosts')], { encoding: 'utf8' });
  assert.match(output, /userknownhostsfile \/tmp\/100%trust\/known_hosts/);
  assert.throws(() => sshArgs(s, '/tmp/${HOME}/known_hosts'));
  assert.equal(specSchema.safeParse({ auth: { agent: '$SSH_AUTH_SOCK' } }).success, false);
});

test('literal credentials allow tab and DEL while remaining single-line', () => {
  assert.equal(specSchema.safeParse({ auth: { password: { source: 'literal', value: 'pa\tss\x7f' } } }).success, true);
  assert.equal(specSchema.safeParse({ auth: { password: { source: 'literal', value: 'pa\nss' } } }).success, false);
});

test('all credential sources enforce the OpenSSH UTF-8 response limit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bartizan-credential-'));
  try {
    for (const value of ['a'.repeat(1023), 'λ'.repeat(511) + 'a', '😀'.repeat(255) + 'abc']) {
      assert.equal(Buffer.byteLength(value), 1023);
      for (const [candidate, accepted] of [[value, true], [value + 'a', false]] as const) {
        const literal = { source: 'literal' as const, value: candidate };
        const path = join(dir, 'credential'); writeFileSync(path, candidate + '\n', { mode: 0o600 });
        if (accepted) assert.deepEqual(secretSchema.parse(literal), literal);
        else assert.throws(() => secretSchema.parse(literal), /1023 UTF-8 bytes/);
        for (const secret of [literal, { source: 'file' as const, path }]) {
          if (accepted) assert.equal(readSecret(secret), candidate);
          else assert.throws(() => readSecret(secret), /1023 UTF-8 bytes/);
        }
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('public credential sources retain their identity without literal values', () => {
  const original = { auth: { password: { source: 'literal' as const, value: 'secret' }, passphrase: { source: 'file' as const, path: '/tmp/passphrase' } } };
  const publicSpec = redactSpec(original);
  assert.deepEqual(publicSpec.auth?.password, { source: 'literal' });
  assert.deepEqual(publicSpec.auth?.passphrase, original.auth.passphrase);
  assert.equal(original.auth.password.value, 'secret');
  assert.throws(() => specSchema.parse(publicSpec));
});


test('automatic authentication tries configured passwords before keyboard-interactive prompts', () => {
  for (const source of [{ source: 'literal', value: 'value' }, { source: 'file', path: 'credential' }] as const) {
    const spec = merge(builtins, { host: 'example.invalid', username: 'test', auth: { password: source } });
    assert.ok(sshArgs(spec, '/tmp/trust').includes('PreferredAuthentications=publickey,password,keyboard-interactive'));
  }
  assert.ok(sshArgs(builtins, '/tmp/trust').includes('PreferredAuthentications=publickey,keyboard-interactive,password'));
});
test('disabled host verification cannot read or populate shared trust', () => {
  const args = sshArgs(merge(builtins, { host_keys: { policy: 'off' as const } }), '/tmp/trust');
  assert.ok(args.includes('UserKnownHostsFile="/dev/null"'));
  assert.ok(args.includes('GlobalKnownHostsFile=none'));
  assert.ok(!args.join(' ').includes('/tmp/trust'));
});


test('credential files reject malformed UTF-8 and preserve valid content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bartizan-utf8-'));
  const path = join(dir, 'credential');
  try {
    writeFileSync(path, Buffer.from([0x70, 0xe4, 0x73, 0x73]));
    assert.throws(() => readSecret({ source: 'file', path }), { code: 'ERR_ENCODING_INVALID_ENCODED_DATA' });
    writeFileSync(path, '\ufeffλ secret\r\n');
    assert.equal(readSecret({ source: 'file', path }), '\ufeffλ secret');
  } finally { rmSync(dir, { recursive: true }); }
});


test('credential file reads reject special files and bound oversized input', { timeout: 5000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'bartizan-file-bounds-'));
  const path = join(dir, 'credential');
  try {
    execFileSync('mkfifo', [path]);
    assert.throws(() => readSecret({ source: 'file', path }), /regular file/);
    assert.throws(() => readSecret({ source: 'file', path: '/dev/zero' }), /regular file/);
    assert.throws(() => readSecret({ source: 'file', path: dir }), /regular file/);
    rmSync(path);
    assert.throws(() => readSecret({ source: 'file', path }), /^Error: Credential file could not be read$/);
    writeFileSync(path, 'x'.repeat(1_000_000));
    assert.throws(() => readSecret({ source: 'file', path }), /1023 UTF-8 bytes/);
    writeFileSync(path, 'x'.repeat(1023) + '\r\n');
    assert.equal(readSecret({ source: 'file', path }), 'x'.repeat(1023));
  } finally { rmSync(dir, { recursive: true }); }
});


test('configuration arguments select one path relative to the launching directory', () => {
  const cwd = join(tmpdir(), 'config-arguments'), fallback = join(cwd, 'config.yaml');
  assert.equal(configurationFile(['--config', 'custom.yml'], cwd, fallback), join(cwd, 'custom.yml'));
  assert.equal(configurationFile([], cwd, fallback), fallback);
  assert.equal(configurationFile(['.', '--use-gl=angle', '--config=~/settings.yaml'], cwd, fallback), join(homedir(), 'settings.yaml'));
  assert.throws(() => configurationFile(['--config=a.yaml', '--config=b.yaml'], cwd, fallback), /only be specified once/);
  for (const args of [['--config'], ['--config='], ['--config', '--other']]) assert.throws(() => configurationFile(args, cwd, fallback), /requires a file path/);
});

test('startup creates a private empty configuration and preserves existing content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bartizan-config-'));
  try {
    const file = join(dir, 'nested', 'config.yaml');
    ensureConfiguration(file);
    assert.deepEqual(loadCatalog(file).profiles, []);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    writeFileSync(file, 'invalid input');
    ensureConfiguration(file);
    assert.equal(readFileSync(file, 'utf8'), 'invalid input');
    assert.throws(() => loadCatalog(file));
    const parent = join(dir, 'not-a-directory');
    writeFileSync(parent, 'preserved');
    assert.throws(() => ensureConfiguration(join(parent, 'config.yaml')));
    assert.equal(readFileSync(parent, 'utf8'), 'preserved');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('configuration reads reject special files and malformed UTF-8', { timeout: 5000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'bartizan-config-bounds-'));
  const path = join(dir, 'settings.yaml');
  try {
    execFileSync('mkfifo', [path]);
    assert.throws(() => loadCatalog(path), /regular file/);
    assert.throws(() => loadCatalog('/dev/zero'), /regular file/);
    rmSync(path);
    writeFileSync(path, Buffer.from([0xe4]));
    assert.throws(() => loadCatalog(path), /not valid UTF-8/);
  } finally { rmSync(dir, { recursive: true }); }
});
