import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDirectory, startSshd, sshProfile, launch } from './lib/harness.mjs';

await withDirectory('reconnect', async (directory, cleanup) => {
  const sshd = await startSshd(directory, { config: 'ForceCommand /bin/sh\n' });
  cleanup(sshd.stop);
  const config = join(directory, 'config.yaml');
  await writeFile(config, `version: 1\nsettings:\n  remoteSessionIntegration: false\nprofiles:\n  rig:\n${sshProfile(sshd)}  second:\n${sshProfile(sshd)}  third:\n${sshProfile(sshd)}`);
  const app = await launch(directory, config);
  cleanup(app.close);
  const { page, api, waitState, recordOutput, output, errors } = app;
  await recordOutput();
  const id = await api('connect', { profileId: 'rig' });
  const first = (await waitState(s => s.terminals[0]?.status === 'connected')).terminals[0].id;
  await app.chooseConnection(id);
  const terminal = id => page.locator(`.nav-item[data-kind="terminal"][data-id="${id}"]`);
  await terminal(first).click();
  await api('input', first, "printf 'KEEP_%s\\n' HISTORY\n");
  await expect.poll(() => output(first)).toContain('KEEP_HISTORY');
  await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toContainText('KEEP_HISTORY');
  const surface = await page.locator('.terminal-surface:not([hidden])').elementHandle();
  await api('input', first, "printf '\\033[?1000h\\033[?1006h'\n");
  await expect.poll(() => output(first)).toContain('\x1b[?1006h');
  const exited = await api('newTerminal', id);
  await api('input', exited, 'exit 0\n');
  await waitState(s => s.terminals.find(t => t.id === exited)?.status === 'closed');
  const ambiguous = await api('newTerminal', id);
  await api('input', ambiguous, 'exit 255\n');
  await waitState(s => s.terminals.find(t => t.id === ambiguous)?.status === 'closed');
  // Disconnect returns once the transport has ended and its final state has been sent.
  await api('disconnect', id);
  assert.equal((await app.state()).connections.find(c => c.id === id).exitCode, undefined);
  await expect(page.locator(`.connection-chip[data-id="${id}"] .status-dot`)).toHaveAttribute('aria-label', 'Closed');
  await page.locator('.connection-reconnect:visible').click();
  const restored = await waitState(s => s.terminals.find(t => t.id === first)?.status === 'connected');
  // The selected terminal resumes with the keyboard focus, so typing reaches its new shell.
  await expect(page.locator('.terminal-surface:not([hidden]) .xterm-helper-textarea')).toBeFocused();
  await page.keyboard.type("printf 'TYPED_%s\\n' RESUMED");
  await page.keyboard.press('Enter');
  await expect.poll(() => output(first)).toContain('TYPED_RESUMED');
  assert.equal(restored.terminals.length, 3);
  assert.equal(restored.terminals.find(t => t.id === exited).status, 'closed');
  assert.equal(restored.terminals.find(t => t.id === ambiguous).status, 'closed');
  assert.equal(await surface.evaluate(node => node === document.querySelector('.terminal-surface:not([hidden])')), true);
  await page.locator('.terminal-surface:not([hidden])').hover();
  await page.mouse.wheel(0, -10000);
  await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toContainText('KEEP_HISTORY');
  await terminal(first).click();
  await page.locator('.terminal-surface:not([hidden])').click({ position: { x: 100, y: 100 } });
  await api('input', first, "printf 'RESTORED_%s\\n' SHELL\n");
  await expect.poll(() => output(first)).toContain('RESTORED_SHELL');
  assert.ok(!(await output(first)).includes('command not found'), 'The new shell must not inherit mouse reporting');
  await terminal(exited).click();
  await page.getByRole('button', { name: 'Reconnect Terminal', exact: true }).click();
  await waitState(s => s.terminals.find(t => t.id === exited)?.status === 'connected');
  await api('input', exited, 'exit 7\n');
  await waitState(s => s.terminals.find(t => t.id === exited)?.status === 'closed');
  await expect.poll(() => output(exited)).toContain('Terminal exited with code 7');
  await api('reconnectTerminal', exited);
  await waitState(s => s.terminals.find(t => t.id === exited)?.status === 'connected');
  // The selected terminal takes the focus when it resumes after another terminal on its connection.
  await api('disconnect', id);
  await page.locator('.connection-reconnect:visible').click();
  await waitState(s => s.terminals.find(t => t.id === exited)?.status === 'connected');
  await expect(page.locator('.terminal-surface:not([hidden]) .xterm-helper-textarea')).toBeFocused();
  await page.keyboard.type("printf 'TYPED_%s\\n' SECOND");
  await page.keyboard.press('Enter');
  await expect.poll(() => output(exited)).toContain('TYPED_SECOND');
  // The selected terminal takes the focus when it resumes, even from a control focused while the connection completes.
  const fullscreen = page.getByRole('button', { name: 'Toggle Fullscreen', exact: true });
  await api('disconnect', id);
  await fullscreen.evaluate(button => document.addEventListener('focusin', function moved(event) {
    if (!event.target.matches('.nav-item')) return;
    document.removeEventListener('focusin', moved);
    button.focus();
  }));
  await page.locator('.connection-reconnect:visible').click();
  await waitState(s => s.terminals.find(t => t.id === exited)?.status === 'connected');
  await expect(page.locator('.terminal-surface:not([hidden]) .xterm-helper-textarea')).toBeFocused();
  // A terminal that resumes out of view leaves the focus alone.
  await terminal(first).click();
  await api('input', exited, 'exit 7\n');
  await waitState(s => s.terminals.find(t => t.id === exited)?.status === 'closed');
  await fullscreen.focus();
  await api('reconnectTerminal', exited);
  await expect(terminal(exited)).toHaveAttribute('data-status', 'connected');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(fullscreen).toBeFocused();
  assert.equal((await app.state()).terminals.find(t => t.id === ambiguous).status, 'closed');
  // A selected terminal that stays closed, and a selected connection page, leave the focus where reconnecting put it.
  for (const row of [terminal(ambiguous), page.locator(`.nav-item[data-kind="details"][data-id="${id}"]`)]) {
    await row.click();
    await api('disconnect', id);
    await page.locator('.connection-reconnect:visible').click();
    await waitState(s => s.terminals.find(t => t.id === exited)?.status === 'connected');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(terminal(first)).toBeFocused();
  }
  console.log('Disconnect closes without an exit code, and reconnect restores interrupted terminals in place; exited and ambiguous terminals require manual retry.');

  // Closing the selected connection follows the displayed order, including the last position.
  const second = await api('connect', { profileId: 'second' });
  const third = await api('connect', { profileId: 'third' });
  await waitState(s => s.connections.every(c => c.status === 'connected'));
  await app.chooseConnection(second);
  await api('disconnect', second);
  await page.locator('.connection-remove:visible').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`.connection-chip[data-id="${third}"] .connection-titles`)).toHaveAttribute('aria-current', 'true');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('.terminal-surface:not([hidden]) textarea').evaluate(node => node === document.activeElement), false);
  await api('disconnect', third);
  await api('removeConnection', third);
  await expect(page.locator(`.connection-chip[data-id="${id}"] .connection-titles`)).toHaveAttribute('aria-current', 'true');
  await api('disconnect', id);
  await api('removeConnection', id);
  await expect(page.locator('.home-button')).toHaveAttribute('aria-current', 'page');
  assert.deepEqual(errors, []);
  console.log('Closing a connection selects its following neighbor, then its preceding neighbor, then Home.');
});
