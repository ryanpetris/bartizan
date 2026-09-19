import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { networkInterfaces, userInfo } from 'node:os';
import { join } from 'node:path';
import { withDirectory, startSshd, launch, waitFor } from './lib/harness.mjs';

const scoped = Object.entries(networkInterfaces()).flatMap(([name, addresses]) => (addresses ?? [])
  .filter(address => address.family === 'IPv6' && address.address.startsWith('fe80:'))
  .map(address => `${address.address}%${name}`))[0];

await withDirectory('connect', async (directory, cleanup) => {
  const sshd = await startSshd(directory, { host: '::1', config: scoped ? `ListenAddress ${scoped}\n` : '' });
  cleanup(sshd.stop);
  const config = join(directory, 'config.yaml');
  const source = `version: 1\ndefaults:\n  port: ${sshd.port}\n  auth:\n    method: key\n    identity_files: [${JSON.stringify(sshd.identity)}]\n  host_keys:\n    policy: accept-new\nprofiles:\n  loopback:\n    label: IPv6 profile\n    host: "[::1]"\n`;
  await writeFile(config, source);
  const app = await launch(directory, config);
  cleanup(app.close);
  const { page, api, waitState, recordOutput, output, errors } = app;
  const dialogs = await app.modal();
  const dialog = dialogs.locator('#connect-dialog');
  const search = dialog.getByRole('textbox', { name: 'Profile or Host', exact: true });
  const options = dialog.locator('.connect-list').locator('.profile-item, .destination-item');
  const add = page.locator('.rail').getByRole('button', { name: 'New Connection', exact: true });
  const openConnect = async () => {
    await add.click();
    await expect(search).toBeFocused();
  };
  /** Closes Connect, which hands focus back to New Connection. */
  const closeConnect = async () => {
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(add).toBeFocused();
  };
  const home = page.getByRole('button', { name: 'Home', exact: true });
  const nothingOpen = page.getByRole('region', { name: 'Nothing Open', exact: true });
  await recordOutput();

  // The home page has no panel and no controls; New Connection opens Connect over every profile.
  await expect(page.locator('.home-view')).toBeVisible();
  await expect(page.locator('.home-view').getByRole('button')).toHaveCount(0);
  await expect(page.locator('.home-view').getByRole('textbox')).toHaveCount(0);
  await expect(page.locator('.rail-panel')).toHaveCount(0);
  await expect(home).toHaveAttribute('aria-current', 'page');
  await openConnect();
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText('IPv6 profile');
  const profileIcon = options.first().locator('.identicon');
  await expect(profileIcon).toBeVisible();
  const profilePattern = await profileIcon.innerHTML();
  await writeFile(config, source.replace('IPv6 profile', 'Renamed profile'));
  await api('reloadConfig');
  await expect(options.first()).toContainText('Renamed profile');
  assert.equal(await profileIcon.innerHTML(), profilePattern, 'A display name change keeps the profile icon');
  await writeFile(config, source);
  await api('reloadConfig');
  await expect(options.first()).toContainText('IPv6 profile');
  await search.fill('::1');
  await expect(options).toHaveCount(2);
  await expect(options.first()).toContainText('IPv6 profile');
  await expect(options.last()).toHaveAccessibleName('Connect to ::1');
  await expect(dialog.locator('.profile-row + .destination-row')).toHaveCount(1);
  // The first result is chosen, and shows it while the search has focus.
  await expect(options.first()).toHaveAttribute('data-chosen');
  await expect(options.last()).not.toHaveAttribute('data-chosen');
  const background = locator => locator.evaluate(node => getComputedStyle(node).backgroundColor);
  assert.notEqual(await background(options.first()), await background(options.last()), 'The chosen result is highlighted');
  await search.fill('[::1]');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toHaveAttribute('data-chosen');
  await closeConnect();
  await page.keyboard.press('Control+Shift+N');
  await expect(search).toBeFocused();
  await closeConnect();
  console.log('Connect lists every profile, then a direct connection when the search names a destination, and highlights the first result once there is text; Ctrl+Shift+N opens it.');

  // A connection made through the interface is shown; one made through the API is chosen from the rail.
  const directPatterns = new Map();
  const verify = async (host, profileId, username, { choose = false, preview } = {}) => {
    const state = await waitState(s => s.connections.length === 1 && s.terminals[0]?.status === 'connected', `connection to ${host}`);
    const [connection] = state.connections, [terminal] = state.terminals;
    const icon = page.locator(`.connection-chip[data-id="${connection.id}"] .identicon`);
    await expect(icon).toBeVisible();
    const pattern = await icon.innerHTML();
    if (preview) assert.equal(pattern, preview, 'The destination row matches the connected badge');
    if (profileId) assert.equal(pattern, profilePattern, 'The profile list and connected badge share an icon');
    else {
      const target = JSON.stringify([host, username]);
      if (directPatterns.has(target)) assert.equal(pattern, directPatterns.get(target), 'A direct connection keeps its icon across sessions');
      directPatterns.set(target, pattern);
    }
    assert.deepEqual({ host: connection.host, profileId: connection.profileId, username: connection.username }, { host, profileId, username });
    await expect(dialog).toBeHidden();
    await expect(dialogs.locator('#connection-dialog')).toBeHidden();
    if (choose) await page.locator(`.connection-chip[data-id="${connection.id}"] .connection-titles`).click();
    // The terminal comes into view with focus; New Connection stays in the rail beside the panel.
    await expect(page.locator(`[data-kind="terminal"][data-id="${terminal.id}"]`)).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-helper-textarea')).toBeFocused();
    await expect(home).not.toHaveAttribute('aria-current');
    const button = await add.boundingBox(), panel = await page.locator('.rail-panel').boundingBox();
    assert.ok(button.x >= 0 && button.x + button.width <= panel.x, 'New Connection sits in the rail');
    await api('input', terminal.id, "printf 'DIRECT_%s\\n' READY\n");
    await waitFor(async () => (await output(terminal.id)).includes('DIRECT_READY'), 'terminal output');
    await api('closeTerminal', terminal.id);
    assert.equal((await waitState(s => !s.terminals.length, 'terminal closed')).connections[0].status, 'connected');
    // The connection stays in view with nothing open; Home returns to the home page, and arrow keys run from it down the rail.
    await expect(nothingOpen).toBeVisible();
    await expect(nothingOpen).toContainText('Nothing Open');
    await expect(page.locator('.rail-panel')).toHaveCount(1);
    await home.click();
    await expect(page.locator('.home-view')).toBeVisible();
    await expect(nothingOpen).toBeHidden();
    await expect(page.locator('.rail-panel')).toHaveCount(0);
    await expect(home).toHaveAttribute('aria-current', 'page');
    await expect(home).toBeFocused();
    await openConnect();
    await search.fill('::1');
    const destinationIcon = dialog.locator('.destination-item .identicon');
    await expect(destinationIcon).toBeVisible();
    if (!profileId && !username && host === '::1') assert.equal(await destinationIcon.innerHTML(), pattern, 'The destination row shows the same icon');
    await closeConnect();
    await home.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator(`.connection-chip[data-id="${connection.id}"] .connection-titles`)).toBeFocused();
    // Removing the connection in view from its panel returns to the home page, with focus on Home.
    await page.keyboard.press('Enter');
    await expect(page.locator('.rail-panel')).toHaveCount(1);
    // Choosing a connection moves focus into it on the next frame.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await api('disconnect', connection.id);
    const remove = page.locator('.rail-panel .connection-remove');
    await expect(remove).toBeVisible();
    await remove.focus();
    await page.keyboard.press('Enter');
    await waitState(s => !s.connections.length, 'connection removed');
    await expect(page.locator('.home-view')).toBeVisible();
    await expect(home).toBeFocused();
  };
  await openConnect();
  await search.fill('::1');
  await search.press('Enter');
  await verify('::1', 'loopback', undefined);
  for (const destination of ['[::1]', `${userInfo().username}@[::1]`]) {
    await openConnect();
    await search.fill(destination);
    await expect(options).toHaveCount(1);
    const preview = await options.first().locator('.identicon').innerHTML();
    await search.press('Enter');
    await verify('::1', undefined, destination.includes('@') ? userInfo().username : undefined, { preview });
  }
  console.log('Enter connects the first result: an IPv6 profile, or a bracketed IPv6 destination with or without a username, using the configured defaults.');
  if (scoped) {
    await openConnect();
    await search.fill(scoped);
    await expect(options).toHaveCount(1);
    await search.press('Enter');
    await verify(scoped, undefined, undefined);
    console.log('A scoped link-local IPv6 destination connects.');
  } else console.log('No link-local IPv6 interface is available; the scoped destination was not tried.');

  await openConnect();
  await dialog.getByRole('button', { name: 'New Profile', exact: true }).click();
  await expect(dialog).toBeHidden();
  const form = dialogs.locator('#connection-dialog');
  await expect(form.locator('#connection-title')).toHaveText('New Profile');
  await form.locator('#field-host').fill('[::1]');
  await form.getByRole('button', { name: 'Connect', exact: true }).click();
  await verify('::1', undefined, undefined);
  await api('connect', { host: '[::1]' });
  await verify('::1', undefined, undefined, { choose: true });
  console.log('The New Profile form and a host target connect to a bracketed IPv6 address.');

  await writeFile(config, source.replace('defaults:\n', `defaults:\n  username: ${JSON.stringify(userInfo().username)}\n`));
  await api('reloadConfig');
  await openConnect();
  await search.fill('[::1]');
  const defaultUserPreview = await options.first().locator('.identicon').innerHTML();
  await search.press('Enter');
  await verify('::1', undefined, userInfo().username, { preview: defaultUserPreview });
  await writeFile(config, source);
  await api('reloadConfig');
  console.log('Quick-connect icons match their connection badges with explicit, default and omitted usernames.');

  await openConnect();
  for (const invalid of ['@host', 'host:22', '[::1', '999.1.1.1']) {
    await search.fill(invalid);
    await expect(options).toHaveCount(0);
    await expect(dialog.getByText('No Results Found', { exact: true })).toBeVisible();
    await search.press('Enter');
    await page.waitForTimeout(200);
    assert.equal((await app.state()).connections.length, 0, invalid);
  }
  await closeConnect();
  assert.equal(await readFile(config, 'utf8'), source);
  assert.deepEqual(errors, []);
  console.log('Invalid destinations offer nothing to connect, and connecting never writes the configuration.');
});
