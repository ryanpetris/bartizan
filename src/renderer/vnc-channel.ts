import { vncLimits, type API } from '../shared';

type Pipe = Pick<API, 'readVnc' | 'writeVnc' | 'stopVnc'>;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/**
 * One VNC attempt's byte stream as the raw channel noVNC attaches in place of a WebSocket. It reads one payload at a time
 * and hands it to noVNC before asking for the next, until the stream ends. noVNC reuses its send buffer, so each send is
 * copied into a queue that one write at a time drains, merging sends up to `vncLimits.chunk` bytes per write.
 *
 * Closing from noVNC, as on cancellation or a protocol failure, stops the attempt in the backend; the stream ending on
 * its own or failing does not, so a host interruption can still resume the attempt. After either, reads go on discarding
 * data until the backend ends the stream, so that it can report the attempt closed.
 */
export class VncChannel {
  binaryType = 'arraybuffer';
  protocol = '';
  readyState: 'open' | 'closed' = 'open';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: Uint8Array }) => void) | null = null;
  onclose: ((event: object) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  /** Why this side ended the stream, when a read, a write or the input limit failed. */
  error?: string;
  /** Whether noVNC closed the channel, rather than the stream ending. */
  closedByViewer = false;
  private queue: Uint8Array[] = [];
  /** Bytes sent and not yet written, including the write in progress. */
  private pending = 0;
  private writing = false;
  private disposed = false;
  constructor(private readonly pipe: Pipe, readonly connectionId: string, readonly id: string, readonly attempt: string) {
    void this.read();
  }
  send(data: Uint8Array) {
    if (this.readyState !== 'open') return;
    if (this.pending + data.byteLength > vncLimits.input) {
      this.error = 'VNC input limit exceeded';
      this.close();
      return;
    }
    if (!data.byteLength) return;
    this.queue.push(data.slice());
    this.pending += data.byteLength;
    void this.write();
  }
  close() {
    if (this.readyState !== 'open') return;
    this.closedByViewer = true;
    this.finish();
    if (!this.disposed) void this.pipe.stopVnc(this.connectionId, this.id, this.attempt).catch(() => {});
    // A WebSocket reports closing after `close` returns, and noVNC expects that order.
    setTimeout(() => this.onclose?.({}));
  }
  /** Leaves the attempt to the backend, as for a tab that has closed or an attempt that has been replaced. */
  dispose() {
    this.disposed = true;
  }
  private finish() {
    this.readyState = 'closed';
    this.queue = [];
  }
  private end(error?: string) {
    if (this.readyState !== 'open') return;
    this.error ??= error;
    this.finish();
    this.onclose?.({});
  }
  private async read() {
    try {
      for (;;) {
        const data = await this.pipe.readVnc(this.connectionId, this.id, this.attempt);
        if (data === null || this.disposed) break;
        if (this.readyState !== 'open') continue;
        try {
          this.onmessage?.({ data });
        } catch (error) {
          this.error ??= message(error);
          this.close();
        }
      }
      this.end();
    } catch (error) {
      this.end(message(error));
    }
  }
  private async write() {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.queue.length && this.readyState === 'open') {
        const data = this.take();
        await this.pipe.writeVnc(this.connectionId, this.id, this.attempt, data);
        this.pending -= data.byteLength;
      }
    } catch (error) {
      this.end(message(error));
    } finally {
      this.writing = false;
    }
  }
  /** The next write: queued sends merged up to the chunk limit, or the first part of a larger one. */
  private take() {
    const queue = this.queue;
    let size = 0, count = 0;
    while (count < queue.length && size + queue[count]!.byteLength <= vncLimits.chunk) size += queue[count++]!.byteLength;
    if (!count) {
      const first = queue[0]!;
      queue[0] = first.subarray(vncLimits.chunk);
      return first.subarray(0, vncLimits.chunk);
    }
    if (count === 1) return queue.shift()!;
    const data = new Uint8Array(size);
    let offset = 0;
    for (const part of queue.splice(0, count)) {
      data.set(part, offset);
      offset += part.byteLength;
    }
    return data;
  }
}
