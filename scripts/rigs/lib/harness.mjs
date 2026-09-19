import { _electron } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export const graphicsArgs = process.env.BARTIZAN_RIG_SOFTWARE_GL === '1' ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [];

/** Runs a rig body with a temporary directory that is removed afterwards, along with everything registered through `cleanup`. */
export async function withDirectory(name, body) {
  const directory = await mkdtemp(join(tmpdir(), `bartizan-${name}-`));
  const cleanups = [];
  try { await body(directory, callback => cleanups.push(callback)); }
  finally {
    for (const callback of cleanups.reverse()) await callback();
    await rm(directory, { recursive: true, force: true });
  }
}

export async function freePort(host = '127.0.0.1') {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

export async function waitFor(check, message = 'condition', timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * The modal overlay beside `page`, where dialogs draw over the pages: a window of its own, which the page replaces when
 * it reloads. The page shows its interface once its overlay has opened, and the newest overlay is the page's.
 */
export async function modalOf(page) {
  await page.locator('.main').waitFor({ state: 'attached' });
  return waitFor(async () => {
    for (const candidate of page.context().pages().reverse())
      if (candidate !== page && !candidate.isClosed() && await candidate.evaluate(() => document.documentElement.classList.contains('overlay-modal')).catch(() => false)) return candidate;
  }, 'the modal overlay');
}

export const sshdBinary = () => (process.env.PATH ?? '').split(delimiter).concat('/usr/sbin').map(directory => join(directory, 'sshd')).find(existsSync);

/**
 * Starts an isolated sshd for the current user with an ed25519 host key and client identity.
 * `passphrase` protects the identity, `name` names its file, and `config` adds sshd_config lines.
 */
export async function startSshd(directory, { host = '127.0.0.1', passphrase = '', name = 'identity', config = '' } = {}) {
  const binary = sshdBinary();
  if (!binary) throw new Error('This rig requires sshd');
  const port = await freePort(host);
  const hostKey = join(directory, 'host');
  const identity = join(directory, name);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', passphrase, '-f', identity]);
  await writeFile(join(directory, 'sshd_config'), `Port ${port}\nListenAddress ${host}\nHostKey ${hostKey}\nPidFile ${directory}/sshd.pid\nAuthorizedKeysFile ${identity.replaceAll('%', '%%')}.pub\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowTcpForwarding yes\nLogLevel VERBOSE\n${config}`);
  const child = spawn(binary, ['-D', '-e', '-f', join(directory, 'sshd_config')]);
  let log = '';
  child.stderr.on('data', chunk => { log += chunk; });
  const listening = () => new Promise(resolve => {
    const socket = connect({ host, port }, () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
  await waitFor(async () => { if (child.exitCode !== null) throw new Error(log); return listening(); }, 'sshd');
  return { host, port, pid: child.pid, hostKey: `${hostKey}.pub`, identity, log: () => log, stop: () => child.kill() };
}

/** YAML for a profile that signs in to a rig sshd with its identity. */
export const sshProfile = (sshd, extra = '') => `    host: "${sshd.host}"\n    port: ${sshd.port}\n    auth:\n      method: key\n      identity_files: [${JSON.stringify(sshd.identity)}]\n    host_keys:\n      policy: accept-new\n${extra}`;

/**
 * Launches the application, with a configuration file when one is given. State events are recorded in the main process
 * after a reload, so `state()` returns the latest state the renderer received. `errors` collects uncaught page errors.
 */
export async function launch(directory, config, { args = [], env = {}, colorScheme = null } = {}) {
  const executable = process.env.BARTIZAN_EXECUTABLE;
  const application = await _electron.launch({
    chromiumSandbox: true, colorScheme, executablePath: executable,
    args: [...(executable ? [] : ['.']), ...graphicsArgs, ...(config ? ['--config', config] : []), ...args],
    env: { ...process.env, BARTIZAN_DATA_DIR: join(directory, 'state'), ...env },
  });
  const page = await application.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.bartizan);
  await application.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const send = contents.send.bind(contents);
    contents.send = (channel, event) => {
      if (event?.type === 'state') globalThis.rigState = event.state;
      return send(channel, event);
    };
  });
  await page.reload();
  await page.waitForFunction(() => window.bartizan);
  const state = () => application.evaluate(() => globalThis.rigState);
  await waitFor(state, 'initial state');
  const api = (name, ...values) => page.evaluate(({ name, values }) => window.bartizan[name](...values), { name, values });
  const waitState = (predicate, message = 'state') => waitFor(async () => { const current = await state(); return predicate(current) && current; }, message);
  /** Records terminal output in the page; `output(id)` returns what a terminal has printed since. */
  const recordOutput = () => page.evaluate(() => {
    window.rigOutputs = {};
    window.bartizan.onEvent(event => { if (event.type === 'data') window.rigOutputs[event.id] = (window.rigOutputs[event.id] ?? '') + event.data; });
  });
  const output = id => page.evaluate(id => window.rigOutputs[id] ?? '', id);
  /** Chooses a connection on the rail, which brings its items into view; a connection made through the API is not chosen by itself. */
  const chooseConnection = id => page.locator(`.connection-chip[data-id="${id}"] .connection-titles`).click();
  return { application, page, errors, state, api, waitState, recordOutput, output, chooseConnection, modal: () => modalOf(page), close: () => application.close() };
}
