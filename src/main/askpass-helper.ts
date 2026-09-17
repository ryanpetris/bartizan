import { connect } from 'node:net';
const socket = connect(process.env.BARTIZAN_SOCKET!);
socket.setEncoding('utf8');
const timer = setTimeout(() => process.exit(1), 125000);
socket.on('error', () => process.exit(1));
socket.on('connect', () => socket.write(JSON.stringify({ token: process.env.BARTIZAN_TOKEN, prompt: process.argv[2] ?? '', hint: process.env.SSH_ASKPASS_PROMPT ?? '' }) + '\n'));
let data = '';
socket.on('data', chunk => {
  data += chunk.toString();
  if (Buffer.byteLength(data, 'utf8') > 65536) process.exit(1);
  if (!data.includes('\n')) return;
  try {
    const { value } = JSON.parse(data.slice(0, data.indexOf('\n')));
    if (typeof value !== 'string') process.exit(1);
    process.stdout.write(value + '\n', () => { clearTimeout(timer); process.exit(0); });
  } catch { process.exit(1); }
});
socket.on('end', () => { if (!data.includes('\n')) process.exit(1); });
