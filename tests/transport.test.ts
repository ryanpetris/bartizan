import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client';
import { dispatch, type Request } from '../src/transport';
import { serverOptions, isLoopback } from '../src/web/options';

test('the client uses the same JSON requests, responses and errors across transports', async () => {
  const received: Request[] = [];
  const api = createClient({
    onEvent: () => () => {},
    request: request => dispatch(JSON.parse(JSON.stringify(request)), (method, args) => {
      received.push({ ...request, args });
      if (method === 'capabilities') return { embeddedBrowser: false, nativeFilePicker: false };
      if (method === 'profile-draft') return { token: 'draft' };
      if (method === 'answer') return args[1];
      throw new Error('Unsupported operation');
    }),
  });
  assert.equal((await api.capabilities()).embeddedBrowser, false);
  assert.equal((await api.profileDraft()).token, 'draft');
  assert.deepEqual(received[1].args, []);
  await api.answer('challenge', null);
  assert.deepEqual(received[2].args, ['challenge', null]);
  await assert.rejects(api.newBrowser('connection'), /Unsupported operation/);
  await assert.rejects(dispatch({ id: 0, method: 'input', args: 'bad' }, () => {}), /Invalid request/);
});

test('server CLI defaults to loopback, accepts host and port, and validates arguments', () => {
  assert.deepEqual(serverOptions([]), { host: '127.0.0.1', port: 3000, config: undefined, allowRemote: false, help: undefined });
  assert.equal(serverOptions(['--host', '::1', '--port', '0']).port, 0);
  assert.equal(serverOptions(['--host', '0.0.0.0', '--allow-remote']).allowRemote, true);
  for (const port of ['-1', '65536', 'NaN', '3.5', '']) assert.throws(() => serverOptions(['--port', port]));
  assert.throws(() => serverOptions(['--unknown']));
  for (const host of ['127.0.0.1', '127.22.33.44', '::1']) assert.equal(isLoopback(host), true);
  for (const host of ['0.0.0.0', '::', '127.attacker.test', '127.0.0.999', '192.0.2.1']) assert.equal(isLoopback(host), false);
});

test('backend shutdown drains active work and rejects queued work', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createBackend } = await import('../src/backend/app');
  const directory = await mkdtemp(join(tmpdir(), 'bartizan-backend-test-'));
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let finished = false, closed = false, queuedRan = false;
  const backend = await createBackend({
    directory, file: join(directory, 'config.yaml'), helper: join(directory, 'askpass.cjs'),
    capabilities: { embeddedBrowser: false, nativeFilePicker: false }, send: () => {},
    extend({ handle, serialize }) {
      handle('hold', () => serialize(async () => { started(); await held; finished = true; }));
      handle('queued', () => serialize(async () => { queuedRan = true; }));
      return { sync() {}, state: () => ({ workspaces: [], challenges: [] }), async closeConnection() {}, answer: () => false, replay() {}, close() { assert.equal(finished, true); closed = true; } };
    },
  });
  try {
    await assert.rejects(backend.request('new-application', ['connection', 'vscode']), /Unsupported operation/);
    await assert.rejects(backend.request('helper-message', ['connection', { type: 'applications.launch', launchId: 'one', application: 'vscode' }]), /sessions.refresh/);
    const active = backend.request('hold', []);
    await entered;
    const queued = assert.rejects(backend.request('queued', []), /Backend is closed/);
    const closing = backend.close();
    assert.equal(closed, false);
    release();
    await Promise.all([active, queued, closing]);
    assert.equal(closed, true);
    assert.equal(queuedRan, false);
  } finally { release(); await backend.close(); await rm(directory, { recursive: true, force: true }); }
});
