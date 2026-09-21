import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IPty } from 'node-pty';
import { connectionFixture } from './connection-fixture';
import { TerminalController } from '../src/main/terminal';

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
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
