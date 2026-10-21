import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VncChannel } from '../src/renderer/vnc-channel';
import { vncLimits } from '../src/shared';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

/** A backend whose reads and writes settle when the test says, recording every call. */
function backend() {
  const reads: ReturnType<typeof deferred<Uint8Array | null>>[] = [];
  const writes: { data: Uint8Array; done: ReturnType<typeof deferred<void>> }[] = [];
  const stops: string[] = [];
  return {
    reads, writes, stops,
    readVnc: (_connection: string, _id: string, _attempt: string) => {
      const read = deferred<Uint8Array | null>();
      reads.push(read);
      return read.promise;
    },
    writeVnc: (_connection: string, _id: string, _attempt: string, data: Uint8Array) => {
      const done = deferred<void>();
      writes.push({ data: Uint8Array.from(data), done });
      return done.promise;
    },
    stopVnc: async (_connection: string, _id: string, attempt: string) => { stops.push(attempt); },
  };
}
function open(pipe = backend()) {
  const channel = new VncChannel(pipe, 'connection', 'tab', 'attempt');
  const received: number[][] = [], closes: object[] = [];
  channel.onmessage = ({ data }) => received.push([...data]);
  channel.onclose = (event) => closes.push(event);
  return { pipe, channel, received, closes };
}

test('a VNC channel keeps one read pending and delivers each payload before asking for the next', async () => {
  const { pipe, received } = open();
  assert.equal(pipe.reads.length, 1);
  pipe.reads[0]!.resolve(Uint8Array.of(1, 2));
  await tick();
  assert.deepEqual(received, [[1, 2]]);
  assert.equal(pipe.reads.length, 2);
  pipe.reads[1]!.resolve(Uint8Array.of(3));
  await tick();
  assert.deepEqual(received, [[1, 2], [3]]);
  assert.equal(pipe.reads.length, 3);
});

test('the stream ending or failing closes the channel without stopping the attempt', async () => {
  const ended = open();
  ended.pipe.reads[0]!.resolve(null);
  await tick();
  assert.equal(ended.channel.readyState, 'closed');
  assert.equal(ended.closes.length, 1);
  assert.equal(ended.channel.error, undefined);
  assert.equal(ended.channel.closedByViewer, false);
  assert.deepEqual(ended.pipe.stops, []);

  const failed = open();
  failed.pipe.reads[0]!.reject(new Error('VNC attempt is no longer current'));
  await tick();
  assert.equal(failed.closes.length, 1);
  assert.equal(failed.channel.error, 'VNC attempt is no longer current');
  assert.deepEqual(failed.pipe.stops, []);
});

test('closing from the viewer stops the attempt once and reports closing afterwards', async () => {
  const { pipe, channel, closes } = open();
  channel.close();
  channel.close();
  assert.equal(channel.readyState, 'closed');
  assert.equal(closes.length, 0);
  await new Promise((resolve) => setTimeout(resolve));
  assert.equal(closes.length, 1);
  assert.deepEqual(pipe.stops, ['attempt']);
  assert.equal(channel.closedByViewer, true);
  // Reads go on until the backend ends the stream, and what arrives is discarded.
  pipe.reads[0]!.resolve(Uint8Array.of(9));
  await tick();
  assert.equal(pipe.reads.length, 2);
  pipe.reads[1]!.resolve(null);
  await tick();
  assert.equal(pipe.reads.length, 2);
  assert.equal(closes.length, 1);
});

test('a disposed channel leaves the attempt to the backend', async () => {
  const { pipe, channel } = open();
  channel.dispose();
  channel.close();
  await new Promise((resolve) => setTimeout(resolve));
  assert.deepEqual(pipe.stops, []);
  pipe.reads[0]!.resolve(Uint8Array.of(1));
  await tick();
  assert.equal(pipe.reads.length, 1);
});

test('sends are copied, written one at a time and merged up to the chunk limit', async () => {
  const { pipe, channel } = open();
  const buffer = Uint8Array.of(1, 2, 3);
  channel.send(buffer);
  buffer.fill(0);
  channel.send(Uint8Array.of(4));
  channel.send(Uint8Array.of(5, 6));
  await tick();
  assert.equal(pipe.writes.length, 1);
  assert.deepEqual([...pipe.writes[0]!.data], [1, 2, 3]);
  pipe.writes[0]!.done.resolve();
  await tick();
  assert.equal(pipe.writes.length, 2);
  assert.deepEqual([...pipe.writes[1]!.data], [4, 5, 6]);
  pipe.writes[1]!.done.resolve();

  const large = new Uint8Array(vncLimits.chunk + 10).fill(7);
  channel.send(large);
  await tick();
  assert.equal(pipe.writes[2]!.data.byteLength, vncLimits.chunk);
  pipe.writes[2]!.done.resolve();
  await tick();
  assert.equal(pipe.writes[3]!.data.byteLength, 10);
});

test('input beyond the queued limit stops the attempt and ends the channel', async () => {
  const { pipe, channel, closes } = open();
  const chunk = new Uint8Array(vncLimits.chunk);
  for (let sent = 0; sent < vncLimits.input; sent += chunk.byteLength) channel.send(chunk);
  assert.equal(channel.readyState, 'open');
  channel.send(Uint8Array.of(1));
  assert.equal(channel.readyState, 'closed');
  assert.equal(channel.error, 'VNC input limit exceeded');
  await new Promise((resolve) => setTimeout(resolve));
  assert.deepEqual(pipe.stops, ['attempt']);
  assert.equal(closes.length, 1);
  pipe.writes[0]!.done.resolve();
  await tick();
  assert.equal(pipe.writes.length, 1);
});

test('a failed write ends the channel without stopping the attempt and keeps reading to the end of the stream', async () => {
  const { pipe, channel, closes, received } = open();
  channel.send(Uint8Array.of(1));
  await tick();
  pipe.writes[0]!.done.reject(new Error('VNC channel is closed'));
  await tick();
  assert.equal(channel.readyState, 'closed');
  assert.equal(channel.error, 'VNC channel is closed');
  assert.equal(closes.length, 1);
  assert.deepEqual(pipe.stops, []);
  pipe.reads[0]!.resolve(Uint8Array.of(2));
  await tick();
  assert.deepEqual(received, []);
  assert.equal(pipe.reads.length, 2);
});

test("noVNC's socket wrapper attaches the channel and exchanges bytes through it", async () => {
  // noVNC's logging reads its level from the window, which this process stands in for.
  Object.assign(globalThis, { window: globalThis });
  const path = '../node_modules/@novnc/novnc/core/websock.js';
  const { default: Websock } = await import(path);
  const { pipe, channel } = open();
  const socket = new Websock();
  let messages = 0;
  socket.on('message', () => messages++);
  socket.attach(channel);
  assert.equal(socket.readyState, 'open');
  pipe.reads[0]!.resolve(Uint8Array.of(0x52, 0x46, 0x42));
  await tick();
  assert.equal(messages, 1);
  assert.equal(socket.rQshiftStr(3), 'RFB');
  socket.sQpushString('ok');
  socket.flush();
  socket.sQpushString('!!');
  socket.flush();
  await tick();
  assert.deepEqual([...pipe.writes[0]!.data], [0x6f, 0x6b]);
  pipe.writes[0]!.done.resolve();
  await tick();
  assert.deepEqual([...pipe.writes[1]!.data], [0x21, 0x21]);
});
