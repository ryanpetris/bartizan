import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connectionFixture } from './connection-fixture';
import { VncController, vncArgs, vncDestinationSchema } from '../src/main/vnc';
import { SshConnection } from '../src/main/ssh-connection';
import { Sessions } from '../src/main/sessions';
import { createClient } from '../src/client';
import { createBackend } from '../src/backend/app';
import { vncLimits, type Event } from '../src/shared';
import type { Askpass } from '../src/main/askpass';

const transport = { socket: '<control socket>', spec: { host: 'ssh.example.invalid', username: 'account', port: 2222 }, connected: true } as SshConnection;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function pipes(t: TestContext) {
  const children: ReturnType<typeof makeChild>[] = [], calls: { file: string; args: string[]; options: unknown }[] = [];
  const makeChild = () => {
    const inputs: Buffer[] = [], callbacks: (() => void)[] = [];
    const child = Object.assign(new EventEmitter(), {
      stdin: new Writable({ write(data, _encoding, callback) { inputs.push(data); callbacks.push(callback); } }),
      stdout: new PassThrough({ highWaterMark: vncLimits.chunk }), stderr: new PassThrough(),
      killed: 0, kill() { this.killed++; return true; }, inputs, callbacks,
    });
    return child;
  };
  t.mock.method(childProcess, 'spawn', (file: string, args: string[], options: unknown) => {
    calls.push({ file, args, options });
    const child = makeChild(); children.push(child);
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  t.mock.method(childProcess, 'execFile', (file: string, args: string[], options: unknown, callback: (error: Error | null) => void) => {
    assert.equal(file, 'ssh');
    assert.deepEqual(args, ['-F', 'none', '-S', '<control socket>', '-O', 'check', '--', calls.at(-1)!.args.at(-1)]);
    assert.equal((options as { timeout: number }).timeout, 1000);
    queueMicrotask(() => callback(null));
    return { kill() { return true; } };
  });
  t.after(() => { for (const child of children) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); for (const callback of child.callbacks) callback(); } });
  return { children, calls };
}

function viewer(t: TestContext) {
  const mocked = pipes(t), { connection } = connectionFixture('');
  const vnc = new VncController(connection, { host: 'localhost', port: 5900 });
  connection.vncs.set(vnc.info.id, vnc);
  vnc.start(transport);
  t.after(() => vnc.close());
  return { ...mocked, connection, vnc, child: mocked.children[0] };
}

test('VNC validates destinations without DNS and brackets IPv6 only for SSH forwarding', () => {
  assert.deepEqual(vncDestinationSchema.parse({}), { host: 'localhost', port: 5900 });
  for (const host of ['localhost', 'vnc.example.invalid', '192.0.2.10', '::1', '2001:db8::1', 'fe80::1%eth0']) {
    assert.equal(vncDestinationSchema.parse({ host }).host, host);
  }
  assert.equal(vncDestinationSchema.parse({ host: '[::1]' }).host, '::1');
  for (const host of ['', '-option', 'host:5900', 'host/name', 'user@host', 'host\nname', 'host;command', '[::1', '[::1]:5900', '1.2.3.999']) {
    assert.throws(() => vncDestinationSchema.parse({ host }), host);
  }
  for (const port of [0, -1, 65536, 1.5, NaN, '5900']) assert.throws(() => vncDestinationSchema.parse({ port }));
  assert.throws(() => vncDestinationSchema.parse({ password: 'secret' }));
  const args = vncArgs(transport, { host: '2001:db8::1', port: 5901 });
  assert.deepEqual(args.slice(-5), ['-T', '-W', '[2001:db8::1]:5901', '--', 'ssh.example.invalid']);
  for (const arg of ['ControlMaster=no', 'ProxyCommand=/bin/false', 'BatchMode=yes', '<control socket>']) assert.ok(args.includes(arg));
  assert.deepEqual(args.slice(args.indexOf('-p'), args.indexOf('-p') + 4), ['-p', '2222', '-l', 'account']);
  assert.ok(!args.includes('-tt'));
});

