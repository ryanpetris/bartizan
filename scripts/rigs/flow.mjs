import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDirectory, startSshd, sshProfile, launch } from './lib/harness.mjs';

/** Keeps the end of each terminal's output in the page, which floods of output would otherwise fill. */
const recordTails = page => page.evaluate(() => {
  window.tails = {}; window.received = 0;
  window.bartizan.onEvent(event => {
    if (event.type !== 'data') return;
    window.received += event.data.length;
    window.tails[event.id] = ((window.tails[event.id] ?? '') + event.data).slice(-4096);
  });
});

await withDirectory('flow', async (directory, cleanup) => {
  const sshd = await startSshd(directory, { config: 'ForceCommand /bin/sh\n' });
  cleanup(sshd.stop);
  const config = join(directory, 'config.yaml');
  await writeFile(config, `version: 1\nsettings:\n  remoteSessionIntegration: false\nprofiles:\n  rig:\n${sshProfile(sshd)}`);
  const app = await launch(directory, config);
  cleanup(app.close);
  const { page, api, waitState, errors } = app;
  await recordTails(page);
  const tail = id => page.evaluate(id => window.tails[id] ?? '', id);
  const connection = await api('connect', { profileId: 'rig' });
  const first = (await waitState(s => s.terminals[0]?.status === 'connected')).terminals[0].id;
  await app.chooseConnection(connection);
  const select = id => page.locator(`.nav-item[data-kind="terminal"][data-id="${id}"]`).click();
  await select(first);
  const rows = page.locator('.terminal-surface:not([hidden]) .xterm-rows');
  await api('input', first, "PS1='FLOW''_PROMPT$ '\n");
  await expect(rows).toContainText('FLOW_PROMPT$');

  /** Floods the shown terminal, then interrupts it and waits for the prompt on screen. */
  const interrupt = async id => {
    await api('input', id, 'yes\n');
    await expect(rows).not.toContainText('FLOW_PROMPT$');
    await page.waitForTimeout(2000);
    const started = Date.now();
    await api('input', id, '\x03');
    await expect(rows).toContainText('FLOW_PROMPT$', { timeout: 5000 });
    return Date.now() - started;
  };
  const elapsed = await interrupt(first);
  const settled = await page.evaluate(() => window.received);
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.received), settled, 'Output stops once the prompt returns');
  await api('input', first, 'echo FLOW_$((6*7))\n');
  await expect(rows).toContainText('FLOW_42');
  console.log(`Ctrl+C during a flood of output returns the prompt in ${elapsed} ms.`);

  // A terminal that is not on show processes and acknowledges its output, so it runs to the end.
  const hidden = await api('newTerminal', connection);
  await waitState(s => s.terminals.find(t => t.id === hidden)?.status === 'connected');
  await select(first);
  await api('input', hidden, 'seq 1 400000; echo HIDDEN_$((6*7))\n');
  await expect.poll(() => tail(hidden), { timeout: 30000 }).toContain('HIDDEN_42');
  console.log('A terminal that is not shown keeps receiving output beyond the paused backlog.');

  // A page that loads again while a terminal is paused starts afresh, so the terminal flows to it.
  await api('input', first, 'yes\n');
  await page.waitForTimeout(1000);
  await page.reload();
  await page.waitForFunction(() => window.bartizan);
  await recordTails(page);
  await app.chooseConnection(connection);
  await select(first);
  await expect.poll(() => tail(first)).toContain('y\r\ny\r\n');
  const started = Date.now();
  await api('input', first, '\x03');
  await expect(rows).toContainText('FLOW_PROMPT$', { timeout: 5000 });
  console.log(`A reloaded page receives paused output, and Ctrl+C returns the prompt in ${Date.now() - started} ms.`);
  assert.deepEqual(errors, []);
});
