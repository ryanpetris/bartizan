import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { withDirectory, launch } from './lib/harness.mjs';
import { openSettings, closeSettings, chooseAppearance, pickerBackground, showSection } from './lib/settings.mjs';

const defaults = { appearance: 'dark', theme: 'rail', interfaceFont: 'Inter', terminalFont: 'JetBrains Mono', terminalFontSize: 13, terminalLigatures: true, terminalWebgl: false, remoteSessionIntegration: true };
const dialogBackground = { dark: 'rgb(30, 32, 41)', light: 'rgb(255, 255, 255)' };
const railBackground = { dark: 'rgb(15, 16, 21)', light: 'rgb(228, 229, 238)' };
const pageBackground = { dark: 'rgb(26, 28, 35)', light: 'rgb(252, 252, 253)' };

await withDirectory('appearance', async (directory, cleanup) => {
  const config = join(directory, 'config.yaml');
  const saved = async () => parse(await readFile(config, 'utf8')).settings;
  let app;
  cleanup(() => app?.close());
  const start = async () => {
    const previous = app;
    app = undefined;
    await previous?.close();
    app = await launch(directory, config, { colorScheme: null });
    return app;
  };
  const themeSource = () => app.application.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
  const colorScheme = mode => app.page.waitForFunction(mode => getComputedStyle(document.documentElement).colorScheme === mode, mode);
  const settingsDialog = () => dialog;
  const appearance = () => settingsDialog().getByRole('combobox', { name: 'Appearance', exact: true });
  const fontChoice = () => settingsDialog().getByRole('combobox', { name: 'Terminal Font', exact: true });
  const family = () => settingsDialog().getByRole('textbox', { name: 'Terminal Font Family', exact: true });
  const size = () => settingsDialog().getByRole('spinbutton', { name: 'Terminal Font Size', exact: true });
  const failure = `Could not save settings ${config}`;
  const section = name => showSection(settingsDialog(), name);

  await writeFile(config, 'version: 1\n');
  let { page, state, api } = await start();
  assert.equal((await state()).settings.appearance, 'dark');
  let dialog = await openSettings(page);
  await expect(appearance()).toBeFocused();
  await expect(appearance()).toHaveValue('dark');
  await closeSettings(page);
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
  for (const mode of ['dark', 'light']) {
    await chooseAppearance(app, mode);
    await colorScheme(mode);
    assert.equal(await themeSource(), mode);
    await expect(page.locator('.rail')).toHaveCSS('background-color', railBackground[mode]);
    dialog = await openSettings(page);
    await expect(dialog).toHaveCSS('background-color', dialogBackground[mode]);
    for (const [name, select] of [['Appearance', appearance()], ['Terminal', fontChoice()]]) {
      await section(name);
      assert.equal(await pickerBackground(app, select), dialogBackground[mode], `Settings options follow ${mode} appearance`);
    }
    await expect(dialog).toHaveJSProperty('open', true);
    await closeSettings(page);
    await page.locator('.rail').getByRole('button', { name: 'New Connection', exact: true }).click();
    const connect = page.locator('.connect');
    await expect(connect).toBeVisible();
    await expect(page.locator('.main')).toHaveCSS('background-color', pageBackground[mode]);
    await connect.getByRole('button', { name: 'New Profile', exact: true }).click();
    const form = (await app.modal()).locator('#connection-dialog');
    await expect(form).toHaveCSS('background-color', dialogBackground[mode]);
    await form.getByRole('tab', { name: 'Authentication', exact: true }).click();
    assert.equal(await pickerBackground(app, form.locator('#field-auth-method')), dialogBackground[mode], `Connection form options follow ${mode} appearance`);
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(form).toBeHidden();
  }
  await chooseAppearance(app, 'dark');
  await colorScheme('dark');
  console.log('Appearance is chosen in Settings without connections and themes the rail, dialogs and option lists.');

  for (const patch of [{ appearance: 'invalid' }, { terminalFontSize: 7 }, { terminalFontSize: 33 }, { terminalFontSize: 12.5 }, { terminalFont: 'x'.repeat(257) }, { terminalFont: 'Bad\nFont' }, { unknown: true }]) {
    await assert.rejects(api('settings', patch), undefined, JSON.stringify(patch));
  }
  assert.deepEqual((await state()).settings, defaults);
  assert.equal(await themeSource(), 'dark');
  console.log('Invalid settings are rejected without changing the saved settings.');

  dialog = await openSettings(page);
  await appearance().selectOption('light');
  await colorScheme('light');
  await expect.poll(async () => (await saved())?.appearance).toBe('light');
  await section('Terminal');
  await fontChoice().selectOption({ label: 'Custom' });
  await expect(family()).toBeFocused();
  await family().fill('  Bartizan Rig Mono  ');
  await family().press('Enter');
  await expect.poll(async () => (await saved())?.terminalFont).toBe('Bartizan Rig Mono');
  await size().fill('7');
  await expect(size()).toHaveAttribute('aria-invalid', 'true');
  await size().press('Enter');
  await expect(size()).toHaveValue('13');
  assert.equal((await state()).settings.terminalFontSize, 13);
  await size().fill('21');
  await size().press('Enter');
  await expect.poll(async () => (await saved())?.terminalFontSize).toBe(21);
  await expect(dialog.locator('.font-sample')).toHaveCSS('font-size', '21px');
  assert.match(await dialog.locator('.font-sample').evaluate(e => e.style.fontFamily), /^"Bartizan Rig Mono", /);
  await closeSettings(page);
  await page.reload();
  dialog = await openSettings(page);
  await expect(appearance()).toHaveValue('light');
  await section('Terminal');
  await expect(fontChoice().locator('option:checked')).toHaveText('Custom');
  await expect(family()).toHaveValue('Bartizan Rig Mono');
  await expect(size()).toHaveValue('21');
  await closeSettings(page);

  ({ page, state } = await start());
  assert.equal(await themeSource(), 'light');
  assert.deepEqual((await state()).settings, { ...defaults, appearance: 'light', terminalFont: 'Bartizan Rig Mono', terminalFontSize: 21 });
  await expect(page.locator('.rail')).toHaveCSS('background-color', railBackground.light);
  await chooseAppearance(app, 'system');
  await expect.poll(themeSource).toBe('system');
  const systemDark = await app.application.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
  await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(systemDark);
  await expect.poll(async () => (await saved())?.appearance).toBe('system');
  for (const mode of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: mode });
    await colorScheme(mode);
  }
  await page.emulateMedia({ colorScheme: null });
  console.log('Settings survive a renderer reload and a restart; System follows the native appearance and media changes.');

  ({ page, state } = await start());
  assert.equal(await themeSource(), 'system');
  const validSource = await readFile(config, 'utf8');
  await rm(config);
  await mkdir(config);
  dialog = await openSettings(page);
  await expect(appearance()).toHaveValue('system');
  await appearance().selectOption('light');
  await expect(dialog.getByRole('alert')).toHaveText(failure);
  await expect(appearance()).toHaveValue('system');
  assert.equal(await themeSource(), 'system');
  // Closing the dialog confirms the typed size, so its failure arrives as the dialog goes.
  await section('Terminal');
  await size().focus();
  await dialog.page().keyboard.press('Control+a');
  await dialog.page().keyboard.type('14');
  await dialog.page().keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-sonner-toaster]')).toContainText(failure);
  assert.equal((await state()).settings.terminalFontSize, 21);
  await rm(config, { recursive: true });
  await writeFile(config, validSource);
  dialog = await openSettings(page);
  await expect(dialog.getByRole('alert')).toBeHidden();
  await section('Terminal');
  await expect(size()).toHaveValue('21');
  await section('Appearance');
  await appearance().selectOption('dark');
  await expect.poll(async () => (await saved())?.appearance).toBe('dark');
  await expect(dialog.getByRole('alert')).toBeHidden();
  await section('Terminal');
  await expect(family()).toHaveValue('Bartizan Rig Mono');
  await closeSettings(page);
  console.log('A failed save is reported in the dialog, or as a toast once the dialog has closed, and leaves the settings unchanged.');

  await writeFile(config, 'version: [\n');
  ({ page, state } = await start());
  assert.equal(await themeSource(), 'dark');
  await page.getByRole('button', { name: 'Errors', exact: true }).click();
  const dialogs = await app.modal();
  await expect(dialogs.locator('.error-current')).toContainText('Invalid YAML');
  await dialogs.keyboard.press('Escape');
  assert.deepEqual((await state()).settings, defaults);
  dialog = await openSettings(page);
  await expect(appearance()).toHaveValue('dark');
  await closeSettings(page);
  assert.deepEqual(app.errors, []);
  console.log('A malformed configuration is a current error and the default settings apply.');
});
