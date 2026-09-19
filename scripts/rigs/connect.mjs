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
  const { application, page, api, waitState, recordOutput, output, errors } = app;
  const search = page.getByRole('combobox', { name: 'Connect', exact: true });
  const results = page.locator('#connect-results');
  const options = results.locator('.connect-option');
  const add = page.locator('.rail').getByRole('button', { name: 'New Connection', exact: true });
  const home = page.getByRole('button', { name: 'Home', exact: true });
  const nothingOpen = page.getByRole('region', { name: 'Nothing Open', exact: true });
  await recordOutput();

  // The home page has no panel: Connect is on it, over every profile, and Home is current.
  await expect(search).toBeFocused();
  await expect(page.locator('.home-view')).toBeVisible();
  await expect(page.locator('.rail-panel')).toHaveCount(0);
  await expect(home).toHaveAttribute('aria-current', 'page');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText('IPv6 profile');
  await expect(options.first()).toHaveAttribute('aria-selected', 'false');
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
  const checkHome = async width => {
    const field = await search.boundingBox(), list = await results.boundingBox(), row = await options.first().boundingBox(), rail = await page.locator('.rail').boundingBox();
    assert.ok(field.x >= rail.x + rail.width, 'Connect sits on the home page beside the rail');
    assert.ok(list.y >= field.y + field.height, 'Connect lists its results below the field');
    assert.ok(Math.abs(row.x - field.x) < 2 && Math.abs(row.width - field.width) < 2, 'Connect results align with the field');
    assert.ok(list.x + list.width <= width, 'Connect results fit the window');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'The home page fits the window');
  };
  const original = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  // A resize finishes once the page has its new size and a frame has passed.
  const resize = async bounds => {
    await application.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), bounds);
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([bounds.width, bounds.height]);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const box = () => page.evaluate(() => {
    const list = document.querySelector('.connect-list'), view = document.querySelector('.home-view');
    return { height: list.getBoundingClientRect().height, scrolls: list.scrollHeight > list.clientHeight, page: view.scrollHeight > view.clientHeight };
  });
  // A long list scrolls in a box of its own, whose height stays put while filtering and follows the window while filtered.
  await writeFile(config, source + Array.from({ length: 30 }, (_, i) => `  s${i}:\n    label: Server ${i + 1}\n    host: s${i}.example.test\n`).join(''));
  await api('reloadConfig');
  await expect(options).toHaveCount(31);
  const full = await box();
  assert.ok(full.scrolls && !full.page, 'A long list scrolls in its box and the page does not');
  for (const query of ['Server 30', 's5.example.test', 'nothing matches']) {
    await search.fill(query);
    assert.equal((await box()).height, full.height, `The box keeps its height for "${query}"`);
  }
  // Far fewer results than fit, so a box sized to what it shows would shrink.
  await search.fill('Server 30');
  await resize({ width: 950, height: 650 });
  const filtered = await box();
  await search.fill('');
  assert.equal((await box()).height, filtered.height, 'A box resized while filtered has its unfiltered height');
  // A row the arrow keys choose comes clear of the fades at the box's edges.
  const chosenClear = () => page.evaluate(() => {
    const list = document.querySelector('.connect-list'), chosen = list.querySelector('[aria-selected="true"]').getBoundingClientRect(), bounds = list.getBoundingClientRect();
    return chosen.top >= bounds.top + 15.5 && chosen.bottom <= bounds.bottom - 15.5;
  });
  for (let i = 0; i < 9; i++) await search.press('ArrowDown');
  await expect.poll(chosenClear, 'a row chosen past the bottom edge is clear of the fade').toBe(true);
  for (let i = 0; i < 4; i++) await search.press('ArrowUp');
  await expect.poll(chosenClear, 'a row chosen past the top edge is clear of the fade').toBe(true);
  await search.press('Escape');
  await search.press('ArrowUp');
  await expect.poll(() => page.evaluate(() => {
    const list = document.querySelector('.connect-list'), last = [...list.querySelectorAll('.connect-option')].at(-1).getBoundingClientRect(), bounds = list.getBoundingClientRect();
    return last.top >= bounds.top - 0.5 && last.bottom <= bounds.bottom + 0.5;
  }), 'the last profile scrolls into the box').toBe(true);
  assert.equal(await page.evaluate(() => document.querySelector('.home-view').scrollTop), 0, 'Choosing the last profile leaves the page where it is');
  await search.press('Escape');
  await resize(original);
  await writeFile(config, source);
  await api('reloadConfig');
  await expect(options).toHaveCount(1);
  console.log('A long profile list scrolls in its own box, which keeps its height while filtering and after a resize while filtered.');
  for (const bounds of [{ width: 950, height: 650 }, { width: 800, height: 500 }]) {
    await resize(bounds);
    await search.fill('');
    const unfiltered = (await box()).height;
    await search.fill('::1');
    assert.equal((await box()).height, unfiltered, 'The box keeps room for the destination row');
    await expect(results).toBeVisible();
    await expect(options).toHaveCount(2);
    await expect(options.first()).toContainText('IPv6 profile');
    await expect(options.last()).toHaveAttribute('aria-label', 'Connect to ::1');
    await checkHome(bounds.width);
  }
  await search.fill('');
  await resize(original);
  console.log('At home, Connect lists its results below it, aligned and inside the window, at two window sizes; profiles are listed before the destination.');

  // A connection made through the interface is shown; one made through the API is chosen from the rail.
  const directPatterns = new Map();
  const verify = async (host, profileId, username, { choose = false, preview } = {}) => {
    const state = await waitState(s => s.connections.length === 1 && s.terminals[0]?.status === 'connected', `connection to ${host}`);
    const [connection] = state.connections, [terminal] = state.terminals;
    const icon = page.locator(`.connection-chip[data-id="${connection.id}"] .identicon`);
    await expect(icon).toBeVisible();
    const pattern = await icon.innerHTML();
    if (preview) assert.equal(pattern, preview, 'The quick-connect preview matches the connected badge');
    if (profileId) assert.equal(pattern, profilePattern, 'The profile list and connected badge share an icon');
    else {
      const target = JSON.stringify([host, username]);
      if (directPatterns.has(target)) assert.equal(pattern, directPatterns.get(target), 'A direct connection keeps its icon across sessions');
      directPatterns.set(target, pattern);
    }
    assert.deepEqual({ host: connection.host, profileId: connection.profileId, username: connection.username }, { host, profileId, username });
    await expect(page.locator('#connection-dialog')).toBeHidden();
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
    await expect(search).toBeFocused();
    await search.fill('::1');
    const destinationIcon = results.locator('.connect-destination .identicon');
    await expect(destinationIcon).toBeVisible();
    if (!profileId && !username && host === '::1') assert.equal(await destinationIcon.innerHTML(), pattern, 'The destination row shows the same icon');
    await search.fill('');
    await home.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator(`.connection-chip[data-id="${connection.id}"] .connection-titles`)).toBeFocused();
    await api('disconnect', connection.id);
    await api('removeConnection', connection.id);
    await waitState(s => !s.connections.length, 'connection removed');
  };
  await search.fill('::1');
  await search.press('Enter');
  await verify('::1', 'loopback', undefined);
  await expect(search).toHaveValue('');
  for (const destination of ['[::1]', `${userInfo().username}@[::1]`]) {
    await search.fill(destination);
    await expect(options).toHaveCount(1);
    const preview = await options.first().locator('.identicon').innerHTML();
    await search.press('Enter');
    await verify('::1', undefined, destination.includes('@') ? userInfo().username : undefined, { preview });
    await expect(search).toHaveValue('');
  }
  console.log('Enter connects the first result: an IPv6 profile, or a bracketed IPv6 destination with or without a username, using the configured defaults.');
  if (scoped) {
    await search.fill(scoped);
    await expect(options).toHaveCount(1);
    await search.press('Enter');
    await verify(scoped, undefined, undefined);
    console.log('A scoped link-local IPv6 destination connects.');
  } else console.log('No link-local IPv6 interface is available; the scoped destination was not tried.');

  await add.click();
  await page.locator('#field-host').fill('[::1]');
  await page.locator('#connection-dialog').getByRole('button', { name: 'Connect', exact: true }).click();
  await verify('::1', undefined, undefined);
  await api('connect', { host: '[::1]' });
  await verify('::1', undefined, undefined, { choose: true });
  console.log('The New Connection form and a host target connect to a bracketed IPv6 address.');

  await writeFile(config, source.replace('defaults:\n', `defaults:\n  username: ${JSON.stringify(userInfo().username)}\n`));
  await api('reloadConfig');
  await search.fill('[::1]');
  const defaultUserPreview = await options.first().locator('.identicon').innerHTML();
  await search.press('Enter');
  await verify('::1', undefined, userInfo().username, { preview: defaultUserPreview });
  await writeFile(config, source);
  await api('reloadConfig');
  console.log('Quick-connect icons match their connection badges with explicit, default and omitted usernames.');

  for (const invalid of ['@host', 'host:22', '[::1', '999.1.1.1']) {
    await search.fill(invalid);
    await expect(options).toHaveCount(0);
    await search.press('Enter');
    await page.waitForTimeout(200);
    assert.equal((await app.state()).connections.length, 0, invalid);
  }
  assert.equal(await readFile(config, 'utf8'), source);
  assert.deepEqual(errors, []);
  console.log('Invalid destinations offer nothing to connect, and connecting never writes the configuration.');
});
