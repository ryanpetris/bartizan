import assert from 'node:assert/strict';
import { withDirectory, launch } from './lib/harness.mjs';

await withDirectory('smoke', async (directory, cleanup) => {
  const { application, page, errors, modal, close } = await launch(directory);
  cleanup(close);
  if (process.env.RELEASE_TAG) assert.equal(await application.evaluate(({ app }) => app.getVersion()), process.env.RELEASE_TAG.slice(1), 'Packaged application version must match the release tag');
  await page.getByRole('button', { name: 'New Connection', exact: true }).click();
  const dialogs = await modal();
  await dialogs.locator('#connect-dialog').getByRole('button', { name: 'New Profile', exact: true }).click();
  await dialogs.locator('[name="host"]').fill('example.invalid');
  await dialogs.locator('[name="username"]').fill('test');
  await dialogs.getByRole('button', { name: 'Preview Command' }).click();
  await dialogs.waitForFunction(() => document.querySelector('#connection-dialog pre')?.textContent?.includes('StrictHostKeyChecking=ask'));
  assert.deepEqual(errors, []);
  console.log('Electron launch, isolated preload, Connect, connection form, and SSH preview passed.');
});