test('VNC uses only binary pipes through ssh and separates diagnostics from framebuffer bytes', async t => {
  const { vnc, child, calls, connection } = viewer(t);
  await tick();
  assert.equal(vnc.info.status, 'connected');
  assert.equal(connection.helper, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'ssh');
  assert.deepEqual((calls[0].options as { stdio: string[] }).stdio, ['pipe', 'pipe', 'pipe']);
  child.stderr.write('\x1b[31mchannel refused\x1b[0m\n');
  const bytes = Buffer.from([0, 255, 128, 10, 13, 27]);
  child.stdout.write(bytes);
  const received = await vnc.read(vnc.info.attempt);
  assert.deepEqual(received, Uint8Array.from(bytes));
  bytes.fill(1);
  assert.deepEqual(received, Uint8Array.from([0, 255, 128, 10, 13, 27]));
  assert.equal(received!.buffer.byteLength, received!.byteLength);
  child.emit('exit', 255); child.stdout.end(); child.stderr.end(); child.emit('close', 255);
  assert.equal(vnc.info.status, 'connected', 'A snapshot cannot dispose the viewer before its EOF read');
  assert.equal(await vnc.read(vnc.info.attempt), null);
  assert.equal(vnc.info.status, 'closed');
  assert.equal(vnc.info.error, 'channel refused');
  assert.equal(await vnc.read(vnc.info.attempt), null);
  assert.equal(child.killed, 0);
});

test('pull reads bound output and cleanup releases pending reads and stream listeners', async t => {
  const { vnc, child } = viewer(t);
  const attempt = vnc.info.attempt;
  const pending = vnc.read(attempt);
  assert.throws(() => vnc.read(attempt), /already pending/);
  child.stdout.write(Buffer.alloc(vncLimits.chunk, 255));
  assert.equal((await pending)!.byteLength, vncLimits.chunk);
  const producer = Readable.from(Array.from({ length: 20 }, () => Buffer.alloc(vncLimits.chunk, 42)));
  child.stdout.once('end', () => { child.emit('exit', 0); child.emit('close', 0); });
  producer.pipe(child.stdout);
  await tick();
  assert.ok(child.stdout.readableLength <= vncLimits.chunk);
  assert.equal(child.stdout.listenerCount('data'), 0);
  for (let i = 0; i < 20; i++) {
    const data = await vnc.read(attempt);
    assert.ok(data && data.byteLength <= vncLimits.chunk);
    assert.equal(data[0], 42);
  }
  assert.equal(await vnc.read(attempt), null);
  assert.equal(child.stdout.listenerCount('readable'), 0);
  vnc.start(transport);
  const replacement = vnc.read(vnc.info.attempt);
  assert.throws(() => vnc.read(attempt), /no longer current/);
  vnc.stop();
  assert.equal(await replacement, null);
  assert.equal(child.stdout.listenerCount('readable'), 0);
});

test('a real exiting subprocess retains trailing bytes between reads until the viewer consumes EOF', { timeout: 10000 }, async t => {
  const spawn = childProcess.spawn;
  const { connection } = connectionFixture('');
  let child!: ReturnType<typeof spawn>;
  t.mock.method(childProcess, 'spawn', () => child = spawn(process.execPath, ['-e', `
    process.stdout.write(Buffer.alloc(1024, 1));
    process.stdin.once('data', () => {
      process.stdin.destroy();
      process.stdout.end(Buffer.alloc(31744, 255));
      process.stderr.end('Authentication failed\\n');
      process.exitCode = 1;
    });
  `], { stdio: ['pipe', 'pipe', 'pipe'] }));
  t.mock.method(childProcess, 'execFile', (_file: string, _args: string[], _options: unknown, callback: (error: Error | null) => void) => {
    queueMicrotask(() => callback(null));
    return { kill() { return true; } };
  });
  const vnc = new VncController(connection, {});
  t.after(() => vnc.close());
  vnc.start(transport);
  const attempt = vnc.info.attempt, first = await vnc.read(attempt);
  assert.deepEqual(first, new Uint8Array(1024).fill(1));
  const exited = once(child, 'exit');
  child.stdin!.end('finish');
  await exited; await tick();
  assert.equal(vnc.info.status, 'connected');
  assert.equal(child.stdout!.listenerCount('readable'), 1);
  const tail = await vnc.read(attempt);
  assert.deepEqual(tail, new Uint8Array(31744).fill(255));
  assert.equal(vnc.info.status, 'connected', 'The consumer still has the last payload to process');
  assert.equal(await vnc.read(attempt), null);
  assert.equal(vnc.info.status, 'closed');
  assert.equal(vnc.info.exitCode, 1);
  assert.equal(vnc.info.error, 'Authentication failed');
  assert.equal(child.stdout!.listenerCount('readable'), 0);
});

