import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { openSettings, closeSettings, showSection } from './lib/settings.mjs';
import { withDirectory, startSshd, sshProfile, launch, waitFor, chooseOption } from './lib/harness.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8Dwn4EIAAD//wMAKQYC/rUbUjwAAAAASUVORK5CYII=', 'base64');

await withDirectory('browsing', async (directory, cleanup) => {
  const requests = [];
  let release, finishNavigation;
  const http = createServer((request, response) => {
    requests.push({ url: request.url, cookie: request.headers.cookie ?? '' });
    if (request.url === '/slow') {
      finishNavigation = () => { response.setHeader('Content-Type', 'text/html'); response.end('<title>Slow page</title>'); };
      return;
    }
    if (request.url === '/icon.png') { response.setHeader('Content-Type', 'image/png'); response.end(png); return; }
    if (request.url === '/large.png') { response.setHeader('Content-Type', 'image/png'); response.end(Buffer.concat([png, Buffer.alloc(70 * 1024)])); return; }
    if (request.url === '/file') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="fixture.bin"', 'Content-Length': 2048 });
      response.write(Buffer.alloc(1024));
      release = () => response.end(Buffer.alloc(1024));
      return;
    }
    if (request.url === '/typing') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<title>Typing</title><input id="typing" autofocus>');
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
  await application.evaluate(({ dialog, shell, app }, { saved, pdf }) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: pdf });
    globalThis.rigShown = [];
    shell.showItemInFolder = path => { globalThis.rigShown.push(path); };
    // Downloads save without a dialog.
    app.on('session-created', session => session.on('will-download', (_event, item) => item.setSavePath(saved)));
  }, { saved, pdf });
  const menuLabels = () => app.menu.labels();
  const choose = label => app.menu.choose(label);
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
  const clickAddress = async () => { const box = await page.getByRole('combobox', { name: 'Address', exact: true }).boundingBox(); click(box.x + box.width / 2, box.y + box.height / 2); await expect(page.getByRole('combobox', { name: 'Address', exact: true })).toBeFocused(); };
  const connection = await api('connect', { profileId: 'rig' });
  await waitState(s => s.terminals[0]?.status === 'connected', 'terminal');
  const session = await api('newBrowser', connection);
  const tabOf = s => s.workspaces.find(w => w.id === session)?.tabs[0];
  const tab = tabOf(await waitState(s => tabOf(s), 'tab')).id;
  await app.chooseConnection(connection);
  const row = page.locator(`.nav-item[data-kind="tab"][data-id="${tab}"]`);
  await row.click();
  const address = page.getByRole('combobox', { name: 'Address', exact: true });
  await address.fill(`${origin}/`);
  press('Return');
  await waitState(s => tabOf(s).title === 'Fixture /' && !tabOf(s).loading, 'page');
  await expect.poll(async () => (await views()).length).toBe(1);
  await expect.poll(() => inPage(contents => contents.isFocused()), 'Address submission focuses a new page').toBe(true);


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

  await clickAddress();
  await address.fill('http://');
  press('Return');
  await expect(page.locator('.browser-error')).toContainText('Invalid URL');
  await expect(address).toBeFocused();
  assert.equal(await inPage(contents => contents.isFocused()), false, 'An invalid address keeps focus in the address field');
  await address.fill(`${origin}/`);
  press('Return');
  await expect.poll(() => inPage(contents => contents.isFocused())).toBe(true);
  await expect(page.locator('.browser-error')).toBeHidden();

  await clickAddress();
  await address.fill(`${origin}/slow`);
  press('Return');
  await waitFor(() => finishNavigation, 'pending navigation');
  await expect.poll(() => inPage(contents => contents.isFocused()), 'Address submission focuses an existing page').toBe(true);
  await expect(address, 'the address shows the page on its way').toHaveValue(`${origin}/slow`);
  const terminal = (await app.state()).terminals[0].id;
  await page.locator(`.nav-item[data-kind="terminal"][data-id="${terminal}"]`).click();
  const terminalInput = page.locator('.terminal-surface:not([hidden]) .xterm-helper-textarea');
  await expect(terminalInput).toBeFocused();
  const shellFocused = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isFocused());
  await expect.poll(shellFocused).toBe(true);
  finishNavigation();
  await waitState(s => tabOf(s).title === 'Slow page' && !tabOf(s).loading, 'background navigation');
  assert.equal(await shellFocused(), true, 'Completing navigation preserves terminal focus');
  await application.evaluate(async ({ webContents }, origin) => {
    const contents = webContents.getAllWebContents().find(contents => contents.getURL() === `${origin}/slow`);
    await contents.loadURL(`${origin}/`);
    await new Promise(resolve => { contents.once('did-finish-load', resolve); contents.reload(); });
  }, origin);
  assert.equal(await shellFocused(), true, 'Background navigation and reload preserve terminal focus');
  await expect(terminalInput).toBeFocused();
  await app.recordOutput();
  execFileSync('xdotool', ['type', 'printf FOCUS_OK']);
  press('Return');
  await expect.poll(() => app.output(terminal)).toContain('FOCUS_OK');
  await row.click();
  await expect.poll(async () => (await views()).length).toBe(1);
  console.log('Address submission focuses the page; background navigation and reload leave typing in the terminal.');

  // A terminal link gives its page the keyboard.
  await page.locator(`.nav-item[data-kind="terminal"][data-id="${terminal}"]`).click();
  await expect(terminalInput).toBeFocused();
  await api('input', terminal, `clear; printf '\\033]8;;${origin}/typing\\033\\\\TYPING LINK\\033]8;;\\033\\\\\\n'\n`);
  // The echoed command holds the link's text too, on a row that clearing the screen empties; the link is the row of the output alone.
  const linkRow = page.locator('.terminal-surface:not([hidden]) .xterm-rows > div').filter({ hasText: /^\s*TYPING\sLINK\s*$/ });
  await expect(linkRow).toHaveCount(1);
  const linkCell = await linkRow.boundingBox();
  // The link shows under a moving pointer.
  const linkPoint = { x: linkCell.x + 20, y: linkCell.y + linkCell.height / 2 };
  await waitFor(async () => {
    for (const x of [linkPoint.x - 4, linkPoint.x]) await page.mouse.move(x, linkPoint.y);
    return await page.locator('.terminal-surface:not([hidden]) .xterm-cursor-pointer').count() === 1;
  }, 'the pointer over the terminal link');
  await page.mouse.click(linkPoint.x, linkPoint.y);
  await waitState(s => s.workspaces[0].tabs.some(t => t.title === 'Typing' && !t.loading), 'linked page');
  await expect.poll(() => inPage((contents, url) => contents.getURL() === url && contents.isFocused(), `${origin}/typing`), 'the linked page has the keyboard').toBe(true);
  const typedBefore = await app.output(terminal);
  execFileSync('xdotool', ['type', 'typedtext']);
  await expect.poll(() => inPage(contents => contents.executeJavaScript('document.querySelector("#typing").value'))).toBe('typedtext');
  assert.equal((await app.output(terminal)).slice(typedBefore.length).includes('typedtext'), false, 'Typing after a terminal link stays out of the shell');
  // Alt+Left and Alt+Right go back and forward once the page leaves them alone.
  const typingTab = (await app.state()).workspaces[0].tabs.find(t => t.title === 'Typing').id;
  await api('browser', session, 'navigate', typingTab, `${origin}/plain`);
  await waitState(s => s.workspaces[0].tabs.find(t => t.id === typingTab).title === 'Fixture /plain', 'second page in the linked tab');
  await clickPage('#image');
  press('alt+Left');
  await expect.poll(() => inPage(contents => contents.getURL())).toBe(`${origin}/typing`);
  await clickPage('#typing');
  await inPage(contents => contents.executeJavaScript('document.activeElement.blur()'));
  press('alt+Right');
  await expect.poll(() => inPage(contents => contents.getURL())).toBe(`${origin}/plain`);
  await api('browser', session, 'close', typingTab);
  execFileSync('xdotool', ['mousemove', '--window', String(windowId), '5', '5']);
  await row.click();
  await expect.poll(async () => (await views()).length).toBe(1);
  console.log('A terminal link gives its page the keyboard, and Alt+Left and Alt+Right move through its history.');


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
  const external = (await app.state()).capabilities.externalBrowser;
  await expect.poll(menuLabels).toEqual(['Reload', 'Duplicate Tab', 'Copy Address', ...external ? ['Open in External Browser'] : [], '-', 'Unmute Tab', '-', 'Close Tab', 'Close Other Tabs (disabled)', 'Close Tabs Below (disabled)', 'Reopen Closed Tab', '-', 'Move Up (disabled)', 'Move Down (disabled)']);
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
  await expect(page.getByRole('combobox', { name: 'Address', exact: true })).toBeFocused();
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
  await expect.poll(async () => (await menuLabels())?.filter(label => !label.startsWith('Undo') && !label.startsWith('Redo'))).toEqual(['-', 'Cut (disabled)', 'Copy (disabled)', 'Paste', 'Select All', '-', 'Inspect Element']);
  await app.menu.close();
  // The page keeps the field's selection while its menu is open, and edits act on it.
  await inPage(contents => contents.executeJavaScript('document.querySelector("#field").select()'));
  await mouse('#field', 'right');
  await expect.poll(async () => (await menuLabels())?.filter(label => !label.startsWith('Undo') && !label.startsWith('Redo'))).toEqual(['-', 'Cut', 'Copy', 'Paste', 'Select All', '-', 'Inspect Element']);
  await choose('Cut');
  await expect.poll(() => application.evaluate(({ clipboard }) => clipboard.readText())).toBe('editable');
  await expect.poll(() => inPage(contents => contents.executeJavaScript('document.querySelector("#field").value'))).toBe('');
  await mouse('#field', 'right');
  await choose('Paste');
  await expect.poll(() => inPage(contents => contents.executeJavaScript('document.querySelector("#field").value'))).toBe('editable');
  await mouse('p', 'right');
  await expect.poll(menuLabels).toEqual(['Back', 'Forward (disabled)', 'Reload', '-', 'Copy Page Address', ...external ? ['Open Page in External Browser'] : [], '-', 'Save as PDF…', 'Print…', '-', 'View Page Source', 'Inspect Element']);
  await choose('Save as PDF…');
  await waitFor(async () => (await readFile(pdf).catch(() => Buffer.alloc(0))).subarray(0, 5).toString() === '%PDF-', 'saved PDF');
  console.log('A page menu offers what applies to the image, field or page under the pointer, cuts and pastes in a field, and saves the page as a PDF.');

  // A menu of a zoomed page opens at the pointer; it takes the keyboard, and a press in the page or Escape closes it and
  // returns the keyboard to the page.
  await api('browser', session, 'zoom-in', tab);
  await api('browser', session, 'zoom-in', tab);
  await waitState(s => tabOf(s).zoom === 125, 'zoomed page');
  const rightClick = (x, y) => execFileSync('xdotool', ['mousemove', '--window', String(windowId), String(Math.round(x)), String(Math.round(y)), 'click', '3']);
  const pageSlot = await slotBounds('.browser-slot'), spot = await center('p');
  const at = { x: pageSlot.x + spot.x * 1.25, y: pageSlot.y + spot.y * 1.25 };
  // Where the page saw the press, in the window.
  await inPage(contents => contents.executeJavaScript('addEventListener("contextmenu", event => { window.rigPress = [event.clientX, event.clientY]; }, { once: true })'));
  rightClick(at.x, at.y);
  await expect.poll(menuLabels).toEqual(['Back', 'Forward (disabled)', 'Reload', '-', 'Copy Page Address', ...external ? ['Open Page in External Browser'] : [], '-', 'Save as PDF…', 'Print…', '-', 'View Page Source', 'Inspect Element']);
  const popupView = () => application.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    for (const view of window.contentView.children)
      if (view.webContents && view.getVisible() && await view.webContents.executeJavaScript('document.documentElement.classList.contains("overlay-popup")').catch(() => false)) return { ...view.getBounds(), focused: view.webContents.isFocused() };
  });
  const popupDocument = await app.popup();
  const menuBox = await popupDocument.evaluate(() => document.querySelector('.menu').getBoundingClientRect().toJSON());
  const shown = await popupView(), [pressX, pressY] = await inPage(contents => contents.executeJavaScript('window.rigPress'));
  const pressed = { x: pageSlot.x + pressX * 1.25, y: pageSlot.y + pressY * 1.25 };
  assert.ok(Math.abs(shown.x + menuBox.x - pressed.x) <= 2 && Math.abs(shown.y + menuBox.y - pressed.y) <= 2, JSON.stringify({ shown, menuBox, pressed }));
  assert.equal(shown.focused, true);
  click(at.x - 40, at.y);
  await expect.poll(() => app.menu.open()).toBe(false);
  await expect.poll(() => inPage(contents => contents.isFocused())).toBe(true);
  rightClick(at.x, at.y);
  await expect.poll(() => app.menu.open()).toBe(true);
  await expect.poll(async () => (await popupView())?.focused).toBe(true);
  press('Down');
  await expect.poll(() => popupDocument.evaluate(() => document.activeElement?.textContent)).toContain('Back');
  press('Escape');
  await expect.poll(() => app.menu.open()).toBe(false);
  await expect.poll(() => inPage(contents => contents.isFocused())).toBe(true);
  // Another window coming to the front closes the menu, and the page has the keyboard once the window is back.
  rightClick(at.x, at.y);
  await expect.poll(async () => (await popupView())?.focused).toBe(true);
  const other = spawn('xmessage', ['-geometry', '+0+0', 'other window'], { stdio: 'ignore' });
  cleanup(() => other.kill());
  const otherId = await waitFor(() => { try { return execFileSync('xdotool', ['search', '--class', 'Xmessage'], { encoding: 'utf8' }).trim().split('\n')[0]; } catch { return undefined; } }, 'the other window');
  execFileSync('xdotool', ['windowactivate', '--sync', otherId]);
  await expect.poll(() => app.menu.open()).toBe(false);
  execFileSync('xdotool', ['windowactivate', '--sync', String(windowId)]);
  await expect.poll(() => inPage(contents => contents.isFocused())).toBe(true);
  other.kill();
  await api('browser', session, 'zoom-reset', tab);
  await waitState(s => tabOf(s).zoom === 100, 'zoom reset');
  // Address keeps the part selected while its menu is open.
  const selection = () => address.evaluate(field => [field.selectionStart, field.selectionEnd]);
  await clickAddress();
  await page.waitForTimeout(100);
  await address.evaluate(field => field.setSelectionRange(0, 4));
  press('shift+F10');
  await expect.poll(async () => (await popupView())?.focused).toBe(true);
  press('Escape');
  await expect.poll(() => app.menu.open()).toBe(false);
  await expect(address).toBeFocused();
  await page.waitForTimeout(100);
  assert.deepEqual(await selection(), [0, 4]);
  // A menu or list that a key opens under a still pointer highlights nothing until the pointer moves.
  const popupFocus = () => popupDocument.evaluate(() => { const active = document.activeElement; return active?.getAttribute('role') ?? active?.className; });
  const middleOf = async selector => { const view = await popupView(), box = await popupDocument.evaluate(selector => document.querySelector(selector).getBoundingClientRect().toJSON(), selector); return { x: view.x + box.x + box.width / 2, y: view.y + box.y + box.height / 2 }; };
  const underStillPointer = async (open, selector, surface, item) => {
    open();
    await expect.poll(async () => (await popupView())?.focused).toBe(true);
    const point = await middleOf(selector);
    press('Escape');
    await expect.poll(async () => (await popupView())?.focused ?? false).toBe(false);
    execFileSync('xdotool', ['mousemove', '--window', String(windowId), String(Math.round(point.x)), String(Math.round(point.y))]);
    await page.waitForTimeout(300);
    open();
    await expect.poll(async () => (await popupView())?.focused).toBe(true);
    await page.waitForTimeout(600);
    assert.equal(await popupFocus(), surface);
    execFileSync('xdotool', ['mousemove_relative', '--', '2', '0']);
    await expect.poll(popupFocus).toBe(item);
    press('Escape');
    await expect.poll(async () => (await popupView())?.focused ?? false).toBe(false);
  };
  await underStillPointer(() => press('shift+F10'), '.menu [role="menuitem"]:not([aria-disabled="true"])', 'menu', 'menuitem');
  await expect(address).toBeFocused();
  // A custom font family left empty keeps its field while its menu pastes into it.
  const settings = await openSettings(page);
  await showSection(settings, 'Terminal');
  await settings.getByRole('button', { name: 'Terminal Font', exact: true }).focus();
  await underStillPointer(() => press('Return'), '.select-list', 'listbox', 'option');
  await expect(settings.getByRole('button', { name: 'Terminal Font', exact: true })).toBeFocused();
  await chooseOption(settings.getByRole('button', { name: 'Terminal Font', exact: true }), { label: 'Custom' });
  const family = settings.getByRole('textbox', { name: 'Terminal Font Family', exact: true });
  await expect(family).toBeFocused();
  await family.fill('');
  await application.evaluate(({ clipboard }) => clipboard.writeText('Bartizan Pasted Mono'));
  const familyBox = await family.boundingBox();
  const modalTop = await application.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    for (const view of window.contentView.children)
      if (view.webContents && view.getVisible() && await view.webContents.executeJavaScript('document.documentElement.classList.contains("overlay-modal")').catch(() => false)) return view.getBounds().y;
  });
  rightClick(familyBox.x + 20, modalTop + familyBox.y + familyBox.height / 2);
  await expect.poll(async () => (await popupView())?.focused).toBe(true);
  await app.menu.choose('Paste');
  await expect(family).toHaveValue('Bartizan Pasted Mono');
  await expect(family).toBeVisible();
  await closeSettings(page);
  await api('settings', { terminalFont: 'JetBrains Mono' });
  console.log('A zoomed page\'s menu opens at the pointer and takes the keyboard; a press in the page or Escape closes it and gives the page the keyboard back, and Address keeps its selection through its menu.');
  console.log('A menu or select list that a key opens under a still pointer highlights nothing until the pointer moves.');

  await mouse('p', 'right');
  await expect.poll(menuLabels).toEqual(['Back', 'Forward (disabled)', 'Reload', '-', 'Copy Page Address', ...external ? ['Open Page in External Browser'] : [], '-', 'Save as PDF…', 'Print…', '-', 'View Page Source', 'Inspect Element']);

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
  // The Page Menu belongs to the page on show, and closes as the tab moves on.
  await page.getByRole('button', { name: 'Page Menu', exact: true }).click();
  await expect.poll(() => app.menu.open()).toBe(true);
  await api('browser', session, 'navigate', tab, `${origin}/handles`);
  await expect.poll(() => app.menu.open()).toBe(false);
  await waitState(s => tabOf(s).title === 'Fixture /handles' && !tabOf(s).loading, 'next page');
  await api('browser', session, 'navigate', tab, `${origin}/`);
  await waitState(s => tabOf(s).title === 'Fixture /' && !tabOf(s).loading, 'first page again');
  await page.getByRole('button', { name: 'Page Menu', exact: true }).click();
  await choose('Dock Developer Tools at Right');
  await expect.poll(async () => { const view = await toolsView(), slot = await slotBounds('.tools-slot'); return view.x === slot.x && view.width === slot.width && view.y === slot.y; }).toBe(true);
  await page.getByRole('button', { name: 'Close Developer Tools', exact: true }).click();
  await waitState(s => !tabOf(s).devtools, 'closed developer tools');
  await expect.poll(toolsView).toBe(undefined);
  console.log('Inspect Element opens developer tools docked inside the window in the tab\'s session; they resize, dock at the right and close.');
  // Closing a tab with its developer tools open removes both views from the window.
  const viewCount = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length);
  const baseline = await viewCount();
  await api('browser', session, 'new', undefined, `${origin}/`);
  const extra = (await waitState(s => s.workspaces.find(w => w.id === session)?.tabs.length === 2, 'second tab')).workspaces.find(w => w.id === session).tabs[1].id;
  await api('browser', session, 'devtools', extra);
  await waitState(s => s.workspaces.find(w => w.id === session)?.tabs[1]?.devtools, 'developer tools on the second tab');
  await api('browser', session, 'close', extra);
  await waitState(s => s.workspaces.find(w => w.id === session)?.tabs.length === 1, 'closed second tab');
  await expect.poll(viewCount).toBe(baseline);
  await api('browser', session, 'select', tab);
  console.log('Closing a tab with its developer tools open removes its views.');

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
  await expect.poll(() => inPage(contents => contents.isFocused())).toBe(true);
  console.log('Downloads list over the page with their progress, show in their folder and clear; focus returns to the page once the list and its button go.');

  // Only the application's own overlays open as child windows.
  assert.equal(await page.evaluate(() => window.open('about:blank', 'other')), null);
  // Opening an overlay's name again reaches the same overlay, which stays blank.
  await page.evaluate(() => { window.open('https://example.invalid/', 'overlay-status'); });
  await page.waitForTimeout(500);
  // The status, downloads and address suggestions overlays are open, and the modal, popup and tooltip overlays, which open at launch.
  assert.deepEqual(await application.evaluate(({ webContents }) => webContents.getAllWebContents().map(contents => contents.getURL()).filter(url => !/^(file|http):/.test(url))), ['about:blank', 'about:blank', 'about:blank', 'about:blank', 'about:blank', 'about:blank']);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  await api('settings', { theme: 'tabs' });
  await expect(page.locator('.tabs-status')).toBeVisible();
  await api('settings', { theme: 'console' });
  await expect(page.locator('.titlebar-marker img.favicon')).toBeVisible();
  await api('settings', { theme: 'rail' });
  assert.deepEqual(errors, []);
  console.log('Every overlay and tool stays inside the one application window.');
});
