// Signs in to an SSH server in a container and browses the container's network through it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, waitFor, withDirectory } from './lib/harness.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const password = 'bartizan-test-password';
const sshFiles = [join(homedir(), '.ssh/config'), join(homedir(), '.ssh/known_hosts'), '/etc/ssh/ssh_config'];
const digest = path => readFile(path).then(data => createHash('sha256').update(data).digest('hex'), error => { if (error.code === 'ENOENT') return null; throw error; });
const originalSshFiles = await Promise.all(sshFiles.map(digest));

await withDirectory('network', async (directory, cleanup) => {
  for (const name of ['client', 'unauthorized']) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(directory, name)]);
  const container = execFileSync('docker', ['run', '--rm', '-d', '-p', '127.0.0.1::2222', '--add-host', 'bartizan.internal:127.0.0.1',
    '-v', `${repository}:/work:ro`, '-v', `${directory}:/fixtures:ro`, 'bartizan-rig', 'sh', '/work/scripts/rigs/fixtures/remote.sh'], { encoding: 'utf8' }).trim();
  cleanup(() => execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }));
  const inContainer = (...args) => execFileSync('docker', ['exec', container, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const port = Number(execFileSync('docker', ['port', container, '2222'], { encoding: 'utf8' }).trim().split(':').at(-1));
  /** Waits until the server offers its current host key. */
  const serving = () => waitFor(() => {
    try { return inContainer('ssh-keyscan', '-T', '1', '-p', '2222', '127.0.0.1').includes(inContainer('cat', '/tmp/hostkey.pub').split(' ').slice(0, 2).join(' ')); }
    catch { return false; }
  }, 'the SSH server');
  await serving();

  const agentOutput = execFileSync('ssh-agent', ['-s'], { encoding: 'utf8' });
  const agentSocket = /SSH_AUTH_SOCK=([^;]+)/.exec(agentOutput)[1];
  cleanup(() => process.kill(Number(/SSH_AGENT_PID=(\d+)/.exec(agentOutput)[1])));
  execFileSync('ssh-add', [join(directory, 'client')], { env: { ...process.env, SSH_AUTH_SOCK: agentSocket }, stdio: 'ignore' });

  const literal = `{ source: literal, value: ${password} }`;
  const automatic = `{ method: auto, agent: none, identity_files: [${JSON.stringify(join(directory, 'unauthorized'))}], password: ${literal} }`;
  const config = join(directory, 'config.yaml');
  await writeFile(config, `version: 1
defaults:
  host: 127.0.0.1
  port: ${port}
  username: node
  host_keys: { policy: accept-new }
profiles:
  unchecked: { host_keys: { policy: "off" }, auth: ${automatic} }
  strict: { host_keys: { policy: strict }, auth: ${automatic} }
  password: { auth: { method: password, password: ${literal} } }
  agent: { auth: { method: agent }, ssh: { ForwardAgent: true } }
  interactive: { auth: { method: keyboard-interactive } }
  cancelled: { auth: { method: password } }
  changed: { auth: { method: password, password: ${literal} } }
`);
  const app = await launch(directory, config, { env: { SSH_AUTH_SOCK: agentSocket } }); cleanup(app.close);
  const { application, api, waitState, recordOutput, output, errors } = app;
  await recordOutput();
  const knownHosts = join(directory, 'state', 'ssh', 'known_hosts');
  const connect = profileId => api('connect', { profileId });
  const status = (id, value) => waitState(s => s.connections.find(connection => connection.id === id)?.status === value, `connection ${value}`);
  const challenge = async id => (await waitState(s => s.challenges.some(item => item.connectionId === id), 'a sign-in prompt')).challenges.find(item => item.connectionId === id);
  const terminalOutput = async id => output((await app.state()).terminals.find(terminal => terminal.connectionId === id).id);
  const rejected = async (id, ...messages) => {
    const state = await status(id, 'closed');
    assert.equal(state.connections.find(connection => connection.id === id).exitCode, 255);
    await waitFor(async () => { const text = await terminalOutput(id); return messages.every(message => text.includes(message)); }, messages.join(' and '));
  };

  const unchecked = await connect('unchecked');
  const uncheckedState = await status(unchecked, 'connected');
  assert.ok(!uncheckedState.challenges.some(item => item.connectionId === unchecked));
  assert.equal(await digest(knownHosts), null);
  await api('disconnect', unchecked);
  await rejected(await connect('strict'), 'Host key verification failed');
  console.log('Automatic password authentication signs in without prompts, and an unchecked host key is not trusted later.');

  const connection = await connect('password');
  await status(connection, 'connected');
  console.log('Password authentication signs in.');

  const session = await api('newBrowser', connection);
  for (const url of ['http://localhost:8080/', 'http://bartizan.internal:8080/']) {
    await api('browser', session, 'new', undefined, url);
    await waitState(s => s.workspaces.find(workspace => workspace.id === session)?.tabs.some(tab => tab.url === url && tab.title === 'Remote container' && !tab.loading), url);
  }
  assert.equal(await application.evaluate(({ webContents }) => webContents.getAllWebContents().find(contents => contents.getURL() === 'http://bartizan.internal:8080/').executeJavaScript(`new Promise((resolve, reject) => {
    const socket = new WebSocket('ws://bartizan.internal:8080/');
    socket.onmessage = event => { resolve(event.data); socket.close(); };
    socket.onerror = () => reject(new Error('WebSocket failed'));
  })`)), 'remote-websocket');
  console.log('Browsers reach the remote loopback, remote-only names and WebSockets.');

  const agent = await connect('agent');
  const terminals = [(await status(agent, 'connected')).terminals.find(terminal => terminal.connectionId === agent).id, await api('newTerminal', agent)];
  for (const terminal of terminals) {
    await api('input', terminal, 'ssh-add -L\n');
    await waitFor(async () => (await output(terminal)).includes('ssh-ed25519 '), 'the forwarded agent key');
  }
  console.log('Agent authentication signs in and forwards the agent to every terminal.');

  const interactive = await connect('interactive');
  await api('answer', (await challenge(interactive)).id, password);
  await status(interactive, 'connected');
  const cancelled = await connect('cancelled');
  await api('answer', (await challenge(cancelled)).id, null);
  await status(cancelled, 'closed');
  console.log('Keyboard-interactive authentication signs in, and cancelling a password prompt closes the connection.');

  inContainer('rm', '/tmp/hostkey', '/tmp/hostkey.pub');
  inContainer('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', '/tmp/hostkey');
  inContainer('sh', '-c', 'kill -HUP "$(cat /tmp/sshd.pid)"');
  await serving();
  await rejected(await connect('changed'), 'REMOTE HOST IDENTIFICATION HAS CHANGED', 'Host key verification failed');
  assert.deepEqual(await Promise.all(sshFiles.map(digest)), originalSshFiles);
  assert.deepEqual(errors, []);
  console.log('A changed host key is rejected, and the system SSH configuration and trust files stay unchanged.');
});