test('stdout EOF waits for process closure and does not deadlock a pending read', async t => {
  const { vnc, child } = viewer(t);
  const pending = vnc.read(vnc.info.attempt);
  let settled = false;
  void pending.then(() => { settled = true; });
  child.stdout.end(); await tick();
  assert.equal(settled, false);
  child.emit('exit', 0); await tick();
  assert.equal(settled, false);
  child.emit('close', 0);
  assert.equal(await pending, null);
  assert.equal(vnc.info.status, 'closed');
  assert.equal(vnc.reconnectOnConnect, false);
});

test('replacement cancels a pending master check and ignores its late result', async t => {
  const { vnc, child } = viewer(t);
  let checked!: (error: Error | null) => void, killed = 0;
  t.mock.method(childProcess, 'execFile', (_file: string, _args: string[], _options: unknown, callback: typeof checked) => {
    checked = callback;
    return { kill() { killed++; return true; } };
  });
  const attempt = vnc.info.attempt, pending = vnc.read(attempt);
  child.stdout.end(); child.emit('exit', 0); child.emit('close', 0);
  vnc.start(transport); await tick();
  assert.equal(await pending, null);
  assert.equal(killed, 1);
  assert.equal(child.stdout.listenerCount('readable'), 0);
  checked(new Error('Master is unavailable'));
  assert.notEqual(vnc.info.attempt, attempt);
  assert.equal(vnc.info.status, 'connected');
  assert.equal(vnc.reconnectOnConnect, false);
});

test('master checks distinguish unavailable transport from an inconclusive probe', async t => {
  for (const [reason, error, connected, reconnect] of [
    ['healthy', null, true, false],
    ['nonzero exit', Object.assign(new Error('Master is unavailable'), { code: 255 }), true, true],
    ['timeout', Object.assign(new Error('Timed out'), { code: null, killed: true, signal: 'SIGTERM' }), true, false],
    ['killed probe', Object.assign(new Error('Killed'), { code: 255, killed: true }), true, false],
    ['spawn failure', Object.assign(new Error('Missing executable'), { code: 'ENOENT' }), true, false],
    ['disconnected transport', Object.assign(new Error('Timed out'), { killed: true }), false, true],
  ] as const) await t.test(reason, async t => {
    const { vnc, children } = viewer(t);
    t.mock.method(childProcess, 'execFile', (_file: string, _args: string[], _options: unknown, callback: (error: Error | null) => void) => {
      queueMicrotask(() => callback(error));
      return { kill() { return true; } };
    });
    vnc.start({ ...transport, connected } as SshConnection);
    const child = children[1];
    child.stdout.end(); child.emit('exit', 0); child.emit('close', 0);
    assert.equal(await vnc.read(vnc.info.attempt), null);
    assert.equal(vnc.reconnectOnConnect, reconnect);
    vnc.stop(true);
    assert.equal(vnc.reconnectOnConnect, reconnect);
    vnc.stop();
    assert.equal(vnc.reconnectOnConnect, false);
  });
});

test('writes own their bytes, bound stalled input and reject stale attempts', async t => {
  const { vnc, child } = viewer(t);
  const attempt = vnc.info.attempt, source = Uint8Array.from([255, 0, 128]);
  const write = vnc.write(attempt, source);
  source.fill(1);
  assert.deepEqual(child.inputs[0], Buffer.from([255, 0, 128]));
  child.callbacks.shift()!(); await write;
  const queued: Promise<unknown>[] = [];
  for (let i = 0; i < vncLimits.input / vncLimits.chunk; i++) queued.push(vnc.write(attempt, new Uint8Array(vncLimits.chunk)).catch(error => error));
  assert.equal(child.stdin.writableLength, vncLimits.input);
  await assert.rejects(vnc.write(attempt, Uint8Array.of(1)), /limit exceeded/);
  assert.equal(vnc.info.status, 'closed');
  assert.equal(child.killed, 1);
  for (const callback of child.callbacks) callback();
  await Promise.all(queued);
  vnc.start(transport);
  await assert.rejects(vnc.write(attempt, Uint8Array.of(1)), /no longer current/);
  const reading = vnc.read(vnc.info.attempt);
  vnc.close();
  assert.equal(await reading, null);
  assert.equal(vnc.connection.vncs.size, 0);
});

