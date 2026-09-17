import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<title>Remote container</title><h1>Remote container</h1><script>document.cookie="container=remote; SameSite=Lax"</script>');
});
server.on('upgrade', (request, socket) => {
  const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const message = Buffer.from('remote-websocket');
  socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]));
  socket.on('error', () => {});
  socket.on('data', frame => { if ((frame[0] & 0xf) === 8) socket.end(Buffer.from([0x88, 0])); });
});
server.listen(8080, '127.0.0.1');
