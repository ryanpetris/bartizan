import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openSettings, closeSettings } from './lib/settings.mjs';
import { launch, sshProfile, startSshd, waitFor, withDirectory } from './lib/harness.mjs';

// BARTIZAN_RIG_DISPLAY selects the Ozone platform, such as wayland on a Wayland desktop.
const display = process.env.BARTIZAN_RIG_DISPLAY || 'x11';

await withDirectory('graphics', async (directory, cleanup) => {
  const sshd = await startSshd(directory); cleanup(sshd.stop);
  const config = join(directory, 'config.yaml');
  await writeFile(config, `version: 1\nprofiles:\n  fixture:\n${sshProfile(sshd)}  enabled:\n${sshProfile(sshd, '    terminal:\n      webgl: true\n')}  disabled:\n${sshProfile(sshd, '    terminal:\n      webgl: false\n')}`);
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
  await app.chooseConnection(connection);
  const select = id => page.locator(`[data-kind="terminal"][data-id="${id}"]`).click();
  const canvasSelector = '.terminal-surface:not([hidden]) .xterm-screen > canvas:not(.xterm-link-layer)';
  const canvas = page.locator(canvasSelector);
  await select(first);
  await expect(canvas).toHaveCount(0);
  await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toBeVisible();
  await api('input', first, "echo DOM_RENDERING_OK\n");
  await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toContainText('DOM_RENDERING_OK');
  const settingsDialog = await openSettings(page);
  const webgl = settingsDialog.getByRole('checkbox', { name: 'WebGL Rendering', exact: true });
  await expect(webgl).not.toBeChecked();
  await webgl.check();
  await expect.poll(async () => (await state()).settings.terminalWebgl).toBe(true);
  await closeSettings(page);
  await expect(canvas, 'WebGL is required; set BARTIZAN_RIG_SOFTWARE_GL=1 without a graphics driver').toHaveCount(1);
  await select(second);
  await expect(canvas).toHaveCount(1);
  await api('settings', { terminalWebgl: false });
  await expect(canvas).toHaveCount(0);
  await select(first);
  await expect(canvas).toHaveCount(0);
  await api('settings', { terminalWebgl: true });
  await expect(canvas).toHaveCount(1);

  for (const enabled of [true, false]) {
    await api('settings', { terminalWebgl: !enabled });
    const override = await api('connect', { profileId: enabled ? 'enabled' : 'disabled' });
    const connected = await waitState(s => s.terminals.some(t => t.connectionId === override && t.status === 'connected'));
    await app.chooseConnection(override);
    await select(connected.terminals.find(t => t.connectionId === override).id);
    if (!enabled) await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toBeVisible();
    await expect(canvas).toHaveCount(enabled ? 1 : 0);
    await api('settings', { terminalWebgl: enabled });
    await api('settings', { terminalWebgl: !enabled });
    await expect(canvas).toHaveCount(enabled ? 1 : 0);
    await api('disconnect', override);
    await api('removeConnection', override);
  }
  await api('settings', { terminalWebgl: true });
  await app.chooseConnection(connection);
  await select(first);
  await expect(canvas).toHaveCount(1);
  await expect(page.locator('#error-count')).toBeHidden();
  console.log('WebGL toggles live, inherited terminals follow global settings, and explicit profile values override them without errors.');
  // A full screen exercises character measurement when switching renderers, including styled and wide characters.
  await api('input', first, "printf '\\033[2J\\033[H'; printf '%30000s' '' | tr ' ' X; printf '\\033[1;3mλ界\\033[0m\\033]2;GRAPHICS_FULL_SCREEN\\007'; sleep 600\n");
  await expect(page.locator(`[data-kind="terminal"][data-id="${first}"]`)).toContainText('GRAPHICS_FULL_SCREEN');
  const browser = await api('newBrowser', connection);
  await page.evaluate(() => {
    window.widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    window.hiddenMeasurements = 0;
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      ...window.widthDescriptor,
      get() {
        const width = window.widthDescriptor.get.call(this);
        if (this.classList.contains('xterm-char-measure-element') && this.closest('.terminal-surface') && !width)
          window.hiddenMeasurements++;
        return width;
      },
    });
  });
  try {
    for (const programmatic of [false, true]) for (const target of [
      page.locator(`[data-kind="terminal"][data-id="${second}"]`),
      page.locator(`[data-kind="browser"][data-id="${browser}"]`),
      page.locator('.home-button'),
    ]) {
      await app.chooseConnection(connection);
      await select(first);
      await page.locator('.terminal-surface:not([hidden]) textarea').focus();
      if (programmatic) await target.evaluate(node => node.click());
      else await target.click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(() => window.hiddenMeasurements), 0, 'Renderer switches measure characters while visible');
    }
  } finally {
    await page.evaluate(() => {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', window.widthDescriptor);
      delete window.widthDescriptor;
    });
  }
  await app.chooseConnection(connection);
  await select(first);
  await api('input', first, '\u0003');
  console.log('Full terminals switch to terminals, browser sessions and Home without measuring hidden characters.');
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
  await expect(page.locator('#error-count')).toBeHidden();
  await expect(canvas).toHaveCount(1);
  await canvas.evaluate(node => node.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
  await expect(canvas).toHaveCount(0, { timeout: 6000 });
  await logged('terminal-lost');
  await logged('terminal-fallback');
  await expect(page.locator('#error-count')).toHaveText('1');
  const inspectErrors = async check => {
    await page.getByRole('button', { name: 'Errors', exact: true }).click();
    const panel = (await app.modal()).locator('#errors-dialog');
    await expect(panel).toBeVisible();
    await check(panel);
    await panel.getByRole('button', { name: 'Close', exact: true }).click();
  };
  await api('reportError', { source: 'rig', message: 'Backend event' });
  await inspectErrors(async panel => {
    await expect(panel.locator('.error-current .error-row')).toHaveCount(1);
    await expect(panel.locator('.error-current .error-row')).toHaveAttribute('data-terminal-id', first);
    await expect(panel.locator('.error-current')).toContainText('WebGL rendering is disabled for');
    await expect(panel.locator('.error-history')).toContainText('Backend event');
    await panel.getByRole('button', { name: 'Clear History', exact: true }).click();
    await expect(panel.locator('.error-history')).toBeHidden();
    await expect(panel.locator('.error-current .error-row')).toHaveCount(1);
  });
  assert.deepEqual((await state()).connections.map(item => [item.id, item.status]), [[connection, 'connected']]);
  await api('input', first, "printf '\\nGRAPHICS_RECOVERY_OK\\n'\n");
  await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toContainText('GRAPHICS_RECOVERY_OK');
  await select(second);
  await select(first);
  await expect(canvas).toHaveCount(1);
  await expect(page.locator('#error-count')).toBeHidden();
  console.log('A restored context keeps WebGL; a lost one falls back to the DOM renderer until the terminal is shown again.');

  const closed = await api('newTerminal', connection);
  await select(closed);
  await expect(canvas).toHaveCount(1);
  await canvas.evaluate(node => node.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
  await expect(page.locator('#error-count')).toHaveText('1');
  await api('closeTerminal', closed);
  await expect(page.locator('#error-count')).toBeHidden();
  await select(first);
  await expect(canvas).toHaveCount(1);
  await canvas.evaluate(node => node.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
  await expect(page.locator('#error-count')).toHaveText('1');
  await select(second);
  await expect(canvas).toHaveCount(1);
  await canvas.evaluate(node => node.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
  await expect(page.locator('#error-count')).toHaveText('2');
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args) {
      if (args[0] === 'webgl2') {
        HTMLCanvasElement.prototype.getContext = original;
        return null;
      }
      return original.apply(this, args);
    };
  });
  await select(first);
  await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toBeVisible();
  await expect(page.locator('#error-count')).toHaveText('1');
  await inspectErrors(async panel => {
    const current = panel.locator('.error-current .error-row');
    await expect(current).toHaveCount(1);
    await expect(current.locator('.error-label')).toHaveText('App');
    await expect(current.locator('.error-text')).toHaveText('WebGL rendering is disabled.');
    assert.equal(await current.getAttribute('data-terminal-id'), null);
  });
  await select(second);
  await expect(canvas).toHaveCount(0);
  await expect(page.locator('#error-count')).toHaveText('1');
  await api('settings', { terminalWebgl: false });
  await expect(page.locator('#error-count')).toBeHidden();
  await api('settings', { terminalWebgl: true });
  await expect(page.locator('#error-count')).toHaveText('1');
  console.log('Graphics errors persist through backend updates and history clearing, resolve per terminal, and collapse to one global failure.');


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
  // The reloaded window opens on the home page, so the connection is chosen before its terminal.
  await inWindow(`(async () => {
    window.recovered = '';
    window.bartizan.onEvent(event => { if (event.type === 'data') window.recovered += event.data; });
    document.querySelector('.connection-chip[data-id=${JSON.stringify(connection)}] .connection-titles').click();
    await new Promise(resolve => requestAnimationFrame(resolve));
    document.querySelector('[data-kind="terminal"][data-id=${JSON.stringify(first)}]').click();
    window.bartizan.input(${JSON.stringify(first)}, 'echo RENDERER_RECOVERY_OK\\n');
  })()`);
  await waitFor(async () => (await inWindow('window.recovered')).includes('RENDERER_RECOVERY_OK'), 'terminal output after the crash');
  await waitFor(async () => await inWindow(`document.querySelectorAll('${canvasSelector}').length`) === 1, 'WebGL after the crash');

  await waitFor(async () => await inWindow(`document.querySelector('#error-count').hidden`), 'graphics errors cleared after reload');

  const diagnostics = logs.split('\n').filter(line => line.startsWith('[graphics] ')).map(line => JSON.parse(line.slice('[graphics] '.length)));
  assert.ok(diagnostics.some(entry => entry.event === 'renderer-process-gone' && typeof entry.exitCode === 'number' && entry.reason));
  assert.ok(diagnostics.every(entry => entry.time && entry.requestedDisplay === display));
  assert.ok(!JSON.stringify(diagnostics).includes('RECOVERY_OK'));
  assert.deepEqual(errors, []);
  console.log(`${display}: a renderer crash reloads the window and keeps the SSH session; graphics logs carry no terminal content.`);
});
