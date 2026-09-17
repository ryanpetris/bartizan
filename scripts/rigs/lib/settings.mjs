import { expect } from '@playwright/test';

export async function openSettings(page) {
  const dialog = page.locator('#settings-dialog');
  if (!(await dialog.evaluate(node => node.open))) await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}
export async function closeSettings(page) {
  await page.locator('#settings-dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('#settings-dialog')).toBeHidden();
}
/** Chooses an appearance in Settings and waits until the main process has saved it; `app` comes from `launch`. */
export async function chooseAppearance(app, mode) {
  const dialog = await openSettings(app.page);
  await dialog.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption(mode);
  await expect.poll(async () => (await app.state()).settings.appearance).toBe(mode);
  await closeSettings(app.page);
}
/** Reads the background of an open select's option list from the rendered window. */
export async function pickerBackground({ application, page }, select) {
  await select.click();
  const option = select.locator('option').nth(1);
  await expect(option).toBeVisible();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const box = await option.boundingBox();
  const color = await application.evaluate(async ({ BrowserWindow }, rect) => {
    const [b, g, r] = (await BrowserWindow.getAllWindows()[0].capturePage(rect)).toBitmap();
    return `rgb(${r}, ${g}, ${b})`;
  }, { x: Math.round(box.x + box.width - 4), y: Math.round(box.y + box.height / 2), width: 1, height: 1 });
  await page.keyboard.press('Escape');
  await expect(option).toBeHidden();
  return color;
}
