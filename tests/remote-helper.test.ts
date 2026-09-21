import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout } from 'node:timers/promises';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteHelper, helperLoader } from '../src/main/remote-helper';
import type { ProcessReport } from '../src/shared';
import type { HelperMessage } from '../src/helper-messages';
import program from '../src/main/remote-helper.pyz';

function archiveFixture(main: string, modules: Record<string, string> = {}): Buffer {
  const directory = mkdtempSync(join(tmpdir(), 'bartizan-zipapp-test-'));
  try {
    const sources = join(directory, 'src');
    mkdirSync(sources);
    writeFileSync(join(sources, '__main__.py'), main);
    for (const [name, source] of Object.entries(modules)) writeFileSync(join(sources, name), source);
    const archive = join(directory, 'fixture.pyz');
    const result = spawnSync('python3', ['-m', 'zipapp', sources, '-o', archive, '-c']);
    assert.equal(result.status, 0, result.stderr.toString());
    return readFileSync(archive);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function temporaryRoot(t: { after: (fn: () => void) => void }): string {
  const directory = mkdtempSync(join(tmpdir(), 'bartizan-helper-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('zipapp imports UTF-8 modules and leaves adjacent commands on stdin', t => {
  const source = archiveFixture(`import json, sys
from greeting import value
assert __name__ == '__main__'
print(json.dumps([value, json.loads(sys.stdin.readline())]))
`, { 'greeting.py': '# 雪🚀\n'.repeat(20000) + 'value = "雪🚀"\n' });
  const directory = temporaryRoot(t);
  const result = spawnSync('python3', ['-u', '-c', helperLoader, String(source.length)], {
    input: Buffer.concat([source, Buffer.from('{"type":"sessions.refresh"}\n')]),
    env: { ...process.env, TMPDIR: directory, LC_ALL: 'C', PYTHONUTF8: '0', PYTHONCOERCECLOCALE: '0', PYTHONIOENCODING: 'ascii' },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message || '');
  assert.deepEqual(JSON.parse(result.stdout), ['雪🚀', { type: 'sessions.refresh' }]);
  assert.deepEqual(readdirSync(directory), []);
});

test('helper starts from a split archive and accepts commands before stdin closes', { timeout: 10000 }, async t => {
  const directory = temporaryRoot(t);
  const source = Buffer.from(program, 'base64');
  const child = spawn('python3', ['-u', '-c', helperLoader, String(source.length)], { env: { ...process.env, TMPDIR: directory } });
  t.after(() => child.kill());
  let diagnostic = '';
  child.stderr.setEncoding('utf8').on('data', text => { diagnostic += text; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  child.stdin.write(source.subarray(0, 100));
  await setTimeout(20);
  const observed: string[] = [];
  child.stdout.on('data', chunk => observed.push(chunk.toString()));
  child.stdin.write(source.subarray(100));
  assert.deepEqual(JSON.parse((await lines.next()).value!), { type: 'helper.ready', pid: child.pid });
  await setTimeout(50);
  assert.equal(observed.join('').includes('sessions.snapshot'), false, 'discovery waits for configuration');
  child.stdin.write('{"type":"sessions.configure","enabled":false}\n');
  assert.deepEqual(JSON.parse((await lines.next()).value!), { type: 'sessions.snapshot', sources: [], sessions: [], errors: [] });
  const files = readdirSync(directory);
  assert.equal(files.length, 1);
  assert.match(files[0], /^bartizan-helper-/);
  const helperDirectory = join(directory, files[0]);
  assert.equal(statSync(helperDirectory).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(helperDirectory), ['helper.pyz']);
  assert.ok(statSync(join(helperDirectory, 'helper.pyz')).isFile());
  const closed = once(child, 'close');
  child.stdin.end();
  assert.deepEqual(await closed, [0, null], diagnostic);
  assert.deepEqual(readdirSync(directory), []);
});

for (const failure of ['truncated', 'invalid', 'entry point'] as const) {
  test(`loader cleans up after ${failure} archive failure`, t => {
    const directory = temporaryRoot(t);
    const source = failure === 'entry point' ? archiveFixture('raise RuntimeError("startup failed")') : Buffer.from('invalid archive');
    const result = spawnSync('python3', ['-u', '-c', helperLoader, String(source.length + (failure === 'truncated' ? 1 : 0))], {
      input: source, env: { ...process.env, TMPDIR: directory }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 1, result.error?.message || '');
    assert.equal(result.stdout, '');
    if (failure === 'truncated') assert.match(result.stderr, /\nEOFError\n$/);
    assert.deepEqual(readdirSync(directory), []);
  });
}

for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
  for (const phase of ['receiving', 'running'] as const) {
    test(`loader deletes its archive on ${signal} while ${phase}`, { timeout: 10000 }, async t => {
      const directory = temporaryRoot(t);
      const source = Buffer.from(program, 'base64');
      const child = spawn('python3', ['-u', '-c', helperLoader, String(source.length)], { env: { ...process.env, TMPDIR: directory } });
      t.after(() => child.kill('SIGKILL'));
      const closed = once(child, 'close');
      if (phase === 'running') {
        const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
        child.stdin.write(source);
        const { value } = await lines.next();
        assert.equal(JSON.parse(value!).type, 'helper.ready');
      } else {
        child.stdin.write(source.subarray(0, 100));
        const deadline = Date.now() + 5000;
        while (!readdirSync(directory).length) {
          assert.ok(Date.now() < deadline, 'Loader did not create an archive');
          await setTimeout(10);
        }
      }
      child.kill(signal);
      assert.deepEqual(await closed, [0, null]);
      assert.deepEqual(readdirSync(directory), []);
    });
  }
}

test('zipapp supports imports after startup without extracting modules', { timeout: 10000 }, async t => {
  const directory = temporaryRoot(t);
  const source = archiveFixture(`import sys
print("ready", flush=True)
sys.stdin.readline()
import later
print(later.value, flush=True)
sys.stdin.readline()
`, { 'later.py': 'value = "loaded"' });
  const child = spawn('python3', ['-u', '-c', helperLoader, String(source.length)], { env: { ...process.env, TMPDIR: directory } });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  child.stdin.write(source);
  assert.equal((await lines.next()).value, 'ready');
  child.stdin.write('import\n');
  assert.equal((await lines.next()).value, 'loaded');
  assert.equal(readdirSync(directory).length, 1);
  const closed = once(child, 'close');
  child.stdin.end();
  assert.deepEqual(await closed, [0, null]);
  assert.deepEqual(readdirSync(directory), []);
});

test('EOF cleanup finishes despite a later termination signal', { timeout: 15000 }, async t => {
  const directory = temporaryRoot(t);
  const temporary = join(directory, 'tmp');
  const cache = join(directory, 'cache/bartizan/tools/vscode/1.0.0');
  const data = join(directory, 'data/bartizan/tools/vscode');
  mkdirSync(temporary);
  mkdirSync(cache, { recursive: true });
  const stopping = join(directory, 'stopping');
  const fixture = readFileSync('tests/fixtures/application.py', 'utf8').replace('import argparse',
    `import signal\nsignal.signal(signal.SIGINT, lambda *_: open(${JSON.stringify(stopping)}, "w").close())\nimport argparse`);
  writeFileSync(join(cache, 'code'), fixture, { mode: 0o700 });
  writeFileSync(join(cache, 'release.json'), JSON.stringify({ name: '1.0.0', version: 'a'.repeat(40) }));
  writeFileSync(join(cache, 'complete'), '');
  const source = Buffer.from(program, 'base64');
  const child = spawn('python3', ['-u', '-c', helperLoader, String(source.length)], { env: {
    ...process.env, TMPDIR: temporary, XDG_CACHE_HOME: join(directory, 'cache'), XDG_DATA_HOME: join(directory, 'data'),
    https_proxy: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', no_proxy: '', NO_PROXY: '',
  } });
  let applicationPid: number | undefined;
  t.after(() => {
    child.kill('SIGKILL');
    if (applicationPid) try { process.kill(-applicationPid, 'SIGKILL'); } catch {}
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  child.stdin.write(Buffer.concat([source, Buffer.from('{"type":"applications.launch","launchId":"cleanup","application":"vscode"}\n')]));
  while (true) {
    const { value, done } = await lines.next();
    assert.equal(done, false, 'Helper exited before consent');
    const message = JSON.parse(value!);
    assert.notEqual(message.type, 'applications.ended', JSON.stringify(message));
    if (message.type === 'applications.consent') break;
  }
  applicationPid = Number(readFileSync(join(data, 'server-data/fixture.pid'), 'utf8'));
  const closed = once(child, 'close');
  child.stdin.end();
  const deadline = Date.now() + 5000;
  while (!existsSync(stopping)) {
    assert.ok(Date.now() < deadline, 'Child did not receive shutdown signal');
    await setTimeout(10);
  }
  child.kill('SIGTERM');
  assert.deepEqual(await closed, [0, null]);
  assert.throws(() => process.kill(applicationPid!, 0), { code: 'ESRCH' });
  applicationPid = undefined;
  assert.deepEqual(readdirSync(temporary), []);
});

test('helper restarts initialize current settings without replaying application commands', { timeout: 10000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bartizan-helper-transport-'));
  writeFileSync(join(directory, 'ssh'), '#!/bin/sh\nexport SHELL=/bin/sh\nfor command; do :; done\nexec /bin/sh -c "$command"\n', { mode: 0o700 });
  const path = process.env.PATH;
  const temp = process.env.TMPDIR;
  process.env.TMPDIR = directory;
  process.env.PATH = directory + ':' + path;
  const reports: ProcessReport[] = [];
  const messages: HelperMessage[] = [], initialized: boolean[] = [];
  let enabled = true;
  const helper = new RemoteHelper('/unused', { host: 'example.invalid' }, message => messages.push(message), () => {
    initialized.push(enabled);
    return [{ type: 'sessions.configure', enabled }];
  }, report => reports.push(report));
  t.after(() => { helper.stop(); process.env.PATH = path; if (temp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = temp; rmSync(directory, { recursive: true, force: true }); });
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) { assert.ok(Date.now() < deadline, JSON.stringify(messages)); await setTimeout(10); }
  };
  assert.equal(reports.at(-1)!.status, 'starting');
  enabled = false; helper.reconfigure();
  await helper.send({ type: 'applications.launch', launchId: 'test', application: 'unknown' });
  await waitFor(() => messages.some(message => message.type === 'applications.ended'));
  assert.equal(reports.at(-1)!.status, 'running');
  assert.ok('pid' in reports.at(-1)!);
  assert.deepEqual(initialized, [false]);
  const child = (helper as unknown as { child: ReturnType<typeof spawn> }).child;
  child.kill('SIGKILL');
  await waitFor(() => messages.some(message => message.type === 'helper.error'));
  assert.equal(reports.at(-1)!.status, 'retrying');
  assert.ok(!('pid' in reports.at(-1)!));
  enabled = true; helper.reconfigure();
  enabled = false; helper.reconfigure();
  await waitFor(() => initialized.length === 2);
  await helper.send({ type: 'sessions.refresh' });
  assert.equal(reports.at(-1)!.status, 'running');
  assert.ok('pid' in reports.at(-1)!);
  assert.deepEqual(initialized, [false, false]);
  assert.equal(messages.filter(message => message.type === 'applications.ended').length, 1);
  const current = (helper as unknown as { child: ReturnType<typeof spawn> }).child;
  const closed = once(current, 'close');
  helper.stop();
  assert.equal(reports.at(-1)!.status, 'stopping');
  await closed;
  assert.equal(reports.at(-1)!.status, 'stopped');
  assert.equal(new Set(reports.map(report => report.id)).size, 1);
});
