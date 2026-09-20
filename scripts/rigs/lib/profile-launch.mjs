import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { userInfo } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { modalOf } from './harness.mjs';

export const connectSearch = dialog => dialog.getByRole('combobox', { name: 'Profile or Host', exact: true });
export async function openConnect(page) {
  const dialog = (await modalOf(page)).locator('#connect-dialog');
  if (!(await dialog.evaluate(node => node.open))) await page.getByRole('button', { name: 'New Connection', exact: true }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}
export async function closeConnect(page) {
  const dialog = (await modalOf(page)).locator('#connect-dialog');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
}

export async function testProfileLaunch(app, config, url) {
  const { application, page, state, api } = app;
  const dialogs = await app.modal();
  const original = await readFile(config, 'utf8');
  const dialog = dialogs.locator('#connect-dialog'), connect = connectSearch(dialog);
  const rows = dialog.locator('.profile-item, .destination-item'), chosen = dialog.locator('[data-chosen]');
  const profileRow = async id => (await openConnect(page)).locator(`.profile-row[data-id="${id}"]`);
  const connected = async () => {
    await expect.poll(async () => (await state()).connections.find(c => c.profileId === 'rig')?.status).toBe('connected');
    return (await state()).connections.find(c => c.profileId === 'rig').id;
  };
  const gone = id => expect.poll(async () => (await state()).connections.some(c => c.id === id)).toBe(false);
  try {
    // Connect lists every profile, and chooses none for Enter to connect while its search is empty.
    await openConnect(page);
    await expect(connect).toBeFocused();
    await expect(rows).toHaveCount(5);
    await expect(chosen).toHaveCount(0);
    await connect.press('Enter');
    await page.waitForTimeout(200);
    assert.equal((await state()).connections.length, 0);
    await expect(dialog).toBeVisible();
    // With the search empty, Down highlights the first result while the search keeps focus.
    await connect.press('ArrowDown');
    await expect(rows.first()).toHaveAttribute('data-chosen');
    await expect(connect).toHaveAttribute('aria-activedescendant', 'connect-profile-rig');
    await expect(connect).toBeFocused();
    // A destination follows the profiles that match it.
    await connect.fill('127.0.0.1');
    await expect(rows).toHaveCount(4);
    await expect(dialog.locator('.profile-row').first()).toHaveAttribute('data-id', 'rig');
    await expect(rows.last()).toHaveClass(/destination-item/);
    await expect(chosen).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-chosen');
    await connect.fill('   ');
    await expect(chosen).toHaveCount(0);
    await connect.press('Escape');
    await expect(connect).toHaveValue('');
    await expect(rows).toHaveCount(5);
    // Clearing the search clears the highlight, and with none Up highlights the last result.
    await expect(chosen).toHaveCount(0);
    await connect.press('ArrowUp');
    await expect(rows.last()).toHaveAttribute('data-chosen');
    await connect.fill('rig');
    await connect.evaluate(input => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
    await page.waitForTimeout(300);
    assert.equal((await state()).connections.length, 0);
    await expect(dialogs.locator('#connection-dialog')).not.toBeVisible();
    await connect.press('Escape');
    await expect(connect).toHaveValue('');
    // A profile's Edit opens its settings without connecting.
    await dialog.locator('.profile-row[data-id="other"] .profile-edit').click();
    await expect(dialog).toBeHidden();
    const editing = dialogs.locator('#connection-dialog');
    await expect(editing).toBeVisible();
    await expect(editing.locator('.dialog-context')).toHaveText('other');
    await expect(editing.locator('#field-profile-id')).toHaveCount(0);
    await expect(editing.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    for (const name of ['Save and Connect', 'Connect']) await expect(editing.getByRole('button', { name, exact: true })).toHaveCount(0);
    await page.waitForTimeout(200);
    assert.equal((await state()).connections.length, 0);
    await editing.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editing).toBeHidden();
    console.log('Connect lists every profile, narrows the list as it is typed in, and supports arrows, Escape, composition and Enter in an empty search without connecting; Edit opens a profile without connecting.');

    await openConnect(page);
    await connect.fill('unmatched profile query');
    await expect(dialog.getByText('No Results Found', { exact: true })).toBeVisible();
    await connect.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(dialogs.locator('#connection-dialog')).not.toBeVisible();
    assert.equal((await state()).connections.length, 0);
    await connect.fill('template');
    await connect.press('Enter');
    await expect(dialogs.locator('#connection-dialog')).toBeVisible();
    await expect(dialogs.locator('[data-path="auth.identity_files"] .field-error')).toBeVisible();
    const noIdentityFiles = dialogs.locator('select[name="auth.identity_files"] option[value="none"]');
    await expect(noIdentityFiles).toHaveText('None');
    await dialogs.locator('select[name="auth.method"]').selectOption('auto');
    await expect(noIdentityFiles).toHaveText('OpenSSH Default');
    assert.equal((await state()).connections.length, 0);
    await dialogs.getByRole('button', { name: 'Cancel', exact: true }).click();

    await (await profileRow('rig')).locator('.profile-item').click();
    const direct = await connected();
    await expect(dialogs.locator('#connection-dialog')).not.toBeVisible();
    const connectedEdit = (await profileRow('rig')).locator('.profile-edit');
    await expect(connectedEdit).toBeEnabled();
    await connectedEdit.click();
    const form = dialogs.locator('#connection-dialog');
    await expect(form).toBeVisible();
    await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    for (const name of ['Save and Connect', 'Connect']) await expect(form.getByRole('button', { name, exact: true })).toHaveCount(0);
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(form).toBeHidden();
    assert.equal((await api('details', direct)).username, userInfo().username);

    await (await profileRow('rig')).locator('.profile-item').click();
    await expect(dialog).toBeHidden();
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
    await expect(page.locator(`.connection-chip[data-id="${direct}"]`)).toHaveCount(1);

    // Tab takes focus to the highlighted result, and Space connects it.
    await openConnect(page);
    await connect.fill('rig');
    await connect.press('Tab');
    await expect(rows.first()).toBeFocused();
    await dialogs.keyboard.press('Space');
    const keyboard = await connected();
    assert.equal((await state()).connections.filter(c => c.profileId === 'rig').length, 1);
    // The connection had no terminal left, so choosing its profile opens one.
    const initial = (await app.waitState(s => s.terminals.some(t => t.connectionId === keyboard), 'a terminal for the chosen profile')).terminals.find(t => t.connectionId === keyboard).id;
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
  }
}
