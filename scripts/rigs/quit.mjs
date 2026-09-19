import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, sshProfile, startSshd, waitFor, withDirectory } from './lib/harness.mjs';

await withDirectory('quit', async (directory, cleanup) => {
  const sshd = await startSshd(directory);
  cleanup(sshd.stop);
  const config = join(directory, 'config.yaml');
  await writeFile(config, `version: 1\nprofiles:\n  first:\n${sshProfile(sshd)}  second:\n${sshProfile(sshd)}`);
  /** Launches the application with the given profiles connected; `closed()` waits for it to exit. */
  const start = async (...profiles) => {
    const app = await launch(directory, config);
    let exited = false;
    app.application.once('close', () => { exited = true; });
    cleanup(() => exited || app.close());
    for (const profileId of profiles) await app.api('connect', { profileId });
    await app.waitState(s => s.connections.filter(c => c.status === 'connected').length === profiles.length, 'connections');
    return { ...app, closed: () => waitFor(() => exited, 'the application to exit') };
  };
  /** Asks the window to close, as its close button and the window manager do; the main process may exit before it answers. */
  const closeWindow = app => app.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => {});
  const windows = app => app.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

  // Closing the window with live connections asks first; Cancel and Escape keep the application open.
  const app = await start('first', 'second');
  const dialogs = await app.modal();
  const dialog = dialogs.locator('#quit-dialog');
  await app.page.evaluate(() => {
    window.rigQuitRequests = 0;
    window.bartizan.onEvent(event => { if (event.type === 'confirm-quit') window.rigQuitRequests++; });
  });
  await closeWindow(app);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading')).toHaveText('Quit Bartizan?');
  await expect(dialog.locator('.dialog-context')).toHaveText('2 active connections');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  const [first] = (await app.state()).connections;
  await app.api('disconnect', first.id);
  await app.waitState(s => s.connections.some(c => c.id === first.id && c.status === 'closed'), 'disconnected');
  await closeWindow(app);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.dialog-context')).toHaveText('1 active connection');
  // Closing again while it asks leaves the one dialog open.
  await closeWindow(app);
  await app.page.waitForFunction(() => window.rigQuitRequests === 3);
  await expect(dialogs.locator('dialog[open]')).toHaveCount(1);
  await dialogs.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  assert.equal(await windows(app), 1);
  assert.equal((await app.state()).connections.filter(c => c.status === 'connected').length, 1);
  console.log('Closing the window with live connections asks to quit, counting only live connections; Cancel and Escape keep it open.');

  // A close the page cannot hear while it reloads is asked once it has loaded; an acknowledged question does not lapse.
  await app.application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.once('did-navigate', () => window.close());
    window.webContents.reload();
  });
  const reloaded = (await app.modal()).locator('#quit-dialog');
  await expect(reloaded).toBeVisible();
  await reloaded.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(reloaded).toBeHidden();
  await new Promise(resolve => setTimeout(resolve, 2100));
  await closeWindow(app);
  await expect(reloaded).toBeVisible();
  console.log('A close made while the page reloads is asked once it has loaded, and closing more than two seconds after an answered question asks again.');

  await reloaded.getByRole('button', { name: 'Quit', exact: true }).click();
  await app.closed();
  assert.deepEqual(app.errors, []);
  console.log('Quit closes the application.');

  // Quitting the application does not ask, nor does closing the window once no connection is live.
  const quitting = await start('first');
  await quitting.application.evaluate(({ app }) => app.quit()).catch(() => {});
  await quitting.closed();
  const idle = await start('first');
  await idle.api('disconnect', (await idle.state()).connections[0].id);
  await idle.waitState(s => s.connections[0]?.status === 'closed', 'disconnected');
  await closeWindow(idle);
  await idle.closed();
  assert.deepEqual([...quitting.errors, ...idle.errors], []);
  console.log('Quitting the application, or closing the window with no live connection, exits without asking.');

  // A renderer that cannot take up the question lets a later close through.
  const hung = await start('first');
  await hung.page.evaluate(() => { setTimeout(() => { for (;;); }); });
  await closeWindow(hung);
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(await windows(hung), 1);
  await closeWindow(hung);
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(await windows(hung), 1, 'A close shortly after an unanswered question still waits');
  await closeWindow(hung);
  await hung.closed();
  console.log('With the renderer hung, closing the window again two seconds later exits.');
});
