import { expect } from '@playwright/test';
import { chooseOption, modalOf, selectList } from './harness.mjs';

export async function openSettings(page) {
  const dialog = (await modalOf(page)).locator('#settings-dialog');
  if (!(await dialog.evaluate(node => node.open))) await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}
/** Shows a section of a form dialog by its tab. */
export async function showSection(dialog, name) {
  await dialog.getByRole('tab', { name, exact: true }).click();
  return dialog;
}
export async function closeSettings(page) {
  const dialog = (await modalOf(page)).locator('#settings-dialog');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
}
/** Chooses an appearance in Settings and waits until the main process has saved it; `app` comes from `launch`. */
export async function chooseAppearance(app, mode) {
  const dialog = await openSettings(app.page);
  await chooseOption(dialog.getByRole('button', { name: 'Appearance', exact: true }), mode);
  await expect.poll(async () => (await app.state()).settings.appearance).toBe(mode);
  await closeSettings(app.page);
}
/** Reads the background of a select's option list, which it opens and closes again. */
export async function listBackground(select) {
  await select.click();
  const list = await selectList(select);
  const color = await list.evaluate(node => getComputedStyle(node).backgroundColor);
  await list.page().keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(select).toBeFocused();
  return color;
}
