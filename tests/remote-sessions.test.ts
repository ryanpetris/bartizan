import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachCommand, killCommand, parseDiscovery, quoteShell, channelArgs, sessionError, loginCommand } from '../src/main/remote-sessions';

// The program is run by an absolute path so the fake backends can be the whole of the PATH it searches.
const python = execFileSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim();
const session = (fields: Record<string, unknown>) => ({ backend: 'tmux', id: '$1', name: 'work', clients: 0, ...fields });
const listing = (sessions: unknown[], errors: Record<string, string> = {}) => JSON.stringify({ sessions, errors });

test('a listing keeps the detail each backend reports', () => {
  const { sessions, failures } = parseDiscovery(listing([
    session({ id: '$1', name: 'build', windows: 3, activity: 1700000000, where: '~/src' }),
    session({ backend: 'screen', id: '123.work', name: 'work', clients: 1, doing: 'vim' }),
    session({ backend: 'herdr', id: 'agents', name: 'agents', windows: 4, where: 'bartizan', doing: 'working' }),
  ]));
  assert.deepEqual(sessions.map(s => s.key), ['tmux:$1', 'screen:123.work', 'herdr:agents']);
  assert.deepEqual(sessions[0], { key: 'tmux:$1', backend: 'tmux', id: '$1', name: 'build', clients: 0, windows: 3, activity: 1700000000, where: '~/src', doing: undefined });
  assert.equal(sessions[1].doing, 'vim');
  assert.equal(sessions[2].windows, 4);
  assert.deepEqual(failures, {});
});

test('a host cannot describe itself into something unusable', () => {
  const { sessions } = parseDiscovery(listing([
    session({ id: '-oProxyCommand=evil' }),
    session({ id: 'has\u0000null' }),
    session({ backend: 'fish', id: '$9' }),
    session({ id: '' }),
    session({ id: '$2', name: 'two\u001bpart', where: 'a\u0007b' }),
    session({ id: '$3', clients: -1, windows: 'many' }),
    'not an object',
  ]));
  assert.deepEqual(sessions.map(s => s.id), ['$2', '$3']);
  assert.equal(sessions[0].name, 'two part', 'control characters leave the name printable');
  assert.equal(sessions[0].where, 'a b');
  // Herdr names its sessions by their identifier, which commands quote rather than print, so cleaning
  // the name for display must not take the session away with it.
  const named = parseDiscovery(listing([session({ backend: 'herdr', id: 'work\u202eside', name: 'work\u202eside' })]));
  assert.equal(named.sessions.length, 1, 'a name that needs cleaning still leaves a session');
  assert.equal(named.sessions[0].id, 'work\u202eside', 'commands use the identifier the host gave');
  assert.equal(named.sessions[0].name, 'work side');
  assert.deepEqual(parseDiscovery(listing([session({ id: 'a\u0001b' })])).sessions, [], 'a terminal control character still bars one');
  assert.equal(sessions[1].clients, 0, 'a negative client count is not a count');
  assert.equal(sessions[1].windows, undefined);

  // An identifier is a command argument: shortening one would name a different session.
  const long = 'x'.repeat(4097);
  assert.deepEqual(parseDiscovery(listing([session({ id: long }), session({ id: long + 'y' })])).sessions, []);
  assert.equal(parseDiscovery(listing([session({ id: 'x'.repeat(4096) })])).sessions.length, 1, 'the limit itself is allowed');
  // A host cannot fill the interface with as many rows as it likes.
  const many = parseDiscovery(listing(Array.from({ length: 300 }, (_, i) => session({ id: `$${i}` }))));
  assert.equal(many.sessions.length, 100);
  assert.equal(many.sessions.at(-1)!.id, '$99', 'the first sessions listed are the ones kept');
});

test('the identifier check does not carry state between entries', () => {
  const { sessions } = parseDiscovery(listing([session({ id: 'a\u0001b' }), session({ id: 'c\u0001d' }), session({ id: 'e\u0001f' })]));
  assert.deepEqual(sessions, [], 'every control-character identifier is rejected, not every other one');
});

test('a failing backend is named as it is written, and reported apart from the others', () => {
  const { sessions, failures } = parseDiscovery(listing([session({ backend: 'herdr', id: 'kept', name: 'kept' })], { tmux: 'no server', herdr: '  bad socket  ', screen: '   ' }));
  assert.deepEqual(sessions.map(s => s.id), ['kept']);
  assert.deepEqual(failures, { tmux: 'no server', herdr: 'bad socket' });
  assert.throws(() => parseDiscovery('{"sessions":"none"}'), /Invalid session listing/);
  assert.throws(() => parseDiscovery('null'), /Invalid session listing/);
});

