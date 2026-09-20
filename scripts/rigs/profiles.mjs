import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { withDirectory, startSshd, launch } from './lib/harness.mjs';
import { tabToResults } from './lib/profile-launch.mjs';

await withDirectory('profiles', async (directory, cleanup) => {
  const sshd = await startSshd(directory);
  cleanup(sshd.stop);
  const config = join(directory, 'config.yaml');
  const items = Array.from({ length: 150 }, (_, index) => `  item-${index}:\n    host: node-${index}.example.invalid\n`).join('');
  const catalog = (incomplete = true) => `# Team profiles
version: 1
defaults:
  port: ${sshd.port} # rig server
  auth:
    method: key
    identity_files: [${JSON.stringify(sshd.identity)}]
  host_keys:
    policy: accept-new
  ssh:
    HostKeyAlgorithms: "+ssh-rsa"
profiles:
  # Edited through the form
  alpha:
    label: Alpha
    host: alpha.example.invalid
    username: ""
    tags: [database]
    auth:
      method: auto
      agent: " /tmp/agent socket "
      password:
        source: literal
        value: saved-secret
      passphrase:
        source: file
        path: "keys/passphrase "
    ssh:
      Ciphers: aes256-ctr # only this cipher
  beta:
    label: Beta
    host: 127.0.0.1
    tags: [web]
${incomplete ? '  incomplete:\n    label: Template\n    username: template-user\n' : ''}${items}`;
  await writeFile(config, catalog());
  const app = await launch(directory, config);
  cleanup(app.close);
  const { application, page, api, state, waitState, errors } = app;
  const profiles = async () => parse(await readFile(config, 'utf8')).profiles;
  const dialogs = await app.modal();
  const connect = page.locator('.connect');
  const search = connect.getByRole('combobox', { name: 'Profile or Host', exact: true });
  const rows = connect.locator('.profile-item');
  const add = page.locator('.rail').getByRole('button', { name: 'New Connection', exact: true });
  const openConnect = async () => { await add.click(); await expect(search).toBeFocused(); };
  const form = dialogs.locator('#connection-dialog');
  const notice = form.locator('.form-notice');
  const button = name => form.getByRole('button', { name, exact: true });
  const section = name => form.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
  /** Resets a field, which then takes focus. */
  const reset = async (label, name) => {
    await button(`Reset ${label}`).click();
    await expect(form.locator(`[name="${name}"]`)).toBeFocused();
  };
  const edit = async id => {
    await add.click();
    await connect.locator(`.profile-row[data-id="${id}"] .profile-edit`).click();
    await expect(form).toBeVisible();
  };
  const newProfile = async () => {
    await add.click();
    await connect.getByRole('button', { name: 'New Profile', exact: true }).click();
    await expect(form).toBeVisible();
  };

  await openConnect();
  await expect(rows).toHaveCount(153);
  // Each search shows its results from the top, where the chosen one is.
  await connect.locator('.picker-body').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await search.fill('item');
  await expect(connect.locator('[data-chosen]')).toBeInViewport();
  // The pointer chooses a result where it is, without scrolling the results.
  const scrollBox = connect.locator('.picker-body');
  const cut = await scrollBox.evaluate(node => {
    const bottom = node.getBoundingClientRect().bottom;
    return [...node.querySelectorAll('.profile-item')].findIndex(item => { const box = item.getBoundingClientRect(); return box.top < bottom - 6 && box.bottom > bottom; });
  });
  assert.ok(cut > 0, 'A result is cut off at the foot of the results');
  const scrolled = await scrollBox.evaluate(node => node.scrollTop), cutBox = await rows.nth(cut).boundingBox();
  await page.mouse.move(cutBox.x + 20, cutBox.y + 3, { steps: 4 });
  await expect(rows.nth(cut)).toHaveAttribute('data-chosen');
  assert.equal(await scrollBox.evaluate(node => node.scrollTop), scrolled, 'Pointing at a result leaves the results where they are');
  await page.mouse.move(0, 0);
  for (const [query, id] of [['ALPHA', 'alpha'], ['database', 'alpha'], ['template-user', 'incomplete'], ['127.0.0.1', 'beta'], ['item-149', 'item-149']]) {
    await search.fill(query);
    await expect(rows).toHaveCount(1);
    await expect(connect.locator('.profile-row')).toHaveAttribute('data-id', id);
  }
  await search.fill('no such profile');
  await expect(rows).toHaveCount(0);
  await expect(connect.getByText('No Results Found', { exact: true })).toBeVisible();
  await search.press('Enter');
  await expect(connect).toBeVisible();
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(connect).toBeVisible();
  // In the search, Up and Down move the highlight while the search keeps focus and names the highlighted result.
  await search.press('ArrowDown');
  await expect(rows.first()).toHaveAttribute('data-chosen');
  await expect(search).toHaveAttribute('aria-activedescendant', 'connect-item-0');
  await search.press('ArrowDown');
  await expect(rows.nth(1)).toHaveAttribute('data-chosen');
  await expect(search).toBeFocused();
  // Tab runs from the search through the controls over the results to the highlighted one, where the arrows, Home and
  // End move focus and the highlight.
  await search.press('Tab');
  await expect(connect.getByRole('button', { name: 'Reload Configuration', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(connect.getByRole('button', { name: 'New Profile', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(rows.nth(1)).toBeFocused();
  await rows.nth(1).press('End');
  await expect(rows.last()).toBeFocused();
  await expect(rows.last()).toHaveAttribute('data-chosen');
  await rows.last().press('Home');
  await expect(rows.first()).toBeFocused();
  await rows.first().press('ArrowUp');
  await expect(rows.first()).toBeFocused();
  // The results are one stop for Tab: back from one takes the last control over them, and forward returns to it.
  // Escape returns to the search with the result still highlighted.
  await rows.first().press('Shift+Tab');
  await expect(connect.getByRole('button', { name: 'New Profile', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(rows.first()).toBeFocused();
  await rows.first().press('Escape');
  await expect(search).toBeFocused();
  await expect(rows.first()).toHaveAttribute('data-chosen');
  await expect(connect).toBeVisible();
  // Right and Left move the search's caret; in the results they move between a profile and its Edit, which Enter opens
  // without connecting.
  await search.fill('alpha');
  await search.press('ArrowRight');
  await expect(search).toBeFocused();
  await tabToResults(page);
  const alphaItem = connect.locator('.profile-row[data-id="alpha"] .profile-item');
  await expect(alphaItem).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(connect.getByRole('button', { name: 'Edit Alpha', exact: true })).toBeFocused();
  await expect(alphaItem).toHaveAttribute('data-chosen');
  // The pointer over the result itself takes focus back from its Edit, so keys act on what it points at.
  const alphaBox = await alphaItem.boundingBox();
  await page.mouse.move(alphaBox.x + 20, alphaBox.y + alphaBox.height / 2, { steps: 4 });
  await expect(alphaItem).toBeFocused();
  await page.mouse.move(0, 0);
  await page.keyboard.press('ArrowRight');
  await expect(connect.getByRole('button', { name: 'Edit Alpha', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(alphaItem).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(form).toBeVisible();
  await expect(form.locator('.dialog-context')).toHaveText('alpha');
  await button('Cancel').click();
  assert.deepEqual((await state()).connections, []);
  console.log('Connect search matches labels, IDs, tags, usernames and endpoints; Up and Down move its highlight, Tab runs through the page controls to the highlighted result, the results are one stop for Tab with arrows, Home and End among them, and Right and Enter open Edit without connecting.');

  await openConnect();
  await search.fill('template-user');
  await tabToResults(page);
  await expect(connect.locator('.profile-row[data-id="incomplete"] .profile-item')).toBeFocused();
  await writeFile(config, catalog(false));
  await api('reloadConfig');
  // A focused result that goes away gives focus and the highlight to the result in its place.
  await expect(connect.locator('.destination-item')).toBeFocused();
  await expect(connect.locator('.destination-item')).toHaveAttribute('data-chosen');
  await expect(search).toHaveValue('template-user');
  await expect(rows).toHaveCount(0);
  await search.fill('node');
  await api('reloadConfig');
  await expect(search).toBeFocused();
  await expect(rows).toHaveCount(150);
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(connect).toBeVisible();
  await search.fill('beta');
  await search.press('Enter');
  await expect(connect).toBeHidden();
  const beta = (await waitState(s => s.connections.some(c => c.profileId === 'beta' && c.status === 'connected'), 'beta connected')).connections[0].id;
  console.log('Reloading keeps the search and moves focus from a removed result to the control in its place; Escape clears the search, and Enter connects the first result.');

  await edit('alpha');
  await expect(form.locator('.dialog-context')).toHaveText('alpha');
  await expect(form.locator('#field-profile-id')).toHaveCount(0);
  await expect(button('Save')).toBeVisible();
  for (const name of ['Save and Connect', 'Connect']) await expect(button(name)).toHaveCount(0);
  await expect(form.locator('[name="label"]')).toHaveValue('Alpha');
  await expect(form.locator('[name="username"]')).toHaveValue('');
  await expect(form.locator('[name="port"]')).toHaveAttribute('placeholder', String(sshd.port));
  await section('Terminal');
  const webgl = form.getByRole('combobox', { name: 'WebGL Rendering', exact: true });
  await expect(webgl).toHaveValue('');
  await expect(webgl.locator('option:checked')).toHaveText('Inherit (Disabled)');
  await webgl.selectOption('false');
  await webgl.selectOption('');
  await section('Authentication');
  await expect(form.locator('select[name="auth.password"]')).toHaveValue('literal');
  await expect(form.locator('[name="auth.password.value"]')).toHaveAttribute('placeholder', '••••••••');
  await application.evaluate(electron => {
    globalThis.rigBrowsed = 0;
    electron.dialog.showOpenDialog = async () => { globalThis.rigBrowsed++; return { canceled: true, filePaths: [] }; };
  });
  await form.locator('[data-path="auth.passphrase"]').getByRole('button', { name: 'Browse…' }).click();
  await expect.poll(() => application.evaluate(() => globalThis.rigBrowsed)).toBe(1);
  await expect(form.locator('[name="auth.passphrase.value"]')).toHaveValue('keys/passphrase ');
  await section('Algorithms');
  await expect(form.locator('[name="ssh.Ciphers"]')).toHaveValue('aes256-ctr');
  await expect(form.locator('[name="ssh.HostKeyAlgorithms"]')).toHaveAttribute('placeholder', '+ssh-rsa');
  await expect(form.locator('[name="ssh.MACs"]')).toHaveAttribute('placeholder', 'OpenSSH Default');
  await section('Connection');
  await form.locator('[name="label"]').fill('Alpha edited');
  await reset('Username', 'username');
  await form.locator('[name="port"]').fill('2222');
  await form.locator('[name="port"]').press('Enter');
  await expect(form).toBeHidden();
  assert.deepEqual((await profiles()).alpha, {
    label: 'Alpha edited', host: 'alpha.example.invalid', tags: ['database'], port: 2222,
    auth: { method: 'auto', agent: ' /tmp/agent socket ', password: { source: 'literal', value: 'saved-secret' }, passphrase: { source: 'file', path: 'keys/passphrase ' } },
    ssh: { Ciphers: 'aes256-ctr' },
  });
  const text = await readFile(config, 'utf8');
  for (const comment of ['# Team profiles', '# rig server', '# Edited through the form', '# only this cipher']) assert.ok(text.includes(comment), comment);
  console.log('Editing shows raw profile values and inherited placeholders, offers only Save, and Enter writes only the changed and reset fields while comments stay.');

  await edit('alpha');
  await form.locator('#field-tags').fill('ops');
  await form.locator('#field-tags').press('Enter');
  await section('Authentication');
  await form.locator('[name="auth.password.value"]').fill('replaced-secret');
  await section('Algorithms');
  await reset('Ciphers', 'ssh.Ciphers');
  await button('Save').click();
  await expect(form).toBeHidden();
  const alpha = (await profiles()).alpha;
  assert.deepEqual([alpha.auth.password.value, alpha.ssh, alpha.tags], ['replaced-secret', undefined, ['database', 'ops']]);
  const draft = await api('profileDraft', 'alpha');
  assert.doesNotMatch(JSON.stringify(draft), /replaced-secret/);
  await assert.rejects(api('profileSave', { token: draft.token, values: {}, reset: [], connect: true }), /Save the profile before connecting/);
  await assert.rejects(api('profileConnect', { token: draft.token, values: {}, reset: [] }), /Save the profile before connecting/);
  console.log('Tags, a replaced credential and a reset table are saved; drafts hide credentials, and a saved profile connects only by its ID.');

  await edit('beta');
  await expect(notice).toBeHidden();
  await form.locator('#field-tags').fill('live');
  await form.locator('#field-tags').press('Enter');
  await expect(notice).toBeHidden();
  await form.locator('[name="label"]').fill('Beta live');
  await expect(notice).toHaveText('Changes will apply when you reconnect.');
  await section('Authentication');
  await expect(notice).toBeVisible();
  await section('Connection');
  await form.locator('[name="label"]').fill('Beta');
  await expect(notice).toBeHidden();
  await form.locator('[name="port"]').fill('70000');
  await button('Save').click();
  await expect(form.locator('[data-path="port"] .field-error')).toBeVisible();
  await expect(notice).toBeVisible();
  await api('disconnect', beta);
  await expect(notice).toBeHidden();
  await api('reconnect', beta);
  await waitState(s => s.connections.find(c => c.id === beta).status === 'connected', 'beta reconnected');
  await expect(notice).toBeVisible();
  await reset('Port', 'port');
  await form.locator('[name="label"]').fill('Beta live');
  await form.locator('[name="label"]').press('Enter');
  await expect(form).toBeHidden();
  assert.deepEqual((await profiles()).beta, { label: 'Beta live', host: '127.0.0.1', tags: ['web', 'live'] });
  assert.deepEqual((await state()).connections.map(c => [c.id, c.label, c.status]), [[beta, 'Beta', 'connected']]);
  console.log('A connected profile shows the reconnect notice for unsaved or invalid changes other than tags, and saving leaves its connection running.');

  await edit('alpha');
  const changed = `${await readFile(config, 'utf8')}\n`;
  await writeFile(config, changed);
  await form.locator('[name="label"]').fill('Conflict');
  await button('Save').click();
  await expect(form.locator('.form-error')).toContainText('Configuration changed on disk; reopen the profile');
  assert.equal(await readFile(config, 'utf8'), changed);
  await button('Cancel').click();
  console.log('A configuration changed on disk after the form opened is not overwritten.');

  await newProfile();
  await expect(form.locator('#connection-title')).toHaveText('New Profile');
  for (const name of ['Save', 'Save and Connect', 'Connect']) await expect(button(name)).toBeVisible();
  await form.locator('#field-profile-id').fill('template');
  await form.locator('[name="label"]').fill('Template');
  await button('Save').click();
  await expect(form).toBeHidden();
  assert.deepEqual((await profiles()).template, { label: 'Template' });
  assert.equal((await state()).connections.length, 1);
  await add.click();
  await expect(connect.locator('.profile-row[data-id="template"]')).toBeVisible();
  await newProfile();
  await form.locator('[name="label"]').fill('Gamma Server');
  await expect(form.locator('#field-profile-id')).toHaveAttribute('placeholder', 'gamma-server');
  await form.locator('[name="host"]').fill('127.0.0.1');
  await button('Save and Connect').click();
  await expect(form).toBeHidden();
  await waitState(s => s.connections.some(c => c.profileId === 'gamma-server' && c.status === 'connected'), 'gamma connected');
  assert.deepEqual((await profiles())['gamma-server'], { label: 'Gamma Server', host: '127.0.0.1' });
  await newProfile();
  await form.locator('#field-profile-id').fill('broken');
  await form.locator('[name="host"]').fill('127.0.0.1');
  await section('Algorithms');
  await form.locator('[name="ssh.Ciphers"]').fill('not-a-supported-cipher');
  await button('Save and Connect').click();
  await expect(form.locator('.dialog-context')).toHaveText('broken');
  await expect(form.locator('.form-error')).toContainText(/cipher/i);
  assert.deepEqual((await profiles()).broken, { host: '127.0.0.1', ssh: { Ciphers: 'not-a-supported-cipher' } });
  await button('Cancel').click();
  assert.equal((await state()).connections.length, 2);
  console.log('New profiles save to the configuration file, incomplete ones included; Save and Connect connects, or reopens the saved profile with the connection error.');

  const saved = await readFile(config, 'utf8');
  await application.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers;
    const connect = handlers.get('request');
    globalThis.rigLate = { connect, done: false };
    handlers.set('request', async (...values) => {
      if (values[1].method !== 'profile-connect') return connect(...values);
      const id = await connect(...values);
      await new Promise(resolve => setTimeout(resolve, 800));
      globalThis.rigLate.done = true;
      return id;
    });
  });
  await newProfile();
  await form.locator('[name="host"]').fill('127.0.0.1');
  await button('Connect').click();
  await button('Cancel').click();
  await expect(form).toBeHidden();
  await newProfile();
  await expect(form.locator('[name="host"]')).toHaveValue('');
  await expect.poll(() => application.evaluate(() => globalThis.rigLate.done)).toBe(true);
  await page.waitForTimeout(300);
  await expect(form).toBeVisible();
  await button('Cancel').click();
  await application.evaluate(({ ipcMain }) => ipcMain._invokeHandlers.set('request', globalThis.rigLate.connect));
  await waitState(s => s.connections.some(c => !c.profileId && c.status === 'connected'), 'unsaved connection');
  const port = form.locator('[name="port"]');
  await newProfile();
  await form.locator('[name="host"]').fill('127.0.0.1');
  await port.fill('2');
  await port.press('e');
  await button('Connect').click();
  await expect(port).toHaveAttribute('aria-invalid', 'true');
  await port.fill('');
  await button('Connect').click();
  await expect(form).toBeHidden();
  await waitState(s => s.connections.filter(c => !c.profileId && c.status === 'connected').length === 2, 'second unsaved connection');
  assert.equal(await readFile(config, 'utf8'), saved);
  console.log('A connection request finishing after Cancel leaves the next form open, an incomplete number blocks Connect until cleared, and unsaved connections use the defaults without writing the file.');

  await writeFile(config, 'version: 1\n');
  await api('reloadConfig');
  await openConnect();
  await expect(connect.getByText('No Profiles', { exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  console.log('An empty configuration shows No Profiles.');
});
