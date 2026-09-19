import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { withDirectory, startSshd, sshProfile, launch, waitFor } from './lib/harness.mjs';
import { openSettings } from './lib/settings.mjs';

await withDirectory('fonts', async (directory, cleanup) => {
  const sshd = await startSshd(directory);
  cleanup(sshd.stop);
  const config = join(directory, 'config.yaml');
  await writeFile(config, `version: 1\nprofiles:\n  alpha:\n    label: Override\n${sshProfile(sshd, '    terminal:\n      font: ""\n      font_size: 20\n')}  beta:\n    label: Inherited\n${sshProfile(sshd)}`);
  const app = await launch(directory, config);
  cleanup(app.close);
  const { application, page, api, state, waitState, errors } = app;
  // Terminal sizes the renderer reports, by terminal.
  await application.evaluate(({ ipcMain }) => {
    globalThis.rigSizes = {};
    const request = ipcMain._invokeHandlers.get('request');
    ipcMain._invokeHandlers.set('request', (event, message) => {
      if (message.method === 'resize') { const [id, cols, rows] = message.args; globalThis.rigSizes[id] = { cols, rows }; }
      return request(event, message);
    });
  });
  const size = id => application.evaluate((_, id) => globalThis.rigSizes[id], id);
  // The bundled terminal font loads only once the rig releases it.
  await page.evaluate(() => {
    const load = document.fonts.load.bind(document.fonts);
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    window.releaseRigFont = release;
    document.fonts.load = (font, text) => font.includes('Bartizan JetBrains Mono') ? pending.then(() => load(font, text)) : load(font, text);
  });
  const openTerminal = async profileId => {
    const connection = await api('connect', { profileId });
    const state = await waitState(s => s.terminals.some(t => t.connectionId === connection && t.status === 'connected'), `${profileId} terminal`);
    return state.terminals.find(t => t.connectionId === connection).id;
  };
  const show = async id => {
    const { connectionId } = (await state()).terminals.find(terminal => terminal.id === id);
    await page.locator(`.connection-chip[data-id="${connectionId}"] .connection-titles`).click();
    await page.locator(`.nav-item[data-kind="terminal"][data-id="${id}"]`).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };

  const override = await openTerminal('alpha');
  await show(override);
  const explicit = await waitFor(() => size(override), 'override terminal size');
  const inherited = await openTerminal('beta');
  await show(inherited);
  // Focus moved elsewhere while a terminal waits for its font stays there once the terminal opens.
  const home = page.getByRole('button', { name: 'Home', exact: true });
  await home.focus();
  await page.waitForTimeout(300);
  assert.equal(await size(inherited), undefined, 'A terminal opens only once its font has loaded');
  await page.evaluate(() => window.releaseRigFont());
  const bundled = await waitFor(() => size(inherited), 'inherited terminal size');
  await expect(home).toBeFocused();
  assert.ok(explicit.cols < bundled.cols && explicit.rows < bundled.rows, 'The override terminal draws larger cells');
  await page.waitForFunction(() => {
    const faces = [...document.fonts].filter(face => face.family.includes('Bartizan JetBrains Mono'));
    return faces.length === 2 && faces.every(face => face.status === 'loaded');
  });
  assert.ok(await page.evaluate(() => document.fonts.check('italic bold 13px "Bartizan JetBrains Mono"')));
  await page.waitForFunction(() => [...document.fonts].some(face => face.family.includes('Bartizan Inter') && face.status === 'loaded'));
  assert.match(await page.locator('body').evaluate(e => getComputedStyle(e).fontFamily), /Bartizan Inter/);
  console.log('Bundled fonts load offline; a terminal opens once its font has loaded without taking back focus that has moved on.');

  await api('settings', { terminalFontSize: 18, interfaceFont: '' });
  await expect.poll(async () => (await size(inherited)).rows).toBeLessThan(bundled.rows);
  await expect.poll(() => page.locator('body').evaluate(e => getComputedStyle(e).fontFamily)).toMatch(/^system-ui/);
  await show(override);
  await page.waitForTimeout(300);
  assert.deepEqual(await size(override), explicit, 'The override terminal keeps its size');
  console.log('A connection with its own font keeps it while the global terminal and interface fonts change.');

  const settings = await openSettings(page);
  await settings.getByRole('combobox', { name: 'Terminal Font', exact: true }).selectOption({ label: 'System Default' });
  await settings.getByRole('combobox', { name: 'Interface Font', exact: true }).selectOption({ label: 'Inter' });
  await waitState(s => s.settings.terminalFont === '' && s.settings.interfaceFont === 'Inter', 'saved fonts');
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(() => page.locator('body').evaluate(e => getComputedStyle(e).fontFamily)).toMatch(/Bartizan Inter/);

  await page.getByRole('button', { name: 'New Connection', exact: true }).click();
  const dialogs = settings.page();
  await dialogs.locator('#connect-dialog .profile-row[data-id="alpha"] .profile-edit').click();
  const form = dialogs.locator('#connection-dialog');
  await form.getByRole('tab', { name: /^Terminal/ }).click();
  await expect(form.locator('[name="terminal.font"] option:checked')).toHaveText('System Default');
  await expect(form.locator('[name="terminal.font_size"]')).toHaveValue('20');
  await form.getByRole('button', { name: 'Reset Font', exact: true }).click();
  await form.getByRole('button', { name: 'Reset Font Size', exact: true }).click();
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form).toBeHidden();
  const saved = parse(await readFile(config, 'utf8'));
  assert.equal(saved.profiles.alpha.terminal, undefined);
  assert.equal(saved.settings.terminalFont, '');
  assert.equal(saved.settings.interfaceFont, 'Inter');
  assert.deepEqual(errors, []);
  console.log('System Default is distinct from inheriting the global font, and resetting profile font fields saves the profile without them.');
});
