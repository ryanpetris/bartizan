import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, sshProfile, startSshd, waitFor, withDirectory } from './lib/harness.mjs';

// BARTIZAN_RIG_DISPLAY selects the Ozone platform, such as wayland on a Wayland desktop.
const display = process.env.BARTIZAN_RIG_DISPLAY || 'x11';

await withDirectory('graphics', async (directory, cleanup) => {
  const sshd = await startSshd(directory); cleanup(sshd.stop);
  const config = join(directory, 'config.yaml');
  await writeFile(config, `version: 1\nprofiles:\n  fixture:\n${sshProfile(sshd)}`);
  const app = await launch(directory, config, { args: [`--ozone-platform=${display}`] }); cleanup(app.close);
  const { application, page, api, state, waitState, errors } = app;
  let logs = '';
  application.process().stderr.on('data', data => { logs += data; });
  const logged = event => waitFor(() => logs.includes(`"event":"${event}"`), `${event} to be logged`);
  const warnings = [];
  page.on('console', message => { if (message.text().includes('Too many active WebGL contexts')) warnings.push(message.text()); });

  const connection = await api('connect', { profileId: 'fixture' });
  const first = (await waitState(s => s.terminals[0]?.status === 'connected', 'connection')).terminals[0].id;
  const second = await api('newTerminal', connection);
  const select = id => page.locator(`[data-kind="terminal"][data-id="${id}"]`).click();
  const canvasSelector = '.terminal-surface:not([hidden]) .xterm-screen > canvas:not(.xterm-link-layer)';
  const canvas = page.locator(canvasSelector);
  await select(first);
  await expect(canvas, 'WebGL is required; set BARTIZAN_RIG_SOFTWARE_GL=1 without a graphics driver').toHaveCount(1);
  // Holding these references makes teardown observable independently of garbage collection.
  await page.evaluate(() => { window.contexts = []; });
  for (let index = 0; index < 48; index++) {
    await canvas.evaluate(node => window.contexts.push(node.getContext('webgl2')));
    await select(index % 2 ? first : second);
    await expect(canvas).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => window.contexts.every(context => context.isContextLost()))).toBe(true);
  }
  assert.deepEqual(warnings, []);
  const third = await api('newTerminal', connection);
  await select(third);
  await expect(canvas).toHaveCount(1);
  await canvas.evaluate(node => { window.closedContext = node.getContext('webgl2'); });
  await api('closeTerminal', third);
  await expect.poll(() => page.evaluate(() => window.closedContext.isContextLost())).toBe(true);
  console.log('Switching and closing terminals frees their WebGL contexts.');

  await select(first);
  await expect(canvas).toHaveCount(1);
  await canvas.evaluate(node => {
    const extension = node.getContext('webgl2').getExtension('WEBGL_lose_context');
    node.addEventListener('webglcontextlost', () => setTimeout(() => extension.restoreContext(), 50), { once: true });
    extension.loseContext();
  });
  await logged('terminal-restored');
  await expect(canvas).toHaveCount(1);
  await canvas.evaluate(node => node.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
  await expect(canvas).toHaveCount(0, { timeout: 6000 });
  await logged('terminal-lost');
  await logged('terminal-fallback');
  assert.deepEqual((await state()).connections.map(item => [item.id, item.status]), [[connection, 'connected']]);
  await api('input', first, "printf '\\nGRAPHICS_RECOVERY_OK\\n'\n");
  await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toContainText('GRAPHICS_RECOVERY_OK');
  await select(second);
  await select(first);
  await expect(canvas).toHaveCount(1);
  console.log('A restored context keeps WebGL; a lost one falls back to the DOM renderer until the terminal is shown again.');

  // A renderer crash must not end the SSH master or its remote shells. The Playwright page stays crashed after the
  // window reloads, so the rig reaches the new renderer through the main process.
  const inWindow = script => application.evaluate(({ BrowserWindow }, script) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(script), script);
  await application.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    globalThis.rigReloaded = false;
    contents.once('did-finish-load', () => { globalThis.rigReloaded = true; });
    process.kill(contents.getOSProcessId(), 'SIGKILL');
  });
  await logged('renderer-process-gone');
  await waitFor(() => application.evaluate(() => globalThis.rigReloaded), 'reload after the crash');
  assert.deepEqual((await waitState(s => s.terminals.length === 2)).connections.map(item => [item.id, item.status]), [[connection, 'connected']]);
  await inWindow(`(() => {
    window.recovered = '';
    window.bartizan.onEvent(event => { if (event.type === 'data') window.recovered += event.data; });
    document.querySelector('[data-kind="terminal"][data-id=${JSON.stringify(first)}]').click();
    window.bartizan.input(${JSON.stringify(first)}, 'echo RENDERER_RECOVERY_OK\\n');
  })()`);
  await waitFor(async () => (await inWindow('window.recovered')).includes('RENDERER_RECOVERY_OK'), 'terminal output after the crash');
  await waitFor(async () => await inWindow(`document.querySelectorAll('${canvasSelector}').length`) === 1, 'WebGL after the crash');

  const diagnostics = logs.split('\n').filter(line => line.startsWith('[graphics] ')).map(line => JSON.parse(line.slice('[graphics] '.length)));
  assert.ok(diagnostics.some(entry => entry.event === 'renderer-process-gone' && typeof entry.exitCode === 'number' && entry.reason));
  assert.ok(diagnostics.every(entry => entry.time && entry.requestedDisplay === display));
  assert.ok(!JSON.stringify(diagnostics).includes('RECOVERY_OK'));
  assert.deepEqual(errors, []);
  console.log(`${display}: a renderer crash reloads the window and keeps the SSH session; graphics logs carry no terminal content.`);
});
