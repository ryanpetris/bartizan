import { expect } from '@playwright/test';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { withDirectory, startSshd, sshProfile, launch, waitFor } from './lib/harness.mjs';
import { openSettings, closeSettings } from './lib/settings.mjs';

const controls = ['New Connection', 'Errors', 'Settings', 'Connection Details'];

await withDirectory('themes', async (directory, cleanup) => {
  const manifestFile = join(directory, 'themes.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../../src/themes/index.ts', import.meta.url))], outfile: manifestFile, bundle: true, platform: 'node', format: 'esm', logLevel: 'error' });
  const { themes, themeIds } = await import(pathToFileURL(manifestFile).href);
  const http = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<title>Fixture</title><body style="background: #246">Fixture</body>'); });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  cleanup(() => { http.closeAllConnections(); http.close(); });
  const sshd = await startSshd(directory, { config: 'ForceCommand /bin/sh\n' });
  cleanup(sshd.stop);
  const config = join(directory, 'config.yaml');
  await writeFile(config, `version: 1\nprofiles:\n  rig:\n    label: Fixture\n${sshProfile(sshd)}`);
  // The native window controls take their strip only under a window manager.
  const wm = spawn('openbox', ['--sm-disable'], { stdio: 'ignore' });
  cleanup(() => wm.kill());
  await waitFor(() => execFileSync('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], { encoding: 'utf8' }).includes('window id #'), 'the window manager');
  const app = await launch(directory, config);
  cleanup(app.close);
  const { application, page, api, waitState, recordOutput, output, errors } = app;
  await expect(page.locator('.home-view')).toBeVisible();
  application.on('window', child => child.on('pageerror', error => errors.push(error.message)));
  await page.addInitScript(() => {
    window.rigPaintedThemes = [];
    const sample = () => {
      if (document.querySelector('#app')?.children.length) window.rigPaintedThemes.push(document.documentElement.dataset.theme);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await application.evaluate(({ Menu }) => { globalThis.rigMenus = []; Menu.prototype.popup = function () { globalThis.rigMenus.push(this); }; });
  await recordOutput();
  const connection = await api('connect', { profileId: 'rig' });
  const terminal = (await waitState(s => s.terminals[0]?.status === 'connected', 'terminal')).terminals[0].id;
  await waitFor(async () => (await output(terminal)).includes('$ '), 'shell prompt');
  const session = await api('newBrowser', connection);
  const tab = (await waitState(s => s.workspaces[0]?.tabs[0], 'tab')).workspaces[0].tabs[0].id;
  await api('browser', session, 'navigate', tab, `http://127.0.0.1:${http.address().port}/`);
  await waitState(s => s.workspaces[0].tabs[0].title === 'Fixture' && !s.workspaces[0].tabs[0].loading, 'page');
  const box = locator => locator.evaluate(node => { const r = node.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.floor(r.width), height: Math.floor(r.height), right: r.right, bottom: r.bottom }; });
  const pageViews = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter(view => view.getVisible()).map(view => ({ url: view.webContents.getURL(), ...view.getBounds() })));
  const overlayWith = selector => waitFor(async () => { for (const candidate of application.windows()) if (candidate !== page && await candidate.evaluate(selector => document.documentElement.classList.contains('overlay') && document.querySelector(selector) !== null, selector).catch(() => false)) return candidate; }, `overlay with ${selector}`);

  for (const [iteration, id] of [...themeIds, 'rail'].entries()) {
    const theme = themes[id];
    const chip = page.locator(`.connection-chip[data-id="${connection}"] .connection-titles`);
    await chip.click();
    await page.locator(`[data-kind="terminal"][data-id="${terminal}"]`).click();
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-screen')).toBeVisible();
    const keptSelectors = ['main.main', '.terminal-view', '.browser-view', '.terminal-surface:not([hidden]) .xterm-screen'];
    for (const selector of keptSelectors) await page.locator(selector).evaluate(node => { node.rigKept = true; });
    const dialog = await openSettings(page);
    if (id === 'tabs') {
      await dialog.getByRole('radio', { checked: true }).focus();
      await dialog.page().keyboard.press('ArrowRight');
      await expect(dialog.getByRole('radio', { name: theme.name, exact: true })).toBeFocused();
    } else await dialog.getByRole('radio', { name: theme.name, exact: true }).click();
    await expect(dialog.getByRole('radio', { name: theme.name, exact: true })).toHaveAttribute('aria-checked', 'true');
    await page.waitForFunction(id => document.documentElement.dataset.theme === id, id);
    await expect.poll(async () => parse(await readFile(config, 'utf8')).settings?.theme ?? 'rail').toBe(id);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => page.evaluate(() => navigator.windowControlsOverlay.getTitlebarAreaRect().height), `${id}: the window controls take the theme's height`).toBe(theme.controls.height);

    // Home shows the home page, keeping focus, with none of what belongs to a connection.
    const home = page.getByRole('button', { name: 'Home', exact: true });
    const furniture = page.locator('.rail-panel, .tabs-strip, .console-windows:not([hidden])');
    await home.click();
    await expect(page.locator('.home-view')).toBeVisible();
    await expect(home).toHaveAttribute('aria-current', 'page');
    await expect(home).toBeFocused();
    await expect(furniture).toHaveCount(0);
    await expect(page.locator('h1#home-title')).toBeVisible();
    // The brand centres on the page, and in Rail, whose bar reads as part of the page at home, on the bar and page together.
    const centres = await page.evaluate(() => {
      const brand = document.querySelector('.home-brand').getBoundingClientRect(), main = document.querySelector('.main').getBoundingClientRect();
      return { brand: (brand.top + brand.bottom) / 2, page: (main.top + main.bottom) / 2, window: main.bottom / 2 };
    });
    assert.ok(Math.abs(centres.brand - (id === 'rail' ? centres.window : centres.page)) <= 1, `${id}: the home page's brand is centred`);
    assert.equal(await page.evaluate(() => document.title), 'Bartizan', `${id}: the window is titled for the home page`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true, `${id}: the home page fits the window`);
    // The theme's New Connection shows Connect in place of the connection in view, keeping none of its items, and its
    // profile icon is the connection's badge.
    const add = page.getByRole('button', { name: 'New Connection', exact: true });
    await chip.click();
    await expect(furniture).toHaveCount(1);
    await add.click();
    const connect = page.locator('.connect');
    await expect(add).toHaveAttribute('aria-current', 'page');
    await expect(home).not.toHaveAttribute('aria-current');
    await expect(furniture).toHaveCount(0);
    // The bar over the view names the page, without a connection's status beside it.
    await expect(page.locator('h1#view-title')).toHaveText('Connect');
    await expect(page.locator('.titlebar-marker')).toBeHidden();
    assert.equal(await page.evaluate(() => document.title), 'Connect — Bartizan', `${id}: the window is titled for the page`);
    await expect(connect.locator('.profile-item .identicon')).toBeVisible();
    const profilePattern = await connect.locator('.profile-item .identicon').innerHTML();
    const badgeIcon = chip.locator('.identicon');
    assert.equal(await badgeIcon.innerHTML(), profilePattern, `${id}: the badge matches the profile icon`);
    if (id === 'rail') await expect(badgeIcon).toBeVisible();
    else await expect(badgeIcon).toBeHidden();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true, `${id}: Connect fits the window`);
    await chip.click();
    await expect(connect).toBeHidden();
    await expect(add).not.toHaveAttribute('aria-current');

    // The terminal keeps its screen, and the view is labelled by the theme's one heading.
    await page.locator(`[data-kind="terminal"][data-id="${terminal}"]`).click();
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-screen')).toBeVisible();
    for (const selector of keptSelectors) assert.equal(await page.locator(selector).evaluate(node => node.rigKept === true), true, `${id}: ${selector} stays mounted`);
    assert.equal(await page.locator('.terminal-surface:not([hidden]) .xterm-screen').evaluate(screen => screen.clientWidth > 300 && screen.clientHeight > 200), true, `${id}: the terminal fits`);
    if (iteration === themeIds.length) {
      for (const property of ['--console-font', '--console-bottom']) assert.equal(await page.evaluate(property => document.documentElement.style.getPropertyValue(property), property), '');
      for (const candidate of application.windows()) if (candidate !== page) await expect(candidate.locator('[data-sonner-toast]')).toHaveCount(0);
    }
    await expect(page.locator('h1#view-title')).toHaveCount(1);
    await expect(page.locator('h1#view-title')).toContainText('Fixture');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true, `${id} fits the window`);

    // Every command is on show inside the window and clear of the native window controls.
    const overlay = await page.evaluate(() => { const area = navigator.windowControlsOverlay.getTitlebarAreaRect(); return { left: area.x + area.width, height: area.height, visible: navigator.windowControlsOverlay.visible }; });
    // Tabs opens terminals and browser sessions from the connection's Add menu.
    const opening = await page.getByRole('button', { name: 'New Terminal', exact: true }).first().isVisible() ? ['New Terminal', 'New Browser Tab'] : ['Add Fixture'];
    for (const name of [...controls, ...opening]) {
      const control = page.getByRole('button', { name, exact: true }).first();
      await expect(control, `${id}: ${name}`).toBeVisible();
      const bounds = await box(control);
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.right <= 1250 && bounds.bottom <= 820, `${id}: ${name} is inside the window`);
      if (overlay.visible) assert.ok(bounds.right <= overlay.left || bounds.y >= overlay.height, `${id}: ${name} is clear of the window controls`);
    }

    // Lists run the way the manifest says, for the Move commands and the arrow keys.
    await page.locator(`[data-kind="terminal"][data-id="${terminal}"]`).click({ button: 'right' });
    const labels = await application.evaluate(() => globalThis.rigMenus.at(-1).items.map(item => item.label));
    assert.deepEqual(labels.slice(-2), theme.axis === 'horizontal' ? ['Move Left', 'Move Right'] : ['Move Up', 'Move Down'], id);
    await page.locator(`[data-kind="terminal"][data-id="${terminal}"]`).focus();
    await page.keyboard.press(theme.axis === 'horizontal' ? 'ArrowRight' : 'ArrowDown');
    await expect.poll(() => page.evaluate(id => { const focused = document.activeElement; return focused?.classList.contains('nav-item') && focused.dataset.id !== id; }, terminal), `${id}: arrow keys move along the list`).toBe(true);

    // The page view fills its slot, and an error notification shows where the page cannot cover it.
    await page.locator(`[data-kind="tab"][data-id="${tab}"]`).click();
    const slot = await box(page.locator('.browser-slot'));
    await expect.poll(async () => (await pageViews()).find(view => view.url.startsWith('http:'))).toMatchObject({ x: slot.x, y: slot.y, width: slot.width, height: slot.height });
    if (id === 'tabs') {
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 500));
      await page.waitForFunction(() => innerWidth === 800 && innerHeight === 500);
      await Promise.all([0, 1, 2].map(n => api('reportError', { source: 'rig', message: `failure in tabs ${n}: ${'A long failure message. '.repeat(30)}` })));
    } else await api('reportError', { source: 'rig', message: `failure in ${id}` });
    if (theme.toasts.overlay) {
      const toasts = await overlayWith('[data-sonner-toast]');
      await expect(toasts.locator('[data-sonner-toast]').first()).toContainText(`failure in ${id}`);
      const body = await box(page.locator('.browser-body'));
      await expect.poll(async () => (await pageViews()).some(view => view.url === 'about:blank' && view.y === body.y && view.x + view.width === body.x + body.width - 16), `${id}: notifications show over the page's corner, below the toolbar`).toBe(true);
    } else {
      const toast = page.locator('[data-sonner-toast]').filter({ hasText: `failure in ${id}` });
      await expect(toast).toBeVisible();
      const bounds = await box(toast);
      assert.ok(bounds.right <= slot.x || bounds.x >= slot.x + slot.width || bounds.bottom <= slot.y || bounds.y >= slot.y + slot.height, `${id}: the notification is clear of the page`);
    }
    if (id === 'rail' && !iteration) {
      // The button that makes the sidebar thin leads its title, and stays where it is as the sidebar narrows.
      const panel = page.locator('.rail-panel'), title = panel.locator('.rail-panel-title');
      const collapse = title.getByRole('button', { name: 'Collapse Sidebar', exact: true }), expand = title.getByRole('button', { name: 'Expand Sidebar', exact: true });
      const pageView = async () => (await pageViews()).find(view => view.url.startsWith('http:'));
      const place = await box(collapse);
      assert.ok(place.x < (await box(title.locator('.connection-name'))).x, 'The sidebar button leads the title');
      await api('reportError', { source: 'rig', message: 'failure beside the wide sidebar' });
      await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'failure beside the wide sidebar' })).toBeVisible();
      const wide = await box(panel);

      // A thin sidebar shows each item by its icon, named in its title, and the view takes the width it gives up.
      await collapse.click();
      await expect(expand).toBeFocused();
      await expect(panel).toHaveClass(/\bthin\b/);
      const thinPlace = await box(expand);
      assert.deepEqual([thinPlace.x, thinPlace.y], [place.x, place.y], 'The sidebar button stays where it was');
      const thin = await box(panel);
      assert.equal(thin.width, 56);
      const narrow = await box(page.locator('.browser-slot'));
      assert.ok(Math.abs(narrow.x - (slot.x - (wide.width - thin.width))) <= 1 && Math.abs(narrow.width - (slot.width + wide.width - thin.width)) <= 1, 'The view takes the width the sidebar gives up');
      await expect.poll(pageView).toMatchObject({ x: narrow.x, y: narrow.y, width: narrow.width, height: narrow.height });
      const terminalItem = panel.locator(`[data-kind="terminal"][data-id="${terminal}"]`), terminalLabel = await terminalItem.locator('.nav-label').textContent();
      await expect(terminalItem).toHaveAttribute('title', terminalLabel);
      await expect(panel.getByRole('button', { name: terminalLabel, exact: true })).toHaveCount(1);
      for (const item of await panel.locator('.nav-item').all()) assert.ok((await box(item)).right <= thin.x + thin.width, 'Every item fits the thin sidebar');
      assert.ok((await box(page.locator('#view-title .titlebar-group'))).width > 20, 'The heading names the connection');
      await expect(page.locator('#view-title')).toContainText('Fixture');

      // Beside a thin sidebar, notifications draw over the page's corner, and those on show move there with it.
      const toasts = await overlayWith('[data-sonner-toast]');
      const toast = message => toasts.locator('[data-sonner-toast][data-removed="false"]').filter({ hasText: message });
      await expect(toast('failure beside the wide sidebar')).toBeVisible();
      await api('reportError', { source: 'rig', message: 'failure beside the thin sidebar' });
      await expect(toast('failure beside the thin sidebar')).toBeVisible();
      assert.equal(await toasts.locator('.error-toaster').evaluate(node => getComputedStyle(node).clipPath), 'none');
      const body = await box(page.locator('.browser-body'));
      await expect.poll(async () => (await pageViews()).some(view => view.url === 'about:blank' && view.y === body.y && view.x + view.width === body.x + body.width - 16), 'Notifications show over the page\'s corner').toBe(true);
      const closeToast = toasts.locator('[data-sonner-toast][data-removed="false"] [data-close-button]');
      while (await closeToast.count()) await closeToast.first().click();

      // Renaming a browser session takes the sidebar's width until the name is done.
      await panel.locator('[data-kind="browser"]').first().click({ button: 'right' });
      await application.evaluate(() => globalThis.rigMenus.at(-1).items.find(item => item.label === 'Rename').click());
      const sessionName = panel.getByRole('textbox', { name: 'Session Name', exact: true });
      await expect(sessionName).toBeFocused();
      await expect(panel).not.toHaveClass(/\bthin\b/);
      await sessionName.press('Escape');
      await expect(panel).toHaveClass(/\bthin\b/);

      // Its icons choose items, and it stays thin through a reload until it is expanded again.
      await terminalItem.click();
      await expect(terminalItem).toHaveAttribute('aria-current', 'page');
      await page.reload();
      await expect(page.locator('.home-view')).toBeVisible();
      await chip.click();
      await expect(panel).toHaveClass(/\bthin\b/);
      await expand.click();
      await expect(collapse).toBeFocused();
      await expect(panel).not.toHaveClass(/\bthin\b/);
      await expect.poll(() => box(panel)).toEqual(wide);
      await page.locator(`[data-kind="tab"][data-id="${tab}"]`).click();
      await expect.poll(() => box(page.locator('.browser-slot'))).toEqual(slot);
      await expect.poll(pageView).toMatchObject({ x: slot.x, y: slot.y, width: slot.width, height: slot.height });
      console.log('Rail makes its sidebar thin and wide again from the sidebar itself, and keeps it thin through a reload.');
    }
    if (id === 'tabs') {
      const toasts = await overlayWith('[data-sonner-toast]');
      const dismiss = async () => {
        while (await toasts.locator('[data-sonner-toast]:not([data-removed="true"]) [data-close-button]').count()) {
          await toasts.locator('[data-sonner-toast]:not([data-removed="true"]) [data-close-button]').first().click();
        }
        await expect(toasts.locator('[data-sonner-toast]')).toHaveCount(0);
      };
      const fits = async () => {
        await expect(toasts.locator('[data-sonner-toast]')).toHaveCount(3);
        await expect.poll(() => toasts.evaluate(() => {
          const bounds = [...document.querySelectorAll('[data-sonner-toast]')].map(node => node.getBoundingClientRect()).sort((a, b) => a.top - b.top);
          return bounds.every((r, i) => r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && (!i || r.top >= bounds[i - 1].bottom));
        }), 'three notifications fit and do not overlap').toBe(true);
        await expect.poll(async () => (await pageViews()).filter(view => view.url === 'about:blank').every(view => view.x >= 0 && view.y >= 0 && view.x + view.width <= 800 && view.y + view.height <= 500)).toBe(true);
      };
      await fits();
      await dismiss();
      await openSettings(page);
      await api('reportError', { source: 'rig', message: 'failure during Settings' });
      await api('reportError', { source: 'rig', message: 'failure during Settings' });
      await page.waitForTimeout(6500);
      await closeSettings(page);
      await expect(toasts.locator('[data-sonner-toast]')).toContainText('failure during Settings');
      await expect(toasts.locator('[data-sonner-toast]')).toContainText('×2');
      await dismiss();
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1250, 820));
      await page.waitForFunction(() => innerWidth === 1250 && innerHeight === 820);
      console.log('Notifications fit at 800×500 and survive Settings for longer than their timeout.');
    }
    if (id === 'console') {
      // A dialog keeps clear of the lines below the view: the windows line and the status line, or at home the status line.
      for (const place of ['connection', 'home']) {
        if (place === 'home') await home.click();
        const dialog = await openSettings(page);
        const below = await page.evaluate(() => innerHeight - document.querySelector('.main').getBoundingClientRect().bottom);
        assert.equal(await dialog.evaluate(node => parseFloat(getComputedStyle(node).bottom)), below, `Console dialogs clear the lines below the view from ${place}`);
        await closeSettings(page);
      }
      await chip.click();
      await page.locator(`[data-kind="terminal"][data-id="${terminal}"]`).click();
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 500));
      await page.waitForFunction(() => innerWidth === 800 && innerHeight === 500);
      const close = (await openSettings(page)).getByRole('button', { name: 'Close', exact: true });
      await expect(close).toBeVisible();
      const bounds = await box(close);
      assert.ok(bounds.y >= 0 && bounds.bottom <= await close.page().evaluate(() => innerHeight), 'Console Settings Close fits a 500px window');
      await close.click();
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1250, 820));
      await page.waitForFunction(() => innerWidth === 1250 && innerHeight === 820);
    }
    if (id !== 'console') {
      await page.reload();
      await page.waitForFunction(id => document.documentElement.dataset.theme === id, id);
      await page.waitForFunction(() => window.rigPaintedThemes.length > 2);
      assert.deepEqual(await page.evaluate(() => [...new Set(window.rigPaintedThemes)]), [id], `${id}: reload paints only the configured theme`);
    }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    for (const owner of application.windows()) {
      const oldDismiss = owner.locator('[data-sonner-toast][data-removed="false"] [data-close-button]');
      while (await oldDismiss.count()) await oldDismiss.first().click();
      await expect(owner.locator('[data-sonner-toast]')).toHaveCount(0);
    }
    for (const action of ['click', 'Enter', 'Space', 'dismiss', 'swipe']) {
      const message = `Open error history: ${id} ${iteration} ${action}`;
      await api('reportError', { source: 'rig', message });
      const owner = theme.toasts.overlay ? await overlayWith('[data-sonner-toast]') : page;
      const notification = owner.locator('[data-sonner-toast][data-removed="false"]').filter({ hasText: message });
      await expect(notification).toBeVisible();
      if (action === 'dismiss' || action === 'swipe') {
        if (action === 'dismiss') await notification.getByRole('button', { name: 'Dismiss', exact: true }).click();
        else {
          await notification.hover();
          const bounds = await notification.boundingBox();
          const x = bounds.x + bounds.width - 5, y = bounds.y + bounds.height / 2;
          await owner.mouse.move(x, y);
          await owner.mouse.down();
          await owner.mouse.move(x + (theme.toasts.overlay ? 100 : -100), y, { steps: 8 });
          await owner.mouse.up();
        }
        await expect(notification).toHaveCount(0);
        await expect((await app.modal()).locator('#errors-dialog')).toBeHidden();
      } else {
        if (action === 'click') await notification.locator('[data-description]').click();
        else await notification.locator('.error-toast-title').press(action);
        const panel = (await app.modal()).locator('#errors-dialog');
        await expect(panel).toBeVisible();
        await expect(panel.locator('.error-history')).toContainText(message);
        await panel.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(panel).toBeHidden();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
    }
    console.log(`${theme.name} lays the window out with every command on show, runs its lists ${theme.axis === 'horizontal' ? 'across' : 'down'}, fits the page view and places notifications clear of it.`);
  }
  assert.deepEqual(errors, []);
});
