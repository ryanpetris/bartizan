import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile, readFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { withDirectory, startSshd, sshProfile, launch } from './lib/harness.mjs';

execFileSync('python3', ['-B', 'tests/remote-applications.py'], { stdio: 'inherit' });
await withDirectory('applications', async (directory, cleanup) => {
  const helperPid = join(directory, 'helper.pid');
  const tmuxRoot = join(directory, `tmux-${userInfo().uid}`), tmuxSocket = join(tmuxRoot, 'test');
  await mkdir(tmuxRoot);
  const tmux = (...args) => execFileSync('/usr/bin/tmux', ['-S', tmuxSocket, ...args]);
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'application-rig', 'sleep 600');
  cleanup(() => { try { tmux('kill-server'); } catch {} });
  const bin = join(directory, 'bin'), cache = join(directory, 'cache'), data = join(directory, 'data');
  const version = join(cache, 'bartizan/tools/vscode/1.10.0');
  await mkdir(bin); await mkdir(version, { recursive: true });
  await writeFile(join(version, 'code'), await readFile('tests/fixtures/application.py')); await chmod(join(version, 'code'), 0o700);
  await writeFile(join(version, 'release.json'), JSON.stringify({ name: '1.10.0', version: 'a'.repeat(40) }));
  await writeFile(join(version, 'complete'), '');
  const executable = async (file, text) => { await writeFile(file, text); await chmod(file, 0o700); };
  // Exercise the production helper over SSH with an unavailable release service.
  await executable(join(bin, 'python3'), `#!/usr/bin/python3\nimport sys, os\nif len(sys.argv) > 3 and sys.argv[2] == '-c':\n open(${JSON.stringify(helperPid)}, 'w').write(str(os.getpid()))\n program = sys.argv[3]\n program = program.replace('if __name__ == "__main__":', 'VSCode.release = lambda self: (_ for _ in ()).throw(OSError("offline"))\\nif __name__ == "__main__":')\n os.execv('/usr/bin/python3', ['python3', '-u', '-c', program])\nos.execv('/usr/bin/python3', ['python3'] + sys.argv[1:])\n`);
  const login = join(directory, 'login');
  await executable(login, '#!/bin/sh\nexec /bin/sh -c "$2"\n');
  const shell = join(directory, 'shell');
  await executable(shell, `#!/bin/sh\nexport PATH='${bin}':/usr/bin:/bin\nexport SHELL='${login}'\nexport TMUX_TMPDIR='${directory}'\nexport XDG_CACHE_HOME='${cache}'\nexport XDG_DATA_HOME='${data}'\nif [ -z "$SSH_ORIGINAL_COMMAND" ]; then exec /bin/sh; fi\nexec /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n`);
  const sshd = await startSshd(directory, { config: `ForceCommand ${shell}\n` }); cleanup(sshd.stop);
  const config = join(directory, 'config.yaml');
  await writeFile(config, `version: 1\nsettings:\n  remoteSessionIntegration: false\nprofiles:\n  test:\n${sshProfile(sshd)}`);
  const app = await launch(directory, config); cleanup(app.close);
  const { api, page, waitState, application } = app;
  const connection = await api('connect', { profileId: 'test' });
  await waitState(s => s.connections[0]?.status === 'connected');
  await app.chooseConnection(connection);
  await application.evaluate(({ Menu }) => { globalThis.rigMenus = []; Menu.prototype.popup = function () { globalThis.rigMenus.push(this); }; });
  await page.evaluate(() => { window.applicationSnapshots = []; window.bartizan.onEvent(event => { if (event.type === 'state') window.applicationSnapshots.push(event.state.workspaces); }); });
  await page.locator('.connection-add:visible').click();
  await application.evaluate(() => { const item = globalThis.rigMenus.at(-1).items.find(i => i.label === 'Visual Studio Code'); if (!item) throw new Error('Visual Studio Code missing'); item.click(); });
  await expect(page.locator('.application-status')).toBeVisible();
  assert.equal((await app.state()).workspaces.find(w => w.application)?.tabs[0]?.title, 'Visual Studio Code');
  await expect(page.getByRole('button', { name: 'Close Tab Visual Studio Code', exact: true })).toBeVisible();
  // The launch is headed by the name its row in the sidebar carries.
  const applicationTab = (await app.state()).workspaces.find(w => w.application).tabs[0].id;
  await expect.poll(() => page.evaluate(id => [document.querySelector('.application-status h2')?.textContent, document.querySelector(`.nav-item[data-kind="tab"][data-id="${id}"] .nav-label`)?.textContent], applicationTab)).toEqual(['Visual Studio Code', 'Visual Studio Code']);
  await expect(page.locator('.application-notice')).toContainText('Fixture application terms', { timeout: 30000 });
  await expect(page.locator('.browser-toolbar')).toBeHidden();
  const first = (await app.state()).workspaces.find(w => w.application);
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
  const firstHelperPid = Number(await readFile(helperPid, 'utf8'));
  await api('browser', first.id, 'close-workspace');
  await expect.poll(() => { try { process.kill(pid, 0); return false; } catch { return true; } }).toBe(true);
  await expect.poll(() => { try { process.kill(firstHelperPid, 0); return false; } catch { return true; } }).toBe(true);
  const second = await api('newApplication', connection, 'vscode');
  await waitState(s => s.workspaces.find(w => w.id === second)?.application.event.type === 'applications.ready', 'cached consent');
  const disconnectedPid = Number(await readFile(join(data, 'bartizan/tools/vscode/server-data/fixture.pid'), 'utf8'));
  await api('disconnect', connection);
  await expect.poll(() => { try { process.kill(disconnectedPid, 0); return false; } catch { return true; } }).toBe(true);
  await waitState(s => s.workspaces.find(w => w.id === second)?.application.event.type === 'applications.ended', 'disconnected application');
  await api('reconnect', connection);
  await waitState(s => s.connections[0]?.status === 'connected');
  await api('retryApplication', second);
  await waitState(s => s.workspaces.find(w => w.id === second)?.application.event.type === 'applications.ready', 'retry');
  await api('settings', { remoteSessionIntegration: true });
  await waitState(s => s.connections[0].remoteSessions?.sessions.some(x => x.label === 'application-rig'), 'discovery enabled alongside application');
  const previousHelper = Number(await readFile(helperPid, 'utf8'));
  process.kill(previousHelper, 'SIGTERM');
  await expect.poll(async () => { const pid = Number(await readFile(helperPid, 'utf8')); return pid > 0 && pid !== previousHelper; }).toBe(true);
  await api('sendHelperMessage', connection, { type: 'sessions.refresh' });
  await waitState(s => s.connections[0].remoteSessions?.sessions.some(x => x.label === 'application-rig'), 'discovery survives helper restart');
  // Cancel on a launch in progress closes it and stops its remote process, as closing its tab does.
  await api('settings', { theme: 'tabs' });
  const pidFile = join(data, 'bartizan/tools/vscode/server-data/fixture.pid');
  const runningPid = Number(await readFile(pidFile, 'utf8'));
  await page.locator('.connection-add:visible').click();
  await application.evaluate(() => { const item = globalThis.rigMenus.at(-1).items.find(i => i.label === 'Visual Studio Code'); if (!item) throw new Error('Visual Studio Code missing'); item.click(); });
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
  assert.deepEqual(app.errors, []);
  console.log('Application launch, consent, native view, cache, cleanup, retry and cancel passed');
});
