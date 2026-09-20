import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import * as pty from 'node-pty';
import { execFileSync } from 'node:child_process';
import { writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { withDirectory, startSshd, sshProfile, launch } from './lib/harness.mjs';

await withDirectory('sessions', async (directory, cleanup) => {
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const socket = join(directory, 'tmux');
  const executable = async (file, text) => { await writeFile(file, text); await chmod(file, 0o700); };
  await executable(join(bin, 'tmux'), `#!/bin/sh\nexec /usr/bin/tmux -S '${socket}' "$@"\n`);
  await executable(join(bin, 'screen'), '#!/bin/sh\nif [ "$1" = -ls ]; then printf "\\t123.screen-work\\t(Attached)\\n"; elif [ "$3" = -Q ]; then printf "0 (vim)"; else printf "screen attached\\n"; exec sleep 300; fi\n');
  const herdrFake = (attach) => `#!/bin/sh\nif [ "$1" = --session ]; then printf '{"result":{"workspaces":[{"label":"rig","tab_count":3,"agent_status":"working"}]}}\\n'; elif [ "$2" = list ]; then printf '{"sessions":[{"name":"herdr-work","running":true}]}\\n'; else ${attach}; fi\n`;
  await executable(join(bin, 'herdr'), herdrFake('printf "herdr attached\\n"; exec sleep 300'));
  const login = join(directory, 'login');
  await executable(login, `#!/bin/sh\nexec /bin/sh -c \"$2\"\n`);
  const shell = join(directory, 'shell');
  await executable(shell, `#!/bin/sh\nexport PATH='${bin}':/usr/bin:/bin\nexport SHELL='${login}'\nif [ -z "$SSH_ORIGINAL_COMMAND" ]; then exec /bin/sh; fi\nexec /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n`);
  const tmux = (...args) => execFileSync('/usr/bin/tmux', ['-S', socket, ...args], { encoding: 'utf8' });
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'build', 'sleep 300');
  cleanup(() => { try { tmux('kill-server'); } catch {} });
  tmux('new-session', '-d', '-s', 'scratch', 'sleep 300');
  tmux('new-session', '-d', '-s', 'busy', 'sleep 300');
  const otherClient = pty.spawn('/usr/bin/tmux', ['-S', socket, 'attach-session', '-t', 'busy'], { name: 'xterm-256color', cols: 80, rows: 24, env: { ...process.env, TERM: 'xterm-256color' } });
  let detached = false;
  otherClient.onData(() => {});
  otherClient.onExit(() => { detached = true; });
  cleanup(() => { if (!detached) otherClient.kill(); });
  await expect.poll(() => tmux('display-message', '-p', '-t', 'busy', '#{session_attached}').trim()).toBe('1');
  const sshd = await startSshd(directory, { config: `ForceCommand ${shell}\n` });
  cleanup(sshd.stop);
  const config = join(directory, 'config.yaml');
  await writeFile(config, `version: 1\nprofiles:\n  test:\n${sshProfile(sshd)}  other:\n${sshProfile(sshd)}`);
  const app = await launch(directory, config);
  cleanup(app.close);
  const { api, page, waitState, chooseConnection, application, errors } = app;
  await application.evaluate(({ Menu }) => {
    globalThis.rigMenus = [];
    Menu.prototype.popup = function () { globalThis.rigMenus.push(this); };
  });
  const id = await api('connect', { profileId: 'test' });
  await waitState(s => s.connections[0].remoteSessions?.sessions.length === 5, 'five discovered sessions');
  await chooseConnection(id);
  const tab = () => page.locator('.nav-item[data-kind="remote"]');
  await expect(tab()).toHaveCount(1);
  await expect(page.locator('.connection-items > li:last-child .nav-item')).toHaveAttribute('data-kind', 'remote');
  for (const theme of ['tabs', 'console', 'rail']) {
    await api('settings', { theme });
    await expect(page.locator('.connection-items > li:last-child .nav-item')).toHaveAttribute('data-kind', 'remote');
    await tab().click();
    await expect(page.locator('.remote-sessions')).toBeVisible();
  }
  const rows = page.locator('.remote-row');
  const row = name => rows.filter({ has: page.getByText(name, { exact: true }) });
  const item = name => row(name).locator('.remote-item');
  const search = page.getByRole('combobox', { name: 'Search Sessions' });
  await expect(rows).toHaveCount(5);
  // One run reports every backend to the depth it can: tmux its windows and directory, screen the command in its
  // current window, Herdr its tabs and workspace.
  await expect(item('build').locator('.item-detail')).toContainText('1 window');
  await expect(item('screen-work').locator('.item-detail')).toHaveText('vim · 1 client');
  await expect(item('herdr-work').locator('.item-detail')).toContainText('3 tabs');
  await expect(item('herdr-work').locator('.item-detail')).toContainText('rig');
  await expect(row('busy')).toHaveAttribute('data-standing', 'attached');
  await expect(row('build')).toHaveAttribute('data-standing', 'detached');
  await expect(item('busy').locator('.remote-action')).toHaveText('Take Over');
  await expect(item('build').locator('.remote-action')).toHaveText('Resume');
  await search.fill('scratch');
  await expect(rows).toHaveCount(1);
  await search.fill('');
  await expect(rows).toHaveCount(5);
  console.log('One discovery run reports every backend with the detail it keeps.');

  await page.getByRole('button', { name: 'Resume All', exact: true }).click();
  await waitState(s => s.terminals.filter(t => t.remoteSession).length === 3, 'detached sessions resumed');
  const initialBulk = (await app.state()).terminals.find(t => t.remoteSession?.name === 'build');
  await expect(page.locator(`.nav-item[data-id="${initialBulk.id}"]`)).toHaveAttribute('aria-current', 'page');
  await tab().click();
  // A session open here keeps its place, as somewhere to return to rather than something to open again.
  await expect(rows).toHaveCount(5);
  await expect(row('build')).toHaveAttribute('data-standing', 'open');
  await expect(item('build').locator('.remote-action')).toHaveText('Go To');
  await expect(item('build').locator('.item-detail')).toContainText('open here');
  await expect(page.getByRole('button', { name: 'Resume All', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'More Session Actions' }).click();
  await expect.poll(() => application.evaluate(() => globalThis.rigMenus.at(-1)?.items[0]?.label)).toBe('Take Over All');
  await application.evaluate(() => globalThis.rigMenus.at(-1).items[0].click());
  await waitState(s => s.terminals.filter(t => t.remoteSession).length === 5, 'attached sessions taken over');
  const state = await app.state();
  const takenOver = state.terminals.find(t => t.remoteSession?.name === 'busy');
  await expect.poll(() => detached).toBe(true);
  await expect.poll(() => tmux('display-message', '-p', '-t', 'busy', '#{session_attached}').trim()).toBe('1');
  await expect(page.locator(`.nav-item[data-id="${takenOver.id}"]`)).toHaveAttribute('aria-current', 'page');
  await tab().click();
  await item('build').click();
  await expect(page.locator(`.nav-item[data-id="${initialBulk.id}"]`)).toHaveAttribute('aria-current', 'page');
  console.log('Bulk actions follow the list, and a session open here is somewhere to go back to.');

  // Backends number sessions per host, so the same key on another connection is a different session.
  const second = await api('connect', { profileId: 'other' });
  await waitState(s => s.connections.find(c => c.id === second)?.remoteSessions?.sessions.length === 5, 'the second connection lists the same host');
  await chooseConnection(second);
  await page.locator('.nav-item[data-kind="remote"]').click();
  await expect(page.locator('.remote-row')).toHaveCount(5);
  await expect(page.locator('.remote-row[data-standing="open"]')).toHaveCount(0, { timeout: 2000 });
  await api('disconnect', second);
  await api('removeConnection', second);
  await waitState(s => s.connections.length === 1, 'the second connection is gone');
  await chooseConnection(id);
  console.log('Sessions open on one connection are not claimed as open on another.');

  await api('closeTerminal', initialBulk.id);
  await api('closeTerminal', state.terminals.find(t => t.remoteSession?.name === 'scratch').id);
  await expect.poll(() => tmux('display-message', '-p', '-t', 'build', '#{session_attached}').trim()).toBe('0');
  await api('discoverRemoteSessions', id);
  await waitState(s => !s.connections[0].remoteSessions?.sessions.some(x => x.error), 'deliberate close leaves no error');
  await tab().click();
  await expect(row('build')).toHaveAttribute('data-standing', 'detached');

  await item('scratch').click({ button: 'right' });
  await expect.poll(() => application.evaluate(() => globalThis.rigMenus.at(-1)?.items.at(-1)?.label)).toBe('Kill Session');
  await application.evaluate(() => globalThis.rigMenus.at(-1).items.at(-1).click());
  const modal = await app.modal();
  await expect(modal.locator('#kill-dialog')).toBeVisible();
  await modal.getByRole('button', { name: 'Kill', exact: true }).click();
  await waitState(s => !s.connections[0].remoteSessions?.sessions.some(x => x.name === 'scratch'), 'killed session leaves the list');
  assert.throws(() => tmux('has-session', '-t', 'scratch'), 'the session is gone from the host');
  console.log('Killing a session ends it on the host.');

  const herdrTerminal = (await app.state()).terminals.find(t => t.remoteSession?.backend === 'herdr');
  await api('closeTerminal', herdrTerminal.id);
  await executable(join(bin, 'herdr'), herdrFake('echo "Attachment failed"; exit 1'));
  await api('discoverRemoteSessions', id);
  await tab().click();
  await item('herdr-work').click();
  await waitState(s => s.connections[0].remoteSessions?.sessions.some(x => x.error?.includes('Attachment failed')), 'failed attachment reported');
  await tab().click();
  await expect(row('herdr-work')).toHaveAttribute('data-standing', 'error');
  await expect(item('herdr-work').locator('.item-detail')).toContainText('Attachment failed');
  await expect(item('herdr-work').locator('.remote-action')).toHaveText('Retry');

  tmux('new-session', '-d', '-s', 'vanishing', 'sleep 300');
  await api('discoverRemoteSessions', id);
  await tab().click();
  tmux('kill-session', '-t', 'vanishing');
  await item('vanishing').click();
  await waitState(s => !s.connections[0].remoteSessions?.sessions.some(x => x.name === 'vanishing'), 'vanished session pruned');
  console.log('A failed attachment states itself on its own row, and a vanished session leaves.');

  // A session that someone attaches between the listing and the click fails to resume; it is then offered
  // as the take-over it now needs, rather than a retry the host would refuse.
  tmux('new-session', '-d', '-s', 'guarded', 'sleep 300');
  await api('discoverRemoteSessions', id);
  await tab().click();
  await expect(row('guarded')).toHaveAttribute('data-standing', 'detached');
  const guard = pty.spawn('/usr/bin/tmux', ['-S', socket, 'attach-session', '-t', 'guarded'], { name: 'xterm-256color', cols: 80, rows: 24, env: { ...process.env, TERM: 'xterm-256color' } });
  let guardLeft = false;
  guard.onData(() => {});
  guard.onExit(() => { guardLeft = true; });
  cleanup(() => { if (!guardLeft) guard.kill(); });
  await expect.poll(() => tmux('display-message', '-p', '-t', 'guarded', '#{session_attached}').trim()).toBe('1');
  await item('guarded').click();
  await waitState(s => s.connections[0].remoteSessions?.sessions.some(x => x.name === 'guarded' && x.error), 'the stale resume is refused');
  await tab().click();
  await expect(row('guarded')).toHaveAttribute('data-standing', 'attached');
  await expect(item('guarded').locator('.remote-action')).toHaveText('Take Over');
  await item('guarded').click();
  await waitState(s => s.terminals.some(t => t.remoteSession?.name === 'guarded' && t.status !== 'closed'), 'the take-over opens it');
  await expect.poll(() => guardLeft).toBe(true);
  console.log('A resume refused because another client arrived becomes the take-over it needs.');

  // A backend that cannot be listed says so on its own, and keeps the sessions it last reported.
  await executable(join(bin, 'herdr'), '#!/bin/sh\nif [ "$2" = list ]; then echo "socket is gone" >&2; exit 3; fi\n');
  await api('discoverRemoteSessions', id);
  await tab().click();
  const notice = page.locator('.remote-sessions .notice');
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText('Herdr');
  await expect(notice).toContainText('socket is gone');
  await expect(row('herdr-work')).toHaveCount(1);
  await expect(row('build')).toHaveCount(1);
  await executable(join(bin, 'herdr'), herdrFake('sleep 2; echo "Attached"; exec sleep 300'));
  await api('discoverRemoteSessions', id);
  await waitState(s => !s.connections[0].remoteSessions?.errors.length, 'the backend recovers');
  await tab().click();
  const opening = Date.now();
  await item('herdr-work').click();
  await expect(page.locator('.nav-item[data-kind="terminal"][aria-current="page"]')).toHaveCount(1, { timeout: 1000 });
  assert.ok(Date.now() - opening < 1000, 'selection does not wait for remote startup');
  await page.evaluate(id => { void window.bartizan.discoverRemoteSessions(id); }, id);
  await api('settings', { remoteSessionIntegration: false });
  await api('settings', { remoteSessionIntegration: true });
  await waitState(s => s.connections[0].remoteSessions && !s.connections[0].remoteSessions.loading, 'discovery after rapid settings toggle');
  const draft = await api('profileDraft', 'test');
  await api('profileSave', { token: draft.token, values: { remote_sessions: false }, reset: [], connect: false });
  await waitState(s => !s.connections[0].remoteSessions, 'profile disables integration');
  const enabledDraft = await api('profileDraft', 'test');
  await api('profileSave', { token: enabledDraft.token, values: { remote_sessions: true }, reset: [], connect: false });
  await api('settings', { remoteSessionIntegration: false });
  await waitState(s => Boolean(s.connections[0].remoteSessions), 'profile overrides disabled global setting');
  const inheritDraft = await api('profileDraft', 'test');
  await api('profileSave', { token: inheritDraft.token, values: {}, reset: ['remote_sessions'], connect: false });
  console.log('Immediate selection, discovery toggles, and profile overrides passed.');


  await api('settings', { remoteSessionIntegration: false });
  await waitState(s => !s.connections[0].remoteSessions, 'integration disabled');
  await api('settings', { remoteSessionIntegration: true });
  await waitState(s => s.connections[0].remoteSessions && !s.connections[0].remoteSessions.loading, 'integration enabled');
  assert.equal(errors.length, 0, errors.join('\n'));
  await api('disconnect', id);
  tmux('has-session', '-t', 'build');
  console.log('Settings take effect on live connections; disconnect preserves tmux sessions.');
});
