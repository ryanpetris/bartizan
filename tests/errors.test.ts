import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Errors } from '../src/main/errors';

test('current errors survive history clearing and resolve on recovery', async () => {
  let time = 10, updates = 0;
  const errors = new Errors(() => updates++, () => time);
  errors.sync('bad config');
  await new Promise<void>(resolve => setImmediate(resolve));
  const before = errors.snapshot();
  assert.deepEqual(before.current.map(e => e.message), ['bad config']);
  errors.sync('bad config');
  assert.equal(updates, 1);
  errors.clear();
  assert.equal(errors.snapshot().history.length, 0);
  assert.equal(errors.snapshot().current.length, 1);
  time++;
  errors.sync(undefined);
  assert.equal(errors.snapshot().current.length, 0);
  assert.equal(before.current[0].resolvedAt, undefined, 'snapshots cannot change underneath consumers');
});

test('each condition episode has its own times and ID; events merge only when consecutive and scoped alike', () => {
  let time = 0;
  const errors = new Errors(() => {}, () => ++time);
  errors.sync('bad config');
  const first = errors.snapshot().current[0].id;
  errors.sync(undefined);
  errors.sync('bad config');
  assert.notEqual(errors.snapshot().current[0].id, first);
  assert.ok(errors.snapshot().history[0].resolvedAt);
  errors.sync('different config error');
  assert.equal(errors.snapshot().history.length, 3);
  assert.ok(errors.snapshot().history[1].resolvedAt);
  const event = { source: 'clipboard', message: 'copy failed', connectionId: 'a', label: 'Alpha' };
  errors.report(event);
  errors.report(event);
  assert.equal(errors.snapshot().history.at(-1)?.count, 2);
  assert.ok(errors.snapshot().history.at(-1)!.lastTime > errors.snapshot().history.at(-1)!.time);
  errors.report({ ...event, connectionId: 'b' });
  errors.report(event);
  assert.equal(errors.snapshot().history.at(-1)?.count, 1);
  assert.equal(errors.snapshot().current.length, 1, 'events never become persistent problems');
});

test('history is bounded without losing active conditions or their eventual recovery', () => {
  const errors = new Errors(() => {});
  errors.sync('bad config');
  for (let i = 0; i < 205; i++) errors.report({ source: 'test', message: `failure ${i}` });
  assert.equal(errors.snapshot().history.length, 200);
  assert.equal(errors.snapshot().current.length, 1);
  errors.sync(undefined);
  assert.equal(errors.snapshot().current.length, 0);
});

test('a burst emits one bounded snapshot per turn', async () => {
  const updates: ReturnType<Errors['snapshot']>[] = [];
  const errors = new Errors(log => updates.push(log));
  for (let i = 0; i < 1000; i++) errors.report({ source: 'test', message: `${i}:` + 'x'.repeat(16384) });
  assert.equal(updates.length, 0);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].history.length, 200);
  assert.equal(updates[0].history.at(-1)?.id, 1000);
  errors.clear();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(updates.length, 2);
  assert.equal(updates[1].history.length, 0);
});
