import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/** Opens a new browser session for a connection and shows an address in its tab. */
export async function browse(app, connectionId, url) {
  const id = await app.api('newBrowser', connectionId);
  const tab = (await app.waitState(s => s.workspaces.find(w => w.id === id)?.tabs.length)).workspaces.find(w => w.id === id).tabs[0].id;
  await app.api('browser', id, 'navigate', tab, url);
  return id;
}

export async function testPageClose(app, connectionId, url) {
  const { application, state, api } = app;
  const id = await browse(app, connectionId, url);
  await expect.poll(async () => (await state()).workspaces.find(w => w.id === id)?.tabs[0]?.title).toBe('Remote fixture');
  await api('browser', id, 'new', undefined, `${url}&second=1`);
  await expect.poll(async () => (await state()).workspaces.find(w => w.id === id)?.tabs.every(t => !t.loading && t.title === 'Remote fixture')).toBe(true);
  await api('showBrowser', id, { x: 300, y: 160, width: 600, height: 400 });
  await application.evaluate(({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(w => w.getURL() === url);
    if (!contents) throw new Error(JSON.stringify({ url, urls: webContents.getAllWebContents().map(w => w.getURL()) }));
    void contents.executeJavaScript('setTimeout(() => window.close(), 0)');
  }, url);
  await expect.poll(async () => (await state()).workspaces.find(w => w.id === id)?.tabs.length).toBe(1);
  const last = (await state()).workspaces.find(w => w.id === id).tabs[0].id;
  await api('browser', id, 'select', last);
  await application.evaluate(({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(w => w.getURL() === `${url}&second=1`);
    contents.focus();
    if (!contents) throw new Error(JSON.stringify({ url, urls: webContents.getAllWebContents().map(w => w.getURL()) }));
    void contents.executeJavaScript('setTimeout(() => window.close(), 0)');
  }, url);
  await expect.poll(async () => (await state()).workspaces.find(w => w.id === id)?.tabs.length).toBe(0);
  assert.equal(await application.evaluate(({ webContents }, url) => webContents.getAllWebContents().some(w => w.getURL().startsWith(url)), url), false);
  await api('browser', id, 'close-workspace');
  await expect.poll(async () => (await state()).workspaces.some(w => w.id === id)).toBe(false);
  await api('showBrowser', null);
  console.log('Self-closing pages discard their tabs and leave their session open until it is closed.');
}

export async function testDisconnectCleanup(app, id, url) {
  const { application, state, api } = app;
  const page = code => application.evaluate(({ webContents }, { url, code }) => webContents.getAllWebContents().find(w => w.getURL() === url).executeJavaScript(code), { url, code });
  await page('document.body.dataset.kept = "yes"');
  await api('disconnect', id);
  const current = await state();
  assert.equal(current.connections.find(c => c.id === id).status, 'closed');
  assert.ok(current.workspaces.some(w => w.connectionId === id));
  await expect.poll(() => page('fetch(location.href).then(() => "loaded", () => "failed")')).toBe('failed');
  assert.equal(await page('document.body.dataset.kept'), 'yes');
  console.log('Disconnect keeps browser pages and their state while their requests fail.');
}

export async function testTransportDiagnostics(app, serverPid) {
  const { page, state, api } = app;
  const children = async pid => (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => '')).trim().split(/\s+/).filter(Boolean);
  const before = new Set(await children(serverPid));
  const id = await api('connect', { profileId: 'other' });
  await expect.poll(async () => (await state()).connections.find(c => c.id === id)?.status).toBe('connected');
  const peers = (await children(serverPid)).filter(pid => !before.has(pid));
  assert.equal(peers.length, 1);
  await page.evaluate(() => {
    window.rigDiagnostics = [];
    window.rigDiagnosticsOff = window.bartizan.onEvent(event => { if (event.type === 'errors') window.rigDiagnostics = event.log.history.filter(entry => entry.source === 'ssh').map(entry => entry.message); });
  });
  const { createServer } = await import('node:net');
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const workspace = await browse(app, id, `http://localhost:${port}/`);
  for (const terminal of (await state()).terminals.filter(t => t.connectionId === id)) await api('closeTerminal', terminal.id);
  await expect.poll(async () => Boolean((await state()).workspaces.find(w => w.id === workspace)?.tabs[0]?.error)).toBe(true);
  for (let i = 0; i < 5; i++) {
    await api('browser', workspace, 'reload');
    await expect.poll(async () => Boolean((await state()).workspaces.find(w => w.id === workspace)?.tabs[0]?.error)).toBe(true);
  }
  assert.deepEqual(await page.evaluate(() => window.rigDiagnostics), []);
  const stopPeer = async pid => {
    for (const child of await children(pid)) await stopPeer(child);
    try { process.kill(Number(pid), 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  await stopPeer(peers[0]);
  await expect.poll(async () => (await state()).connections.find(c => c.id === id)?.status).toBe('closed');
  await expect.poll(() => page.evaluate(() => window.rigDiagnostics.length)).toBe(1);
  const message = await page.evaluate(() => { window.rigDiagnosticsOff(); return window.rigDiagnostics[0]; });
  assert.ok(message.length <= 4200);
  assert.ok(message.split('\n').length <= 4);
  assert.match(message, /closed|reset|Broken pipe|fatal/i);
  await api('removeConnection', id);
  console.log('Browser request failures stay out of application alerts; transport loss reports one bounded diagnostic.');
}

export async function testAuthenticationTransportLoss(app) {
  const { application, state, api } = app;
  const main = await application.evaluate(() => process.pid);
  const children = async () => (await readFile(`/proc/${main}/task/${main}/children`, 'utf8')).trim().split(/\s+/);
  const before = new Set(await children());
  const id = await api('connect', { profileId: 'ask' });
  await expect.poll(async () => (await state()).challenges.some(c => c.connectionId === id)).toBe(true);
  let master;
  for (const pid of (await children()).filter(pid => !before.has(pid))) {
    const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0');
    if (args.includes('-M')) master = Number(pid);
  }
  assert.ok(master);
  process.kill(master, 'SIGKILL');
  await expect.poll(async () => {
    const current = await state();
    return current.connections.find(c => c.id === id)?.status === 'closed' && !current.challenges.some(c => c.connectionId === id);
  }, { timeout: 2000 }).toBe(true);
  await api('removeConnection', id);
  console.log('A master lost during authentication closes immediately and dismisses its askpass challenge.');
}

export async function testBrowserStartupDisconnect(app, url) {
  const { application, api, waitState } = app;
  const main = await application.evaluate(() => process.pid);
  const children = async () => (await readFile(`/proc/${main}/task/${main}/children`, 'utf8')).trim().split(/\s+/);
  const before = new Set(await children());
  const id = await api('connect', { profileId: 'other' });
  await waitState(s => s.connections.find(c => c.id === id)?.status === 'connected');
  let master;
  for (const pid of await children()) {
    if (before.has(pid)) continue;
    const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0');
    if (args.includes('-M')) master = Number(pid);
  }
  assert.ok(master);
  await application.evaluate(({ session }) => {
    const original = session.fromPartition;
    session.fromPartition = (...args) => {
      const partition = original(...args);
      if (!args[0].startsWith('browser-')) return partition;
      session.fromPartition = original;
      const offline = partition.enableNetworkEmulation.bind(partition);
      partition.enableNetworkEmulation = options => { globalThis.rigBrowserOffline = options.offline; offline(options); };
      const setProxy = partition.setProxy.bind(partition);
      partition.setProxy = async options => {
        await setProxy(options);
        await new Promise(resolve => { globalThis.rigReleaseProxy = resolve; });
      };
      return partition;
    };
  });
  const opening = api('newBrowser', id);
  await expect.poll(() => application.evaluate(() => Boolean(globalThis.rigReleaseProxy))).toBe(true);
  process.kill(master, 'SIGKILL');
  await waitState(s => s.connections.find(c => c.id === id)?.status === 'closed');
  await application.evaluate(() => { globalThis.rigReleaseProxy(); delete globalThis.rigReleaseProxy; });
  const workspace = await opening;
  assert.equal(await application.evaluate(() => globalThis.rigBrowserOffline), true);
  const snapshot = await waitState(s => s.workspaces.find(w => w.id === workspace)?.tabs.length);
  const tab = snapshot.workspaces.find(w => w.id === workspace).tabs[0].id;
  await api('browser', workspace, 'navigate', tab, url);
  await waitState(s => s.workspaces.find(w => w.id === workspace)?.tabs[0]?.error);
  await api('removeConnection', id);
  console.log('A browser created during SSH transport loss is offline before its first navigation.');
}
