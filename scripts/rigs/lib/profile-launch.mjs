import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { userInfo } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';

export const connectSearch = page => page.getByRole('combobox', { name: 'Connect', exact: true });
export const connectResults = page => page.getByRole('listbox', { name: 'Profiles', exact: true });
export async function openProfiles(page) {
  const dialog = page.locator('#profiles-dialog');
  if (!(await dialog.evaluate(node => node.open))) await page.getByRole('button', { name: 'Profiles', exact: true }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}
export async function closeProfiles(page) {
  await page.locator('#profiles-dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('#profiles-dialog')).toBeHidden();
}

export async function testProfileLaunch(app, config, url) {
  const { application, page, state, api } = app;
  const original = await readFile(config, 'utf8');
  const connect = connectSearch(page), results = connectResults(page);
  const profileRow = async id => (await openProfiles(page)).locator(`.profile-row[data-id="${id}"]`);
  const connected = async () => {
    await expect.poll(async () => (await state()).connections.find(c => c.profileId === 'rig')?.status).toBe('connected');
    return (await state()).connections.find(c => c.profileId === 'rig').id;
  };
  const gone = id => expect.poll(async () => (await state()).connections.some(c => c.id === id)).toBe(false);
  try {
    await connect.focus();
    await expect(results).toBeHidden();
    await connect.fill('127.0.0.1');
    await expect(results.getByRole('option')).toHaveCount(4);
    await expect(results.getByRole('option').last()).toHaveId('connect-destination');
    await expect(page.locator('#connect-profile-rig')).toHaveAttribute('aria-selected', 'true');
    await connect.press('ArrowDown');
    await expect(page.locator('#connect-profile-other')).toHaveAttribute('aria-selected', 'true');
    await expect(connect).toHaveAttribute('aria-activedescendant', 'connect-profile-other');
    await connect.press('Escape');
    await expect(results).toBeHidden();
    await expect(connect).toHaveValue('127.0.0.1');
    await connect.blur();
    await connect.focus();
    await page.waitForTimeout(200);
    await expect(results).toBeHidden();
    await connect.press('ArrowDown');
    await expect(results).toBeVisible();
    await page.locator('.sidebar').click({ position: { x: 20, y: 20 } });
    await expect(results).toBeHidden();
    await connect.fill('rig');
    await expect(results).toBeVisible();
    await connect.evaluate(input => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
    await page.waitForTimeout(300);
    assert.equal((await state()).connections.length, 0);
    await expect(page.locator('#connection-dialog')).not.toBeVisible();
    await connect.press('Escape');
    await connect.press('Escape');
    await expect(connect).toHaveValue('');
    console.log('Connect results open only for typed input and support arrows, Escape, outside dismissal and composition without connecting.');

    await connect.fill('unmatched profile query');
    await expect(results.getByRole('option', { name: 'No Results Found', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await connect.press('Enter');
    await expect(page.locator('#connection-dialog')).not.toBeVisible();
    assert.equal((await state()).connections.length, 0);
    await connect.fill('template');
    await connect.press('Enter');
    await expect(page.locator('#connection-dialog')).toBeVisible();
    await expect(page.locator('[data-path="auth.identity_files"] .field-error')).toBeVisible();
    const noIdentityFiles = page.locator('select[name="auth.identity_files"] option[value="none"]');
    await expect(noIdentityFiles).toHaveText('None');
    await page.locator('select[name="auth.method"]').selectOption('auto');
    await expect(noIdentityFiles).toHaveText('OpenSSH Default');
    assert.equal((await state()).connections.length, 0);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await (await profileRow('rig')).locator('.profile-item').click();
    const direct = await connected();
    await expect(page.locator('#connection-dialog')).not.toBeVisible();
    const connectedEdit = (await profileRow('rig')).locator('.profile-edit');
    await expect(connectedEdit).toBeEnabled();
    await connectedEdit.click();
    const form = page.locator('#connection-dialog');
    await expect(form).toBeVisible();
    await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    for (const name of ['Save and Connect', 'Connect']) await expect(form.getByRole('button', { name, exact: true })).toHaveCount(0);
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(form).toBeHidden();
    assert.equal((await api('details', direct)).username, userInfo().username);
    await (await profileRow('rig')).locator('.profile-item').click();
    await expect(page.locator('#profiles-dialog')).toBeHidden();
    assert.equal((await state()).connections.filter(c => c.profileId === 'rig').length, 1);
    await api('newTerminal', direct);
    const workspace = await api('newBrowser', direct);
    const tab = (await app.waitState(s => s.workspaces.find(w => w.id === workspace)?.tabs.length)).workspaces.find(w => w.id === workspace).tabs[0].id;
    await api('browser', workspace, 'navigate', tab, url);
    for (const terminal of (await state()).terminals.filter(t => t.connectionId === direct)) await api('closeTerminal', terminal.id);
    assert.equal((await state()).connections.find(c => c.id === direct)?.status, 'connected');
    await expect.poll(async () => (await state()).workspaces.find(w => w.id === workspace)?.tabs[0]?.url).toBe(url);
    await expect.poll(async () => (await state()).workspaces.find(w => w.id === workspace)?.tabs[0]?.loading).toBe(false);
    await application.evaluate(async ({ webContents }, url) => {
      const page = webContents.getAllWebContents().find(w => w.getURL() === url);
      if (!page) throw new Error('Missing browser fixture');
      await page.executeJavaScript('window.close()').catch(() => {});
    }, url);
    await expect.poll(async () => (await state()).workspaces.find(w => w.id === workspace)?.tabs.length).toBe(0);
    await api('browser', workspace, 'close-workspace');
    assert.equal((await state()).connections.find(c => c.id === direct)?.status, 'connected');
    await expect(page.locator(`.connection[data-id="${direct}"]`)).toHaveCount(1);

    await connect.fill('rig');
    await connect.press('Enter');
    await connect.press('Enter');
    const keyboard = await connected();
    assert.equal((await state()).connections.filter(c => c.profileId === 'rig').length, 1);
    const initial = (await state()).terminals.find(t => t.connectionId === keyboard).id;
    const added = await api('newTerminal', keyboard);
    await api('closeTerminal', initial);
    assert.equal((await state()).connections.find(c => c.id === keyboard)?.status, 'connected');
    await api('closeTerminal', added);
    assert.equal((await state()).connections.find(c => c.id === keyboard)?.status, 'connected');
    await api('disconnect', keyboard);
    assert.equal((await state()).connections.find(c => c.id === keyboard)?.status, 'closed');
    await api('removeConnection', keyboard);
    await gone(keyboard);
    console.log('Profile activation and validation work; closing all children retains the connection until explicitly removed.');
  } finally {
    await writeFile(config, original);
    await api('reloadConfig');
    await connect.fill('');
  }
}
