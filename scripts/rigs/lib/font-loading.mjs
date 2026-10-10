import { expect } from '@playwright/test';
import { showSection } from './settings.mjs';
import { chooseOption, optionOf, selectList } from './harness.mjs';

/** Exercises the font worker while other settings save, with font access held until the rig releases it. */
export async function checkFontLoading(page, dialogs) {
  await page.evaluate(() => {
    window.rigFontQueries = 0;
    window.queryLocalFonts = () => {
      window.rigFontQueries++;
      return new Promise(resolve => {
        window.releaseRigFonts = () => resolve([
          ...['Rig Mono', 'Rig Proportional'].map((family, index) => ({
            family, style: 'Regular', postscriptName: family,
            blob: async () => {
              const bytes = new ArrayBuffer(44), data = new DataView(bytes);
              data.setUint32(0, 0x00010000); data.setUint16(4, 1);
              data.setUint32(12, 0x706f7374); data.setUint32(20, 28); data.setUint32(24, 16);
              data.setUint32(28, 0x00030000); data.setUint32(40, index === 0 ? 1 : 0);
              return new Blob([bytes]);
            },
          })),
          { family: 'Rig Unreadable', style: 'Regular', postscriptName: 'Unreadable', blob: async () => { throw new Error('Unreadable'); } },
        ]);
      });
    };
  });
  const open = () => page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = dialogs.locator('#settings-dialog');
  const close = async () => {
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog.locator('.form-shell')).toHaveCount(0);
  };
  await open();
  await expect(dialog).toBeVisible();
  const font = dialog.locator('#settings-font'), ui = dialog.locator('#settings-interface-font');
  await expect(ui).toBeDisabled();
  await showSection(dialog, 'Terminal');
  await expect(font).toBeDisabled();
  await expect(dialog.getByRole('textbox', { name: 'Terminal Font Family', exact: true, includeHidden: true })).toBeDisabled();
  await showSection(dialog, 'Appearance');
  await chooseOption(dialog.locator('#settings-appearance'), 'light');
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'light');
  await close();
  await open();
  await expect(dialog.locator('#settings-appearance')).toHaveAttribute('value', 'light');
  await expect(ui).toBeDisabled();
  await page.evaluate(() => window.releaseRigFonts());
  await expect(ui).toBeEnabled();
  // The list names installed fonts in their own typefaces, and typing finds them: a repeated letter steps through the
  // fonts it starts, and a run of letters finds the font they start.
  await ui.click();
  let list = await selectList(ui);
  await expect(optionOf(list, 'Rig Proportional')).toHaveCount(1);
  await expect(optionOf(list, 'Rig Proportional').locator('.menu-label')).toHaveCSS('font-family', '"Rig Proportional", system-ui, sans-serif');
  await expect(list).toBeFocused();
  await expect(optionOf(list, 'Inter')).toHaveAttribute('aria-selected', 'true');
  for (const name of ['Rig Mono', 'Rig Proportional']) {
    await list.page().keyboard.press('r');
    await expect(optionOf(list, name)).toBeFocused();
  }
  await list.page().waitForTimeout(600);
  await list.page().keyboard.type('rig m');
  await expect(optionOf(list, 'Rig Mono')).toBeFocused();
  // Escape closes the list and leaves the dialog open, and so does a click beside the list; focus returns to the select.
  await list.page().keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(ui).toBeFocused();
  await ui.click();
  list = await selectList(ui);
  await list.page().mouse.click(8, 200);
  await expect(list).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(ui).toBeFocused();
  await expect(ui).toHaveAttribute('value', 'Inter');
  await showSection(dialog, 'Terminal');
  await expect(font).toBeEnabled();
  await font.click();
  list = await selectList(font);
  await expect(optionOf(list, 'Rig Mono')).toHaveCount(1);
  await expect(optionOf(list, 'Rig Proportional')).toHaveCount(0);
  await expect(optionOf(list, 'Rig Unreadable')).toHaveCount(0);
  await optionOf(list, 'Rig Mono').click();
  await expect(list).toHaveCount(0);
  await close();
  await open();
  await showSection(dialog, 'Terminal');
  await expect(font).toHaveAttribute('value', 'Rig Mono');
  await expect.poll(() => page.evaluate(() => window.rigFontQueries)).toBe(1);
  await chooseOption(font, 'JetBrains Mono');
  await showSection(dialog, 'Appearance');
  await chooseOption(dialog.locator('#settings-appearance'), 'dark');
  await close();
  console.log('Settings remain editable and save while fonts load; the worker enables and filters the font choices.');
}
