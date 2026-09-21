import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { withDirectory, startSshd, sshProfile, launch, waitFor } from './lib/harness.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8Dwn4EIAAD//wMAKQYC/rUbUjwAAAAASUVORK5CYII=', 'base64');

await withDirectory('browsing', async (directory, cleanup) => {
  const requests = [];
  let release;
  const http = createServer((request, response) => {
    requests.push({ url: request.url, cookie: request.headers.cookie ?? '' });
    if (request.url === '/icon.png') { response.setHeader('Content-Type', 'image/png'); response.end(png); return; }
    if (request.url === '/large.png') { response.setHeader('Content-Type', 'image/png'); response.end(Buffer.concat([png, Buffer.alloc(70 * 1024)])); return; }
    if (request.url === '/file') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="fixture.bin"', 'Content-Length': 2048 });
      response.write(Buffer.alloc(1024));
      release = () => response.end(Buffer.alloc(1024));
      return;
    }
    if (request.url === '/handles') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<title>Fixture /handles</title><body style="font: 20px sans-serif"><p>needle</p><script>window.handled = []; addEventListener("keydown", event => { if (event.ctrlKey && event.key === "f") { event.preventDefault(); handled.push(event.key); } });</script>');
      return;
    }
    const icon = request.url === '/large' ? '/large.png' : request.url === '/plain' ? '' : '/icon.png';
    response.setHeader('Content-Type', 'text/html');
    response.setHeader('Set-Cookie', 'fixture=1; Path=/');
    response.end(`<title>Fixture ${request.url}</title>${icon ? `<link rel="icon" href="${icon}">` : ''}
      <body style="margin: 0; font: 20px sans-serif">
      <a id="link" href="/next" style="display: block; font-size: 40px">Page link</a>
      <img id="image" src="/icon.png" width="80" height="80" style="display: block">
      <input id="field" value="editable" style="display: block; font-size: 30px">
      <a id="file" href="/file" style="display: block; font-size: 40px">Download</a>
      <p>needle one</p><p>needle two</p><p>needle three</p>
      <script>window.play = () => { const audio = new AudioContext(), tone = audio.createOscillator(); tone.connect(audio.destination); tone.start(); };</script>`);
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  cleanup(() => { http.closeAllConnections(); http.close(); });
  const origin = `http://127.0.0.1:${http.address().port}`;
  const sshd = await startSshd(directory, { config: 'ForceCommand /bin/sh\n' });
  cleanup(sshd.stop);
  const config = join(directory, 'config.yaml');
  await writeFile(config, `version: 1\nprofiles:\n  rig:\n    label: Fixture\n${sshProfile(sshd)}`);
  // Real keys reach the window through a window manager, as they do on a desktop.
  const wm = spawn('openbox', ['--sm-disable'], { stdio: 'ignore' });
  cleanup(() => wm.kill());
  await waitFor(() => execFileSync('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], { encoding: 'utf8' }).includes('window id #'), 'the window manager');
  const app = await launch(directory, config);
  cleanup(app.close);
  const { application, page, api, waitState, errors } = app;
  const saved = join(directory, 'fixture.bin'), pdf = join(directory, 'page.pdf');
  await application.evaluate(({ Menu, dialog, shell, app }, { saved, pdf }) => {
    globalThis.rigMenus = [];
    Menu.prototype.popup = function () { globalThis.rigMenus.push(this); };
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: pdf });
    globalThis.rigShown = [];
    shell.showItemInFolder = path => { globalThis.rigShown.push(path); };
    // Downloads save without a dialog.
    app.on('session-created', session => session.on('will-download', (_event, item) => item.setSavePath(saved)));
  }, { saved, pdf });
  const menuLabels = () => application.evaluate(() => globalThis.rigMenus.at(-1)?.items.map(item => item.type === 'separator' ? '-' : item.enabled ? item.label : `${item.label} (disabled)`));
  const choose = label => application.evaluate((_, label) => globalThis.rigMenus.at(-1).items.find(item => item.label === label).click(), label);
  /** Runs a function in the main process with the visible page's web contents. */
  const inPage = (action, argument) => application.evaluate(async ({ BrowserWindow }, { action, argument }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const contents = window.contentView.children.find(view => view.getVisible() && view.webContents !== window.webContents && /^https?:/.test(view.webContents.getURL())).webContents;
    return new Function('contents', 'argument', `return (${action})(contents, argument)`)(contents, argument);
  }, { action: action.toString(), argument });
  const center = selector => inPage((contents, selector) => contents.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`), selector);
  const mouse = async (selector, button) => {
    const point = await center(selector);
    await inPage((contents, { point, button }) => {
      contents.sendInputEvent({ type: 'mouseMove', ...point });
      if (!button) return;
      contents.sendInputEvent({ type: 'mouseDown', ...point, button, clickCount: 1 });
      contents.sendInputEvent({ type: 'mouseUp', ...point, button, clickCount: 1 });
    }, { point, button });
  };
  const key = (keyCode, modifiers = []) => inPage((contents, { keyCode, modifiers }) => contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }), { keyCode, modifiers });
  const slotBounds = selector => page.locator(selector).evaluate(node => { const r = node.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.floor(r.width), height: Math.floor(r.height) }; });
  const views = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter(view => view.getVisible()).map(view => ({ url: view.webContents.getURL().split('?')[0], ...view.getBounds() })));
  /** The overlay document that holds an element. */
  const overlay = selector => waitFor(async () => { for (const candidate of application.windows()) if (candidate !== page && await candidate.evaluate(selector => document.documentElement.classList.contains('overlay') && document.querySelector(selector) !== null, selector).catch(() => false)) return candidate; }, `overlay with ${selector}`);

  const windowId = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readUInt32LE(0));
  execFileSync('xdotool', ['windowactivate', '--sync', String(windowId)]);
  /** Clicks a point of the window and presses keys, as the user would. */
  const click = (x, y) => execFileSync('xdotool', ['mousemove', '--window', String(windowId), String(Math.round(x)), String(Math.round(y)), 'click', '1']);
  const press = keys => execFileSync('xdotool', ['key', keys]);
  const clickPage = async selector => { const slot = await slotBounds('.browser-slot'), point = await center(selector); click(slot.x + point.x, slot.y + point.y); await expect.poll(() => inPage(contents => contents.isFocused())).toBe(true); };
  const clickAddress = async () => { const box = await page.getByRole('textbox', { name: 'Address', exact: true }).boundingBox(); click(box.x + box.width / 2, box.y + box.height / 2); await expect(page.getByRole('textbox', { name: 'Address', exact: true })).toBeFocused(); };
  const connection = await api('connect', { profileId: 'rig' });
  await waitState(s => s.terminals[0]?.status === 'connected', 'terminal');
  const session = await api('newBrowser', connection);
  const tabOf = s => s.workspaces.find(w => w.id === session)?.tabs[0];
  const tab = tabOf(await waitState(s => tabOf(s), 'tab')).id;
  await api('browser', session, 'navigate', tab, `${origin}/`);
  await waitState(s => tabOf(s).title === 'Fixture /' && !tabOf(s).loading, 'page');
  await app.chooseConnection(connection);
  const row = page.locator(`.nav-item[data-kind="tab"][data-id="${tab}"]`);
  await row.click();
  await expect.poll(async () => (await views()).length).toBe(1);

  // Page titles and icons
  await expect(page.locator('#view-title .titlebar-item')).toHaveText('Fixture /');
  await expect(page).toHaveTitle('Fixture · Fixture / — Bartizan');
  await expect(row.locator('img.favicon')).toHaveAttribute('src', `data:image/png;base64,${png.toString('base64')}`);
  await expect(page.locator('.titlebar-marker img.favicon')).toHaveAttribute('src', `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(requests.find(request => request.url === '/icon.png' && request.cookie.includes('fixture=1')) !== undefined, true, 'the icon request carries the session cookie');
  await api('browser', session, 'navigate', tab, `${origin}/large`);
  await waitState(s => tabOf(s).title === 'Fixture /large' && !tabOf(s).loading, 'large icon page');
  await waitFor(() => requests.some(request => request.url === '/large.png'), 'large icon request');
  await expect(row.locator('img.favicon')).toHaveCount(0);
  await expect(page.locator('#view-title .titlebar-item')).toHaveText('Fixture /large');
  await expect(page.locator('.titlebar-marker img.favicon')).toHaveCount(0);
  await api('browser', session, 'navigate', tab, `${origin}/`);
  await waitState(s => tabOf(s).title === 'Fixture /' && !tabOf(s).loading, 'page again');
  await expect(row.locator('img.favicon')).toHaveCount(1);
  await expect(page.locator('.titlebar-marker img.favicon')).toHaveCount(1);
  console.log('A tab shows its page icon, fetched through its session, and ignores an icon over the size limit.');

  // Sound
  await expect(row.locator('..').locator('.row-mute')).toHaveCount(0);
  await inPage(contents => contents.executeJavaScript('play()', true));
  const audible = await waitState(s => tabOf(s).audible, 'audible tab').then(() => true, () => false);
  if (!audible) await inPage(contents => { contents.emit('audio-state-changed', { audible: true }); });
  const mute = row.locator('..').getByRole('button', { name: 'Mute Fixture /', exact: true });
  await expect(mute).toBeVisible();
  await mute.click();
  await waitState(s => tabOf(s).muted, 'muted tab');
  assert.equal(await inPage(contents => contents.isAudioMuted()), true);
  await row.click({ button: 'right' });
  assert.deepEqual(await menuLabels(), ['Unmute Tab', 'Move Up (disabled)', 'Move Down (disabled)']);
  await choose('Unmute Tab');
  await waitState(s => !tabOf(s).muted, 'unmuted tab');
  console.log(`A tab playing sound${audible ? '' : ' (reported by the rig)'} shows a control that mutes it.`);

  // Zoom
  // Clicking the image focuses the page without placing a caret in its text, where a search would start.
  await clickPage('#image');
  press('ctrl+equal');
  await waitState(s => tabOf(s).zoom === 110, 'zoom in from the page');
  await clickAddress();
  press('ctrl+equal');
  await waitState(s => tabOf(s).zoom === 125, 'zoom in from the application');
  assert.equal(Math.round(await inPage(contents => contents.getZoomFactor()) * 100), 125);
  const level = page.getByRole('button', { name: 'Reset Zoom', exact: true });
  await expect(level).toHaveText('125%');
  await level.click();
  await waitState(s => tabOf(s).zoom === 100, 'zoom reset');
  await expect(level).toBeHidden();
  console.log('Zoom steps from a page and from the application, and the address field shows a level that resets it.');

  // Find
  const find = page.getByRole('textbox', { name: 'Find in Page', exact: true });
  await expect(find).toBeHidden();
  await clickPage('#image');
  press('ctrl+f');
  await expect(find).toBeFocused();
  await find.fill('needle');
  await expect(page.locator('.find-count')).toHaveText('1/3');
  await expect(find).toBeFocused();
  await find.press('Enter');
  await expect(page.locator('.find-count')).toHaveText('2/3');
  await find.press('Shift+Enter');
  await expect(page.locator('.find-count')).toHaveText('1/3');
  await find.press('Escape');
  await expect(find).toBeHidden();
  await expect.poll(() => inPage(contents => contents.isFocused())).toBe(true);
  await clickAddress();
  press('ctrl+f');
  await expect(find).toBeFocused();
  await page.getByRole('button', { name: 'Close Find', exact: true }).click();
  console.log('Find in Page opens from a page and from the application, counts matches, steps both ways and returns focus to the page.');

  // A page sees these keys first
  await api('browser', session, 'navigate', tab, `${origin}/handles`);
  await waitState(s => tabOf(s).title === 'Fixture /handles' && !tabOf(s).loading, 'page that handles Ctrl+F');
  await clickPage('p');
  press('ctrl+f');
  await expect.poll(() => inPage(contents => contents.executeJavaScript('handled.length'))).toBe(1);
  await page.waitForTimeout(300);
  await expect(find).toBeHidden();
  press('ctrl+l');
  await expect(page.getByRole('textbox', { name: 'Address', exact: true })).toBeFocused();
  await api('browser', session, 'navigate', tab, `${origin}/`);
  await waitState(s => tabOf(s).title === 'Fixture /' && !tabOf(s).loading, 'first page again');
  console.log('A page that handles Ctrl+F keeps it, while Ctrl+L still reaches the application.');

  // Context menus
  await mouse('#image', 'right');
  await expect.poll(menuLabels).toEqual(['Open Image in New Tab', 'Save Image As…', 'Copy Image', 'Copy Image Address', '-', 'Inspect Element']);
  await application.evaluate(({ clipboard }) => clipboard.writeText(''));
  await choose('Copy Image Address');
  await expect.poll(() => application.evaluate(({ clipboard }) => clipboard.readText())).toBe(`${origin}/icon.png`);
  await mouse('#field', 'right');
  await expect.poll(async () => (await menuLabels()).filter(label => !label.startsWith('Undo') && !label.startsWith('Redo'))).toEqual(['-', 'Cut (disabled)', 'Copy (disabled)', 'Paste', 'Select All', '-', 'Inspect Element']);
  await mouse('p', 'right');
  await expect.poll(menuLabels).toEqual(['Back', 'Forward (disabled)', 'Reload', '-', 'Save as PDF…', 'Print…', '-', 'Inspect Element']);
  await choose('Save as PDF…');
  await waitFor(async () => (await readFile(pdf).catch(() => Buffer.alloc(0))).subarray(0, 5).toString() === '%PDF-', 'saved PDF');
  console.log('A page menu offers what applies to the image, field or page under the pointer, and saves the page as a PDF.');

  // Developer tools
  await choose('Inspect Element');
  await waitState(s => tabOf(s).devtools, 'developer tools');
  const toolsView = async () => (await views()).find(view => view.url.startsWith('devtools://'));
  await expect.poll(async () => { const view = await toolsView(); return view && { x: view.x, y: view.y, width: view.width, height: view.height }; }).toEqual(await slotBounds('.tools-slot'));
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  assert.equal(await application.evaluate(({ webContents }) => { const tools = webContents.getAllWebContents().find(contents => contents.getURL().startsWith('devtools://')); const page = webContents.getAllWebContents().find(contents => /^http:/.test(contents.getURL())); return tools.session === page.session; }), true);
  const before = await slotBounds('.tools-slot');
  const splitter = page.getByRole('separator', { name: 'Resize Developer Tools', exact: true });
  await splitter.focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await slotBounds('.tools-slot')).height).toBe(before.height + 16);
  await expect.poll(async () => (await toolsView()).height).toBe(before.height + 16);
  await page.getByRole('button', { name: 'Page Menu', exact: true }).click();
  await choose('Dock Developer Tools at Right');
  await expect.poll(async () => { const view = await toolsView(), slot = await slotBounds('.tools-slot'); return view.x === slot.x && view.width === slot.width && view.y === slot.y; }).toBe(true);
  await page.getByRole('button', { name: 'Developer Tools', exact: true }).click();
  await waitState(s => !tabOf(s).devtools, 'closed developer tools');
  await expect.poll(toolsView).toBe(undefined);
  console.log('Inspect Element opens developer tools docked inside the window in the tab\'s session; they resize, dock at the right and close.');

  // Link status
  await mouse('#link');
  const status = await overlay('.link-status');
  await expect(status.locator('.link-status')).toHaveText(`${origin}/next`);
  const slot = await slotBounds('.browser-slot');
  await expect.poll(async () => { const view = (await views()).find(view => view.url === 'about:blank'); return view && view.x === slot.x && view.y + view.height === slot.y + slot.height; }).toBe(true);
  await mouse('p');
  await expect.poll(async () => (await views()).some(view => view.url === 'about:blank')).toBe(false);
  console.log('The address of a hovered link shows over the corner of the page and goes when the pointer leaves the link.');

  // Downloads
  const downloads = page.getByRole('button', { name: 'Downloads', exact: true });
  await expect(downloads).toBeHidden();
  await mouse('#file', 'left');
  await waitState(s => s.workspaces[0].downloads[0]?.state === 'progressing' && s.workspaces[0].downloads[0].received >= 1024, 'running download');
  await expect(downloads).toBeVisible();
  await downloads.click();
  const list = await overlay('.downloads');
  await expect(list.locator('.download-name')).toHaveText('fixture.bin');
  await expect(list.locator('.download-status')).toHaveText('1.0 KB / 2.0 KB');
  const button = await downloads.evaluate(node => { const r = node.getBoundingClientRect(); return { right: Math.round(r.right), bottom: Math.round(r.bottom) }; });
  await expect.poll(async () => (await views()).some(view => view.url === 'about:blank' && view.y === button.bottom && view.x + view.width === button.right + 16)).toBe(true);
  release();
  await waitState(s => s.workspaces[0].downloads[0]?.state === 'completed', 'completed download');
  assert.equal((await readFile(saved)).length, 2048);
  await list.getByRole('button', { name: 'Show fixture.bin in Folder', exact: true }).click();
  await expect.poll(() => application.evaluate(() => globalThis.rigShown)).toEqual([saved]);
  // Focus inside the list returns to the application when the list goes.
  const listFocused = () => application.evaluate(({ BrowserWindow }, y) => BrowserWindow.getAllWindows()[0].contentView.children.find(view => view.getVisible() && view.webContents.getURL() === 'about:blank' && view.getBounds().y === y)?.webContents.isFocused(), button.bottom);
  await application.evaluate(({ BrowserWindow }, y) => BrowserWindow.getAllWindows()[0].contentView.children.find(view => view.getVisible() && view.webContents.getURL() === 'about:blank' && view.getBounds().y === y).webContents.focus(), button.bottom);
  await expect.poll(listFocused).toBe(true);
  await list.getByRole('button', { name: 'Clear', exact: true }).click();
  await waitState(s => s.workspaces[0].downloads.length === 0, 'cleared downloads');
  await expect(downloads).toBeHidden();
  await expect.poll(async () => (await views()).some(view => view.url === 'about:blank' && view.y === button.bottom)).toBe(false);
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isFocused())).toBe(true);
  console.log('Downloads list over the page with their progress, show in their folder and clear; focus returns to the application.');

  // Only the application's own overlays open as child windows.
  assert.equal(await page.evaluate(() => window.open('about:blank', 'other')), null);
  // Opening an overlay's name again reaches the same overlay, which stays blank.
  await page.evaluate(() => { window.open('https://example.invalid/', 'overlay-status'); });
  await page.waitForTimeout(500);
  // The status and downloads overlays are open, and the modal overlay, which opens at launch.
  assert.deepEqual(await application.evaluate(({ webContents }) => webContents.getAllWebContents().map(contents => contents.getURL()).filter(url => !/^(file|http):/.test(url))), ['about:blank', 'about:blank', 'about:blank']);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  await api('settings', { theme: 'tabs' });
  await expect(page.locator('.tabs-status')).toBeVisible();
  await api('settings', { theme: 'console' });
  await expect(page.locator('.titlebar-marker img.favicon')).toBeVisible();
  await api('settings', { theme: 'rail' });
  assert.deepEqual(errors, []);
  console.log('Every overlay and tool stays inside the one application window.');
});
