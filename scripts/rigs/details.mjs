import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDirectory, startSshd, sshProfile, launch } from './lib/harness.mjs';

await withDirectory('details', async (directory, cleanup) => {
  const sshd = await startSshd(directory); cleanup(sshd.stop);
  const config = join(directory, 'config.yaml');
  await writeFile(config, `version: 1\nsettings:\n  remoteSessionIntegration: false\nprofiles:\n  test:\n${sshProfile(sshd)}`);
  const app = await launch(directory, config); cleanup(app.close);
  const { api, page, waitState, application } = app;
  const id = await api('connect', { profileId: 'test' });
  await waitState(s => s.connections[0]?.status === 'connected');
  await app.chooseConnection(id);
  const tab = page.locator('.nav-item[data-kind="details"]');
  const details = page.locator('.connection-details');
  for (const theme of ['rail', 'tabs', 'console']) {
    await api('settings', { theme });
    await expect(tab).toBeVisible();
    await expect(tab).toHaveAttribute('draggable', 'false');
    await tab.click();
    await expect(tab).toHaveAttribute('aria-current', 'page');
    await expect(details).toBeVisible();
    await expect(details).toBeFocused();
    await expect(details.locator('.details-status')).toHaveText('Connected');
    await expect(details.locator('.process-row')).toHaveCount(0);
    await expect(details.getByRole('button')).toHaveCount(0);
    await expect(page).toHaveTitle('test · Connection Details — Bartizan');
    const separator = await page.locator('.details-entry').evaluate(node => {
      const style = getComputedStyle(node);
      return [style.borderTopWidth, style.borderLeftWidth];
    });
    assert.equal(separator[theme === 'rail' ? 0 : 1], '1px');
    await api('settings', { remoteSessionIntegration: true });
    await expect(details.locator('.process-status')).toHaveText(['Running']);
    await expect(details.locator('.process-pid')).toHaveText(/^PID \d+$/);
    await expect(details.locator('[aria-labelledby="security-title"]')).toBeVisible();
    if (theme === 'rail') {
      const processId = (await app.state()).connections[0].processes[0].id;
      await page.reload();
      await app.chooseConnection(id);
      await tab.click();
      await expect(details.locator('.process-row')).toHaveAttribute('data-id', processId);
    }
    for (const width of [800, 1250]) {
      await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 820), width);
      await expect.poll(() => details.evaluate(node => {
        const connection = node.querySelector('[aria-labelledby="connection-title"]').getBoundingClientRect();
        const ssh = node.querySelector('[aria-labelledby="security-title"]').getBoundingClientRect();
        const processes = node.querySelector('.details-processes').getBoundingClientRect();
        const style = getComputedStyle(node);
        const wide = node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) >= 840;
        return (wide ? Math.abs(connection.top - ssh.top) < 1 && ssh.left > connection.right : ssh.top >= connection.bottom) && processes.top >= Math.max(connection.bottom, ssh.bottom) && node.scrollWidth <= node.clientWidth;
      })).toBe(true);
    }
    if (process.env.BARTIZAN_DETAILS_SCREENSHOTS) await page.screenshot({ path: join(process.env.BARTIZAN_DETAILS_SCREENSHOTS, `details-${theme}.png`) });
    await api('settings', { remoteSessionIntegration: false });
    await expect(details.locator('.process-row')).toHaveCount(0);
  }
  const terminal = (await app.state()).terminals[0].id;
  await api('closeTerminal', terminal);
  await expect(tab).toHaveAttribute('aria-current', 'page');
  await expect(details).toBeVisible();
  await api('disconnect', id);
  await expect(details.locator('.details-status')).toContainText('Closed');
  await expect(details.locator('.process-row')).toHaveCount(0);
  await api('reconnect', id);
  await waitState(s => s.connections[0]?.status === 'connected');
  await expect(details.locator('.details-status')).toHaveText('Connected');
  await expect(details.locator('.process-row')).toHaveCount(0);
  assert.deepEqual(app.errors, []);
  console.log('Connection details stay pinned across themes, empty sessions and reconnects.');
});