test('reconnect retains the tab and destination, with no helper requirement', async t => {
  const mocked = pipes(t);
  const { connection } = connectionFixture('');
  t.mock.method(connection, 'setHelperNeeded', () => { throw new Error('VNC must not request a helper'); });
  const master = (connection as unknown as { transport: SshConnection });
  master.transport = transport;
  connection.info.status = 'connected';
  const id = connection.newVnc({ host: '[2001:db8::2]', port: 5902 }), vnc = connection.vncs.get(id)!;
  const first = vnc.info.attempt;
  await tick();
  vnc.stop(true);
  assert.equal(vnc.reconnectOnConnect, true);
  await connection.reconnectVnc(id);
  assert.notEqual(vnc.info.attempt, first);
  assert.equal(vnc.info.id, id);
  assert.equal(vnc.info.host, '2001:db8::2');
  assert.equal(vnc.info.port, 5902);
  mocked.children[0].emit('exit', 255); mocked.children[0].emit('close', 255);
  await tick();
  assert.equal(vnc.info.status, 'connected', 'The old process cannot end the new attempt');
  assert.equal(vnc.reconnectOnConnect, false);
  vnc.stop();
  assert.equal(vnc.reconnectOnConnect, false);
  Object.assign(vnc.info, { error: 'Previous failure', exitCode: 7 });
  vnc.failure('Current failure');
  assert.equal(vnc.info.error, 'Current failure');
  assert.equal(vnc.info.exitCode, undefined);
  Object.assign(vnc.info, { error: 'Previous failure', exitCode: 7 });
  connection.info.status = 'connecting';
  await connection.reconnectVnc(id);
  assert.equal(vnc.info.status, 'connecting');
  assert.equal(vnc.info.error, undefined);
  assert.equal(vnc.info.exitCode, undefined);
  vnc.stop();
  Object.assign(vnc.info, { error: 'Previous failure', exitCode: 7 });
  connection.info.status = 'closed';
  t.mock.method(connection, 'connect', async () => { throw new Error('Master unavailable'); });
  await connection.reconnectVnc(id);
  assert.equal(vnc.info.status, 'closed');
  assert.equal(vnc.info.error, 'Error: Master unavailable');
  assert.equal(vnc.info.exitCode, undefined);
  assert.equal(vnc.reconnectOnConnect, false);
  vnc.close();
  assert.equal(mocked.calls.length, 2);
});

test('host reconnect restores interrupted viewers and disposal releases their pipes', async t => {
  const { children, calls } = pipes(t), { connection } = connectionFixture('');
  let starts = 0;
  t.mock.method(SshConnection.prototype, 'start', async function (this: SshConnection) {
    starts++; this.socket = '<control socket>'; this.connected = true;
    (this as unknown as { ready(): void }).ready();
  });
  t.mock.method(SshConnection.prototype, 'stop', async function (this: SshConnection) {
    this.connected = false; (this as unknown as { finish(): void }).finish();
  });
  await connection.connect(false);
  const id = connection.newVnc({ host: 'vnc.example.invalid', port: 5909 }), vnc = connection.vncs.get(id)!;
  await tick();
  const initialAttempt = vnc.info.attempt, reading = vnc.read(initialAttempt);
  await connection.disconnect();
  assert.equal(await reading, null);
  assert.equal(vnc.reconnectOnConnect, true);
  await connection.connect(false); await tick();
  assert.equal(starts, 2);
  assert.equal(calls.length, 2);
  assert.notEqual(vnc.info.attempt, initialAttempt);
  assert.equal(vnc.info.status, 'connected');
  assert.equal(vnc.info.host, 'vnc.example.invalid');
  assert.equal(vnc.info.port, 5909);
  const pending = vnc.read(vnc.info.attempt);
  await connection.dispose();
  assert.equal(await pending, null);
  assert.equal(connection.vncs.size, 0);
  assert.ok(children.every(child => child.killed === 1 && child.stdout.destroyed && child.stdin.destroyed && child.stderr.destroyed));
});

