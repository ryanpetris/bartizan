import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createBackend } from '../backend/app';
import { dispatch } from '../transport';
import { bindAddress, confirmRemote, serverOptions, isLoopback } from './options';

export async function serve(args: string[], dataDirectory?: string) {
  const options = serverOptions(args);
  if (options.help) { console.log('Usage: bartizan serve [--host ADDRESS] [--port PORT] [--config FILE] [--allow-remote]'); return; }
  const address = await bindAddress(options.host);
  await confirmRemote(options.host, address, options.allowRemote);
  const directory = dataDirectory ?? process.env.BARTIZAN_DATA_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'bartizan');
  const clients = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
  const send = (socket: WebSocket, message: unknown) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 8 * 1024 * 1024) { socket.close(1013, 'Client is too slow'); return; }
    socket.send(JSON.stringify(message));
  };
  const backend = await createBackend({
    file: resolve(options.config ?? join(directory, 'config.yaml')), directory, helper: join(__dirname, 'askpass.cjs'),
    capabilities: { embeddedBrowser: false, nativeFilePicker: false },
    send: event => { for (const socket of clients.clients) send(socket, { event }); },
  });
  const allowedHost = (host: string | undefined) => {
    if (!isLoopback(address)) return true;
    try { const name = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, ''); return name === 'localhost' || isLoopback(name); }
    catch { return false; }
  };
  const assets = new Set(['/', '/index.html', '/app.js', '/font-worker.js', '/app.css', '/style.css']);
  const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf' };
  const server = createServer(async (request, response) => {
    try {
      if (!allowedHost(request.headers.host)) { response.writeHead(403).end(); return; }
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
      const path = decodeURIComponent(new URL(request.url!, 'http://localhost').pathname);
      const font = path.startsWith('/fonts/') && !!mime[extname(path)] && !path.includes('..') && !path.includes('\\');
      if (!assets.has(path) && !font) { response.writeHead(404).end(); return; }
      const file = resolve(__dirname, '.' + (path === '/' ? '/index.html' : path));
      if (!file.startsWith(resolve(__dirname) + sep)) { response.writeHead(404).end(); return; }
      let body = await readFile(file);
      if (extname(file) === '.html') body = Buffer.from(body.toString().replace("connect-src 'none'", "connect-src 'self' ws: wss:"));
      response.writeHead(200, { 'Content-Type': mime[extname(file)], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch { response.writeHead(404).end(); }
  });
  server.on('upgrade', (request, socket, head) => {
    // Same-origin checks prevent other websites from driving a local server; they are not authentication.
    let origin: URL;
    try { origin = new URL(request.headers.origin ?? ''); } catch { socket.destroy(); return; }
    if (!allowedHost(request.headers.host) || request.url !== '/socket' || !['http:', 'https:'].includes(origin.protocol) || origin.host !== request.headers.host) { socket.destroy(); return; }
    clients.handleUpgrade(request, socket, head, client => clients.emit('connection', client));
  });
  clients.on('connection', socket => {
    const id = randomUUID();
    for (const event of backend.snapshot()) send(socket, { event });
    socket.on('message', (data, binary) => {
      if (binary) { socket.close(1003, 'Expected JSON'); return; }
      void (async () => {
        try {
          const response = await dispatch(JSON.parse(data.toString()), (method, args) => method === 'graphics' ? undefined : backend.request(method, args, id));
          send(socket, response);
        } catch { socket.close(1008, 'Invalid request'); }
      })();
    });
    socket.on('error', () => {});
    socket.on('close', () => backend.release(id));
  });
  let stopped = false;
  let finished!: () => void;
  const done = new Promise<void>(resolve => { finished = resolve; });
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    for (const socket of clients.clients) socket.terminate();
    clients.close(); server.close();
    try { await backend.close(); } finally { finished(); }
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, address, resolve); });
    const bound = server.address() as import('node:net').AddressInfo;
    console.log(`Bartizan listening on http://${address.includes(':') ? `[${address}]` : address}:${bound.port}`);
  } catch (error) { await stop(); throw error; }
  await done;
}
