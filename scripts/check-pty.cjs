const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const root = resolve(process.argv[2] ?? '.');
const pty = require(root + '/node_modules/node-pty');
if (process.argv[3]) assert.equal(require(root + '/package.json').version, process.argv[3]);
const terminal = pty.spawn('/bin/sh', ['-c', 'stty -echo; printf "READY\\n"; read line; stty size; printf "INPUT:%s\\n" "$line"; exit 7'], {
  name: 'xterm-256color', cols: 80, rows: 24, env: process.env,
});
let output = '', sent = false;
const timer = setTimeout(() => { terminal.kill(); throw new Error('PTY check timed out'); }, 10000);
terminal.onData(data => {
  output += data;
  if (!sent && output.includes('READY')) {
    sent = true;
    terminal.resize(91, 37);
    terminal.write('bartizan\n');
  }
});
terminal.onExit(({ exitCode }) => {
  clearTimeout(timer);
  assert.equal(exitCode, 7);
  assert.match(output, /37 91/);
  assert.match(output, /INPUT:bartizan/);
  console.log('PTY spawn, input, resize and exit passed.');
});