test('master loss resumes VNC in either callback order, including a pending master check', async t => {
  for (const order of ['channel-first', 'master-first', 'check-pending']) await t.test(order, async t => {
    const { children, calls } = pipes(t), { connection } = connectionFixture('');
    let checked!: (error: Error | null) => void;
    t.mock.method(childProcess, 'execFile', (_file: string, _args: string[], _options: unknown, callback: typeof checked) => {
      checked = callback;
      return { kill() { return true; } };
    });
    t.mock.method(SshConnection.prototype, 'start', async function (this: SshConnection) {
      this.socket = '<control socket>'; this.connected = true;
      (this as unknown as { ready(): void }).ready();
    });
    const master = () => (connection as unknown as { transport: SshConnection }).transport;
    const lost = () => {
      master().connected = false;
      const callbacks = master() as unknown as { finish(): void; closed(code: number): void };
      callbacks.finish(); callbacks.closed(255);
    };
    t.after(() => { for (const vnc of connection.vncs.values()) vnc.close(); });
    await connection.connect(false);
    const id = connection.newVnc({ host: 'vnc.example.invalid', port: 5908 }), vnc = connection.vncs.get(id)!;
    await tick();
    const attempt = vnc.info.attempt, pending = vnc.read(attempt);
    if (order === 'master-first') lost();
    children[0].stdout.end(); children[0].emit('exit', 0); children[0].emit('close', 0);
    if (order === 'channel-first') {
      checked(Object.assign(new Error('Master is unavailable'), { code: 255 }));
      assert.equal(await pending, null);
      assert.equal(vnc.info.status, 'closed');
      assert.equal(vnc.reconnectOnConnect, true);
    }
    if (order !== 'master-first') lost();
    if (order === 'check-pending') checked(new Error('Master is unavailable'));
    assert.equal(await pending, null);
    assert.equal(vnc.reconnectOnConnect, true);
    await connection.connect(false); await tick();
    assert.equal(calls.length, 2);
    assert.equal(vnc.info.id, id);
    assert.notEqual(vnc.info.attempt, attempt);
    assert.equal(vnc.info.host, 'vnc.example.invalid');
    assert.equal(vnc.info.port, 5908);
    assert.equal(vnc.info.status, 'connected');
    assert.equal(vnc.reconnectOnConnect, false);
  });
});

test('server EOF, authentication cancellation and renderer detach cannot request a later automatic reconnect', async t => {
  for (const reason of ['server-eof', 'auth-cancel', 'renderer-detach']) await t.test(reason, async t => {
    const { children, calls } = pipes(t), { connection, configuration } = connectionFixture('');
    t.mock.method(SshConnection.prototype, 'start', async function (this: SshConnection) {
      this.socket = '<control socket>'; this.connected = true;
      (this as unknown as { ready(): void }).ready();
    });
    t.mock.method(SshConnection.prototype, 'stop', async function (this: SshConnection) {
      this.connected = false; (this as unknown as { finish(): void }).finish();
    });
    const sessions = new Sessions(tmpdir(), {} as Askpass, '', () => {}, () => {}, () => {}, configuration);
    sessions.entries.set(connection.info.id, connection);
    t.after(() => connection.dispose());
    await connection.connect(false);
    const id = connection.newVnc(), vnc = connection.vncs.get(id)!;
    await tick();
    if (reason === 'server-eof') {
      children[0].stdout.end(Buffer.from('authentication result'));
      children[0].emit('exit', 0); children[0].emit('close', 0);
      await tick();
      assert.equal(vnc.info.status, 'connected', 'Trailing server bytes are still available');
    } else if (reason === 'auth-cancel') vnc.stop();
    else sessions.detach('desktop');
    assert.equal(vnc.reconnectOnConnect, false);
    await connection.disconnect();
    assert.equal(vnc.reconnectOnConnect, false);
    await connection.connect(false); await tick();
    assert.equal(calls.length, 1);
    assert.equal(vnc.info.status, 'closed');
    await connection.reconnectVnc(id); await tick();
    assert.equal(calls.length, 2, 'An explicit reconnect remains available');
  });
});

