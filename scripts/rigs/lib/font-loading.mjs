import { expect } from '@playwright/test';
import { showSection } from './settings.mjs';

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
  await dialog.locator('#settings-appearance').selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'light');
  await close();
  await open();
  await expect(dialog.locator('#settings-appearance')).toHaveValue('light');
  await expect(ui).toBeDisabled();
  await page.evaluate(() => window.releaseRigFonts());
  await expect(ui).toBeEnabled();
  await expect(ui.locator('option[value="Rig Proportional"]')).toHaveCount(1);
  await showSection(dialog, 'Terminal');
  await expect(font).toBeEnabled();
  await expect(font.locator('option[value="Rig Mono"]')).toHaveCount(1);
  await expect(font.locator('option[value="Rig Proportional"]')).toHaveCount(0);
  await expect(font.locator('option[value="Rig Unreadable"]')).toHaveCount(0);
  await font.selectOption('Rig Mono');
  await close();
  await open();
  await showSection(dialog, 'Terminal');
  await expect(font).toHaveValue('Rig Mono');
  await expect.poll(() => page.evaluate(() => window.rigFontQueries)).toBe(1);
  await font.selectOption('JetBrains Mono');
  await showSection(dialog, 'Appearance');
  await dialog.locator('#settings-appearance').selectOption('dark');
  await close();
  console.log('Settings remain editable and save while fonts load; the worker enables and filters the font choices.');
}
