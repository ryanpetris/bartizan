import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Askpass } from '../src/main/askpass';
import { SshConnection } from '../src/main/ssh-connection';

/** Runs an SshConnection against a stand-in `ssh` whose master runs `master`; checks succeed once the master runs `ready`. */
async function attempt(master: string, act: (connection: SshConnection) => Promise<void> = async () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'bartizan-ssh-test-'));
  const path = process.env.PATH;
  const marker = join(directory, 'ready');
  writeFileSync(join(directory, 'ssh'), `#!/bin/sh\ncase " $* " in *" -G "*) exit 0;; *" -O "*) test -e '${marker}'; exit;; esac\nready() { touch '${marker}'; }\n${master}\n`);
  chmodSync(join(directory, 'ssh'), 0o755);
  process.env.PATH = `${directory}:${path}`;
  const events = { diagnostics: '', failures: [] as string[], closed: [] as (number | undefined)[], ready: false };
  try {
    const askpass = { register: () => ({}), unregister: () => {} } as unknown as Askpass;
    const connection = new SshConnection({ host: 'example.invalid' }, 'c', directory, askpass, join(directory, 'askpass.cjs'),
      () => { events.ready = true; }, code => events.closed.push(code), text => { events.diagnostics += text; }, text => events.failures.push(text));
    await connection.start();
    await act(connection);
    await connection.ended;
    await new Promise(resolve => setTimeout(resolve, 100));
    return { ...events, exitCode: connection.exitCode };
  } finally { process.env.PATH = path; rmSync(directory, { recursive: true, force: true }); }
}

test('master error output reaches terminals only until the connection is ready, and a failure reports what followed apart from refused channels', async () => {
  const result = await attempt('echo "Welcome banner" >&2; ready; sleep 1; echo "channel 3: open failed: connect failed" >&2; echo "Connection closed by remote host" >&2; exit 255');
  const silent = await attempt('ready; sleep 0.5; exit 255');
  assert.equal(result.ready, true);
  assert.equal(result.diagnostics, 'Welcome banner\n');
  assert.deepEqual(result.closed, [255]);
  assert.equal(result.exitCode, 255);
  assert.deepEqual(result.failures, ['Connection closed by remote host']);
  assert.deepEqual(silent.failures, ['SSH connection exited with code 255']);
});

test('stopping the master records no exit code', async () => {
  const result = await attempt("trap 'exit 255' TERM; ready; while :; do sleep 0.05; done", async connection => {
    while (!connection.connected) await new Promise(resolve => setTimeout(resolve, 20));
    await connection.stop();
  });
  assert.deepEqual(result.closed, [undefined]);
  assert.equal(result.exitCode, undefined);
  assert.deepEqual(result.failures, []);
});
