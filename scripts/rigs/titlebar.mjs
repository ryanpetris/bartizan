// Uses the native window controls under Openbox, which draws them on the right.
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { launch, waitFor, withDirectory } from './lib/harness.mjs';

await withDirectory('titlebar', async (directory, cleanup) => {
  const wm = spawn('openbox', ['--sm-disable'], { stdio: 'ignore' });
  cleanup(() => wm.kill());
  await waitFor(() => execFileSync('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], { encoding: 'utf8' }).includes('window id #'), 'the window manager');
  const app = await launch(directory);
  let closed = false;
  cleanup(() => closed || app.close());
  const { application, page, api, errors } = app;
  const pointer = (...args) => execFileSync('xdotool', args.map(String), { stdio: 'pipe' });
  const bounds = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  const windowState = () => application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; return { maximized: window.isMaximized(), minimized: window.isMinimized() }; });
  const windowId = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readUInt32LE(0));
  pointer('windowactivate', '--sync', windowId);
  const overlay = () => page.evaluate(() => {
    const { x, width, height } = navigator.windowControlsOverlay.getTitlebarAreaRect();
    return { x, width, height, innerWidth, visible: navigator.windowControlsOverlay.visible };
  });
  await expect.poll(async () => (await overlay()).visible).toBe(true);
  /** Clicks a native control: 0 minimizes, 1 maximizes or restores, 2 closes. */
  const nativeButton = async index => {
    const area = await overlay();
    assert.equal(area.x, 0);
    const controls = area.innerWidth - area.width;
    assert.ok(controls > 60);
    pointer('mousemove', '--window', windowId, Math.round(area.width + controls * (index + 0.5) / 3), Math.round(area.height / 2), 'click', 1);
  };
  /** Presses at a window position and moves the pointer in steps. */
  const drag = async (x, y, dx, dy) => {
    pointer('mousemove', '--window', windowId, x, y, 'mousedown', 1);
    for (let step = 0; step < 10; step++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      pointer('mousemove_relative', '--sync', dx, dy);
    }
    pointer('mouseup', 1);
  };

  for (const appearance of ['light', 'dark', 'system']) {
    await api('settings', { appearance });
    const dark = await application.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
    await expect.poll(() => page.locator('.rail-topbar').evaluate(node => getComputedStyle(node).backgroundColor)).toBe(dark ? 'rgb(26, 28, 35)' : 'rgb(252, 252, 253)');
    assert.equal(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), dark);
    assert.equal((await overlay()).height, 44);
  }
  console.log('The title bar follows the light, dark and system appearance.');

  // The page resizes after the window state changes, so each click waits until the page has its new width.
  const normal = (await overlay()).innerWidth;
  await nativeButton(1);
  await expect.poll(windowState).toEqual({ maximized: true, minimized: false });
  await expect.poll(async () => (await overlay()).innerWidth).toBeGreaterThan(normal);
  await nativeButton(1);
  await expect.poll(windowState).toEqual({ maximized: false, minimized: false });
  await expect.poll(async () => (await overlay()).innerWidth).toBe(normal);
  await nativeButton(0);
  await expect.poll(windowState).toEqual({ maximized: false, minimized: true });
  pointer('windowmap', windowId, 'windowactivate', '--sync', windowId);
  await expect.poll(windowState).toEqual({ maximized: false, minimized: false });
  const before = await bounds();
  await drag(Math.round((await overlay()).width / 2), 20, 8, 5);
  await expect.poll(async () => { const after = await bounds(); return after.x !== before.x || after.y !== before.y; }).toBe(true);
  const moved = await bounds();
  await drag(Math.round(moved.width / 2), moved.height + 2, 0, 4);
  await expect.poll(async () => (await bounds()).height).toBeGreaterThan(moved.height);
  console.log('Native minimize, maximize and restore work, and the title bar drags the window and its edge resizes it.');

  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  for (const zoom of [1, 1.25, 0.8]) {
    await application.evaluate(({ BrowserWindow }, zoom) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(800, 600); window.webContents.setZoomFactor(zoom); }, zoom);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('.rail').getByRole('button', { name: 'New Connection', exact: true }).click();
    await expect(page.locator('#connection-dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    for (const control of [page.getByRole('button', { name: 'Profiles', exact: true }), settings]) {
      assert.equal(await control.evaluate(node => {
        const bounds = node.getBoundingClientRect(), area = navigator.windowControlsOverlay.getTitlebarAreaRect();
        return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight && (bounds.top >= area.bottom || bounds.right <= area.right);
      }), true, `Application controls stay clear of the native controls at ${zoom}x`);
    }
    await page.getByRole('button', { name: 'Profiles', exact: true }).click();
    await expect(page.locator('#profiles-dialog')).toBeVisible();
    await page.locator('#profiles-dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await settings.click();
    await expect(page.locator('#settings-dialog')).toBeVisible();
    await page.locator('#settings-dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await expect(settings).toBeFocused();
  }
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  await page.reload();
  await expect(page.locator('.rail-topbar')).toBeVisible();
  assert.deepEqual(errors, []);
  console.log('Application controls stay usable beside the native controls at every zoom level and after a reload.');

  const exited = application.waitForEvent('close');
  await nativeButton(2);
  await exited;
  closed = true;
  console.log('The native close button quits the application.');
});
