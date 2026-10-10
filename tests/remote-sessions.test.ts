import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quoteShell, channelArgs, sessionError, loginCommand } from '../src/main/remote-sessions';
import { parseHelperMessage } from '../src/main/remote-helper';
import { HelperMessages, type HelperMessage, type RemoteSession } from '../src/helper-messages';
import { connectionFixture } from './connection-fixture';
import type { RemoteHelper } from '../src/main/remote-helper';

const session = (key: string, source = 'one'): RemoteSession => ({ source, key, label: 'build', group: 'tmux', detail: '2 windows', attached: false, commands: { resume: "exec tmux -S '/socket' attach-session -t '$0'" } });
const snapshot = (sources: string[], sessions: RemoteSession[], errors: { source?: string; message: string }[] = []): HelperMessage => ({ type: 'sessions.snapshot', sources, sessions, errors });

test('helper messages validate reconciliation boundaries and preserve literal commands', () => {
  const value = session('a');
  value.label = 'work\u001b\u202eend';
  value.commands.resume = "printf '%s' '雪\nquoted'";
  const parsed = parseHelperMessage(JSON.stringify(snapshot(['one'], [value])));
  assert.equal(parsed.type, 'sessions.snapshot');
  if (parsed.type !== 'sessions.snapshot') return;
  assert.equal(parsed.sessions[0].label, 'work  end');
  assert.equal(parsed.sessions[0].commands.resume, value.commands.resume);
  for (const invalid of [snapshot([], [value]), snapshot(['one'], [value, value]), { type: 'sessions.upsert', source: 'other', session: value }, snapshot(['one'], [{ ...value, commands: { resume: 'null\0byte' } }])]) {
    assert.throws(() => parseHelperMessage(JSON.stringify(invalid)));
  }
  assert.throws(() => parseHelperMessage(JSON.stringify(snapshot(['one'], Array.from({ length: 101 }, (_, i) => session(String(i)))))));
});

test('subscribers independently receive messages and unsubscribe without consuming them', async () => {
  const failures: unknown[] = [], sent: unknown[] = [];
  const bus = new HelperMessages(async (...args) => { sent.push(args); }, error => failures.push(error));
  bus.on('sessions.snapshot', ({ message }) => { message.sessions.length = 0; throw new Error('subscriber failed'); });
  const received: number[] = [];
  const off = bus.on('sessions.snapshot', ({ message }) => received.push(message.sessions.length));
  const original = snapshot(['one'], [session('a')]);
  bus.publish('connection', original);
  assert.deepEqual(received, [1]);
  assert.equal(failures.length, 1);
  off(); bus.publish('connection', original);
  assert.deepEqual(received, [1]);
  await bus.send('connection', { type: 'sessions.refresh' });
  assert.deepEqual(sent, [['connection', { type: 'sessions.refresh' }]]);
});

test('snapshots remove only confirmed sources and keep errors separate from incoming records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bartizan-helper-'));
  try {
    const { connection: entry } = connectionFixture(directory);
    entry.info.remoteSessions = { sessions: [session('a'), { ...session('b', 'two'), error: 'attach failed' }], loading: true, errors: [] };
    for (const session of entry.info.remoteSessions!.sessions) entry.remoteSessions.set(session.key, session);
    entry.receiveHelperMessage(snapshot(['one'], [], [{ source: 'two', message: 'timeout' }]));
    assert.deepEqual(entry.info.remoteSessions!.sessions.map(s => s.key), ['b']);
    const incoming = session('b', 'two');
    entry.receiveHelperMessage({ type: 'sessions.upsert', source: 'two', session: incoming });
    assert.equal(entry.info.remoteSessions!.sessions[0].error, 'attach failed');
    assert.equal(incoming.error, undefined);
    entry.receiveHelperMessage(snapshot([], [], [{ message: 'Directory unavailable' }]));
    assert.equal(entry.info.remoteSessions!.sessions.length, 1);
    // A restarted helper has no memory of vanished sockets; its inventory still reconciles them.
    entry.receiveHelperMessage(snapshot([], []));
    assert.deepEqual(entry.info.remoteSessions!.sessions, []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('login commands preserve literal arguments and channels require the existing SSH master', () => {
  const name = "session'; printf injected; # $(false)";
  assert.equal(execFileSync('sh', ['-c', loginCommand(`printf %s ${quoteShell(name)}`)], { encoding: 'utf8', env: { ...process.env, SHELL: '/bin/sh' }, stdio: ['ignore', 'pipe', 'ignore'] }), name);
  assert.ok(channelArgs('/socket', { host: 'host' }).includes('ProxyCommand=/bin/false'));
  assert.equal(sessionError('banner\nmore banner\n\x1b[31mfailed\x1b[0m\r\n'), 'banner\nmore banner\nfailed');
  assert.equal(sessionError('x'.repeat(5000)).length, 1024);
});

test('fresh records take priority over retained failures at the session limit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bartizan-helper-'));
  try {
    const { connection: entry } = connectionFixture(directory);
    entry.info.remoteSessions = { sessions: Array.from({ length: 100 }, (_, i) => session(String(i), 'failed')), loading: false, errors: [] };
    for (const session of entry.info.remoteSessions!.sessions) entry.remoteSessions.set(session.key, session);
    entry.receiveHelperMessage(snapshot(['fresh'], [session('new', 'fresh')], [{ source: 'failed', message: 'timeout' }]));
    assert.equal(entry.info.remoteSessions!.sessions.length, 100);
    assert.ok(entry.info.remoteSessions!.sessions.some(s => s.key === 'new'));
    entry.receiveHelperMessage({ type: 'sessions.upsert', source: 'fresh', session: session('newer', 'fresh') });
    assert.ok(entry.info.remoteSessions!.sessions.some(s => s.key === 'newer'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('shutdown stops helpers even without a state-change callback or a running SSH master', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bartizan-helper-'));
  try {
    const { connection: entry } = connectionFixture(directory);
    let stopped = 0;
    entry.helper = { stop: () => { stopped++; } } as unknown as RemoteHelper;
    await entry.dispose();
    assert.equal(stopped, 1);
    assert.equal(entry.helper, undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