test('spawn failures close immediately; pipe failures drain and classify the master before EOF', async t => {
  const { vnc, child, children } = viewer(t);
  const reading = vnc.read(vnc.info.attempt);
  child.emit('error', new Error('Could not spawn ssh'));
  assert.equal(await reading, null);
  assert.equal(vnc.info.error, 'Could not spawn ssh');
  assert.equal(vnc.info.status, 'closed');
  vnc.start(transport);
  await tick();
  const blocked = vnc.read(vnc.info.attempt);
  children[1].stdout.emit('error', new Error('Pipe closed'));
  assert.equal(vnc.info.status, 'connected');
  assert.equal(children[1].killed, 1);
  await assert.rejects(vnc.write(vnc.info.attempt, Uint8Array.of(1)), /channel is closed/);
  children[1].stdout.end(); children[1].emit('exit', 0); children[1].emit('close', 0);
  assert.equal(await blocked, null);
  assert.equal(vnc.info.error, 'Pipe closed');
  assert.equal(vnc.reconnectOnConnect, false);
});

test('real EPIPE preserves host-loss intent and trailing bytes without resuming server failures or cancellation', { timeout: 10000 }, async t => {
  for (const reason of ['server-close', 'channel-first', 'master-first', 'cancel']) await t.test(reason, async t => {
    const spawn = childProcess.spawn, { connection } = connectionFixture('');
    let child!: ReturnType<typeof spawn>, checked!: (error: Error | null) => void;
    t.mock.method(childProcess, 'spawn', () => child = spawn(process.execPath, ['-e', `
      require('node:fs').closeSync(0);
      process.stdout.write(Buffer.alloc(32768, 255));
      setInterval(() => {}, 1000);
    `], { stdio: ['pipe', 'pipe', 'pipe'] }));
    t.mock.method(childProcess, 'execFile', (_file: string, _args: string[], _options: unknown, callback: typeof checked) => {
      checked = callback;
      return { kill() { return true; } };
    });
    const vnc = new VncController(connection, {});
    t.after(() => vnc.close());
    vnc.start(transport);
    const attempt = vnc.info.attempt;
    await once(child.stdout!, 'readable');
    const exited = once(child, 'exit');
    if (reason === 'master-first') child.stdin!.on('error', () => vnc.stop(true));
    await assert.rejects(vnc.write(attempt, new Uint8Array(vncLimits.chunk)), { code: 'EPIPE' });
    await exited;
    if (reason === 'master-first') {
      assert.equal(await vnc.read(attempt), null);
      assert.equal(vnc.reconnectOnConnect, true);
    } else {
      assert.equal(vnc.info.status, 'connected');
      if (reason === 'cancel') vnc.stop();
      checked(reason === 'server-close' ? null : Object.assign(new Error('Master unavailable'), { code: 255 }));
      if (reason !== 'cancel') {
        assert.deepEqual(await vnc.read(attempt), new Uint8Array(32768).fill(255));
        assert.equal(vnc.info.status, 'connected');
      }
      assert.equal(await vnc.read(attempt), null);
      assert.equal(vnc.info.status, 'closed');
      assert.equal(vnc.reconnectOnConnect, reason === 'channel-first');
      vnc.stop(true);
      assert.equal(vnc.reconnectOnConnect, reason === 'channel-first');
      if (reason === 'server-close') assert.match(vnc.info.error!, /EPIPE/);
    }
  });
});

test('the binary client copies writes, limits IPC work and never puts bytes in JSON requests', async () => {
  const requests: string[] = [], input: Uint8Array[] = [];
  let finishRead!: (data: Uint8Array | null) => void;
  const releases: (() => void)[] = [];
  const api = createClient({
    request: async request => { requests.push(request.method); return { id: request.id }; }, onEvent: () => () => {},
    readVnc: () => new Promise(resolve => { finishRead = resolve; }),
    writeVnc: async (_connection, _id, _attempt, data) => { input.push(data); await new Promise<void>(resolve => releases.push(resolve)); },
  });
  const args = [randomUUID(), randomUUID(), randomUUID()] as const;
  await api.writeVnc(...args, new Uint8Array());
  assert.equal(input.length, 0);
  const reading = api.readVnc(...args);
  await assert.rejects(api.readVnc(...args), /already pending/);
  finishRead(null); assert.equal(await reading, null);
  const bytes = Buffer.from([255, 0, 128]);
  const writing = api.writeVnc(...args, bytes);
  bytes.fill(1); assert.deepEqual(input[0], Uint8Array.from([255, 0, 128]));
  releases.shift()!(); await writing;
  const pending: Promise<void>[] = [];
  for (let i = 0; i < vncLimits.input / vncLimits.chunk; i++) pending.push(api.writeVnc(...args, new Uint8Array(vncLimits.chunk)));
  await assert.rejects(api.writeVnc(...args, Uint8Array.of(1)), /limit exceeded/);
  assert.deepEqual(requests, ['stop-vnc']);
  for (const release of releases) release(); await Promise.all(pending);
  const web = createClient({ request: async request => ({ id: request.id }), onEvent: () => () => {} });
  await assert.rejects(web.readVnc(...args), /desktop/);
  await assert.rejects(web.writeVnc(...args, Uint8Array.of(1)), /desktop/);
});

