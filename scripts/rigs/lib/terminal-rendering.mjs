import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { chooseAppearance, openSettings, closeSettings, showSection } from './settings.mjs';

export async function testTerminalRendering(app, first, second) {
  const { application, page, api, state } = app;
  const settings = async () => (await state()).settings;
  await page.emulateMedia({ colorScheme: null });
  // The renderers this exercises draw with WebGL, which is off by default.
  await api('settings', { terminalWebgl: true });
  const renderer = '.terminal-surface .xterm-screen > canvas:not(.xterm-link-layer)';
  const select = id => page.locator(`[data-kind="terminal"][data-id="${id}"]`).click();
  const background = () => page.locator('.terminal-host').evaluate(e => getComputedStyle(e).backgroundColor);
  const waitBackground = value => page.waitForFunction(value => getComputedStyle(document.querySelector('.terminal-host')).backgroundColor === value, value);
  await select(first);
  assert.equal((await settings()).appearance, 'dark');
  assert.equal(await background(), 'rgb(26, 28, 35)');
  await page.waitForFunction(selector => document.querySelectorAll(selector).length === 1, renderer);
  await chooseAppearance(app, 'light'); await waitBackground('rgb(252, 252, 253)');
  await select(second); assert.equal(await background(), 'rgb(252, 252, 253)');
  await page.waitForFunction(selector => document.querySelectorAll(selector).length === 1, renderer);
  assert.equal(await page.locator(renderer).count(), 1);
  await chooseAppearance(app, 'system');
  await expect.poll(() => application.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('system');
  const systemDark = await application.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
  await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(systemDark);
  await page.emulateMedia({ colorScheme: 'dark' });
  await waitBackground('rgb(26, 28, 35)');
  assert.equal(await page.locator('.rail-panel').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(21, 23, 29)');
  await page.emulateMedia({ colorScheme: 'light' });
  await waitBackground('rgb(252, 252, 253)');
  assert.equal(await page.locator('.rail-panel').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(241, 242, 247)');
  await page.emulateMedia({ colorScheme: null });
  await chooseAppearance(app, 'dark'); await waitBackground('rgb(26, 28, 35)');
  assert.equal(await page.locator('.rail-panel').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(21, 23, 29)');
  await select(first);

  const draw = async () => {
    await page.evaluate(id => window.bartizan.input(id, "printf '\\033[2J\\033[H\\033[?25l\\033[38;2;231;37;53m┌────────┐\\n│        │\\n│        │\\n└────────┘\\033[0m\\n\\033[41m          \\033[0m\\n\\033[48;5;196m          \\033[0m\\n\\033[48;2;12;200;34m          \\033[0m\\n'\n"), first);
    await page.waitForTimeout(350);
    const pixels = await application.evaluate(async ({ BrowserWindow }) => {
      const image = await BrowserWindow.getAllWindows()[0].capturePage();
      const { width, height } = image.getSize(); const data = image.toBitmap();
      const rows = new Set(); let minX = width, maxX = 0, minY = height, maxY = 0, horizontal = 0, horizontalSpan = 0;
      let ansi = 0, indexed = 0, rgb = 0;
      for (let y = 0; y < height; y++) {
        let count = 0, firstX = width, lastX = 0;
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4, b = data[i], g = data[i + 1], r = data[i + 2];
          if (r === 231 && g === 37 && b === 53) { count++; firstX = Math.min(firstX, x); lastX = x; rows.add(y); minX = Math.min(x, minX); maxX = Math.max(x, maxX); minY = Math.min(y, minY); maxY = Math.max(y, maxY); }
          if (r === 240 && g === 113 && b === 122) ansi++;
          if (r === 255 && g === 0 && b === 0) indexed++;
          if (r === 12 && g === 200 && b === 34) rgb++;
        }
        if (count > horizontal) { horizontal = count; horizontalSpan = lastX - firstX + 1; }
      }
      return { width: maxX - minX + 1, height: maxY - minY + 1, rows: rows.size, horizontal, horizontalSpan, ansi, indexed, rgb };
    });
    assert.ok(pixels.width > 50 && pixels.height > 30, JSON.stringify(pixels));
    assert.equal(pixels.rows, pixels.height, 'Vertical box borders have no empty pixel rows');
    assert.ok(pixels.horizontal > pixels.width * 0.8);
    assert.equal(pixels.horizontal, pixels.horizontalSpan, 'Horizontal box borders have no empty pixel columns');
    assert.ok(pixels.ansi > 100 && pixels.indexed > 100 && pixels.rgb > 100, JSON.stringify(pixels));
  };
  await draw();
  const terminalSize = async () => {
    await page.evaluate(id => { window.rigOutput = ''; window.bartizan.input(id, "printf 'TERMINAL_SIZE_%s_END\\n' \"$(stty size | tr ' ' x)\"\n"); }, first);
    await page.waitForFunction(() => /TERMINAL_SIZE_\d+x\d+_END/.test(window.rigOutput));
    return page.evaluate(() => window.rigOutput.match(/TERMINAL_SIZE_(\d+)x(\d+)_END/).slice(1).map(Number));
  };
  const initialSize = await terminalSize();
  let dialog = await showSection(await openSettings(page), 'Terminal');
  await dialog.getByRole('spinbutton', { name: 'Terminal Font Size', exact: true }).fill('18');
  await dialog.getByRole('spinbutton', { name: 'Terminal Font Size', exact: true }).press('Enter');
  await expect.poll(async () => (await settings()).terminalFontSize).toBe(18);
  await dialog.getByRole('combobox', { name: 'Terminal Font', exact: true }).selectOption({ label: 'Custom' });
  await dialog.getByRole('textbox', { name: 'Terminal Font Family', exact: true }).fill('Bartizan Missing Font');
  await dialog.getByRole('textbox', { name: 'Terminal Font Family', exact: true }).press('Enter');
  await expect.poll(async () => (await settings()).terminalFont).toBe('Bartizan Missing Font');
  await closeSettings(page);
  await expect.poll(async () => { const [rows, columns] = await terminalSize(); return rows < initialSize[0] && columns < initialSize[1]; }).toBe(true);
  await page.waitForFunction(selector => document.querySelectorAll(selector).length === 1, renderer);
  await draw();
  await page.evaluate(id => window.bartizan.input(id, "printf 'FONT_%s\\n' KEPT\n"), first);
  await page.waitForFunction(() => window.rigOutput.includes('FONT_KEPT'));
  dialog = await showSection(await openSettings(page), 'Terminal');
  await dialog.getByRole('combobox', { name: 'Terminal Font', exact: true }).selectOption('JetBrains Mono');
  await dialog.getByRole('spinbutton', { name: 'Terminal Font Size', exact: true }).fill('13');
  await closeSettings(page);
  await expect.poll(settings).toEqual({ appearance: 'dark', theme: 'rail', interfaceFont: 'Inter', terminalLigatures: true, terminalWebgl: true, terminalFont: 'JetBrains Mono', terminalFontSize: 13, remoteSessionIntegration: true });
  await expect.poll(async () => (await terminalSize()).join('x')).toBe(initialSize.join('x'));
  await draw();
  console.log('Terminal font family and size apply live, keep the session, fall back for a missing family and restore the terminal size.');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25));
  await page.waitForTimeout(200); await draw();
  await application.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setZoomFactor(1); win.setSize(800, 600); });
  await page.waitForTimeout(200);
  const chromeFits = () => page.evaluate(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect();
    const overlay = navigator.windowControlsOverlay, area = overlay.visible ? overlay.getTitlebarAreaRect() : { left: 0, right: innerWidth };
    const heading = document.querySelector('.titlebar-heading'), item = box('.titlebar-item'), actions = box('.titlebar-actions'), settings = box('.rail-actions .icon-button:last-child');
    return document.documentElement.scrollWidth <= innerWidth && heading.scrollWidth <= heading.clientWidth && box('.titlebar-titles').right <= actions.left && item.right <= actions.left && actions.right <= area.right && settings.left >= 0 && settings.right <= innerWidth;
  });
  const titlebar = page.locator('.rail-topbar');
  // The selected terminal's name, which a shell may set, matches in the panel, title bar heading and window title.
  await expect.poll(() => page.evaluate(() => {
    const row = document.querySelector('.nav-item[data-kind="terminal"][aria-current="page"] .nav-label')?.textContent ?? '';
    return Boolean(row) && document.querySelector('.titlebar-heading .titlebar-item')?.textContent === row && document.title.includes(` · ${row} — `);
  })).toBe(true);
  const topButtons = await titlebar.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
  for (const name of ['New Terminal', 'New Browser Tab', 'Visual Studio Code', 'Connection Details']) assert.ok(topButtons.includes(name), name);
  await expect(page.locator('.rail-panel .connection-disconnect')).toBeVisible();
  const detailsButton = titlebar.getByRole('button', { name: 'Connection Details', exact: true });
  await detailsButton.click();
  const details = (await app.modal()).locator('#details-dialog');
  await expect(details).toBeVisible();
  await expect(details.locator('.details-row', { hasText: 'Status' }).locator('dd')).toHaveText('Connected');
  await details.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(detailsButton).toBeFocused();
  assert.equal(await chromeFits(), true);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25));
  await page.waitForTimeout(200);
  assert.equal(await chromeFits(), true);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  await page.waitForTimeout(200);
  console.log('The title bar shows terminal context and connection actions without overlap at minimum width and zoom.');
  await draw();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 820));

  await page.evaluate(selector => document.querySelector(selector).getContext('webgl2').getExtension('WEBGL_lose_context').loseContext(), renderer);
  await page.waitForFunction(selector => !document.querySelector(selector), renderer);
  assert.equal(await page.locator('.terminal-surface:not([hidden])').evaluate(e => e.querySelector('.xterm-screen').getBoundingClientRect().width <= e.getBoundingClientRect().width), true);
  await page.evaluate(id => window.bartizan.input(id, "printf 'CONTEXT_%s\\n' ALIVE\n"), first);
  await page.waitForFunction(() => document.querySelector('.terminal-surface:not([hidden]) .xterm-rows')?.textContent.includes('CONTEXT_ALIVE'));
  await select(second); await select(first);
  await page.waitForFunction(selector => document.querySelectorAll(selector).length === 1, renderer);
  await draw();
  await page.evaluate(id => window.bartizan.input(id, "printf '\\033[?25h'\n"), first);
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args) {
      const context = original.apply(this, args);
      if (args[0] === 'webgl2' && context) {
        HTMLCanvasElement.prototype.getContext = original;
        context.getExtension('WEBGL_lose_context').loseContext();
        window.rigRendererFailed = true;
      }
      return context;
    };
  });
  await select(second);
  await page.waitForFunction(() => window.rigRendererFailed);
  await page.waitForFunction(() => document.querySelector('.terminal-surface:not([hidden]) .xterm-rows'));
  assert.equal(await page.locator(renderer).count(), 0);
  await select(first); await select(second); await select(first);
  assert.equal(await page.locator(renderer).count(), 0);
  await page.evaluate(id => window.bartizan.input(id, "printf 'FALLBACK_%s\\n' ALIVE\n"), first);
  await page.waitForFunction(() => document.querySelector('.terminal-surface:not([hidden]) .xterm-rows')?.textContent.includes('FALLBACK_ALIVE'));
  await chooseAppearance(app, 'light');
  await page.reload();
  await app.chooseConnection((await state()).terminals.find(t => t.id === first).connectionId);
  await select(first);
  await expect((await openSettings(page)).getByRole('combobox', { name: 'Appearance', exact: true })).toHaveValue('light');
  await closeSettings(page);
  await select(first);
  await waitBackground('rgb(252, 252, 253)');
  await page.waitForFunction(selector => document.querySelectorAll(selector).length === 1, renderer);
  await chooseAppearance(app, 'system');
  console.log('Application and terminal appearance, continuous borders, ANSI/256/RGB backgrounds, zoom, resize and context-loss recovery passed.');
}
