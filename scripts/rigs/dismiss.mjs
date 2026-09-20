import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, sshProfile, startSshd, withDirectory } from './lib/harness.mjs';

await withDirectory('dismiss', async (directory, cleanup) => {
  const sshd = await startSshd(directory, { passphrase: 'rig-passphrase' });
  cleanup(sshd.stop);
  const config = join(directory, 'config.yaml');
  await writeFile(config, `version: 1\nprofiles:\n  fixture:\n${sshProfile(sshd)}`);
  const app = await launch(directory, config);
  cleanup(app.close);
  const { page, api, waitState, errors } = app;
  const dialogs = await app.modal();
  const add = page.locator('.rail').getByRole('button', { name: 'New Connection', exact: true });
  const connect = page.locator('.connect');
  const settingsButton = page.getByRole('button', { name: 'Settings', exact: true });
  const settings = dialogs.locator('#settings-dialog');
  const form = dialogs.locator('#connection-dialog');
  const prompt = dialogs.locator('#auth-dialog');
  /** Clicks the backdrop at the top left corner, clear of every dialog. */
  const backdrop = () => dialogs.mouse.click(8, 8);

  // A click on the backdrop dismisses a dialog, and focus returns to where it was; a press inside that is released outside does not.
  await settingsButton.click();
  await expect(settings).toBeVisible();
  const appearance = settings.getByRole('combobox', { name: 'Appearance', exact: true });
  const box = await settings.locator('#settings-title').boundingBox();
  await dialogs.mouse.move(box.x + 10, box.y + box.height / 2);
  await dialogs.mouse.down();
  await dialogs.mouse.move(8, 8, { steps: 5 });
  await dialogs.mouse.up();
  await expect(settings).toBeVisible();
  await backdrop();
  await expect(settings).toBeHidden();
  await expect(settingsButton).toBeFocused();
  console.log('A click on the backdrop dismisses Settings and returns focus; a press inside released on the backdrop does not.');

  // A click on the backdrop that closes a select's list leaves the dialog open.
  await settingsButton.click();
  await appearance.click();
  await expect(appearance.locator('option').nth(1)).toBeVisible();
  await backdrop();
  await expect(appearance.locator('option').nth(1)).toBeHidden();
  await expect(settings).toBeVisible();
  await backdrop();
  await expect(settings).toBeHidden();
  console.log('A backdrop click that closes a select list leaves Settings open; the next one dismisses it.');

  // The connection form closes from the backdrop unless it has unsaved changes, which it shows for a while; Escape still closes it.
  const openForm = async () => {
    await add.click();
    await connect.getByRole('button', { name: 'New Profile', exact: true }).click();
    await expect(form).toBeVisible();
  };
  const notice = form.locator('.unsaved-notice');
  await openForm();
  await backdrop();
  await expect(form).toBeHidden();
  await openForm();
  const host = form.locator('[name="host"]');
  await host.fill('example.invalid');
  await backdrop();
  await expect(notice).toHaveText('Unsaved changes');
  await expect(form).toBeVisible();
  await expect(host).toBeFocused();
  await expect(notice).toHaveText('', { timeout: 5000 });
  await host.fill('');
  await backdrop();
  await expect(form).toBeHidden();
  await openForm();
  await host.fill('example.invalid');
  await dialogs.keyboard.press('Escape');
  await expect(form).toBeHidden();
  await add.click();
  await connect.getByRole('button', { name: 'Edit fixture', exact: true }).click();
  await expect(form).toBeVisible();
  await backdrop();
  await expect(form).toBeHidden();
  console.log('The connection form closes from the backdrop without changes, holds with a passing notice while it has them, and Escape still closes it.');

  // An authentication prompt is cancelled from the backdrop, as Escape does, unless something has been typed.
  await api('connect', { profileId: 'fixture' });
  await expect(prompt).toBeVisible();
  await backdrop();
  await expect(prompt).toBeHidden();
  await waitState(s => s.connections[0]?.status === 'closed', 'the cancelled connection');
  await api('connect', { profileId: 'fixture' });
  await expect(prompt).toBeVisible();
  const passphrase = prompt.locator('#auth-response');
  await passphrase.fill('rig-passphrase');
  await backdrop();
  await expect(prompt.locator('.unsaved-notice')).toHaveText('Unsaved changes');
  await expect(prompt).toBeVisible();
  await passphrase.press('Enter');
  await waitState(s => s.connections[0]?.status === 'connected', 'the connection');
  console.log('A backdrop click cancels an untouched authentication prompt and holds one with a typed answer.');

  // Only the top dialog of a stack is dismissed.
  await settingsButton.click();
  await expect(settings).toBeVisible();
  await app.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const quit = dialogs.locator('#quit-dialog');
  await expect(quit).toBeVisible();
  await backdrop();
  await expect(quit).toBeHidden();
  await expect(settings).toBeVisible();
  await backdrop();
  await expect(settings).toBeHidden();
  assert.deepEqual(errors, []);
  console.log('A backdrop click dismisses only the dialog on top.');
});
