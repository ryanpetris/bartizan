import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { writeFile, readFile, mkdir, chmod, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { withDirectory, startSshd, sshProfile, launch, freePort } from './lib/harness.mjs';

execFileSync('python3', ['-B', 'tests/remote-applications.py'], { stdio: 'inherit' });
await withDirectory('applications', async (directory, cleanup) => {
  const helperPid = join(directory, 'helper.pid');
  const tmuxRoot = join(directory, `tmux-${userInfo().uid}`), tmuxSocket = join(tmuxRoot, 'test');
  await mkdir(tmuxRoot);
  const tmux = (...args) => execFileSync('/usr/bin/tmux', ['-S', tmuxSocket, ...args]);
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'application-rig', 'sleep 600');
  cleanup(() => { try { tmux('kill-server'); } catch {} });
  // The host's account has a home of its own, so no installed T3 Code or its data is ever in reach.
  const bin = join(directory, 'bin'), cache = join(directory, 'cache'), data = join(directory, 'data'), home = join(directory, 'home');
  await mkdir(home);
  const version = join(cache, 'bartizan/tools/vscode/1.10.0');
  await mkdir(bin); await mkdir(version, { recursive: true });
  await writeFile(join(version, 'code'), await readFile('tests/fixtures/application.py')); await chmod(join(version, 'code'), 0o700);
  await writeFile(join(version, 'release.json'), JSON.stringify({ name: '1.10.0', version: 'a'.repeat(40) }));
  await writeFile(join(version, 'complete'), '');
  const executable = async (file, text) => { await writeFile(file, text); await chmod(file, 0o700); };
  // Exercise the production helper over SSH with an unavailable release service.
  await executable(join(bin, 'python3'), `#!/usr/bin/python3
import sys, os
if len(sys.argv) > 3 and sys.argv[2] == '-c':
    open(${JSON.stringify(helperPid)}, 'w').write(str(os.getpid()))
    program = "import urllib.request\\nurllib.request.urlopen = lambda *args, **kwargs: (_ for _ in ()).throw(OSError('offline'))\\n" + sys.argv[3]
    os.execv('/usr/bin/python3', ['python3', '-u', '-c', program] + sys.argv[4:])
os.execv('/usr/bin/python3', ['python3'] + sys.argv[1:])
`);
  const login = join(directory, 'login');
  await executable(login, '#!/bin/sh\nexec /bin/sh -c "$2"\n');
  const shell = join(directory, 'shell');
  await executable(shell, `#!/bin/sh\nexport HOME='${home}'\nunset T3CODE_HOME\nexport PATH='${bin}':/usr/bin:/bin\nexport SHELL='${login}'\nexport TMUX_TMPDIR='${directory}'\nexport XDG_CACHE_HOME='${cache}'\nexport XDG_DATA_HOME='${data}'\nif [ -z "$SSH_ORIGINAL_COMMAND" ]; then exec /bin/sh; fi\nexec /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n`);
  const sshd = await startSshd(directory, { config: `ForceCommand ${shell}\n` }); cleanup(sshd.stop);
  const config = join(directory, 'config.yaml');
  await writeFile(config, `version: 1\nsettings:\n  remoteSessionIntegration: false\nprofiles:\n  test:\n${sshProfile(sshd)}`);
  const app = await launch(directory, config); cleanup(app.close);
  const { api, page, waitState, application } = app;
  const connection = await api('connect', { profileId: 'test' });
  await waitState(s => s.connections[0]?.status === 'connected');
  await app.chooseConnection(connection);
  assert.deepEqual((await app.state()).connections[0].processes, []);
  await page.evaluate(() => { window.applicationSnapshots = []; window.processSnapshots = []; window.bartizan.onEvent(event => { if (event.type === 'state') { window.applicationSnapshots.push(event.state.workspaces); window.processSnapshots.push(event.state.connections[0].processes); } }); });
  await page.locator('.connection-add:visible').click();
  await app.menu.choose('Visual Studio Code');
  await expect(page.locator('.application-status')).toBeVisible();
  assert.equal((await app.state()).workspaces.find(w => w.application)?.tabs[0]?.title, 'Visual Studio Code');
  await expect(page.getByRole('button', { name: 'Close Tab Visual Studio Code', exact: true })).toBeVisible();
  // The launch is headed by the name its row in the sidebar carries.
  const applicationTab = (await app.state()).workspaces.find(w => w.application).tabs[0].id;
  await expect.poll(() => page.evaluate(id => [document.querySelector('.application-status h2')?.textContent, document.querySelector(`.nav-item[data-kind="tab"][data-id="${id}"] .nav-label`)?.textContent], applicationTab)).toEqual(['Visual Studio Code', 'Visual Studio Code']);
  await expect(page.locator('.application-notice')).toContainText('Fixture application terms', { timeout: 30000 });
  await expect(page.locator('.browser-toolbar')).toBeHidden();
  const first = (await app.state()).workspaces.find(w => w.application);
  await page.locator('.nav-item[data-kind="details"]').click();
  const launcher = page.locator('.process-row').filter({ has: page.getByText('Visual Studio Code Launcher', { exact: true }) });
  await expect(launcher.locator('.process-status')).toHaveText('Running');
  await expect(launcher.locator('.process-message')).toHaveText('Awaiting Approval');
  assert.ok(await launcher.evaluate(row => { const name = row.querySelector('.process-name').getBoundingClientRect(), message = row.querySelector('.process-message').getBoundingClientRect(); return Math.abs(name.left - message.left) < 1 && message.top >= name.bottom && Math.abs(message.right - row.getBoundingClientRect().right) < 1; }), 'activity spans the row beneath the name');
  await expect(launcher.locator('.process-pid')).toHaveText(/^PID \d+$/);
  const starting = await page.evaluate(() => window.processSnapshots.flat());
  for (const name of ['Bartizan Helper', 'Visual Studio Code Launcher']) assert.ok(starting.some(record => record.name === name && record.status === 'starting' && record.pid === undefined));
  await page.locator(`.nav-item[data-kind="tab"][data-id="${applicationTab}"]`).click();
  // The bar over the view carries the name of the tab in view, while the launch keeps the application's own name.
  await page.evaluate(id => {
    window.applicationNames = new Set();
    const record = () => {
      const row = document.querySelector(`.nav-item[data-kind="tab"][data-workspace="${id}"][aria-current="page"] .nav-label`)?.textContent;
      const view = document.querySelector('#view-title .titlebar-item')?.textContent;
      if (!row || !view) return;
      window.applicationNames.add(`${view}|${row}|${document.querySelector('.application-status h2')?.textContent ?? ''}`);
    };
    new MutationObserver(record).observe(document.body, { subtree: true, childList: true, characterData: true });
    setInterval(record, 20);
  }, first.id);
  const initialSnapshots = await page.evaluate(id => window.applicationSnapshots.flatMap(workspaces => workspaces.filter(w => w.id === id)), first.id);
  assert.ok(initialSnapshots.length);
  assert.ok(initialSnapshots.every(w => w.application?.application === 'vscode' && w.name === 'Visual Studio Code' && w.tabs.every(t => t.title === 'Visual Studio Code')));
  assert.equal((await app.state()).connections[0].remoteSessions, undefined);
  await page.getByRole('button', { name: 'Accept and Continue', exact: true }).click();
  // The launch names the host, the cached release it fell back to, and the transfer beside the bar.
  await expect.poll(() => page.evaluate(() => ['[role=status]', '.application-measure', '.dialog-context'].map(selector => document.querySelector('.application-status ' + selector)?.textContent).concat(document.querySelector('.application-status progress')?.getAttribute('value'))), { intervals: [100] })
    .toEqual(['Downloading Visual Studio Code Server', '50 B of 100 B', 'test · 1.10.0 · cached', '50']);
  await expect(page.locator('.application-status [role=status]')).toHaveText('Unpacking Visual Studio Code Server');
  await expect(page.locator('.application-status [role=status]')).toHaveText('Starting Visual Studio Code Server');
  await waitState(s => s.workspaces.find(w => w.id === first.id)?.application.event.type === 'applications.ready', 'application ready');
  await expect(page.locator('.application-status')).toHaveCount(0);
  // The application navigates itself from then on, and every state it passes through keeps the view with its page.
  await page.evaluate(() => { window.applicationSnapshots.length = 0; });
  const reloading = (await app.state()).workspaces.find(w => w.id === first.id).tabs[0].id;
  await api('browser', first.id, 'reload', reloading);
  const reloadStates = () => page.evaluate(id => window.applicationSnapshots.flatMap(workspaces => workspaces.filter(w => w.id === id)), first.id);
  await expect.poll(async () => { const seen = await reloadStates(); return seen.some(w => w.tabs[0]?.loading) && seen.at(-1)?.tabs[0]?.loading === false; }).toBe(true);
  for (const seen of await reloadStates())
    assert.ok(seen.application.page === 'open' && seen.application.event.type === 'applications.ready' && seen.tabs[0]?.url && !seen.tabs[0].error,
      `the launch took the view back while the application reloaded itself: ${JSON.stringify(seen.application)}`);
  const state = await app.state(), url = state.workspaces.find(w => w.id === first.id).tabs[0].url;
  const names = await page.evaluate(() => [...window.applicationNames]);
  assert.ok(names.some(entry => entry.startsWith('Visual Studio Code|')), names.join(' , '));
  assert.ok(names.some(entry => entry.startsWith('Editor fixture|')), `the bar over the view never took the page's own name: ${names.join(' , ')}`);
  for (const entry of names) {
    const [view, row, heading] = entry.split('|');
    assert.equal(view, row, `the bar over the view and the tab row disagree: ${entry}`);
    assert.ok(!url.includes(view), `the view is named after its address: ${entry}`);
    assert.ok(heading === '' || heading === 'Visual Studio Code', `the launch is not headed by the application: ${entry}`);
  }
  assert.equal(new URL(url).hostname, '127.0.0.1'); assert.notEqual(new URL(url).port, '8000');
  for (const theme of ['tabs', 'console', 'rail']) {
    await api('settings', { theme });
    await expect(page.locator('.browser-toolbar')).toBeHidden();
    await expect(page.getByRole('button', { name: 'New Tab in Visual Studio Code', exact: true })).toHaveCount(0);
  }
  // The native view receives editing keys, and ordinary tabs use a different session.
  await application.evaluate(({ webContents }) => {
    const editor = webContents.getAllWebContents().find(w => w.getTitle() === 'Editor fixture');
    if (!editor) throw new Error('No editor view');
    return editor.executeJavaScript(`document.querySelector('input').value = 'edited'; document.querySelector('input').value`).then(value => assertValue(value));
    function assertValue(value) { if (value !== 'edited') throw new Error('Editor did not load'); }
  });
  const pid = Number(await readFile(join(data, 'bartizan/tools/vscode/server-data/fixture.pid'), 'utf8'));
  const simultaneous = await api('newApplication', connection, 'vscode');
  await waitState(s => s.workspaces.find(w => w.id === simultaneous)?.application.event.type === 'applications.ready', 'independent simultaneous session');
  await page.locator('.nav-item[data-kind="details"]').click();
  await expect(page.locator('.process-row')).toHaveCount(3);
  await expect(page.locator('.process-status')).toHaveText(['Running', 'Running', 'Running']);
  const processes = (await app.state()).connections[0].processes;
  assert.equal(new Set(processes.map(record => record.id)).size, 3);
  assert.equal(new Set(processes.map(record => record.pid)).size, 3);
  assert.ok(processes.some(record => record.pid === pid));
  await page.locator(`.nav-item[data-kind="tab"][data-id="${applicationTab}"]`).click();
  const simultaneousURL = (await app.state()).workspaces.find(w => w.id === simultaneous).application.event.view.url;
  assert.notEqual(new URL(url).port, new URL(simultaneousURL).port);
  await expect.poll(() => application.evaluate(({ webContents }) => webContents.getAllWebContents().filter(w => w.getTitle() === 'Editor fixture').length)).toBe(2);
  await application.evaluate(async ({ webContents }) => {
    const editors = webContents.getAllWebContents().filter(w => w.getTitle() === 'Editor fixture');
    if (editors.length !== 2 || editors[0].session === editors[1].session || editors.some(w => w.session.isPersistent())) throw new Error('Application sessions are not private and independent');
    await editors[0].session.cookies.set({ url: 'http://127.0.0.1', name: 'isolated', value: 'one' });
    if ((await editors[1].session.cookies.get({ name: 'isolated' })).length) throw new Error('Cookies leaked between applications');
  });
  await page.evaluate(id => Promise.all([
    window.bartizan.browser(id, 'close-workspace'),
    window.bartizan.browser(id, 'close-workspace'),
  ]), simultaneous);
  await waitState(s => !s.workspaces.some(w => w.id === simultaneous));
  assert.equal((await app.state()).workspaces.find(w => w.id === first.id).application.event.type, 'applications.ready');
  const browser = await api('newBrowserTab', connection); assert.notEqual(browser, first.id);
  const countBeforePopup = (await app.state()).workspaces.length;
  await application.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getTitle() === 'Editor fixture').executeJavaScript(`document.querySelector('a').click()`));
  await waitState(s => s.workspaces.find(w => w.id === browser)?.tabs.length === 2, 'application popup uses ordinary browser');
  assert.equal((await app.state()).workspaces.length, countBeforePopup);
  // A blank popup opens in the ordinary session once its opener sends it to an address, and closes.
  await page.waitForTimeout(1100);
  const editor = script => application.evaluate(({ webContents }, script) => webContents.getAllWebContents().find(w => w.getTitle() === 'Editor fixture').executeJavaScript(script, true), script);
  assert.equal(await editor(`(() => { window.rigPopup = window.open(); rigPopup.location = 'http://127.0.0.1:1/blank-popup'; return rigPopup !== null; })()`), true);
  await waitState(s => s.workspaces.find(w => w.id === browser)?.tabs.some(tab => tab.url === 'http://127.0.0.1:1/blank-popup'), 'blank application popup in the ordinary session');
  await expect.poll(() => editor('rigPopup.closed')).toBe(true);
  assert.equal((await app.state()).workspaces.length, countBeforePopup);
  // An application's page reads the clipboard.
  await page.locator(`.nav-item[data-kind="tab"][data-id="${applicationTab}"]`).click();
  await application.evaluate(({ clipboard }) => clipboard.writeText('to application'));
  await expect.poll(() => editor('navigator.clipboard.readText().then(text => text, error => error.name)')).toBe('to application');
  console.log('A blank application popup opens in the ordinary session, and the application reads the clipboard.');
  const firstHelperPid = Number(await readFile(helperPid, 'utf8'));
  await api('browser', first.id, 'close-workspace');
  await expect.poll(() => { try { process.kill(pid, 0); return false; } catch { return true; } }).toBe(true);
  process.kill(firstHelperPid, 0);
  assert.equal(Number(await readFile(helperPid, 'utf8')), firstHelperPid);
  await page.locator('.nav-item[data-kind="details"]').click();
  await expect(page.locator('.process-row')).toHaveCount(1);
  await expect(page.locator('.process-row')).toContainText('Bartizan Helper');
  const stopped = await page.evaluate(() => window.processSnapshots);
  assert.ok(stopped.some(records => records.some(record => record.status === 'stopping' && record.id === first.application.launchId)));
  assert.ok(stopped.every(records => records.every(record => record.status !== 'stopped')));
  process.kill(firstHelperPid, 'SIGKILL');
  await waitState(s => !s.connections[0].processes.some(p => p.name === 'Bartizan Helper'), 'idle helper exits');
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(Number(await readFile(helperPid, 'utf8')), firstHelperPid, 'Idle helper does not restart');
  const second = await api('newApplication', connection, 'vscode');
  await waitState(s => s.workspaces.find(w => w.id === second)?.application.event.type === 'applications.ready', 'cached consent');
  assert.notEqual(Number(await readFile(helperPid, 'utf8')), firstHelperPid, 'Application demand starts a helper after an idle crash');
  const disconnectedPid = Number(await readFile(join(data, 'bartizan/tools/vscode/server-data/fixture.pid'), 'utf8'));
  await api('disconnect', connection);
  await expect.poll(() => { try { process.kill(disconnectedPid, 0); return false; } catch { return true; } }).toBe(true);
  await waitState(s => s.workspaces.find(w => w.id === second)?.application.event.type === 'applications.ended', 'disconnected application');
  await page.locator('.nav-item[data-kind="details"]').click();
  await expect(page.locator('.details-status')).toContainText('Closed');
  await expect(page.locator('.process-status')).toHaveText(['Failed']);
  await expect(page.locator('.process-pid')).toHaveText('');
  await api('reconnect', connection);
  await waitState(s => s.connections[0]?.status === 'connected');
  await api('retryApplication', second);
  await waitState(s => s.workspaces.find(w => w.id === second)?.application.event.type === 'applications.ready', 'retry');
  await api('settings', { remoteSessionIntegration: true });
  await waitState(s => s.connections[0].remoteSessions?.sessions.some(x => x.label === 'application-rig'), 'discovery enabled alongside application');
  await expect(page.locator('.remote-entry + .details-entry')).toBeVisible();
  await page.locator('.nav-item[data-kind="details"]').click();
  await expect(page.locator('.process-row').filter({ hasText: 'Bartizan Helper' }).locator('.process-status')).toHaveText('Running');
  // Both pinned pages share a connection ID; opening either one reveals its own row.
  for (const theme of ['rail', 'console']) {
    await api('settings', { theme });
    const selector = theme === 'rail' ? '.rail-panel-scroll' : '.console-windows .console-scroll';
    await page.locator(selector).evaluate((node, theme) => { node.style[theme === 'rail' ? 'maxHeight' : 'maxWidth'] = theme === 'rail' ? '90px' : '250px'; }, theme);
    await page.locator('.nav-item[data-kind="remote"]').click();
    await page.locator('.icon-button[aria-label="Connection Details"]').click();
    await expect.poll(() => page.locator(selector).evaluate((node, theme) => {
      const item = node.querySelector('.nav-item[data-kind="details"]').getBoundingClientRect(), box = node.getBoundingClientRect();
      return theme === 'rail' ? item.top >= box.top && item.bottom <= box.bottom + 1 : item.left >= box.left && item.right <= box.right + 1;
    }, theme)).toBe(true);
    await page.locator(selector).evaluate(node => node.removeAttribute('style'));
  }
  const previousHelper = Number(await readFile(helperPid, 'utf8'));
  const helperRecord = (await app.state()).connections[0].processes.find(record => record.name === 'Bartizan Helper');
  await page.locator('.nav-item[data-kind="remote"]').click();
  await page.evaluate(() => { window.restartSessions = []; window.bartizan.onEvent(event => { if (event.type === 'state') window.restartSessions.push(event.state.connections[0].remoteSessions?.sessions ?? []); }); });
  process.kill(previousHelper, 'SIGTERM');
  await expect.poll(() => page.evaluate(id => window.processSnapshots.some(records => records.some(record => record.id === id && record.status === 'retrying' && record.pid === undefined)), helperRecord.id)).toBe(true);
  await expect.poll(async () => { const pid = Number(await readFile(helperPid, 'utf8')); return pid > 0 && pid !== previousHelper; }).toBe(true);
  await api('sendHelperMessage', connection, { type: 'sessions.refresh' });
  await waitState(s => s.connections[0].remoteSessions?.sessions.some(x => x.label === 'application-rig'), 'discovery survives helper restart');
  await expect.poll(async () => (await app.state()).connections[0].processes.find(record => record.id === helperRecord.id)?.status).toBe('running');
  assert.notEqual((await app.state()).connections[0].processes.find(record => record.id === helperRecord.id).pid, helperRecord.pid);
  assert.ok(await page.evaluate(() => window.restartSessions.every(sessions => sessions.some(session => session.label === 'application-rig'))), 'restart retains discovered sessions throughout');

  // Cancel on a launch in progress closes it and stops its remote process, as closing its tab does.
  await api('settings', { theme: 'tabs' });
  const pidFile = join(data, 'bartizan/tools/vscode/server-data/fixture.pid');
  const runningPid = Number(await readFile(pidFile, 'utf8'));
  await page.locator('.connection-add:visible').click();
  await app.menu.choose('Visual Studio Code');
  await expect(page.locator('.application-status[data-state="progress"]')).toBeVisible();
  // The fixture truncates its pid file before writing, so only a whole new pid counts.
  let cancelledPid = 0;
  await expect.poll(async () => { const pid = Number(await readFile(pidFile, 'utf8')); if (pid > 0 && pid !== runningPid) cancelledPid = pid; return cancelledPid; }).toBeGreaterThan(0);
  const cancelled = (await app.state()).workspaces.find(w => w.application && w.id !== second).id;
  const cancelledTab = (await app.state()).workspaces.find(w => w.id === cancelled).tabs[0].id;
  await expect(page.locator('.application-status[data-state="progress"]')).toBeVisible();
  await page.locator('.application-status').getByRole('button', { name: 'Cancel', exact: true }).click();
  await waitState(s => !s.workspaces.some(w => w.id === cancelled), 'cancelled launch');
  await api('browser', cancelled, 'close', cancelledTab);
  await assert.rejects(api('browser', cancelled, 'reload', cancelledTab), /Browser session is closed/);
  await expect.poll(() => { try { process.kill(cancelledPid, 0); return false; } catch { return true; } }).toBe(true);
  await api('browser', second, 'close-workspace');
  // A tab can close while its first navigation waits for network cleanup after reconnect.
  const racing = await api('newApplication', connection, 'vscode');
  await waitState(s => s.workspaces.find(w => w.id === racing)?.application.event.type === 'applications.ready');
  await expect.poll(() => application.evaluate(({ webContents }) => webContents.getAllWebContents().some(w => w.getTitle() === 'Editor fixture'))).toBe(true);
  await application.evaluate(({ webContents }) => {
    const session = webContents.getAllWebContents().find(w => w.getTitle() === 'Editor fixture').session;
    const close = session.closeAllConnections.bind(session);
    session.closeAllConnections = async () => {
      session.closeAllConnections = close;
      await close();
      await new Promise(resolve => { globalThis.releaseApplicationNetwork = resolve; });
    };
  });
  await api('disconnect', connection);
  await expect.poll(() => application.evaluate(() => typeof globalThis.releaseApplicationNetwork)).toBe('function');
  await api('reconnect', connection);
  await waitState(s => s.connections[0].status === 'connected');
  await api('retryApplication', racing);
  const readyState = await waitState(s => s.workspaces.find(w => w.id === racing)?.application.event.type === 'applications.ready');
  const racingLaunch = readyState.workspaces.find(w => w.id === racing).application.launchId;
  const pausedHelper = Number(await readFile(helperPid, 'utf8'));
  process.kill(pausedHelper, 'SIGSTOP');
  cleanup(() => { try { process.kill(pausedHelper, 'SIGCONT'); } catch {} });
  await page.evaluate(id => { window.pendingApplicationClose = window.bartizan.browser(id, 'close-workspace'); }, racing);
  await waitState(s => !s.workspaces.some(w => w.id === racing));
  await application.evaluate(() => globalThis.releaseApplicationNetwork());
  await page.evaluate(() => window.pendingApplicationClose);
  assert.equal((await app.state()).connections[0].processes.find(record => record.id === racingLaunch)?.status, 'stopping');
  process.kill(pausedHelper, 'SIGCONT');
  await waitState(s => !s.connections[0].processes.some(record => record.id === racingLaunch));

  // T3 Code is offered only where the host has `t3`; each choice of it opens a session of its own, and they share one server.
  await api('settings', { theme: 'rail' });
  const t3Log = join(home, '.t3/userdata/serve.log'), t3Runtime = join(home, '.t3/userdata/server-runtime.json');
  const starts = async () => { try { return (await readFile(t3Log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  /** Opens the connection's Add menu and returns its items. */
  const addMenu = async () => { await app.menu.close(); await page.locator('.connection-add:visible').click(); return app.menu.shown(); };
  const chooseT3 = () => app.menu.choose('T3 Code');
  const openT3 = async () => { await addMenu(); await chooseT3(); };
  const t3Sessions = state => state.workspaces.filter(w => w.application?.application === 't3');
  // Waits for this many T3 Code sessions, each ready with a launch other than those given.
  const t3Ready = (count, label, previous = []) => waitState(s => {
    const sessions = t3Sessions(s);
    return sessions.length === count && sessions.every(w => w.application.event.type === 'applications.ready' && !previous.includes(w.application.launchId));
  }, label);
  const launches = state => t3Sessions(state).map(w => w.application.launchId);
  const closeT3 = async session => {
    await api('browser', session.id, 'close-workspace');
    await waitState(s => !s.connections[0].processes.some(record => record.id === session.application.launchId), 'T3 Code launch ended');
  };
  // A tab reports its page's title until the main process hears that the page replacing it has committed, so the script
  // may run in a document with nothing in it yet, or in a frame being replaced.
  const t3Pages = () => application.evaluate(({ webContents }) => Promise.all(webContents.getAllWebContents().filter(w => w.getTitle() === 'T3 fixture')
    .map(w => w.executeJavaScript(`document.querySelector('#state')?.textContent`).then(state => `${new URL(w.getURL()).port} ${state}`, () => 'pending'))));
  const reconnect = async () => {
    await api('disconnect', connection);
    await waitState(s => s.connections[0].status === 'closed');
    await api('reconnect', connection);
    await waitState(s => s.connections[0].status === 'connected');
  };
  await waitState(s => s.connections[0].installed?.length === 0, 'applications looked for');
  await page.locator('.nav-item[data-kind="details"]').click();
  assert.ok(!(await addMenu()).includes('T3 Code'));
  await executable(join(bin, 't3'), await readFile('tests/fixtures/t3.py', 'utf8'));
  await reconnect();
  // The connection looks for T3 Code again each time it connects.
  await waitState(s => s.connections[0].installed?.includes('t3'), 'T3 Code found');
  assert.ok((await addMenu()).includes('T3 Code'));
  assert.deepEqual(await app.menu.icons(), { Terminal: 'terminal', 'Browser Session': 'window', 'Visual Studio Code': 'code', 'T3 Code': 'agent' });
  await chooseT3();
  let current = await t3Ready(1, 'T3 Code ready');
  const t3 = t3Sessions(current)[0];
  assert.equal(t3.name, 'T3 Code');
  const port = (await starts())[0].port;
  await expect.poll(t3Pages).toEqual([`${port} paired`]);
  await waitState(s => t3Sessions(s)[0]?.tabs[0]?.url === `http://127.0.0.1:${port}/` && t3Sessions(s)[0].tabs[0].title === 'T3 fixture', 'the paired page names its tab');
  await expect(page.locator('.browser-toolbar')).toBeHidden();
  await expect(page.locator('.application-status')).toHaveCount(0);
  // Choosing T3 Code again opens another session, which is shown and signs in to the same server with a link of its own.
  await openT3();
  current = await t3Ready(2, 'second T3 Code');
  const another = t3Sessions(current).find(w => w.id !== t3.id);
  assert.deepEqual(t3Sessions(current).map(w => w.tabs.length), [1, 1]);
  await expect(page.locator('.nav-item[data-kind="tab"][aria-current="page"]')).toHaveAttribute('data-workspace', another.id);
  await expect.poll(t3Pages).toEqual([`${port} paired`, `${port} paired`]);
  assert.equal((await starts()).length, 1);
  // A page of its own server that T3 Code opens in a new window opens in an ordinary session, which has no sign-in.
  const popup = `http://127.0.0.1:${port}/popup`;
  const popups = s => s.workspaces.flatMap(w => w.application ? [] : w.tabs.filter(tab => tab.url === popup).map(tab => [w.id, tab.id]));
  await application.evaluate(({ webContents }, popup) => webContents.getAllWebContents().find(w => w.getTitle() === 'T3 fixture')
    .executeJavaScript(`window.open(${JSON.stringify(popup)}); 0`, true), popup);
  current = await waitState(s => popups(s).length === 1, 'T3 Code popup in an ordinary session');
  assert.deepEqual(t3Sessions(current).map(w => w.tabs.length), [1, 1]);
  await expect.poll(async () => (await t3Pages()).sort()).toEqual([`${port} paired`, `${port} paired`, `${port} unpaired`]);
  await api('browser', popups(current)[0][0], 'close', popups(current)[0][1]);
  await expect.poll(t3Pages).toEqual([`${port} paired`, `${port} paired`]);
  // The server outlasts the session that started it while another uses it.
  await closeT3(t3);
  assert.ok(alive((await starts())[0].pid));
  await expect.poll(t3Pages).toEqual([`${port} paired`]);
  await openT3();
  current = await t3Ready(2, 'third T3 Code');
  await expect.poll(t3Pages).toEqual([`${port} paired`, `${port} paired`]);
  assert.equal((await starts()).length, 1);
  // Disconnecting keeps the sessions; reconnecting launches each again, on one new server.
  const firstServer = (await starts())[0].pid, before = launches(current);
  await api('disconnect', connection);
  await waitState(s => t3Sessions(s).length === 2 && t3Sessions(s).every(w => w.application.event.type === 'applications.ended'), 'disconnected T3 Code');
  await expect.poll(() => alive(firstServer)).toBe(false);
  await api('reconnect', connection);
  await waitState(s => s.connections[0].status === 'connected');
  await t3Ready(2, 'relaunched T3 Code', before);
  await expect.poll(async () => (await starts()).length).toBe(2);
  const relaunched = (await starts())[1].port;
  await expect.poll(t3Pages).toEqual([`${relaunched} paired`, `${relaunched} paired`]);
  // A host where T3 Code is gone keeps the sessions and says so in them.
  await rm(join(bin, 't3'));
  await reconnect();
  current = await waitState(s => t3Sessions(s).length === 2 && t3Sessions(s).every(w => { const event = w.application.event; return event.type === 'applications.ended' && event.error?.message === 'T3 Code is not installed'; }), 'T3 Code missing');
  const [one, two] = t3Sessions(current);
  await waitState(s => s.connections[0].installed?.length === 0);
  await page.locator(`.nav-item[data-kind="tab"][data-id="${one.tabs[0].id}"]`).click();
  await expect(page.locator('.application-status .notice-message')).toHaveText('T3 Code is not installed');
  assert.ok(!(await addMenu()).includes('T3 Code'));
  await executable(join(bin, 't3'), await readFile('tests/fixtures/t3.py', 'utf8'));
  await page.locator('.application-status').getByRole('button', { name: 'Retry', exact: true }).click();
  await waitState(s => s.workspaces.find(w => w.id === one.id)?.application.event.type === 'applications.ready', 'retried T3 Code');
  const retried = (await starts()).at(-1);
  // The other session keeps the page of its launch before until it launches again.
  await expect.poll(async () => (await t3Pages()).sort()).toEqual([`${relaunched} paired`, `${retried.port} paired`].sort());
  await page.locator(`.nav-item[data-kind="tab"][data-id="${two.tabs[0].id}"]`).click();
  await page.locator('.application-status').getByRole('button', { name: 'Retry', exact: true }).click();
  current = await t3Ready(2, 'both T3 Code sessions retried');
  await expect.poll(t3Pages).toEqual([`${retried.port} paired`, `${retried.port} paired`]);
  assert.equal((await starts()).at(-1).pid, retried.pid);
  // Closing one session keeps the server; closing the last stops the server Bartizan started.
  await closeT3(t3Sessions(current)[0]);
  assert.ok(alive(retried.pid));
  await closeT3(t3Sessions(current)[1]);
  await expect.poll(() => alive(retried.pid)).toBe(false);
  await expect.poll(() => access(t3Runtime).then(() => true, () => false)).toBe(false);
  // A server that was already running is used and left running.
  const sharedPort = await freePort();
  const shared = spawn('python3', [join(bin, 't3'), 'serve', '--host', '127.0.0.1', '--port', String(sharedPort), '--base-dir', join(home, '.t3'), home],
    { env: { ...process.env, HOME: home, T3CODE_NO_BROWSER: '1' }, stdio: 'ignore' });
  cleanup(() => shared.kill('SIGKILL'));
  await expect.poll(() => access(t3Runtime).then(() => true, () => false)).toBe(true);
  const known = (await starts()).length;
  await reconnect();
  await waitState(s => s.connections[0].installed?.includes('t3'), 'T3 Code found again');
  await page.locator('.nav-item[data-kind="details"]').click();
  await openT3();
  await t3Ready(1, 'T3 Code on a running server');
  await openT3();
  current = await t3Ready(2, 'T3 Code on a running server again');
  await expect.poll(t3Pages).toEqual([`${sharedPort} paired`, `${sharedPort} paired`]);
  await closeT3(t3Sessions(current)[0]);
  assert.ok(alive(shared.pid));
  await openT3();
  current = await t3Ready(2, 'T3 Code on a running server once more');
  assert.equal((await starts()).length, known);
  // A server that goes away while the connection is up gives way to one of the connection's own, which its sessions share.
  shared.kill('SIGTERM');
  current = await t3Ready(2, 'T3 Code after its server went away', launches(current));
  assert.equal((await starts()).length, known + 1);
  const own = (await starts()).at(-1);
  await expect.poll(t3Pages).toEqual([`${own.port} paired`, `${own.port} paired`]);
  // So does a crash of the connection's own server.
  process.kill(own.pid, 'SIGKILL');
  current = await t3Ready(2, 'T3 Code after its server crashed', launches(current));
  assert.equal((await starts()).length, known + 2);
  const restarted = (await starts()).at(-1);
  await expect.poll(t3Pages).toEqual([`${restarted.port} paired`, `${restarted.port} paired`]);
  await closeT3(t3Sessions(current)[0]);
  assert.ok(alive(restarted.pid));
  await closeT3(t3Sessions(current)[1]);
  await expect.poll(() => alive(restarted.pid)).toBe(false);
  assert.deepEqual(app.errors, []);
  console.log('Application launch, consent, native view, cache, cleanup, retry, cancel and T3 Code passed');
});