test('backend enforces desktop capability, session ownership and separate binary delivery', async t => {
  const mocked = pipes(t);
  const directory = mkdtempSync(join(tmpdir(), 'bartizan-vnc-'));
  const { connection, configuration } = connectionFixture(directory);
  const sessions = new Sessions(directory, {} as Askpass, '', () => {}, () => {}, () => {}, configuration);
  connection.info.id = randomUUID();
  connection.info.status = 'connected';
  (connection as unknown as { transport: SshConnection }).transport = transport;
  sessions.entries.set(connection.info.id, connection);
  const events: Event[] = [];
  let owned!: Sessions;
  const backend = await createBackend({
    directory, file: join(directory, 'config.yaml'), helper: '',
    capabilities: { embeddedBrowser: false, externalBrowser: false, nativeFilePicker: false, vnc: true },
    send: event => events.push(event), extend({ sessions }) {
      owned = sessions; sessions.entries.set(connection.info.id, connection);
      return { state: () => ({ workspaces: [], challenges: [] }), answer: () => false, replay() {}, close() {} };
    },
  });
  try {
    const id = await backend.request('new-vnc', [connection.info.id]) as string;
    const vnc = sessions.vnc(connection.info.id, id), attempt = vnc.info.attempt;
    assert.throws(() => sessions.vnc(randomUUID(), id), /Unknown connection/);
    assert.throws(() => sessions.vnc(connection.info.id, randomUUID()), /does not belong/);
    const reading = backend.readVnc(connection.info.id, id, attempt);
    mocked.children[0].stdout.write(Buffer.from([255, 0, 128]));
    assert.deepEqual(await reading, Uint8Array.from([255, 0, 128]));
    assert.equal(backend.state().capabilities.vnc, true);
    assert.equal(backend.state().vncs[0].id, id);
    assert.equal(events.filter(event => event.type === 'data').length, 0);
    await assert.rejects(backend.request('vnc-read', [connection.info.id, id, attempt]), /Unsupported operation/);
    await backend.request('stop-vnc', [connection.info.id, id, randomUUID()]);
    assert.notEqual(vnc.info.status, 'closed');
    const pending = backend.readVnc(connection.info.id, id, attempt);
    backend.detach('desktop');
    assert.equal(await pending, null);
    assert.equal(vnc.reconnectOnConnect, false);
    await backend.request('close-vnc', [connection.info.id, id]);
    assert.equal(backend.state().vncs.length, 0);
  } finally {
    owned.entries.clear(); sessions.entries.clear();
    await backend.close();
    rmSync(directory, { recursive: true, force: true });
  }
  const webDirectory = mkdtempSync(join(tmpdir(), 'bartizan-vnc-web-'));
  const web = await createBackend({ directory: webDirectory, file: join(webDirectory, 'config.yaml'), helper: '', capabilities: { embeddedBrowser: false, externalBrowser: false, nativeFilePicker: false, vnc: false }, send() {} });
  try {
    assert.equal(web.state().capabilities.vnc, false);
    for (const method of ['new-vnc', 'reconnect-vnc', 'close-vnc', 'stop-vnc']) await assert.rejects(web.request(method, [randomUUID(), randomUUID(), randomUUID()]), /desktop/);
    assert.throws(() => web.readVnc(randomUUID(), randomUUID(), randomUUID()), /desktop/);
    assert.throws(() => web.writeVnc(randomUUID(), randomUUID(), randomUUID(), Uint8Array.of(1)), /desktop/);
  } finally { await web.close(); rmSync(webDirectory, { recursive: true, force: true }); }
});
