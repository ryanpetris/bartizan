import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import { Relay } from '../src/core/relay';

test('browser relay forwards to its SSH proxy and fails closed when disconnected', async () => {
  const proxy = createServer(socket => { socket.on('error', () => {}); socket.end('proxy'); });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const relay = new Relay(); const port = await relay.start();
  const read = () => new Promise<string>((resolve, reject) => { let value = ''; const socket = connect({ host: '127.0.0.1', port }); socket.on('data', data => value += data); socket.on('end', () => resolve(value)); socket.on('error', reject); });
  try {
    relay.route((proxy.address() as { port: number }).port); assert.equal(await read(), 'proxy');
    relay.route(); assert.equal(await read(), '');
  } finally { relay.close(); proxy.close(); }
});
