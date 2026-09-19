import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { connectSearch, openConnect, closeConnect } from './profile-launch.mjs';

export async function testProfileTags(app, config, connectionId) {
  const { application, page, state } = app;
  const original = await readFile(config, 'utf8');
  const before = await state();
  const connectionBefore = before.connections.find(connection => connection.id === connectionId);
  const dialogs = await app.modal();
  const dialog = dialogs.locator('#connect-dialog'), connect = connectSearch(dialog);
  const profile = dialog.locator('.profile-row[data-id="rig"]');
  const chip = page.locator(`.connection-chip[data-id="${connectionId}"] .connection-titles`);
  await chip.click();
  const connection = page.locator('.rail-panel');
  const reload = async tags => {
    await writeFile(config, original.replace('\n  rig:\n', `\n  rig:\n    tags: ${JSON.stringify(tags)}\n`));
    await page.evaluate(() => window.bartizan.reloadConfig());
  };
  try {
    await reload([' Operations ', 'operations', 'Team Blue', '<b>literal</b>']);
    await openConnect(page);
    await expect(profile).toContainText('Operations');
    await expect(profile).toContainText('<b>literal</b>');
    await expect(profile.locator('b')).toHaveCount(0);
    await profile.locator('.profile-item').focus();
    await dialogs.keyboard.press('ArrowDown');
    await expect(dialog.locator('.profile-item').nth(1)).toBeFocused();
    await closeConnect(page);
    assert.deepEqual((await state()).profiles.find(p => p.id === 'rig').tags, ['Operations', 'Team Blue', '<b>literal</b>']);
    // Connect finds profiles by tag, and hides no connection while it does.
    await openConnect(page);
    await connect.fill('oPERAt');
    await expect(dialog.locator('.profile-item')).toHaveCount(1);
    await expect(profile).toContainText('Operations');
    await expect(page.locator('.connection-chip')).toHaveCount(before.connections.length);
    await connect.fill('Team Blue');
    await expect(profile).toBeVisible();
    await connect.fill('Operations');
    await expect(profile).toBeVisible();
    await reload(['Updated']);
    await expect(profile).toBeHidden();
    await expect(chip).toBeVisible();
    await connect.fill('Updated');
    await expect(profile).toBeVisible();
    await closeConnect(page);
    await chip.click();
    await expect(connection.locator('[data-kind="terminal"]')).toHaveCount(before.terminals.filter(t => t.connectionId === connectionId).length);
    await expect(connection.locator('[data-kind="tab"]')).toHaveCount(before.workspaces.filter(w => w.connectionId === connectionId).reduce((count, w) => count + w.tabs.length, 0));
    await reload(Array.from({ length: 32 }, (_, i) => String(i).padEnd(64, 'x')));
    for (const theme of ['dark', 'light', 'system']) {
      await page.evaluate(appearance => window.bartizan.settings({ appearance }), theme);
      for (const zoom of [1, 1.25]) {
        await application.evaluate(({ BrowserWindow }, zoom) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(800, 700); window.webContents.setZoomFactor(zoom); }, zoom);
        await openConnect(page);
        await expect(profile).toBeVisible();
        await expect.poll(() => dialog.locator('.connect-body').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
        await closeConnect(page);
      }
    }
    await reload([]);
    await openConnect(page);
    await expect(profile.locator('.tag')).toHaveCount(0);
    await closeConnect(page);
    assert.deepEqual((await state()).profiles.find(p => p.id === 'rig').tags, []);
    const after = await state();
    assert.deepEqual(after.connections, before.connections);
    assert.deepEqual(after.terminals, before.terminals);
    assert.deepEqual(after.workspaces.map(w => [w.id, w.tabs.map(t => t.id)]), before.workspaces.map(w => [w.id, w.tabs.map(t => t.id)]));
    assert.deepEqual((await state()).connections.find(connection => connection.id === connectionId), connectionBefore);
    console.log('Profile tags render as text, match Connect search without hiding connections, reload live without changing SSH or tabs, and fit narrow themed layouts.');
  } finally {
    await writeFile(config, original);
    await page.evaluate(() => window.bartizan.reloadConfig());
    await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.webContents.setZoomFactor(1); window.setSize(1280, 800); });
    await page.evaluate(() => window.bartizan.settings({ appearance: 'dark' }));
  }
}
