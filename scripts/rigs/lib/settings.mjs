import { expect } from '@playwright/test';
import { modalOf } from './harness.mjs';

export async function openSettings(page) {
  const dialog = (await modalOf(page)).locator('#settings-dialog');
  if (!(await dialog.evaluate(node => node.open))) await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(dialog).toBeVisible();
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
  await dialog.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption(mode);
  await expect.poll(async () => (await app.state()).settings.appearance).toBe(mode);
  await closeSettings(app.page);
}
/** Reads the background of an open select's option list from the rendered view that holds it. */
export async function pickerBackground({ application, page }, select) {
  const owner = select.page();
  await select.click();
  const option = select.locator('option').nth(1);
  await expect(option).toBeVisible();
  await owner.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const box = await option.boundingBox();
  const color = await application.evaluate(async ({ BrowserWindow }, { rect, overlaid }) => {
    const window = BrowserWindow.getAllWindows()[0];
    // The modal overlay is the view that spans the window's width with no page in it.
    const contents = overlaid
      ? window.contentView.children.find(view => view.getVisible() && view.webContents.getURL() === 'about:blank' && view.getBounds().width === window.getContentBounds().width).webContents
      : window.webContents;
    const [b, g, r] = (await contents.capturePage(rect)).toBitmap();
    return `rgb(${r}, ${g}, ${b})`;
  }, { rect: { x: Math.round(box.x + box.width - 4), y: Math.round(box.y + box.height / 2), width: 1, height: 1 }, overlaid: owner !== page });
  await owner.keyboard.press('Escape');
  await expect(option).toBeHidden();
  return color;
}
