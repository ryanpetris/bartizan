import { createServer, connect, type Socket } from 'node:net';
export class Relay {
  private sockets = new Set<Socket>();
  private target?: number;
  private server = createServer(client => {
    if (!this.target) { client.destroy(); return; }
    const upstream = connect({ host: '127.0.0.1', port: this.target });
    for (const socket of [client, upstream]) {
      this.sockets.add(socket);
      socket.on('error', () => { client.destroy(); upstream.destroy(); });
      socket.once('close', () => { this.sockets.delete(socket); if (socket === client) upstream.destroy(); });
    }
    client.pipe(upstream); upstream.pipe(client);
  });
  async start(): Promise<number> {
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    return (this.server.address() as { port: number }).port;
  }
  route(port?: number) {
    if (port === this.target) return;
    for (const socket of this.sockets) socket.destroy();
    this.target = port;
  }
  close() { this.route(undefined); this.server.close(); }
}
export async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
