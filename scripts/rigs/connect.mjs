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
  const add = page.locator('.sidebar').getByRole('button', { name: 'New Connection', exact: true });
  await recordOutput();

  await expect(search).toBeFocused();
  await expect(results).toBeHidden();
  const checkLayout = async width => {
    const field = await search.boundingBox(), sidebar = await page.locator('.sidebar').boundingBox(), button = await add.boundingBox();
    assert.ok(field.y > sidebar.y + sidebar.height - 70, 'Connect sits in the sidebar footer');
    assert.ok(button.x >= field.x + field.width && Math.abs(button.y - field.y) < 10, 'New Connection follows Connect');
    const list = await results.boundingBox();
    assert.ok(list.y >= 0 && list.y + list.height <= field.y, 'Connect results open above the field');
    assert.ok(Math.abs(list.x - field.x) < 2, 'Connect results align with the field');
    assert.ok(list.x + list.width <= width, 'Connect results fit the window');
  };
  const original = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  // Connect closes its results on resize, so a resize finishes once its event has been dispatched before a frame.
  const resize = async bounds => {
    await application.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), bounds);
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([bounds.width, bounds.height]);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  for (const bounds of [{ width: 950, height: 650 }, { width: 800, height: 500 }]) {
    await resize(bounds);
    await search.fill('');
    await search.fill('::1');
    await expect(results).toBeVisible();
    await expect(options).toHaveCount(2);
    await expect(options.first()).toContainText('IPv6 profile');
    await expect(options.last()).toHaveAttribute('aria-label', 'Connect to ::1');
    await checkLayout(bounds.width);
  }
  await resize(original);
  console.log('Connect sits in the sidebar footer and its results open above it, aligned and inside the window, at two window sizes; profiles are listed before the destination.');

  const verify = async (host, profileId, username) => {
    const state = await waitState(s => s.connections.length === 1 && s.terminals[0]?.status === 'connected', `connection to ${host}`);
    const [connection] = state.connections, [terminal] = state.terminals;
    assert.deepEqual({ host: connection.host, profileId: connection.profileId, username: connection.username }, { host, profileId, username });
    await expect(page.locator('#connection-dialog')).toBeHidden();
    await api('input', terminal.id, "printf 'DIRECT_%s\\n' READY\n");
    await waitFor(async () => (await output(terminal.id)).includes('DIRECT_READY'), 'terminal output');
    await api('closeTerminal', terminal.id);
    assert.equal((await waitState(s => !s.terminals.length, 'terminal closed')).connections[0].status, 'connected');
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
    await search.press('Enter');
    await verify('::1', undefined, destination.includes('@') ? userInfo().username : undefined);
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
  await verify('::1', undefined, undefined);
  console.log('The New Connection form and a host target connect to a bracketed IPv6 address.');

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
