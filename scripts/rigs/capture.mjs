import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { withDirectory, startSshd, sshProfile, launch, waitFor } from './lib/harness.mjs';

await withDirectory('capture', async (directory, cleanup) => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<title>Capture</title><body><button id="capture">Capture</button><script>
      window.keys = [];
      addEventListener('keydown', event => { keys.push(event.key); });
      document.querySelector('button').onclick = async () => {
        try {
          await document.documentElement.requestFullscreen();
          await navigator.keyboard.lock();
          await document.body.requestPointerLock();
          window.captured = true;
        } catch (error) { window.captureError = String(error); }
      };
    </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const sshd = await startSshd(directory, { config: 'ForceCommand /bin/sh\n' });
  cleanup(sshd.stop);
  const config = join(directory, 'config.yaml');
  await writeFile(config, `version: 1\nsettings:\n  remoteSessionIntegration: false\nprofiles:\n  rig:\n${sshProfile(sshd)}`);
  const wm = spawn('openbox', ['--sm-disable'], { stdio: 'ignore' });
  cleanup(() => wm.kill());
  await waitFor(() => execFileSync('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], { encoding: 'utf8' }).includes('window id #'));
  const app = await launch(directory, config);
  cleanup(app.close);
  const { application, page, api, waitState, errors } = app;
  const windowId = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readUInt32LE(0));
  execFileSync('xdotool', ['windowactivate', '--sync', String(windowId)]);
  const fullscreen = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen());
  await page.getByRole('button', { name: 'Toggle Fullscreen' }).click();
  await expect.poll(fullscreen).toBe(true);
  await api('setFullscreen', false);
  await expect.poll(fullscreen).toBe(false);
  const id = await api('connect', { profileId: 'rig' });
  await waitState(s => s.connections[0]?.status === 'connected');
  const workspace = await api('newBrowser', id);
  await api('browser', workspace, 'navigate', undefined, url);
  await app.chooseConnection(id);
  await page.locator('.nav-item[data-kind="tab"]').click();
  await waitState(s => s.workspaces[0]?.tabs[0]?.url.startsWith(url) && !s.workspaces[0].tabs[0].loading);
  execFileSync('xdotool', ['key', 'F11']);
  await expect.poll(fullscreen).toBe(true);
  await expect(page.locator('.browser-toolbar')).toBeHidden();
  execFileSync('xdotool', ['key', 'F11']);
  await expect.poll(fullscreen).toBe(false);
  await expect(page.locator('.browser-toolbar')).toBeVisible();
  await application.evaluate(({ Menu }) => { globalThis.originalPopup = Menu.prototype.popup; Menu.prototype.popup = function () { globalThis.fullscreenMenu = this; }; });
  const chooseMode = async label => {
    await expect.poll(() => application.evaluate((_electron, label) => globalThis.fullscreenMenu?.items.some(item => item.label === label), label)).toBe(true);
    assert.equal(await application.evaluate((_electron, label) => globalThis.fullscreenMenu.items.find(item => item.label === label).enabled, label), true);
    await application.evaluate((_electron, label) => globalThis.fullscreenMenu.items.find(item => item.label === label).click(), label);
  };
  const openModeMenu = async button => {
    await application.evaluate(() => { globalThis.fullscreenMenu = undefined; });
    await button.click({ button: 'right' });
  };
  const hint = () => waitFor(async () => {
    for (const candidate of application.windows()) if (candidate !== page && await candidate.evaluate(() => !!document.querySelector('.fullscreen-hint')).catch(() => false)) return candidate;
  });
  const exitFullscreen = async () => {
    execFileSync('xdotool', ['key', 'F11']);
    await expect.poll(fullscreen).toBe(false);
  };
  const fillsWindow = selector => page.locator(selector).evaluate(node => {
    const rect = node.getBoundingClientRect();
    return rect.x === 0 && rect.y === 0 && Math.abs(rect.width - innerWidth) < 1 && Math.abs(rect.height - innerHeight) < 1;
  });
  for (const theme of ['rail', 'console', 'tabs']) {
    await api('settings', { theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const button = page.getByRole('button', { name: 'Toggle Fullscreen' });
    const position = await button.boundingBox();
    assert.ok(position.y < 100 && position.x > (await page.evaluate(() => innerWidth)) / 2);
    const details = await page.getByRole('button', { name: 'Connection Details', exact: true }).boundingBox();
    const terminal = await (theme === 'tabs' ? button.locator('..').locator('.connection-add') : button.locator('..').getByRole('button', { name: 'New Terminal', exact: true })).boundingBox();
    assert.ok(details.x < position.x && position.x < terminal.x);
    await openModeMenu(button);
    await chooseMode('Fullscreen Window');
    await expect.poll(fullscreen).toBe(true);
    await expect(page.locator('.browser-toolbar')).toBeVisible();
    await openModeMenu(button);
    await chooseMode('Fullscreen Content');
    await expect(page.locator('.browser-toolbar')).toBeHidden();
    const notice = (await hint()).getByRole('status');
    await expect(notice).toHaveText('Press F11 to exit fullscreen');
    await page.waitForTimeout(4200);
    await expect(notice).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Toggle Fullscreen' })).toBeHidden();
    await expect.poll(() => fillsWindow('.browser-slot')).toBe(true);
    await expect.poll(() => application.evaluate(({ BrowserWindow }, url) => {
      const window = BrowserWindow.getAllWindows()[0], [width, height] = window.getContentSize();
      const bounds = window.contentView.children.find(view => view.webContents?.getURL().startsWith(url)).getBounds();
      return bounds.x === 0 && bounds.y === 0 && bounds.width === width && bounds.height === height;
    }, url)).toBe(true);
    await expect.poll(() => application.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(contents => contents.getURL().startsWith(url)).executeJavaScript('document.hasFocus()'), url)).toBe(true);
    execFileSync('xdotool', ['key', 'ctrl+f']);
    const closeFind = page.getByRole('button', { name: 'Close Find', exact: true });
    await expect(closeFind).toBeVisible();
    const findBounds = await closeFind.boundingBox();
    execFileSync('xdotool', ['mousemove', '--window', String(windowId), String(Math.round(findBounds.x + findBounds.width / 2)), String(Math.round(findBounds.y + findBounds.height / 2)), 'click', '1']);
    await expect(closeFind).toBeHidden();
    assert.equal(await fullscreen(), true);
    await api('reportError', { source: 'rig', message: 'Fullscreen notification' });
    await expect.poll(() => application.evaluate(async ({ BrowserWindow }) => {
      for (const view of BrowserWindow.getAllWindows()[0].contentView.children) {
        if (view.getVisible() && await view.webContents.executeJavaScript('document.documentElement.classList.contains("overlay-toasts")')) return view.getBounds().y >= 0;
      }
      return false;
    })).toBe(true);
    await exitFullscreen();
    await expect.poll(fullscreen).toBe(false);
    await expect(page.locator('.browser-toolbar')).toBeVisible();
    await page.locator('.nav-item[data-kind="terminal"]').click();
    await button.click();
    await expect.poll(fullscreen).toBe(true);
    await expect.poll(() => fillsWindow('.terminal-view')).toBe(true);
    await exitFullscreen();
    await expect.poll(fullscreen).toBe(false);
    await button.click();
    await expect.poll(fullscreen).toBe(true);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false));
    await expect.poll(fullscreen).toBe(false);
    await expect(page.locator('html')).toHaveAttribute('data-fullscreen', '');
    await page.locator('.nav-item[data-kind="tab"]').click();
  }
  await api('settings', { theme: 'rail' });
  console.log('Every theme places fullscreen at the top right, fills the window with browser or terminal content, and restores normal chrome on exit.');
  await page.getByRole('button', { name: 'Toggle Fullscreen' }).click();
  execFileSync('xdotool', ['key', 'ctrl+l']);
  await expect(page.locator('html')).toHaveAttribute('data-fullscreen', 'window');
  await expect(page.locator('.browser-toolbar input')).toBeFocused();
  await page.getByRole('button', { name: 'Toggle Fullscreen' }).click();
  await expect.poll(fullscreen).toBe(false);
  await api('browser', workspace, 'new');
  const blank = (await app.state()).workspaces[0].activeTab;
  await page.getByRole('button', { name: 'Toggle Fullscreen' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-fullscreen', 'content');
  await expect(page.locator('.browser-toolbar input')).toBeFocused();
  await page.locator('.browser-toolbar input').fill('https://example');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('event', { type: 'fullscreen', mode: 'content' }));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.locator('.browser-toolbar input').pressSequentially('.com');
  await expect(page.locator('.browser-toolbar input')).toHaveValue('https://example.com');
  await exitFullscreen();
  await expect.poll(fullscreen).toBe(false);
  await api('browser', workspace, 'close', blank);

  const evaluate = source => application.evaluate(({ webContents }, { url, source }) => webContents.getAllWebContents().find(contents => contents.getURL().startsWith(url)).executeJavaScript(source, true), { url, source });
  const focusPage = async () => {
    await expect.poll(() => application.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].contentView.children.some(view => view.getVisible() && view.webContents?.getURL().startsWith(url)), url)).toBe(true);
    await application.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(contents => contents.getURL().startsWith(url)).focus(), url);
  };
  const capture = async () => {
    await focusPage();
    await evaluate('window.captured = false; window.captureError = null; document.querySelector("button").click();');
    await expect.poll(() => evaluate('window.captureError || window.captured')).toBe(true);
    await expect.poll(fullscreen).toBe(true);
    await expect.poll(() => application.evaluate(({ BrowserWindow }, url) => {
      const window = BrowserWindow.getAllWindows()[0];
      const view = window.contentView.children.find(view => view.webContents?.getURL().startsWith(url));
      const [width, height] = window.getContentSize();
      return { actual: view.getBounds(), expected: { x: 0, y: 0, width, height } };
    }, url).then(({ actual, expected }) => JSON.stringify(actual) === JSON.stringify(expected))).toBe(true);
  };
  await api('setFullscreen', 'content');
  await capture();
  execFileSync('xdotool', ['key', 'Escape']);
  await expect.poll(() => evaluate('keys.includes("Escape")')).toBe(true);
  assert.equal(await evaluate('!!document.pointerLockElement && !!document.fullscreenElement'), true);
  execFileSync('xdotool', ['key', 'ctrl+l']);
  await expect.poll(() => evaluate('keys.includes("l")')).toBe(true);
  assert.equal(await evaluate('!!document.pointerLockElement && !!document.fullscreenElement && document.hasFocus()'), true);
  execFileSync('xdotool', ['key', 'F11']);
  await expect.poll(() => evaluate('!!document.pointerLockElement || !!document.fullscreenElement')).toBe(false);
  await expect.poll(fullscreen).toBe(false);
  console.log('Fullscreen capture receives a short Escape and application shortcuts; F11 exits fullscreen and releases mouse and keyboard capture.');
  await api('setFullscreen', 'content');
  await capture();
  await evaluate('document.exitPointerLock(); navigator.keyboard.unlock();');
  await api('setFullscreen', 'window');
  await application.evaluate(({ Menu }) => { Menu.prototype.popup = globalThis.originalPopup; });
  await expect.poll(() => evaluate('!!document.fullscreenElement')).toBe(false);
  assert.equal(await fullscreen(), true);
  await expect(page.locator('.browser-toolbar')).toBeVisible();
  await page.getByRole('button', { name: 'Toggle Fullscreen' }).click();
  await expect.poll(fullscreen).toBe(false);

  await capture();
  await api('browser', workspace, 'new');
  await expect.poll(fullscreen).toBe(false);
  await expect.poll(() => evaluate('!!document.pointerLockElement || !!document.fullscreenElement')).toBe(false);
  assert.deepEqual(errors, []);
  console.log('Switching tabs restores the window and releases capture.');
  const original = (await app.state()).workspaces[0].tabs[0].id;
  await api('browser', workspace, 'select', original);
  await api('setFullscreen', 'window');
  await expect.poll(fullscreen).toBe(true);
  await capture();
  await evaluate('document.exitFullscreen()');
  await expect.poll(() => evaluate('!!document.pointerLockElement || !!document.fullscreenElement')).toBe(false);
  assert.equal(await fullscreen(), true);
  await capture();
  await api('browser', workspace, 'new');
  await expect.poll(() => evaluate('!!document.pointerLockElement || !!document.fullscreenElement')).toBe(false);
  assert.equal(await fullscreen(), true);
  await api('setFullscreen', false);
  await expect.poll(fullscreen).toBe(false);
  console.log('Leaving page fullscreen preserves a window that was already fullscreen.');
  await api('browser', workspace, 'select', original);
  await focusPage();
  // Chromium briefly blocks pointer reacquisition after Escape or a fullscreen exit.
  await page.waitForTimeout(2000);
  assert.equal(await evaluate('document.body.requestPointerLock().then(() => true, error => String(error))'), true);
  await expect.poll(() => evaluate('!!document.pointerLockElement')).toBe(true);
  execFileSync('xdotool', ['key', 'Escape']);
  await expect.poll(() => evaluate('!!document.pointerLockElement')).toBe(false);
  await evaluate('document.documentElement.requestFullscreen()');
  await expect.poll(fullscreen).toBe(true);
  execFileSync('xdotool', ['key', 'F11']);
  await expect.poll(fullscreen).toBe(false);
  await expect.poll(() => evaluate('!!document.fullscreenElement')).toBe(false);
  await evaluate('document.documentElement.requestFullscreen()');
  await expect.poll(fullscreen).toBe(true);
  await api('browser', workspace, 'close', original);
  await expect.poll(fullscreen).toBe(false);
  console.log('Windowed pointer capture releases with Escape, and closing a fullscreen page restores the window.');
});