test('remote names are shell arguments, and only explicit takeover detaches clients', () => {
  const tmux = { key: 'tmux:$1', backend: 'tmux' as const, id: "$1'; rm -rf /", name: 'x', clients: 0 };
  assert.ok(attachCommand(tmux, true).includes(quoteShell(tmux.id)));
  assert.ok(attachCommand(tmux, false).includes('session_attached'), 'a busy session is refused rather than stolen');
  assert.ok(!attachCommand(tmux, false).includes('attach-session -d'));
  assert.ok(killCommand(tmux).includes(quoteShell(tmux.id)));
  assert.equal(killCommand({ ...tmux, backend: 'screen', id: 'w' }), "screen -S 'w' -X quit");
  assert.equal(killCommand({ ...tmux, backend: 'herdr', id: 'w' }), "herdr session stop 'w'");
  assert.ok(channelArgs('/socket', { host: 'host' }).includes('ProxyCommand=/bin/false'));
});

test('login commands preserve literal arguments and error feedback stays bounded', () => {
  const name = "session'; printf injected; # $(false)";
  assert.equal(execFileSync('sh', ['-c', loginCommand(`printf %s ${quoteShell(name)}`)], { encoding: 'utf8', env: { ...process.env, SHELL: '/bin/sh' }, stdio: ['ignore', 'pipe', 'ignore'] }), name);
  assert.equal(sessionError('banner\nmore banner\n\x1b[31mfailed\x1b[0m\r\n'), 'banner\nmore banner\nfailed');
  assert.equal(sessionError('x'.repeat(5000)).length, 1024);
});

test('the discovery program reports every backend from one run', () => {
  const bin = mkdtempSync(join(tmpdir(), 'bartizan-discovery-'));
  const fake = (name: string, body: string) => { const file = join(bin, name); writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o700); };
  // tmux escapes its free fields for a shell, so a name holding a pipe, a space or a quote survives intact.
  fake('tmux', String.raw`if [ "$1" = -V ]; then printf 'tmux 3.4\n'; exit 0; fi
printf '%s\n' '$0 0 3 1700000000 /home/someone/src a\|b\ \"q\"\ \$x' '$1 2 1 1700000009 /tmp busy'`);
  fake('screen', 'if [ "$1" = -ls ]; then printf "\\t123.work\\t(Detached)\\n"; exit 1; fi\nprintf "0 (vim)"');
  fake('herdr', 'if [ "$2" = list ]; then printf \'{"sessions":[{"name":"agents","running":true},{"name":"dead","running":false}]}\\n\'; else printf \'{"result":{"workspaces":[{"label":"bartizan","tab_count":3,"agent_status":"working"}]}}\\n\'; fi');
  const out = execFileSync(python, ['src/main/remote-discovery.py'], { encoding: 'utf8', env: { ...process.env, PATH: bin, HOME: '/home/someone' } });
  const { sessions, failures } = parseDiscovery(out);
  assert.deepEqual(failures, {}, 'screen exiting 1 with a listing is not a failure');
  assert.deepEqual(sessions.map(s => s.key), ['tmux:$0', 'tmux:$1', 'screen:123.work', 'herdr:agents']);
  assert.equal(sessions[0].name, 'a|b "q" $x');
  assert.deepEqual([sessions[0].windows, sessions[0].where, sessions[0].activity], [3, '~/src', 1700000000]);
  assert.equal(sessions[1].clients, 2);
  assert.deepEqual([sessions[2].name, sessions[2].doing, sessions[2].clients], ['work', 'vim', 0]);
  assert.deepEqual([sessions[3].windows, sessions[3].where, sessions[3].doing], [3, 'bartizan', 'working'], 'a Herdr session carries its workspace detail');
});

test('the discovery program isolates a backend that fails', () => {
  const bin = mkdtempSync(join(tmpdir(), 'bartizan-discovery-'));
  const fake = (name: string, body: string) => { const file = join(bin, name); writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o700); };
  fake('tmux', 'echo "no server running on /tmp/x" >&2; exit 1');
  fake('herdr', 'if [ "$2" = list ]; then echo "socket is gone" >&2; exit 3; fi');
  const { sessions, failures } = parseDiscovery(execFileSync(python, ['src/main/remote-discovery.py'], { encoding: 'utf8', env: { ...process.env, PATH: bin } }));
  assert.deepEqual(sessions, [], 'a backend that is absent contributes nothing at all');
  assert.equal(failures.tmux, undefined, 'a tmux server that is not running is an empty list, not a fault');
  assert.equal(failures.herdr, 'socket is gone');
});

