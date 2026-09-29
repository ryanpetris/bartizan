import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'bartizan-serve-'));
const server = spawn(process.argv[2], ['serve', '--port', '0'], {
  detached: true,
  env: { ...process.env, DISPLAY: '', TMPDIR: directory, BARTIZAN_DATA_DIR: directory },
});
const stopped = new Promise(resolve => server.once('close', resolve));
let log = '';
server.stdout.on('data', data => log += data);
server.stderr.on('data', data => log += data);
try {
  const deadline = Date.now() + 20000;
  let url;
  while (!(url = /Bartizan listening on (http:\/\/\S+)/.exec(log)?.[1])) {
    assert.equal(server.exitCode, null, log);
    assert.equal(server.signalCode, null, log);
    assert.ok(Date.now() < deadline, log || 'Server startup timed out');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /script-src 'self';/);
  const assets = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^\"]+)"/g)].map(match => match[1]);
  assert.ok(assets.some(asset => asset.endsWith('.js')) && assets.some(asset => asset.endsWith('.css')));
  for (const asset of assets) assert.equal((await fetch(new URL(asset, url))).status, 200, asset);
  for (const path of ['/server.cjs', '/main.cjs', '/preload/preload.cjs', '/assets/../../main/main.cjs', '/package.json']) {
    assert.equal((await fetch(url + path)).status, 404, path);
  }
  console.log('Packaged serve command and renderer assets passed.');
} finally {
  try { process.kill(-server.pid, 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  await stopped;
  await rm(directory, { recursive: true, force: true });
}
