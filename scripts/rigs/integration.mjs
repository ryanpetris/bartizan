import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { withDirectory, startSshd, launch, waitFor } from './lib/harness.mjs';
import { handleAuthentication, testAuthentication } from './lib/http-auth.mjs';
import { testTerminalRendering } from './lib/terminal-rendering.mjs';
import { testClipboard } from './lib/clipboard.mjs';
import { testPageClose, testDisconnectCleanup, testTransportDiagnostics, testAuthenticationTransportLoss, testBrowserStartupDisconnect } from './lib/browser-lifecycle.mjs';
import { testHostKeyPins } from './lib/host-keys.mjs';
import { testProfileLaunch } from './lib/profile-launch.mjs';
import { testProfileTags } from './lib/tags.mjs';
import { testSessionUI } from './lib/session-ui.mjs';
import { testBrowserInteractions } from './lib/browser-interaction.mjs';

async function checkSandbox(application) {
  const processes = await application.evaluate(({ app, webContents }) => ({ disabled: app.commandLine.hasSwitch('no-sandbox'), main: process.pid, renderers: webContents.getAllWebContents().map(contents => contents.getOSProcessId()) }));
  assert.equal(processes.disabled, false);
  const sandbox = async pid => {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const match = /^Seccomp_filters:\s+(\d+)$/m.exec(status);
    assert.ok(match, 'Linux must report seccomp filter counts');
    const namespaces = /^NSpid:\s+(.+)$/m.exec(status);
    assert.ok(namespaces, 'Linux must report nested process IDs');
    return { filters: Number(match[1]), depth: namespaces[1].trim().split(/\s+/).length };
  };
  const inherited = await sandbox(processes.main);
  for (const pid of processes.renderers) {
    const renderer = await sandbox(pid);
    assert.ok(renderer.filters > inherited.filters, 'Renderer must install its own seccomp filter');
    assert.ok(renderer.depth > inherited.depth, 'Renderer must have its own PID namespace');
  }
  console.log('Application and browser renderers have seccomp filters and isolated PID namespaces.');
}

/** Records terminal output in the page, all together and by terminal. */
const recordOutput = page => page.evaluate(() => {
  window.rigOutput = ''; window.outputs = {};
  window.bartizan.onEvent(event => {
    if (event.type !== 'data') return;
    window.rigOutput += event.data;
    window.outputs[event.id] = (window.outputs[event.id] ?? '') + event.data;
  });
});