test('a tmux that cannot quote its own output is named rather than misread', () => {
  const bin = mkdtempSync(join(tmpdir(), 'bartizan-discovery-'));
  const fake = (name: string, body: string) => { const file = join(bin, name); writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o700); };
  // The q modifier arrived in 2.9; before it, session names could only be guessed at.
  fake('tmux', String.raw`if [ "$1" = -V ]; then printf 'tmux 2.7\n'; exit 0; fi
printf 'whatever this old version would say\n'`);
  const { sessions, failures } = parseDiscovery(execFileSync(python, ['src/main/remote-discovery.py'], { encoding: 'utf8', env: { ...process.env, PATH: bin } }));
  assert.deepEqual(sessions, [], 'nothing is read from a version that cannot be read correctly');
  assert.match(failures.tmux!, /^Version 2\.7 is not supported; 2\.9 or later is required$/);
  fake('tmux', String.raw`if [ "$1" = -V ]; then printf 'tmux next-3.8\n'; exit 0; fi
printf '$0 0 1 1700000000 /tmp ok\n'`);
  const later = parseDiscovery(execFileSync(python, ['src/main/remote-discovery.py'], { encoding: 'utf8', env: { ...process.env, PATH: bin } }));
  assert.deepEqual(later.failures, {}, 'a development version reads as its own numbers');
  assert.deepEqual(later.sessions.map(session => session.name), ['ok']);

  // A version only bars tmux when it is read and is too old. A version that cannot be read is no answer,
  // so the listing is asked for and tmux speaks for itself.
  const run = () => parseDiscovery(execFileSync(python, ['src/main/remote-discovery.py'], { encoding: 'utf8', env: { ...process.env, PATH: bin } }));
  fake('tmux', String.raw`if [ "$1" = -V ]; then printf 'tmux master\n'; exit 0; fi
printf '$0 0 1 1700000000 /tmp unnumbered\n'`);
  assert.deepEqual(run().sessions.map(session => session.name), ['unnumbered'], 'a version without numbers is not a refusal');
  fake('tmux', String.raw`if [ "$1" = -V ]; then echo 'no version here' >&2; exit 2; fi
printf '$0 0 1 1700000000 /tmp silent\n'`);
  assert.deepEqual(run().sessions.map(session => session.name), ['silent'], 'a version that cannot be asked for is not a refusal');
  fake('tmux', String.raw`if [ "$1" = -V ]; then exit 2; fi
echo 'lost connection to server' >&2; exit 1`);
  assert.equal(run().failures.tmux, 'lost connection to server', 'tmux speaks for itself when the listing fails');
});

test('names survive the C locale the caller sets, and a host cannot list one session twice', () => {
  const bin = mkdtempSync(join(tmpdir(), 'bartizan-discovery-'));
  const fake = (name: string, body: string) => { const file = join(bin, name); writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o700); };
  fake('tmux', String.raw`if [ "$1" = -V ]; then printf 'tmux 3.4\n'; exit 0; fi
printf '$0 0 1 1700000000 /srv café-serveur\n'`);
  // Python would otherwise decode by the locale, which under LC_ALL=C without coercion is ASCII.
  const strict = { ...process.env, PATH: bin, LC_ALL: 'C', PYTHONCOERCECLOCALE: '0', PYTHONUTF8: '0' };
  const { sessions } = parseDiscovery(execFileSync(python, ['src/main/remote-discovery.py'], { encoding: 'utf8', env: strict }));
  assert.deepEqual(sessions.map(session => session.name), ['café-serveur'], 'a name is not replaced byte by byte');

  const twice = parseDiscovery(listing([session({ id: '$1', name: 'first' }), session({ id: '$1', name: 'second' })]));
  assert.deepEqual(twice.sessions.map(s => s.name), ['first'], 'a repeated identifier is one session');
});

test('text that could rewrite the line it is shown on does not reach the interface', () => {
  const { sessions, failures } = parseDiscovery(listing(
    [session({ id: '$1', name: 'safe\u202ekill me\u2028now', where: 'a\u0085b' })],
    { tmux: 'first line\nsecond line\u0007 here' }));
  assert.equal(sessions[0].name, 'safe kill me now', 'overrides and separators become spaces');
  assert.equal(sessions[0].where, 'a b');
  // Herdr names its sessions by their identifier, which commands quote rather than print, so cleaning
  // the name for display must not take the session away with it.
  const named = parseDiscovery(listing([session({ backend: 'herdr', id: 'work\u202eside', name: 'work\u202eside' })]));
  assert.equal(named.sessions.length, 1, 'a name that needs cleaning still leaves a session');
  assert.equal(named.sessions[0].id, 'work\u202eside', 'commands use the identifier the host gave');
  assert.equal(named.sessions[0].name, 'work side');
  assert.deepEqual(parseDiscovery(listing([session({ id: 'a\u0001b' })])).sessions, [], 'a terminal control character still bars one');
  assert.equal(failures.tmux, 'first line\nsecond line  here', 'a failure keeps the lines it was written with');
});
