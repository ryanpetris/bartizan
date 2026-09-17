import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IPty } from 'node-pty';
import type { Askpass } from '../src/main/askpass';
import { Sessions } from '../src/main/sessions';

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = mkdtempSync(join(tmpdir(), 'bartizan-resize-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sizes: number[][] = [];
  const sessions = new Sessions(directory, {} as Askpass, '', () => {}, () => {}, () => {});
  sessions.terminals.set('terminal', {
    info: { id: 'terminal', connectionId: 'connection', status: 'connected' }, cols: 80, rows: 24,
    process: { resize: (cols: number, rows: number) => sizes.push([cols, rows]), kill: () => {} } as unknown as IPty,
  });
  return { sessions, sizes };
}

test('repainting changes rows while preserving the requested final geometry', t => {
  const { sessions, sizes } = fixture(t);
  sessions.resize('terminal', 80, 24, true);
  assert.deepEqual(sizes, [[80, 23]]);
  assert.equal(sessions.terminals.get('terminal')!.rows, 24);
  t.mock.timers.tick(100);
  assert.deepEqual(sizes, [[80, 23], [80, 24]]);
});

test('resizes during repaint coalesce to the latest geometry', t => {
  const { sessions, sizes } = fixture(t);
  sessions.resize('terminal', 80, 24, true);
  sessions.resize('terminal', 100, 30);
  sessions.resize('terminal', 110, 35, true);
  t.mock.timers.tick(100);
  assert.deepEqual(sizes, [[80, 23], [110, 35]]);
});

test('closing a terminal cancels a pending repaint', t => {
  const { sessions, sizes } = fixture(t);
  sessions.resize('terminal', 80, 24, true);
  sessions.closeTerminal('terminal');
  t.mock.timers.tick(100);
  assert.deepEqual(sizes, [[80, 23]]);
});
