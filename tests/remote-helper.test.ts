import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout } from 'node:timers/promises';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteHelper, helperLoader } from '../src/main/remote-helper';
import type { HelperMessage } from '../src/helper-messages';
import program from '../src/main/remote-helper.py';

test('loader executes large UTF-8 source and leaves adjacent commands on stdin', () => {
  const source = Buffer.from('# 雪🚀\n'.repeat(20000) + `import json
assert __name__ == '__main__'
print(json.dumps(['雪🚀', json.loads(sys.stdin.readline())]))
`, 'utf8');
  const result = spawnSync('python3', ['-u', '-c', helperLoader, String(source.length)], {
    input: Buffer.concat([source, Buffer.from('{"type":"sessions.refresh"}\n')]),
    env: { ...process.env, LC_ALL: 'C', PYTHONUTF8: '0', PYTHONCOERCECLOCALE: '0', PYTHONIOENCODING: 'ascii' },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message || '');
  assert.deepEqual(JSON.parse(result.stdout), ['雪🚀', { type: 'sessions.refresh' }]);
});

test('helper starts from split source and accepts commands before stdin closes', { timeout: 10000 }, async t => {
  const source = Buffer.from(program, 'utf8');
  const child = spawn('python3', ['-u', '-c', helperLoader, String(source.length)]);
  t.after(() => child.kill());
  let diagnostic = '';
  child.stderr.setEncoding('utf8').on('data', text => { diagnostic += text; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  child.stdin.write(source.subarray(0, 100));
  await setTimeout(20);
  child.stdin.write(Buffer.concat([source.subarray(100), Buffer.from('{"type":"sessions.refresh"}\n')]));
  for (let index = 0; index < 2; index++) {
    const { value } = await lines.next();
    assert.deepEqual(JSON.parse(value!), { type: 'sessions.snapshot', sources: [], sessions: [], errors: [] });
  }
  const closed = once(child, 'close');
  child.stdin.end();
  assert.deepEqual(await closed, [0, null], diagnostic);
});

test('loader raises EOFError without executing truncated source', () => {
  const source = Buffer.from('print("must not execute")\n');
  const result = spawnSync('python3', ['-u', '-c', helperLoader, String(source.length + 1)], {
    input: source, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1, result.error?.message || '');
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /\nEOFError\n$/);
});

test('helper restarts initialize current settings without replaying application commands', { timeout: 10000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bartizan-helper-transport-'));
  writeFileSync(join(directory, 'ssh'), '#!/bin/sh\nfor command; do :; done\nexec /bin/sh -c "$command"\n', { mode: 0o700 });
  const path = process.env.PATH;
  process.env.PATH = directory + ':' + path;
  const messages: HelperMessage[] = [], initialized: boolean[] = [];
  let enabled = true;
  const helper = new RemoteHelper('/unused', { host: 'example.invalid' }, message => messages.push(message), () => {
    initialized.push(enabled);
    return [{ type: 'sessions.configure', enabled }];
  });
  t.after(() => { helper.stop(); process.env.PATH = path; rmSync(directory, { recursive: true, force: true }); });
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) { assert.ok(Date.now() < deadline, JSON.stringify(messages)); await setTimeout(10); }
  };
  enabled = false; helper.reconfigure();
  await helper.send({ type: 'applications.launch', launchId: 'test', application: 'unknown' });
  await waitFor(() => messages.some(message => message.type === 'applications.ended'));
  assert.deepEqual(initialized, [false]);
  const child = (helper as unknown as { child: ReturnType<typeof spawn> }).child;
  child.kill('SIGKILL');
  await waitFor(() => messages.some(message => message.type === 'helper.error'));
  enabled = true; helper.reconfigure();
  enabled = false; helper.reconfigure();
  await waitFor(() => initialized.length === 2);
  await helper.send({ type: 'sessions.refresh' });
  assert.deepEqual(initialized, [false, false]);
  assert.equal(messages.filter(message => message.type === 'applications.ended').length, 1);
});