await withDirectory('integration', async (directory, cleanup) => {
  const http = createServer((req, res) => {
    if (handleAuthentication(req, res)) return;
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Remote fixture</title><h1>Remote fixture</h1><input id="draft"><script>document.cookie="rig=present; SameSite=Lax"; localStorage.setItem("rig", "present")</script>');
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  cleanup(() => { http.closeAllConnections(); http.close(); });
  const httpPort = http.address().port;
  const url = tag => `http://localhost:${httpPort}/?tab=${tag}`;
  // The identity path exercises OpenSSH token escaping.
  const sshd = await startSshd(directory, { passphrase: 'rig-passphrase', name: '100%identity' });
  cleanup(sshd.stop);
  const profile = (host, policy) => `    host: "${host}"\n    port: ${sshd.port}\n    auth:\n      method: key\n      identity_files: [${JSON.stringify(sshd.identity)}]\n      passphrase: {source: literal, value: rig-passphrase}\n    host_keys:\n      policy: ${policy}\n`;
  const config = join(directory, 'rig.yaml');
  // `ask` uses another host name, so its trust decisions stay apart from the other profiles'.
  await writeFile(config, `version: 1\nprofiles:\n  rig:\n${profile('127.0.0.1', 'accept-new')}  other:\n${profile('127.0.0.1', 'accept-new')}  ask:\n${profile('localhost', 'ask')}  template:\n    host: "127.0.0.1"\n    port: ${sshd.port}\n    auth:\n      method: key\n  broken:\n    host: example.invalid\n    ssh:\n      Ciphers: not-a-cipher\n`);
  const trust = join(directory, 'state', 'ssh', 'known_hosts');
  let app = await launch(directory, config);
  cleanup(() => app.close());
  const { application, page, errors, state, api, waitState } = app;
  await expect(page.locator('.home-view')).toBeVisible();
  await testProfileLaunch(app, config, url('autoclose'));
  await testHostKeyPins(app, config, sshd.hostKey, `${sshd.identity}.pub`);
  // The application menu stays hidden and holds only the accelerators of the shortcuts a page sees first: no roles, and nothing to choose.
  const menu = await application.evaluate(({ Menu, BrowserWindow }) => ({ visible: BrowserWindow.getAllWindows()[0].isMenuBarVisible(), items: Menu.getApplicationMenu().items.flatMap(item => item.submenu.items.map(entry => ({ role: entry.role ?? null, accelerator: entry.accelerator }))) }));
  assert.equal(menu.visible, false);
  assert.ok(menu.items.length > 0 && menu.items.every(item => item.role === null && item.accelerator));
  assert.equal(await application.evaluate(({ app }) => {
    let prevented = false; let selected = 'unanswered';
    app.emit('select-client-certificate', { preventDefault() { prevented = true; } }, null, 'https://example.invalid', [], certificate => { selected = certificate; });
    return prevented && selected === undefined;
  }), true);
  console.log('Production menu is absent and automatic client certificate selection is declined.');
  await assert.rejects(api('connect', { profileId: 'broken' }));
  assert.equal((await state()).connections.length, 0);
  assert.equal((await state()).workspaces.length, 0);
  console.log('A connection that fails to start leaves no connection or browser session.');
  const retained = await api('connect', { profileId: 'other' });
  await waitState(s => s.connections.find(c => c.id === retained)?.status === 'connected');
  await api('disconnect', retained);
  const terminalsBeforeFailure = (await state()).terminals.map(t => t.id);
  const validConfig = await readFile(config, 'utf8');
  await writeFile(config, validConfig.replace('  other:\n', '  other:\n    ssh:\n      Ciphers: not-a-cipher\n'));
  await api('reloadConfig');
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(api('connect', { profileId: 'other' }));
    assert.deepEqual((await state()).terminals.map(t => t.id), terminalsBeforeFailure);
  }
  await writeFile(config, validConfig);
  await api('reloadConfig');
  await api('removeConnection', retained);
  console.log('Failed transport setup on a retained connection leaves no extra terminal tabs.');


  await recordOutput(page);
  const first = await api('connect', { profileId: 'rig' });
  const duplicates = await Promise.all(Array.from({ length: 4 }, () => api('connect', { profileId: 'rig' })));
  assert.ok(duplicates.every(id => id === first));
  let current = await waitState(s => s.connections.find(c => c.id === first)?.status === 'connected');
  assert.equal(current.connections.filter(c => c.profileId === 'rig' && c.status !== 'closed').length, 1);
  assert.equal(current.workspaces.length, 0);
  const terminal1 = current.terminals.find(t => t.connectionId === first).id;
  const terminal2 = await api('newTerminal', first);
  for (const id of [terminal1, terminal2]) await api('input', id, 'stty -echo; exec sh\n');
  async function shell(id, command) {
    const tag = `RESULT_${Math.random().toString(36).slice(2)}`;
    const encoded = Buffer.from(command).toString('base64');
    await api('input', id, `printf '\\n${tag}:'; printf '%s' '${encoded}' | base64 -d | sh | tr -d '\\r\\n'; printf ':${tag}END\\n'\n`);
    await page.waitForFunction(({ id, tag }) => new RegExp('\\r?\\n' + tag + ':([^\\r\\n]*):' + tag + 'END').test(window.outputs[id] ?? ''), { id, tag }, { timeout: 15000 });
    return page.evaluate(({ id, tag }) => window.outputs[id].match(new RegExp('\\r?\\n' + tag + ':([^\\r\\n]*):' + tag + 'END'))[1].trim(), { id, tag });
  }
  const transport1 = await shell(terminal1, 'printf "%s" "$SSH_CONNECTION"');
  const transport2 = await shell(terminal2, 'printf "%s" "$SSH_CONNECTION"');
  assert.equal(transport1, transport2);
  assert.equal(transport1.split(' ').length, 4);
  assert.equal(await shell(terminal1, 'printf terminal-one'), 'terminal-one');
  assert.equal(await shell(terminal2, 'printf terminal-two'), 'terminal-two');
  await page.evaluate(id => { window.bartizan.resize(id, 91, 37); window.bartizan.input(id, "printf '\\nRIG_UNICODE_λ_終\\n'; stty size\n"); }, terminal1);
  await page.waitForFunction(() => window.rigOutput.includes('RIG_UNICODE_λ_終') && window.rigOutput.includes('37 91'));
  execFileSync('vim', ['--version']);
  await api('input', terminal1, 'vim -Nu NONE -n\n');
  await page.waitForFunction(() => /\x1b\[\?1049h/.test(window.rigOutput));
  await api('input', terminal1, 'iUnicode λ 終\x1b:q!\r');
  await page.waitForFunction(() => /\x1b\[\?1049l/.test(window.rigOutput));
  console.log('PTY resize, Unicode input/output and interactive Vim passed.');

  await assert.rejects(api('reconnect', first));
  await assert.rejects(api('removeConnection', first));
  assert.equal(await api('connect', { profileId: 'rig' }), first);
  const details = await api('details', first);
  assert.equal(details.username, userInfo().username);
  const draft = await api('profileDraft', 'rig');
  const preview = await api('profilePreview', { token: draft.token, values: {}, reset: [] });
  const main = await application.evaluate(() => process.pid);
  let master;
  for (const pid of (await readFile(`/proc/${main}/task/${main}/children`, 'utf8')).trim().split(/\s+/)) {
    const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0').slice(1, -1);
    if (args.includes('-M')) master = args;
  }
  assert.ok(master);
  // Details show negotiated values when the local client reports connection information.
  const conninfo = spawnSync('ssh', ['-F', 'none', '-S', master[master.indexOf('-S') + 1], '-O', 'conninfo', '--', '127.0.0.1']).status === 0;
  if (conninfo) { assert.ok(details.cipher); assert.ok(details.received); }
  const displayed = preview.map((arg, index) => arg === '<control socket>' || arg === '127.0.0.1:<allocated port>' || arg.startsWith('UserKnownHostsFile=') ? master[index] : arg);
  assert.deepEqual(displayed, master);
  console.log('One profile transport, concurrent duplicate connects, independent multiplexed shells and the effective command preview passed.');

  for (const closeInitial of [true, false]) {
    const delayed = await api('connect', { profileId: 'ask' });
    const pending = await waitState(s => s.challenges.some(c => c.connectionId === delayed));
    const initial = pending.terminals.find(t => t.connectionId === delayed).id;
    if (closeInitial) {
      await api('closeTerminal', initial);
      assert.equal((await state()).connections.find(c => c.id === delayed)?.status, 'connecting');
    } else {
      await api('resize', initial, 64, 17);
      await api('answer', pending.challenges.find(c => c.connectionId === delayed).id, 'yes');
      await waitState(s => s.connections.find(c => c.id === delayed)?.status === 'connected');
      assert.equal(await shell(initial, 'stty size </dev/tty'), '17 64');
      // Forget the accepted key so `ask` prompts again.
      await rm(trust);
    }
    await api('disconnect', delayed);
  }
  console.log('Closing and resizing terminals during authentication passed.');
  await testAuthenticationTransportLoss(app);
  const rejected = await api('connect', { profileId: 'ask' });
  const rejectedState = await waitState(s => s.challenges.some(c => c.connectionId === rejected));
  await api('answer', rejectedState.challenges.find(c => c.connectionId === rejected).id, 'no');
  await waitState(s => s.connections.find(c => c.id === rejected)?.status === 'closed');
  await page.waitForFunction(() => window.rigOutput.includes('Host key verification failed'));
  await api('closeTerminal', rejectedState.terminals.find(t => t.connectionId === rejected).id);
  await waitState(s => !s.terminals.some(t => t.connectionId === rejected));
  await api('removeConnection', rejected);
  await waitState(s => !s.connections.some(c => c.id === rejected));
  console.log('Authentication failure output remains visible until its terminal closes.');
  await testTransportDiagnostics(app, sshd.pid);
  await testBrowserStartupDisconnect(app, url('startup-disconnect'));

  /** Opens a new browser session showing a page. */
  const browse = async (connection, address) => {
    const id = await api('newBrowser', connection);
    const tab = (await waitState(s => s.workspaces.find(w => w.id === id)?.tabs.length)).workspaces.find(w => w.id === id).tabs[0].id;
    await api('browser', id, 'navigate', tab, address);
    return id;
  };
  const loaded = () => waitState(s => s.workspaces.every(w => w.tabs.every(t => t.title === 'Remote fixture' && !t.loading)), 'pages to load');
  const web = (tag, code) => application.evaluate(async ({ webContents }, { tag, code }) => {
    const contents = webContents.getAllWebContents().find(w => w.getURL().includes(`tab=${tag}`));
    if (!contents) throw new Error(`Missing page ${tag}`);
    return contents.executeJavaScript(code);
  }, { tag, code });
  const one = await browse(first, url('one'));
  await api('browser', one, 'new', undefined, url('one-b'));
  const two = await browse(first, url('two'));
  assert.notEqual(one, two);
  await loaded();
  await web('one', 'document.cookie="account=one; Max-Age=3600; SameSite=Lax"; localStorage.setItem("account","one")');
  assert.match(await web('one-b', 'document.cookie'), /account=one/);
  assert.equal(await web('one-b', 'localStorage.getItem("account")'), 'one');
  assert.ok(!(await web('two', 'document.cookie')).includes('account='));
  assert.equal(await web('two', 'localStorage.getItem("account")'), null);
  await web('two', 'document.cookie="account=two; SameSite=Lax"; localStorage.setItem("account","two")');
  await api('browser', two, 'new', undefined, url('two-b'));
  await loaded();
  assert.equal(await web('two-b', 'localStorage.getItem("account")'), 'two');
  await api('closeTerminal', terminal1);
  assert.equal((await state()).connections.find(c => c.id === first).status, 'connected');
  await api('closeTerminal', terminal2);
  assert.equal(await web('one', 'fetch(location.href).then(r=>r.status)'), 200);
  const third = await api('newTerminal', first);
  await api('input', third, 'stty -echo; exec sh\n');
  assert.equal(await shell(third, 'printf "%s" "$SSH_CONNECTION"'), transport1);
  console.log('Tabs of one browser session share cookies and storage, sessions stay isolated, and browser-only connections stay open.');

  assert.equal(await application.evaluate(({ webContents }) => {
    globalThis.rigSession = webContents.getAllWebContents().find(w => w.getURL().includes('tab=two')).session;
    return globalThis.rigSession.isPersistent();
  }), false);
  await api('browser', two, 'close-workspace');
  assert.equal(await application.evaluate(async () => (await globalThis.rigSession.cookies.get({})).length), 0);
  await testPageClose(app, first, url('selfclose'));
  await api('newTerminal', first);
  await testDisconnectCleanup(app, first, url('one'));
  assert.ok((await state()).terminals.every(t => t.status === 'closed'));
  await assert.rejects(api('newTerminal', first));
  await assert.rejects(api('newBrowser', first));
  console.log('Closed browser sessions discard their data; disconnect ends terminals and keeps browser contents.');

  const next = await api('reconnect', first);
  assert.equal(next, first);
  await waitState(s => s.connections.find(c => c.id === next)?.status === 'connected');
  assert.ok((await state()).workspaces.some(w => w.id === one));
  await api('browser', one, 'new', undefined, url('retained'));
  await loaded();
  assert.equal(await web('retained', 'localStorage.getItem("account")'), 'one');
  assert.match(await web('retained', 'document.cookie'), /account=one/);
  await browse(next, url('fresh'));
  await loaded();
  assert.equal(await web('fresh', 'localStorage.getItem("account")'), null);
  console.log('Browser sessions keep their tabs and data through reconnect.');
  await testAuthentication(app, httpPort, next);
  await recordOutput(page);
  await checkSandbox(application);
  await testSessionUI(app, next);
  await testProfileTags(app, config, next);
  const final1 = await api('newTerminal', next);
  const final2 = await api('newTerminal', next);
  for (const id of [final1, final2]) await api('input', id, 'stty -echo; exec sh\n');
  await testClipboard(app, final1);
  await testTerminalRendering(app, final1, final2);
  await testBrowserInteractions(app, httpPort, final1);

  let socket;
  for (const pid of (await readFile(`/proc/${main}/task/${main}/children`, 'utf8')).trim().split(/\s+/)) {
    const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0');
    if (args.includes('-M') && args.includes('-S')) socket = args[args.indexOf('-S') + 1];
  }
  assert.ok(socket?.includes('/bartizan-ssh-'));
  const incoming = () => (sshd.log().match(/Connection from /g) ?? []).length;
  const before = incoming();
  await rm(socket);
  const unavailable = await api('newTerminal', next);
  await waitState(s => s.terminals.find(t => t.id === unavailable)?.status === 'closed');
  assert.equal(incoming(), before);
  console.log('Missing control socket fails without a new SSH transport.');
  assert.deepEqual(errors, []);

  await app.close();
  app = await launch(directory, config);
  const restarted = await app.state();
  assert.equal(restarted.connections.length, 0);
  assert.equal(restarted.workspaces.length, 0);
  const again = await app.api('connect', { profileId: 'rig' });
  await app.waitState(s => s.connections.find(c => c.id === again)?.status === 'connected');
  assert.equal((await app.api('details', again)).status, 'connected');
  const id = await app.api('newBrowser', again);
  const tab = (await app.waitState(s => s.workspaces[0]?.tabs.length)).workspaces[0].tabs[0].id;
  await app.api('browser', id, 'navigate', tab, url('restart'));
  await app.waitState(s => s.workspaces[0].tabs[0].title === 'Remote fixture' && !s.workspaces[0].tabs[0].loading);
  await waitFor(() => app.application.evaluate(({ webContents }) => webContents.getAllWebContents().some(w => w.getURL().includes('tab=restart'))));
  assert.equal(await app.application.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getURL().includes('tab=restart')).executeJavaScript('localStorage.getItem("account")')), null);
  assert.deepEqual(app.errors, []);
  console.log('A restarted application starts without connections, and its browser sessions start empty.');
});
