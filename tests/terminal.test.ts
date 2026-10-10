import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IPty } from 'node-pty';
import { connectionFixture } from './connection-fixture';
import { TerminalController, flowLimits } from '../src/main/terminal';
import { Sessions } from '../src/main/sessions';
import type { Askpass } from '../src/main/askpass';

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const directory = mkdtempSync(join(tmpdir(), 'bartizan-resize-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sizes: number[][] = [];
  const { connection } = connectionFixture(directory);
  const terminal = new TerminalController(connection, () => {});
  terminal.cols = 80; terminal.rows = 24;
  terminal.process = { resize: (cols: number, rows: number) => sizes.push([cols, rows]), kill: () => {} } as unknown as IPty;
  return { terminal, sizes };
}

test('repainting changes rows while preserving the requested final geometry', t => {
  const { terminal, sizes } = fixture(t);
  terminal.resize(80, 24, true);
  assert.deepEqual(sizes, [[80, 23]]);
  assert.equal(terminal.rows, 24);
  t.mock.timers.tick(100);
  assert.deepEqual(sizes, [[80, 23], [80, 24]]);
});

test('resizes during repaint coalesce to the latest geometry', t => {
  const { terminal, sizes } = fixture(t);
  terminal.resize(80, 24, true);
  terminal.resize(100, 30);
  terminal.resize(110, 35, true);
  t.mock.timers.tick(100);
  assert.deepEqual(sizes, [[80, 23], [110, 35]]);
});

test('closing a terminal cancels a pending repaint', t => {
  const { terminal, sizes } = fixture(t);
  terminal.resize(80, 24, true);
  terminal.close();
  t.mock.timers.tick(100);
  assert.deepEqual(sizes, [[80, 23]]);
});

test('only interrupted live terminals qualify for restoration', t => {
  const { terminal } = fixture(t);
  terminal.info.status = 'connecting';
  terminal.stop(true);
  assert.equal(terminal.reconnectOnConnect, false);
  terminal.info.status = 'connected';
  terminal.stop(true);
  assert.equal(terminal.reconnectOnConnect, true);
  terminal.stop(true);
  assert.equal(terminal.reconnectOnConnect, true);
  terminal.failure('Session is gone');
  terminal.stop(true);
  assert.equal(terminal.reconnectOnConnect, false);
  terminal.info.status = 'connected';
  terminal.stop(true);
  assert.equal(terminal.reconnectOnConnect, true);
});

test('reconnect errors append red terminal output without clearing history', () => {
  const { connection } = connectionFixture('');
  const chunks: string[] = [];
  const terminal = new TerminalController(connection, (_id, chunk) => chunks.push(chunk));
  terminal.reconnectOnConnect = true;
  terminal.failure('Session not found');
  assert.equal(terminal.info.status, 'closed');
  assert.equal(terminal.reconnectOnConnect, false);
  assert.match(chunks.join(''), /\x1b\[31mSession not found\x1b\[0m\r\n$/);
  assert.doesNotMatch(chunks.join(''), /\x1b\[(?:2|3)J|\x1bc/);
});

test('output pauses while every client is behind and resumes once one catches up', t => {
  const { terminal } = fixture(t);
  const { configuration } = connectionFixture('');
  const directory = mkdtempSync(join(tmpdir(), 'bartizan-flow-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sessions = new Sessions(directory, {} as Askpass, '', () => {}, () => {}, () => {}, configuration);
  sessions.terminals.set(terminal.info.id, terminal);
  const calls: string[] = [];
  Object.assign(terminal.process!, { pause: () => calls.push('pause'), resume: () => calls.push('resume') });
  const { id } = terminal.info, { pause, resume } = flowLimits;
  sessions.sent(id, pause * 4);
  assert.deepEqual(calls, [], 'Output with no client attached is not held back');
  sessions.attach('a'); sessions.attach('b');
  sessions.sent(id, pause);
  assert.deepEqual(calls, []);
  sessions.sent(id, 1);
  assert.deepEqual(calls, ['pause']);
  sessions.processed('b', id, pause - resume);
  assert.deepEqual(calls, ['pause'], 'A client above the resume level keeps the terminal paused');
  sessions.processed('b', id, 1);
  assert.deepEqual(calls, ['pause', 'resume'], 'The fastest client paces the terminal');
  sessions.sent(id, pause);
  assert.deepEqual(calls, ['pause', 'resume', 'pause']);
  sessions.detach('b');
  assert.deepEqual(calls, ['pause', 'resume', 'pause']);
  assert.equal(sessions.behind('a', pause * 2), true);
  assert.equal(sessions.behind('b', 0), false);
  sessions.processed('a', id, pause * 10);
  sessions.processed('missing', id, pause);
  assert.deepEqual(calls, ['pause', 'resume', 'pause', 'resume'], 'Acknowledgements beyond what was sent count as caught up');
  sessions.sent(id, pause + 1);
  assert.deepEqual(calls.at(-1), 'pause');
  sessions.attach('a');
  assert.deepEqual(calls.at(-1), 'resume', 'A client that attaches again starts from nothing unprocessed');
  sessions.sent(id, pause + 1);
  sessions.detach('a');
  assert.deepEqual(calls.slice(-2), ['pause', 'resume'], 'A terminal with no clients left runs freely');
});

test('a paused terminal reads on once its child has exited, keeping its last output', t => {
  const { terminal } = fixture(t);
  const calls: string[] = [];
  let exited = false;
  t.mock.method(process, 'kill', (pid: number, signal: number) => {
    assert.deepEqual([pid, signal], [4242, 0]);
    if (exited) throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    return true;
  });
  Object.assign(terminal.process!, { pid: 4242, pause: () => calls.push('pause'), resume: () => calls.push('resume') });
  terminal.unprocessed.set('a', flowLimits.pause + 1);
  terminal.pace();
  t.mock.timers.tick(200);
  assert.deepEqual(calls, ['pause']);
  exited = true;
  t.mock.timers.tick(50);
  assert.deepEqual(calls, ['pause', 'resume']);
  t.mock.timers.tick(200);
  assert.deepEqual(calls, ['pause', 'resume']);
});
