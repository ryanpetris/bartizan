import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Askpass, type Challenge } from '../src/main/askpass';

function request(socketPath: string, token: string, prompt: string, hint = ''): Promise<{ value: string | null }> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath); let data = '';
    socket.on('connect', () => socket.write(JSON.stringify({ token, prompt, hint }) + '\n'));
    socket.on('error', reject); socket.on('data', chunk => data += chunk);
    socket.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('No response')); } });
  });
}
test('askpass delivers a configured password once and keeps MFA and confirmation interactive', async () => {
  const prompts: Challenge[] = [];
  const broker = new Askpass(challenge => { prompts.push(challenge); broker.answer(challenge.id, 'interactive'); });
  await broker.start();
  try {
    const env = broker.register('connection', { auth: { method: 'password', password: { source: 'literal', value: 'secret' } } }, '', '');
    assert.equal((await request(env.BARTIZAN_SOCKET, env.BARTIZAN_TOKEN, "test@example.invalid's password:")).value, 'secret');
    assert.equal((await request(env.BARTIZAN_SOCKET, env.BARTIZAN_TOKEN, "test@example.invalid's password:")).value, 'interactive');
    assert.equal((await request(env.BARTIZAN_SOCKET, env.BARTIZAN_TOKEN, 'Verification code:')).value, 'interactive');
    assert.equal((await request(env.BARTIZAN_SOCKET, env.BARTIZAN_TOKEN, 'Accept key?', 'confirm')).value, 'interactive');
    assert.equal(prompts.at(-1)?.confirm, true);
    assert.equal(prompts.length, 3);
    await assert.rejects(request(env.BARTIZAN_SOCKET, 'wrong-token', 'Password:'));
  } finally { broker.close(); }
});

test('withdraws disconnected challenges and reports unreadable configured credentials', async () => {
  const prompts: Challenge[] = [], withdrawn: string[] = [], errors: { message: string; connectionId: string }[] = [];
  const broker = new Askpass(challenge => prompts.push(challenge), id => withdrawn.push(id), (message, connectionId) => errors.push({ message, connectionId }));
  await broker.start();
  try {
    const env = broker.register('connection', { auth: { method: 'password', password: { source: 'file', path: '/nonexistent/bartizan-secret' } } }, '', '');
    const reply = request(env.BARTIZAN_SOCKET, env.BARTIZAN_TOKEN, "test@example.invalid's password:");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(errors.length, 1); assert.equal(errors[0].connectionId, 'connection'); assert.equal(prompts.length, 1);
    assert.equal(broker.answer(prompts[0].id, 'manual'), 'connection');
    assert.equal((await reply).value, 'manual'); assert.deepEqual(withdrawn, [prompts[0].id]);
    const pending = request(env.BARTIZAN_SOCKET, env.BARTIZAN_TOKEN, 'Touch security key', 'none');
    const rejected = assert.rejects(pending);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(prompts[1].notification, true);
    broker.unregister('connection'); await rejected;
    assert.ok(withdrawn.includes(prompts[1].id));
  } finally { broker.close(); }
});

test('invalid interactive responses remain pending and fragmented prompts retain Unicode', async () => {
  const withdrawn: string[] = [];
  let prompt!: Challenge;
  const broker = new Askpass(challenge => { prompt = challenge; }, id => withdrawn.push(id));
  await broker.start();
  const env = broker.register('connection', {}, '', '');
  const socket = connect(env.BARTIZAN_SOCKET);
  try {
    await once(socket, 'connect');
    const bytes = Buffer.from(JSON.stringify({ token: env.BARTIZAN_TOKEN, prompt: 'λ prompt:', hint: '' }) + '\n');
    const cut = bytes.indexOf(0xce) + 1;
    socket.write(bytes.subarray(0, cut));
    await new Promise(resolve => setTimeout(resolve, 30));
    socket.write(bytes.subarray(cut));
    for (let i = 0; !prompt && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(prompt.prompt, 'λ prompt:');
    const response = 'λ'.repeat(511) + 'a';
    assert.throws(() => broker.answer(prompt.id, response + 'a'), /1023 UTF-8 bytes/);
    assert.throws(() => broker.answer(prompt.id, 'first\nsecond'), /single line/);
    assert.deepEqual(withdrawn, []);
    const data: Buffer[] = []; socket.on('data', chunk => data.push(Buffer.from(chunk)));
    const ended = once(socket, 'end');
    assert.equal(broker.answer(prompt.id, response), 'connection');
    await ended;
    assert.equal(JSON.parse(Buffer.concat(data).toString()).value, response);
    assert.deepEqual(withdrawn, [prompt.id]);
  } finally { socket.destroy(); broker.close(); }
});

test('askpass helper decodes a UTF-8 character split across socket chunks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bartizan-helper-'));
  const server = createServer(socket => socket.once('data', () => {
    const response = Buffer.from(JSON.stringify({ value: 'λ secret' }) + '\n');
    const cut = response.indexOf(0xce) + 1;
    socket.write(response.subarray(0, cut));
    setTimeout(() => socket.end(response.subarray(cut)), 30);
  }));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const path = join(directory, 'broker');
    await new Promise<void>(resolve => server.listen(path, resolve));
    const helper = fileURLToPath(new URL('../src/main/askpass-helper.ts', import.meta.url));
    child = spawn(process.execPath, ['--import', 'tsx', helper, 'Password:'], { env: { ...process.env, BARTIZAN_SOCKET: path, BARTIZAN_TOKEN: 'test' } });
    let output = ''; child.stdout!.setEncoding('utf8').on('data', chunk => output += chunk);
    const [code] = await once(child, 'close');
    assert.equal(code, 0); assert.equal(output, 'λ secret\n');
  } finally { child?.kill(); server.close(); await rm(directory, { recursive: true, force: true }); }
});


test('invalid configured credentials explain the format error without exposing values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bartizan-auth-errors-'));
  const path = join(directory, 'credential');
  const errors: string[] = [];
  const broker = new Askpass(challenge => broker.answer(challenge.id, 'manual'), undefined, message => errors.push(message));
  await broker.start();
  try {
    for (const [content, expected] of [[Buffer.from('hidden-credential'.repeat(100)), 'Credential must be at most 1023 UTF-8 bytes'], [Buffer.from([0xe4]), 'Configured credential is not valid UTF-8'], [Buffer.from('hidden\ncredential'), 'Credential must be a single line']] as const) {
      await writeFile(path, content);
      const env = broker.register('connection', { auth: { method: 'password', password: { source: 'file', path } } }, '', '');
      assert.equal((await request(env.BARTIZAN_SOCKET, env.BARTIZAN_TOKEN, "test@example.invalid's password:")).value, 'manual');
      assert.equal(errors.at(-1), expected);
      broker.unregister('connection');
    }
    await rm(path);
    for (const [password, expected] of [
      [{ source: 'file', path }, 'Credential file could not be read'],
      [{ source: 'file', path: '/dev/zero' }, 'Credential source must be a regular file'],
    ] as const) {
      const env = broker.register('connection', { auth: { method: 'password', password } }, '', '');
      assert.equal((await request(env.BARTIZAN_SOCKET, env.BARTIZAN_TOKEN, "test@example.invalid's password:")).value, 'manual');
      assert.equal(errors.at(-1), expected);
      broker.unregister('connection');
    }
    assert.ok(!JSON.stringify(errors).includes('hidden'));
  } finally { broker.close(); await rm(directory, { recursive: true, force: true }); }
});
