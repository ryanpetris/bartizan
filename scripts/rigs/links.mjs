import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { withDirectory, startSshd, sshProfile, launch, waitFor } from './lib/harness.mjs';

await withDirectory('links', async (directory, cleanup) => {
  const requests = [], posts = [];
  const http = createServer((request, response) => {
    requests.push(request.url);
    if (request.method === 'POST') { posts.push(request.url); response.setHeader('Content-Type', 'text/html'); response.end('<title>Posted</title>'); return; }
    // A slow page answers only when the connection closes.
    if (request.url === '/slow') return;
    if (request.url === '/data.json') { response.setHeader('Content-Type', 'application/json'); response.end('{"fixture":true}'); return; }
    if (request.url === '/cookie') response.setHeader('Set-Cookie', 'site=1; Path=/');
    response.setHeader('Content-Type', 'text/html');
    response.end(request.url === '/form'
      ? '<title>Form</title><form method="post" action="/submitted"><button>Send</button></form>'
      : request.url === '/system' ? `<title>System</title><style>a, iframe { display: block; font-size: 30px; margin: 10px; } iframe { height: 80px; border: 0; }</style>
        <a id="mailto" href="mailto:someone@example.com?subject=Hello&amp;attach=/etc/hostname">Mail</a><a id="tel" href="tel:+15550100" target="_blank">Call</a>
        <a id="file" href="file:///etc/hostname">File</a><a id="custom" href="bartizan-rig://open">Custom</a>
        <iframe srcdoc='<a id="sms" href="sms:+15550100" style="font-size: 30px">Text</a>'></iframe>`
      : request.url === '/unload' ? '<title>Unload</title><script>addEventListener("beforeunload", event => { event.preventDefault(); event.returnValue = ""; })</script>'
      : `<title>Fixture ${request.url}</title><a href="/page" style="font-size: 40px">Page link</a>`);
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  cleanup(() => { http.closeAllConnections(); http.close(); });
  const origin = `http://127.0.0.1:${http.address().port}`;
  const plain = `${origin}/plain?q=one#part`, osc = `${origin}/osc`, pageLink = `${origin}/page`;
  // A plain shell keeps the screen to what the rig prints; commands run as they are.
  const shell = join(directory, 'shell');
  await writeFile(shell, '#!/bin/sh\nif [ -n "$SSH_ORIGINAL_COMMAND" ]; then exec /bin/sh -c "$SSH_ORIGINAL_COMMAND"; fi\nexec /bin/sh\n');
  await chmod(shell, 0o755);
  const sshd = await startSshd(directory, { config: `ForceCommand ${shell}\n` });
  cleanup(sshd.stop);
  const config = join(directory, 'config.yaml');
  await writeFile(config, `version: 1\nsettings:\n  remoteSessionIntegration: false\nprofiles:\n  rig:\n    label: Fixture\n${sshProfile(sshd)}`);
  // An xdg-open on PATH makes the external browser available; opening it is recorded instead.
  const bin = join(directory, 'bin'), empty = join(directory, 'empty');
  await mkdir(bin);
  await mkdir(empty);
  // It records each address it is given, one bracketed argument after another, and exits with RIG_OPEN_EXIT.
  const openedFile = join(directory, 'opened');
  await writeFile(join(bin, 'xdg-open'), '#!/bin/sh\n{ for argument in "$@"; do printf "[%s]" "$argument"; done; echo; } >> "$RIG_OPENED"\nexit ${RIG_OPEN_EXIT:-0}\n');
  await chmod(join(bin, 'xdg-open'), 0o755);
  const opener = `${bin}:${process.env.PATH}`;
  const app = await launch(directory, config, { env: { PATH: opener, RIG_OPENED: openedFile } });
  cleanup(app.close);
  const { application, page, api, waitState, recordOutput, output, errors } = app;
  await application.evaluate(({ ipcMain, shell }) => {
    globalThis.rigInputs = [];
    const request = ipcMain._invokeHandlers.get('request');
    ipcMain._invokeHandlers.set('request', (event, message) => { if (message.method === 'input') globalThis.rigInputs.push(message.args[1]); return request(event, message); });
    globalThis.rigExternal = [];
    shell.openExternal = async url => { globalThis.rigExternal.push(url); };
  });
  await page.evaluate(() => window.bartizan.onEvent(event => { if (event.type === 'errors') window.rigErrors = event.log.history; }));
  /** Opens a menu and checks the items of the menu it shows. */
  const menu = async (open, expected) => {
    await app.menu.close();
    await open();
    await expect.poll(() => app.menu.labels()).toEqual(expected);
  };
  const choose = label => app.menu.choose(label);
  const clipboard = () => application.evaluate(({ clipboard }) => clipboard.readText());
  const copied = async url => {
    await application.evaluate(({ clipboard }) => clipboard.writeText(''));
    await choose('Copy Link');
    await expect.poll(clipboard).toBe(url);
  };
  const noMenu = async open => {
    await app.menu.close();
    await open();
    await page.waitForTimeout(300);
    assert.equal(await app.menu.open(), false);
  };
  const reports = () => application.evaluate(() => globalThis.rigInputs.filter(data => data.startsWith('\x1b[<')));

  await recordOutput();
  const connection = await api('connect', { profileId: 'rig' });
  const terminal = (await waitState(s => s.terminals[0]?.status === 'connected', 'terminal')).terminals[0].id;
  await waitFor(async () => (await output(terminal)).includes('$ '), 'shell prompt');
  await app.chooseConnection(connection);
  const showTerminal = async () => {
    await page.locator(`.nav-item[data-kind="terminal"][data-id="${terminal}"]`).click();
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-screen')).toBeVisible();
  };
  await showTerminal();
  const surface = page.locator('.terminal-surface:not([hidden])');
  const pointer = surface.locator('.xterm-cursor-pointer');
  /** Prints a screen from a file and keeps the shell busy until the next screen interrupts it. */
  let screen = 0;
  const show = async text => {
    if (screen) {
      const before = (await output(terminal)).length;
      await api('input', terminal, '\x03');
      await waitFor(async () => (await output(terminal)).slice(before).includes('$ '), 'shell prompt');
    }
    const file = join(directory, `screen-${++screen}`);
    const marker = `SCREEN-${screen}-READY`;
    await writeFile(file, `\x1b[2J\x1b[H${text}\r\n${marker}`);
    await api('input', terminal, `cat '${file}'; sleep 600\n`);
    await waitFor(async () => (await output(terminal)).includes(marker), `screen ${screen}`);
  };
  /** Moves the pointer over a terminal row, after leaving any link. */
  const point = async (row, link = true) => {
    const box = await surface.locator('.xterm-screen').boundingBox();
    const height = await waitFor(() => surface.locator('.xterm-helper-textarea').evaluate(element => parseFloat(element.style.height) || 0), 'terminal row height');
    await page.mouse.move(box.x + box.width - 5, box.y + box.height - 5);
    await expect(pointer).toHaveCount(0);
    const position = { x: box.x + 20, y: box.y + height * (row + 0.5) };
    await page.mouse.move(position.x, position.y);
    if (link) await expect(pointer).toHaveCount(1);
    return position;
  };
  const rightClick = (row, link) => async () => { const { x, y } = await point(row, link); await page.mouse.click(x, y, { button: 'right' }); };
  const leftClick = async row => { const { x, y } = await point(row); await page.mouse.click(x, y); };
  const shiftF10 = async () => { await surface.locator('textarea').focus(); await page.keyboard.press('Shift+F10'); };
  const single = ['Open Link', 'Open in New Browser Session', 'Open in External Browser', '-', 'Copy Link'];
  const terminalMenu = ['Copy (disabled)', 'Paste', 'Select All'];
  const shiftRightClick = row => async () => {
    const { x, y } = await point(row, false);
    await page.keyboard.down('Shift');
    await page.mouse.click(x, y, { button: 'right' });
    await page.keyboard.up('Shift');
  };

  await show(`${plain}\r\n\x1b]8;;${osc}\x07Linked label\x1b]8;;\x07\x1b[?1000h\x1b[?1006h`);
  await noMenu(rightClick(5, false));
  await expect.poll(reports).toHaveLength(2);
  await menu(shiftRightClick(5), terminalMenu);
  await menu(rightClick(0), single);
  await copied(plain);
  await menu(rightClick(1), single);
  await copied(osc);
  assert.equal((await reports()).length, 2);
  await page.mouse.move(0, 0);
  await menu(shiftF10, [plain, osc]);
  // Each link has a submenu, which Right and Enter open with focus on it and no item highlighted, and Left and Escape close.
  const popup = await app.popup();
  const focusedItem = () => popup.evaluate(() => document.activeElement?.closest('[role^="menuitem"]')?.querySelector('.menu-label').textContent);
  await expect.poll(() => popup.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('menu');
  await popup.keyboard.press('ArrowDown');
  assert.equal(await focusedItem(), plain);
  await popup.keyboard.press('ArrowRight');
  await expect.poll(() => app.menu.labels(1)).toEqual(single);
  await expect.poll(() => popup.evaluate(() => document.activeElement === document.querySelectorAll('.menu')[1])).toBe(true);
  await popup.keyboard.press('ArrowDown');
  assert.equal(await focusedItem(), 'Open Link');
  await popup.keyboard.press('ArrowLeft');
  await expect.poll(() => app.menu.labels(1)).toBeUndefined();
  assert.equal(await focusedItem(), plain);
  await popup.keyboard.press('ArrowDown');
  await popup.keyboard.press('Enter');
  await expect.poll(() => app.menu.labels(1)).toEqual(single);
  await expect.poll(() => popup.evaluate(() => document.activeElement === document.querySelectorAll('.menu')[1])).toBe(true);
  await popup.keyboard.press('End');
  assert.equal(await focusedItem(), 'Copy Link');
  await popup.keyboard.press('Escape');
  await expect.poll(() => app.menu.labels(1)).toBeUndefined();
  assert.deepEqual([await app.menu.labels(), await focusedItem()], [[plain, osc], osc]);
  // The pointer resting on a link opens its submenu.
  await (await app.menu.item(plain)).hover();
  await expect.poll(() => app.menu.labels(1)).toEqual(single);
  await application.evaluate(({ clipboard }) => clipboard.writeText(''));
  await app.menu.choose('Copy Link', 1);
  await expect.poll(clipboard).toBe(plain);
  await expect.poll(app.menu.open).toBe(false);
  console.log('With remote mouse reporting on, right clicks on plain and OSC 8 links open the link menu and Shift+right clicks elsewhere the terminal menu, without reaching the remote side; Shift+F10 offers every link on screen, each in a submenu the keys and the pointer open.');

  await show(`\x1b[?1000l\x1b[?1006l\x1b]8;;https://user:secret@example.invalid/\x07credentials link\x1b]8;;\x07\r\n\x1b]8;;javascript:alert(1)\x07script link\x1b]8;;\x07\r\n\x1b]8;;https://example.invalid/${'x'.repeat(8200)}\x07long link\x1b]8;;\x07\r\nftp://example.invalid/file`);
  for (const [row, link] of [[0, true], [1, false], [2, true], [3, false]]) await menu(rightClick(row, link), terminalMenu);
  await menu(shiftF10, single);
  await copied(osc);
  console.log('Links with credentials, other schemes or excessive length offer no link menu, and Shift+F10 falls back to recent valid hyperlinks.');

  await show('\x1b[?2004hPASTE-SCREEN');
  const inputCount = () => application.evaluate(() => globalThis.rigInputs.length);
  const pasted = async paste => {
    const count = await inputCount();
    await paste();
    await expect.poll(() => application.evaluate((_, count) => globalThis.rigInputs.slice(count), count)).toContain('\x1b[200~PASTED\x1b[201~');
  };
  await application.evaluate(({ clipboard }) => clipboard.writeText('PASTED'));
  await menu(rightClick(0, false), terminalMenu);
  await pasted(() => choose('Paste'));
  await surface.locator('textarea').focus();
  await pasted(() => page.keyboard.press('Control+Shift+V'));
  await pasted(() => page.keyboard.press('Shift+Insert'));
  await menu(rightClick(0, false), terminalMenu);
  await choose('Select All');
  await menu(rightClick(0, false), ['Copy', 'Paste', 'Select All']);
  await choose('Copy');
  await expect.poll(clipboard).toContain('PASTE-SCREEN');
  console.log('Elsewhere the terminal menu copies, pastes and selects all, and Paste, Ctrl+Shift+V and Shift+Insert paste in bracketed paste mode.');

  await show(`${plain}\r\n\x1b]8;;${osc}\x07Linked label\x1b]8;;\x07`);
  await application.evaluate(({ clipboard }) => clipboard.writeText(''));
  const { x, y } = await point(0);
  await page.mouse.down();
  await page.mouse.move(x + 100, y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => { const text = await clipboard(); return text.length > 5 && plain.includes(text); }).toBe(true);
  await page.waitForTimeout(300);
  assert.equal((await app.state()).workspaces.length, 0);
  console.log('Dragging across a terminal link copies the selected part without opening it.');
  await leftClick(0);
  let state = await waitState(s => s.workspaces.length === 1 && s.workspaces[0].tabs.length === 1, 'first browser');
  const first = state.workspaces[0].id;
  assert.equal(state.workspaces[0].tabs[0].url, plain);
  await expect(page.locator(`.nav-item[data-kind="tab"][data-workspace="${first}"]`)).toHaveAttribute('aria-current', 'page');
  await showTerminal();
  await leftClick(1);
  state = await waitState(s => s.workspaces[0].tabs.length === 2, 'second tab');
  assert.deepEqual([state.workspaces.length, state.workspaces[0].tabs[1].url], [1, osc]);
  console.log('Clicking a terminal link opens it in the connection\'s first browser session.');

  await showTerminal();
  const withBrowser = ['Open Link', 'Open in New Browser Session', 'Open in Browser', 'Open in External Browser', '-', 'Copy Link'];
  await menu(rightClick(0), withBrowser);
  await choose('Open in External Browser');
  await expect.poll(() => application.evaluate(() => globalThis.rigExternal)).toEqual([plain]);
  await application.evaluate((_, empty) => { process.env.PATH = empty; }, empty);
  await menu(rightClick(0), withBrowser.filter(label => label !== 'Open in External Browser'));
  await application.evaluate((_, opener) => { process.env.PATH = opener; }, opener);
  await menu(rightClick(1), withBrowser);
  await choose('Open in New Browser Session');
  state = await waitState(s => s.workspaces.length === 2, 'second browser');
  const second = state.workspaces.find(w => w.id !== first);
  assert.deepEqual(second.tabs.map(tab => tab.url), [osc]);
  const firstColor = String(state.workspaces.find(w => w.id === first).color), secondColor = String(second.color);
  assert.notEqual(firstColor, secondColor);
  await showTerminal();
  await menu(rightClick(0), ['Open Link', 'Open in New Browser Session', 'Open in Browser', 'Open in Browser', 'Open in External Browser', '-', 'Copy Link']);
  // Sessions show in the link menu in their colors.
  assert.deepEqual(await app.menu.colors(), [null, null, firstColor, secondColor, null, null]);
  await app.menu.chooseColor(secondColor);
  await waitState(s => s.workspaces.find(w => w.id === second.id)?.tabs.length === 2, 'tab in the second session');
  await showTerminal();
  await menu(rightClick(1), ['Open Link', 'Open in New Browser Session', 'Open in Browser', 'Open in Browser', 'Open in External Browser', '-', 'Copy Link']);
  await choose('Open Link');
  await waitState(s => s.workspaces.find(w => w.id === first).tabs.length === 3, 'third tab in the first session');
  console.log('The link menu opens links in the first, a new or a chosen browser session, each in its color, and offers the external browser only when xdg-open is on PATH.');

  await page.locator(`.session-row .nav-item[data-id="${second.id}"]`).click();
  await waitState(s => s.workspaces.find(w => w.id === second.id).tabs.every(tab => !tab.loading && tab.title.startsWith('Fixture')), 'second session pages');
  const rightClickPage = () => application.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const contents = window.contentView.children.find(view => view.webContents && view.webContents !== window.webContents && view.getVisible()).webContents;
    const { x, y } = await contents.executeJavaScript('(() => { const r = document.querySelector("a").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()');
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 });
  });
  await menu(rightClickPage, ['Open Link', 'Open Link in New Tab', 'Open in New Browser Session', 'Open in Browser', 'Open in External Browser', '-', 'Copy Link', '-', 'Inspect Element']);
  await copied(pageLink);
  // A press in the page closes its menu, which opens beside the pointer.
  const pageMenuItems = ['Open Link', 'Open Link in New Tab', 'Open in New Browser Session', 'Open in Browser', 'Open in External Browser', '-', 'Copy Link', '-', 'Inspect Element'];
  await menu(rightClickPage, pageMenuItems);
  const [menuBox, linkBox] = await Promise.all([
    popup.evaluate(() => document.querySelector('.menu').getBoundingClientRect().toJSON()),
    application.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const view = window.contentView.children.find(child => child.webContents && child.webContents !== window.webContents && child.getVisible() && /^http/.test(child.webContents.getURL()));
      const link = await view.webContents.executeJavaScript('(() => { const r = document.querySelector("a").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()');
      return { x: view.getBounds().x + link.x, y: view.getBounds().y + link.y };
    }),
  ]);
  const popupBounds = await application.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    for (const child of window.contentView.children)
      if (child.webContents && child.getVisible() && await child.webContents.executeJavaScript('document.documentElement.classList.contains("overlay-popup")').catch(() => false)) return child.getBounds();
  });
  assert.ok(Math.abs(popupBounds.x + menuBox.x - linkBox.x) <= 1 && Math.abs(popupBounds.y + menuBox.y - linkBox.y) <= 1, JSON.stringify({ popupBounds, menuBox, linkBox }));
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const contents = window.contentView.children.find(view => view.webContents && view.webContents !== window.webContents && view.getVisible() && /^http/.test(view.webContents.getURL())).webContents;
    contents.sendInputEvent({ type: 'mouseDown', x: 5, y: 5, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x: 5, y: 5, button: 'left', clickCount: 1 });
  });
  await expect.poll(app.menu.open).toBe(false);
  await menu(rightClickPage, pageMenuItems);
  await choose('Open Link');
  state = await waitState(s => s.workspaces.find(w => w.id === second.id).tabs.length === 3, 'page link in the second session');
  assert.equal(state.workspaces.find(w => w.id === second.id).tabs[2].url, pageLink);
  console.log('A link right-clicked in a page opens the same menu at the pointer, where Open Link stays in that session, and a press in the page closes it.');

  const tabCounts = async () => Object.fromEntries((await app.state()).workspaces.map(w => [w.id, w.tabs.length]));
  await assert.rejects(api('renameBrowser', second.id, 'A\nB'));
  await api('renameBrowser', second.id, 'A & B');
  await showTerminal();
  await menu(rightClick(1), ['Open Link', 'Open in New Browser Session', 'Open in Browser', 'Open in A & B', 'Open in External Browser', '-', 'Copy Link']);
  await api('renameBrowser', second.id, '');
  console.log('Renamed sessions appear in the link menu by name.');
  await menu(() => page.locator(`.session-row .nav-item[data-id="${second.id}"]`).click({ button: 'right' }), ['Rename', 'Move Up', 'Move Down (disabled)']);
  await choose('Move Up');
  await expect(page.locator('.session-row .nav-item').first()).toHaveAttribute('data-id', second.id);
  // The link menu lists sessions in the order the panel shows them.
  await showTerminal();
  await menu(rightClick(1), ['Open Link', 'Open in New Browser Session', 'Open in Browser', 'Open in Browser', 'Open in External Browser', '-', 'Copy Link']);
  assert.deepEqual(await app.menu.colors(), [null, null, secondColor, firstColor, null, null]);
  await app.menu.close();
  await showTerminal();
  await leftClick(0);
  await waitState(s => s.workspaces.find(w => w.id === second.id).tabs.length === 4, 'link in the nearest session below the terminal');
  await showTerminal();
  await menu(rightClick(1), ['Open Link', 'Open in New Browser Session', 'Open in Browser', 'Open in Browser', 'Open in External Browser', '-', 'Copy Link']);
  await choose('Open Link');
  await waitState(s => s.workspaces.find(w => w.id === second.id).tabs.length === 5, 'menu link in the nearest session below the terminal');
  assert.deepEqual(await tabCounts(), { [first]: 3, [second.id]: 5 });
  // With no session below it, a terminal's links go to the nearest one above it.
  for (let step = 0; step < 2; step++) {
    await page.locator(`.nav-item[data-kind="terminal"][data-id="${terminal}"]`).click({ button: 'right' });
    await choose('Move Down');
  }
  await showTerminal();
  await leftClick(0);
  await waitState(s => s.workspaces.find(w => w.id === first).tabs.length === 4, 'link in the nearest session above the terminal');
  assert.deepEqual(await tabCounts(), { [first]: 4, [second.id]: 5 });
  console.log('Terminal links use the nearest session below the terminal in the panel, or else above it.');

  await showTerminal();
  await menu(rightClick(0), ['Open Link', 'Open in New Browser Session', 'Open in Browser', 'Open in Browser', 'Open in External Browser', '-', 'Copy Link']);
  await api('browser', second.id, 'close-workspace');
  await waitState(s => s.workspaces.length === 1, 'second session closed');
  await app.menu.chooseColor(secondColor);
  await waitFor(() => page.evaluate(() => window.rigErrors?.some(entry => entry.source === 'link' && entry.message.includes('Browser session is closed'))), 'stale session error');
  assert.equal((await app.state()).workspaces.length, 1);
  const linkErrors = () => page.evaluate(() => window.rigErrors.filter(entry => entry.source === 'link').reduce((sum, entry) => sum + entry.count, 0));
  const reported = await linkErrors();
  await menu(rightClick(0), ['Open Link', 'Open in New Browser Session', 'Open in Browser', 'Open in External Browser', '-', 'Copy Link']);
  await choose('Open Link');
  await waitState(s => s.workspaces[0].tabs.length === 5, 'Open Link in the remaining session');
  await api('openLink', terminal, plain);
  await waitState(s => s.workspaces[0].tabs.length === 6, 'terminal link in the remaining session');
  await page.waitForTimeout(200);
  assert.equal(await linkErrors(), reported);
  await showTerminal();
  await api('disconnect', connection);
  await waitState(s => s.connections[0].status === 'closed', 'disconnected');
  await menu(rightClick(1), ['Open Link', 'Open in New Browser Session (disabled)', 'Open in Browser', 'Open in External Browser', '-', 'Copy Link']);
  await copied(osc);
  assert.deepEqual(errors, []);
  console.log('Choosing a closed session reports an error, a closed first session falls back to the remaining one, and a disconnected terminal still offers its links for existing sessions and copying.');

  // Tabs of a session of its own, shown in the window.
  await api('reconnect', connection);
  await waitState(s => s.connections[0].status === 'connected', 'reconnected');
  const tools = await api('newBrowser', connection);
  const tabsOf = s => s.workspaces.find(w => w.id === tools)?.tabs ?? [];
  const toolsState = async predicate => tabsOf(await waitState(s => predicate(tabsOf(s), s.workspaces.find(w => w.id === tools)), 'tools session'));
  const [blankTab] = await toolsState(tabs => tabs.length === 1);
  const address = page.getByRole('combobox', { name: 'Address', exact: true });
  const tabRow = id => page.locator(`.nav-item[data-kind="tab"][data-id="${id}"]`);
  await tabRow(blankTab.id).click();
  await expect(address).toBeFocused();
  /** Runs a function in the main process with the page on show. */
  const visible = (action, argument) => application.evaluate(({ BrowserWindow }, { action, argument }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const contents = window.contentView.children.find(view => view.getVisible() && view.webContents !== window.webContents && /^(https?|view-source):/.test(view.webContents.getURL()))?.webContents;
    return new Function('contents', 'argument', `return (${action})(contents, argument)`)(contents, argument);
  }, { action: action.toString(), argument });
  const pageFocused = () => visible(contents => contents?.isFocused() ?? false);
  /** Runs a function in the main process with each page at an address. */
  const at = (url, action) => application.evaluate(({ webContents }, { url, action }) =>
    Promise.all(webContents.getAllWebContents().filter(contents => contents.getURL() === url).map(contents => new Function('contents', `return (${action})(contents)`)(contents))), { url, action: action.toString() });
  const pageMenu = page.getByRole('button', { name: 'Page Menu', exact: true });
  /** Presses keys in the page on show, once one is. */
  const pageKey = (keyCode, modifiers = []) => waitFor(() => visible((contents, input) => {
    if (!contents) return false;
    contents.sendInputEvent({ type: 'keyDown', ...input }); contents.sendInputEvent({ type: 'keyUp', ...input });
    return true;
  }, { keyCode, modifiers }), 'a page on show');
  const overlay = selector => waitFor(async () => { for (const candidate of application.windows()) if (candidate !== page && await candidate.evaluate(selector => document.documentElement.classList.contains('overlay') && document.querySelector(selector) !== null, selector).catch(() => false)) return candidate; }, `overlay with ${selector}`);

  // Suggestions
  const suggestionsView = await overlay('.address-suggestions');
  const suggested = () => suggestionsView.locator('.address-suggestion').allTextContents();
  await expect.poll(suggested).toEqual(expect.arrayContaining([plain, osc, pageLink]));
  await address.fill('/os');
  await expect.poll(() => suggested()).toEqual([osc]);
  await address.press('ArrowDown');
  await expect(address).toHaveAttribute('aria-activedescendant', 'address-suggestion-0');
  await expect(page.locator('#address-suggestion-0')).toHaveAttribute('aria-selected', 'true');
  await expect(suggestionsView.locator('.address-suggestion').first()).toHaveAttribute('data-highlighted', 'true');
  await address.press('Escape');
  await expect.poll(() => suggestionsView.locator('.address-suggestion').count()).toBe(0);
  await expect(address).toHaveValue('/os');
  await address.press('ArrowDown');
  await expect.poll(() => suggested()).toEqual([osc]);
  await address.press('ArrowDown');
  await address.press('Enter');
  const [firstTab] = await toolsState(tabs => tabs[0]?.url === osc && !tabs[0].loading);
  await expect.poll(pageFocused, 'a chosen suggestion gives the page the keyboard').toBe(true);
  await address.focus();
  await address.fill('/plain');
  await expect.poll(() => suggested()).toEqual([plain]);
  await suggestionsView.locator('.address-suggestion').click();
  await toolsState(tabs => tabs[0].url === plain && !tabs[0].loading);
  await expect.poll(() => suggestionsView.locator('.address-suggestion').count()).toBe(0);
  await address.focus();
  await address.fill('/os');
  await expect.poll(() => suggested()).toEqual([osc]);
  await address.press('Tab');
  await expect(address).not.toBeFocused();
  await expect.poll(() => suggestionsView.locator('.address-suggestion').count()).toBe(0);
  console.log('Address suggests the connection\'s history, filtered by the text; keys and the pointer choose one.');

  // The address field's draft
  await address.fill('foo bar');
  await address.press('Enter');
  await expect(page.locator('.browser-error')).toBeVisible();
  await expect(address).toHaveValue('foo bar');
  // Typing leaves the error in place, so the typing undoes in one step.
  const refusal = await page.locator('.browser-error').textContent();
  await address.press('End');
  await page.keyboard.type(' baz');
  await expect(address).toHaveValue('foo bar baz');
  assert.equal(await page.locator('.browser-error').textContent(), refusal);
  await address.press('Control+z');
  await expect(address).toHaveValue('foo bar');
  await address.fill(`${origin}/slow`);
  await address.press('Enter');
  await toolsState(tabs => tabs[0].url === `${origin}/slow` && tabs[0].loading);
  await expect(page.locator('.browser-error')).toBeHidden();
  await expect(address).toHaveValue(`${origin}/slow`);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await toolsState(tabs => tabs[0].url === plain && !tabs[0].loading);
  await expect(address).toHaveValue(plain);
  await address.fill('left behind');
  await address.evaluate(node => node.blur());
  await api('browser', tools, 'navigate', firstTab.id, pageLink);
  await toolsState(tabs => tabs[0].url === pageLink && !tabs[0].loading);
  await expect(address).toHaveValue(pageLink);
  await api('browser', tools, 'navigate', firstTab.id, `${origin}/data.json`);
  await toolsState(tabs => tabs[0].title === `${new URL(origin).host}/data.json`);
  // A refused address's error gives way once the tab moves on, so a page that then fails to load shows its own.
  await address.fill('foo bar');
  await address.press('Enter');
  await expect(page.locator('.browser-error')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeHidden();
  await api('browser', tools, 'navigate', firstTab.id, 'http://127.0.0.1:1/');
  await toolsState(tabs => tabs[0].error && !tabs[0].loading);
  await expect(page.locator('.browser-error')).toContainText("Couldn't Load Page");
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await api('browser', tools, 'navigate', firstTab.id, `${origin}/data.json`);
  await toolsState(tabs => tabs[0].title === `${new URL(origin).host}/data.json` && !tabs[0].error && !tabs[0].loading);
  await expect(page.locator('.browser-error')).toBeHidden();
  console.log('A refused address stays in the field with its error until the tab moves on, a loading address shows until Stop, a draft gives way to navigation, and a page without a title is named by its address.');

  // The address field's menu
  await address.click({ button: 'right' });
  await expect.poll(async () => (await app.menu.labels())?.map(label => label.replace(' (disabled)', ''))).toEqual(['Undo', 'Redo', '-', 'Cut', 'Copy', 'Paste', 'Paste and Go', 'Delete', '-', 'Select All', '-', 'Copy Address']);
  await application.evaluate(({ clipboard }) => clipboard.writeText(''));
  await choose('Copy Address');
  await expect.poll(clipboard).toBe(`${origin}/data.json`);
  await application.evaluate(({ clipboard }, url) => clipboard.writeText(`  ${url}\n`), pageLink);
  await address.click({ button: 'right' });
  await expect.poll(async () => (await app.menu.labels())?.includes('Paste and Go')).toBe(true);
  await choose('Paste and Go');
  await toolsState(tabs => tabs[0].url === pageLink && !tabs[0].loading);
  // The field keeps its selection while its menu is open, and Copy acts on it.
  await address.focus();
  await page.waitForTimeout(100);
  await address.evaluate(field => field.setSelectionRange(0, 4));
  await address.press('Shift+F10');
  await expect.poll(async () => (await app.menu.labels())?.includes('Copy')).toBe(true);
  await choose('Copy');
  await expect.poll(clipboard).toBe(pageLink.slice(0, 4));
  await expect(address).toBeFocused();
  await page.waitForTimeout(100);
  assert.deepEqual(await address.evaluate(field => [field.selectionStart, field.selectionEnd]), [0, 4]);
  await pageMenu.click();
  await choose('Find in Page');
  const findField = page.getByRole('textbox', { name: 'Find in Page', exact: true });
  await expect(findField).toBeFocused();
  await findField.fill('Page');
  await menu(() => findField.click({ button: 'right' }), ['Undo', 'Redo (disabled)', '-', 'Cut (disabled)', 'Copy (disabled)', 'Paste', 'Delete (disabled)', '-', 'Select All']);
  await choose('Select All');
  await expect.poll(() => findField.evaluate(field => field.selectionEnd - field.selectionStart)).toBe(4);
  await findField.press('Escape');
  console.log('Text fields have an editing menu; the address field\'s also pastes and goes and copies the address.');

  // Popups and background tabs
  await page.evaluate(() => { window.rigTabs = []; });
  const linkPoint = () => visible(contents => contents.executeJavaScript('(() => { const r = document.querySelector("a").getBoundingClientRect(); return { x: Math.round(r.x + 10), y: Math.round(r.y + r.height / 2) }; })()'));
  const linkAt = await linkPoint();
  // Each click opens one background tab, apart from the limit on popups.
  const controlClick = () => visible((contents, point) => { for (const type of ['mouseDown', 'mouseUp']) contents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1, modifiers: ['control'] }); }, linkAt);
  await controlClick();
  await toolsState(tabs => tabs.length === 2);
  await controlClick();
  let tabs = await toolsState(tabs => tabs.length === 3);
  assert.deepEqual(tabs.map(tab => tab.url), [pageLink, pageLink, pageLink]);
  assert.equal((await app.state()).workspaces.find(w => w.id === tools).activeTab, firstTab.id);
  assert.equal(await pageFocused(), true);
  const opened = await visible(contents => contents.executeJavaScript(`(() => {
    addEventListener('message', event => { window.rigMessage = event.data; });
    const popup = window.open('about:blank');
    popup.location = location.origin + '/target';
    return [popup !== null, window.open(location.origin + '/flood') === null];
  })()`, true));
  assert.deepEqual(opened, [true, true]);
  tabs = await toolsState(tabs => tabs.length === 4 && tabs[3].url === `${origin}/target` && !tabs[3].loading);
  assert.equal((await app.state()).workspaces.find(w => w.id === tools).activeTab, tabs[3].id);
  await at(`${origin}/target`, contents => contents.executeJavaScript('window.opener.postMessage("from popup", "*")'));
  await expect.poll(async () => (await at(pageLink, contents => contents.executeJavaScript('window.rigMessage ?? null'))).filter(Boolean)).toEqual(['from popup']);
  // A popup to an address with credentials is refused, and a blank one shows what it is until its opener sends it on.
  await page.waitForTimeout(1100);
  const [refused] = await at(`${origin}/target`, contents => contents.executeJavaScript('[window.open("http://user@" + location.host + "/") === null, (window.rigBlank = window.open()) !== null]'));
  assert.deepEqual(refused, [true, true]);
  await toolsState(tabs => tabs.length === 5 && tabs[4].url === 'about:blank');
  await expect(address).toHaveValue('about:blank');
  await at(`${origin}/target`, contents => contents.executeJavaScript('rigBlank.close()'));
  await toolsState(tabs => tabs.length === 4);
  console.log('Ctrl+click opens links as background tabs without the popup limit, and window.open returns a popup tab that keeps its opener.');

  // Shortcuts
  await tabRow(firstTab.id).click();
  await expect.poll(pageFocused, 'selecting a tab with a page gives the page the keyboard').toBe(true);
  await pageKey('Tab', ['control']);
  await toolsState((tabs, w) => w.activeTab === tabs[1].id);
  await expect.poll(pageFocused).toBe(true);
  await pageKey('PageUp', ['control']);
  await toolsState((tabs, w) => w.activeTab === tabs[0].id);
  await pageKey('Tab', ['control', 'shift']);
  await toolsState((tabs, w) => w.activeTab === tabs[3].id);
  await pageKey('W', ['control']);
  tabs = await toolsState(tabs => tabs.length === 3);
  await toolsState((tabs, w) => w.activeTab === tabs[2].id && w.closedTabs === 1);
  await pageKey('T', ['control', 'shift']);
  tabs = await toolsState(tabs => tabs.length === 4 && tabs[3].url === `${origin}/target`);
  await toolsState((tabs, w) => w.activeTab === tabs[3].id && w.closedTabs === 0);
  await pageKey('T', ['control']);
  tabs = await toolsState(tabs => tabs.length === 5);
  await expect(address).toBeFocused();
  await page.keyboard.press('Control+w');
  tabs = await toolsState(tabs => tabs.length === 4);
  await address.focus();
  await page.keyboard.press('Control+PageDown');
  await toolsState((tabs, w) => w.activeTab === tabs[0].id);
  await page.keyboard.press('Control+t');
  await toolsState(tabs => tabs.length === 5);
  await page.keyboard.press('Control+Shift+t');
  await toolsState(tabs => tabs.length === 5);
  await page.keyboard.press('Control+w');
  await toolsState(tabs => tabs.length === 4);
  await showTerminal();
  await page.locator('.terminal-surface:not([hidden]) textarea').focus();
  const inputs = await application.evaluate(() => globalThis.rigInputs.length);
  await page.keyboard.press('Control+w');
  await expect.poll(() => application.evaluate((_, from) => globalThis.rigInputs.slice(from), inputs)).toContain('\x17');
  await page.waitForTimeout(300);
  assert.equal(tabsOf(await app.state()).length, 4);
  console.log('Tab shortcuts open, close, reopen and cycle tabs from the page and the application, and leave a terminal its keys.');

  // Tab order decides the tab that takes a closed tab's place, and the tab menu
  const [a, b, c, d] = tabsOf(await app.state());
  await tabRow(b.id).click({ button: 'right' });
  await choose('Move Up');
  await expect.poll(() => page.locator(`.nav-item[data-kind="tab"][data-workspace="${tools}"]`).evaluateAll(nodes => nodes.map(node => node.dataset.id))).toEqual([b.id, a.id, c.id, d.id]);
  await tabRow(a.id).click();
  await pageKey('W', ['control']);
  await toolsState((tabs, w) => tabs.length === 3 && w.activeTab === c.id);
  await tabRow(b.id).click({ button: 'right' });
  await expect.poll(() => app.menu.labels()).toEqual(['Reload', 'Duplicate Tab', 'Copy Address', 'Open in External Browser', '-', 'Mute Tab', '-', 'Close Tab', 'Close Other Tabs', 'Close Tabs Below', 'Reopen Closed Tab', '-', 'Move Up (disabled)', 'Move Down']);
  await application.evaluate(({ clipboard }) => clipboard.writeText(''));
  await choose('Copy Address');
  await expect.poll(clipboard).toBe(b.url);
  await tabRow(b.id).click({ button: 'right' });
  await choose('Duplicate Tab');
  tabs = await toolsState(tabs => tabs.length === 4);
  assert.equal(tabs[3].url, b.url);
  await tabRow(c.id).click({ button: 'right' });
  await choose('Open in External Browser');
  await expect.poll(() => application.evaluate(() => globalThis.rigExternal.at(-1))).toBe(c.url);
  await tabRow(c.id).click({ button: 'right' });
  await choose('Close Tabs Below');
  await toolsState(tabs => tabs.length === 2);
  await tabRow(b.id).click({ button: 'right' });
  await choose('Reopen Closed Tab');
  await toolsState(tabs => tabs.length === 3);
  await tabRow(b.id).click({ button: 'right' });
  await choose('Close Other Tabs');
  await toolsState((tabs, w) => tabs.length === 1 && w.activeTab === b.id);
  console.log('A closed tab gives way to its neighbour in the order shown, and the tab menu reloads, duplicates, copies, opens elsewhere, closes and reopens tabs.');

  // Page menu
  await tabRow(b.id).click();
  await api('browser', tools, 'navigate', b.id, `${origin}/cookie`);
  await toolsState(tabs => tabs[0].url === `${origin}/cookie` && !tabs[0].loading);
  const rightClickBody = () => visible(contents => { for (const type of ['mouseDown', 'mouseUp']) contents.sendInputEvent({ type, x: 300, y: 300, button: 'right', clickCount: 1 }); });
  await menu(rightClickBody, ['Back', 'Forward (disabled)', 'Reload', '-', 'Copy Page Address', 'Open Page in External Browser', '-', 'Save as PDF…', 'Print…', '-', 'View Page Source', 'Inspect Element']);
  await application.evaluate(({ clipboard }) => clipboard.writeText(''));
  await choose('Copy Page Address');
  await expect.poll(clipboard).toBe(`${origin}/cookie`);
  await menu(rightClickBody, ['Back', 'Forward (disabled)', 'Reload', '-', 'Copy Page Address', 'Open Page in External Browser', '-', 'Save as PDF…', 'Print…', '-', 'View Page Source', 'Inspect Element']);
  await choose('Open Page in External Browser');
  await expect.poll(() => application.evaluate(() => globalThis.rigExternal.at(-1))).toBe(`${origin}/cookie`);
  await menu(rightClickBody, ['Back', 'Forward (disabled)', 'Reload', '-', 'Copy Page Address', 'Open Page in External Browser', '-', 'Save as PDF…', 'Print…', '-', 'View Page Source', 'Inspect Element']);
  await choose('View Page Source');
  tabs = await toolsState((tabs, w) => tabs.length === 2 && w.activeTab === tabs[1].id && tabs[1].url === `view-source:${origin}/cookie` && !tabs[1].loading);
  await api('browser', tools, 'close', tabs[1].id);
  await toolsState(tabs => tabs.length === 1);
  await expect.poll(() => visible(contents => contents?.getURL())).toBe(`${origin}/cookie`);
  await menu(rightClickPage, ['Open Link', 'Open Link in New Tab', 'Open in New Browser Session', 'Open in Browser', 'Open in External Browser', '-', 'Copy Link', '-', 'Inspect Element']);
  await choose('Open Link in New Tab');
  tabs = await toolsState(tabs => tabs.length === 2 && tabs[1].url === pageLink);
  assert.equal((await app.state()).workspaces.find(w => w.id === tools).activeTab, b.id);
  await api('browser', tools, 'close', tabs[1].id);
  console.log('A page menu copies, opens elsewhere and shows the source of its page, and opens a link in a background tab.');

  // System links
  await api('browser', tools, 'navigate', b.id, `${origin}/system`);
  await toolsState(tabs => tabs[0].url === `${origin}/system` && !tabs[0].loading);
  /** Clicks, or right-clicks, an element of the page or of its frame. */
  const press = (selector, button = 'left') => visible(async (contents, { selector, button }) => {
    const { x, y } = await contents.executeJavaScript(`(() => {
      const frame = document.querySelector('iframe'), target = document.querySelector(${JSON.stringify(selector)}) ?? frame.contentDocument.querySelector(${JSON.stringify(selector)});
      const r = target.getBoundingClientRect(), offset = target.ownerDocument === document ? { x: 0, y: 0 } : frame.getBoundingClientRect();
      return { x: Math.round(offset.x + r.x + 10), y: Math.round(offset.y + r.y + r.height / 2) };
    })()`);
    for (const type of ['mouseDown', 'mouseUp']) contents.sendInputEvent({ type, x, y, button, clickCount: 1 });
  }, { selector, button });
  // Each question the main process asks reaches the page as an event, and shows in the modal overlay.
  await page.evaluate(() => { window.rigQuestions = []; window.bartizan.onEvent(event => { if (event.type === 'question') window.rigQuestions.push(event.question); }); });
  const dialogs = await app.modal(), question = dialogs.locator('#question-dialog');
  const prompted = async detail => {
    await expect(question).toBeVisible();
    await expect(dialogs.locator('dialog[open]')).toHaveCount(1);
    await expect(question.getByRole('heading')).toHaveText('Open in Another Application?');
    await expect(question.locator('#question-detail')).toHaveText(detail);
    assert.deepEqual(await question.getByRole('button').allTextContents(), ['Cancel', 'Open']);
    await expect(question.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  };
  /** Answers Open, Cancel, or with Escape, once the dialog takes clicks. */
  const answer = async response => {
    await page.waitForTimeout(600);
    if (response === 'Escape') await dialogs.keyboard.press('Escape');
    else await question.getByRole('button', { name: response === 0 ? 'Open' : 'Cancel', exact: true }).click();
    await expect(question).toBeHidden();
  };
  const handed = async () => (await readFile(openedFile, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const quiet = async (count, message) => { await page.waitForTimeout(400); assert.equal(await page.evaluate(() => window.rigQuestions.length), count, message); };
  const mailto = 'mailto:someone@example.com?subject=Hello';
  // A click asks first, with the link as it will open; a second request while it asks is dropped, and Open hands over
  // exactly that address.
  // A click as the question appears, as the end of a double-click meant for the page, does nothing and leaves the keyboard
  // on Cancel. The overlay notes when the question opened and when the press came, so a press too late to test that fails.
  await dialogs.evaluate(() => {
    window.rigTiming = {};
    new MutationObserver(() => { if (document.querySelector('#question-dialog[open]')) window.rigTiming.opened ??= performance.now(); })
      .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    document.addEventListener('mousedown', event => { window.rigTiming.pressed ??= event.timeStamp; }, true);
  });
  await press('#mailto');
  const early = question.getByRole('button', { name: 'Open', exact: true });
  await early.waitFor();
  const box = await early.boundingBox();
  await dialogs.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const timing = await dialogs.evaluate(() => window.rigTiming), delay = timing.pressed - timing.opened;
  assert.ok(delay < 450, `The press came ${Math.round(delay)} ms after the question opened, too late to test that early clicks do nothing`);
  await prompted(mailto);
  assert.deepEqual(await handed(), []);
  await press('#sms');
  await quiet(1, 'A tab asks one question at a time');
  await answer(0);
  await expect.poll(handed).toEqual([`[${mailto}]`]);
  // Cancel hands over nothing and keeps the page from asking again until the user acts in it.
  await press('#sms');
  await prompted('sms:+15550100');
  await answer(1);
  await visible(contents => contents.executeJavaScript('location.href = "mailto:script@example.com"'));
  await quiet(2, 'A tab that was answered Cancel asks nothing more');
  await page.waitForTimeout(1100);
  // A page that had the keyboard takes it back.
  await visible(contents => contents.focus());
  await expect.poll(pageFocused).toBe(true);
  await press('#tel');
  await prompted('tel:+15550100');
  await answer(0);
  await expect.poll(pageFocused).toBe(true);
  await expect.poll(handed).toEqual([`[${mailto}]`, '[tel:+15550100]']);
  // A tab that is not on show asks nothing.
  await api('browser', tools, 'new', undefined, pageLink);
  const [, front] = await toolsState((tabs, w) => tabs.length === 2 && w.activeTab === tabs[1].id && !tabs[1].loading);
  await at(`${origin}/system`, contents => contents.executeJavaScript('location.href = "mailto:hidden@example.com"'));
  await quiet(3, 'A tab not on show asks nothing');
  await api('browser', tools, 'close', front.id);
  await toolsState((tabs, w) => tabs.length === 1 && w.activeTab === b.id);
  // A page asks the same for a link it opens itself; other schemes ask nothing.
  await visible(contents => contents.executeJavaScript('location.href = "mailto:script@example.com?attachment=/etc/hostname"'));
  await prompted('mailto:script@example.com');
  await answer(0);
  await press('#file');
  await press('#custom');
  await quiet(4, 'Other schemes ask nothing');
  // An opener that fails says so.
  await application.evaluate(() => { process.env.RIG_OPEN_EXIT = '4'; });
  await page.evaluate(() => window.bartizan.clearErrors());
  await press('#mailto');
  await prompted(mailto);
  await answer(0);
  await waitFor(() => page.evaluate(() => window.rigErrors?.some(entry => entry.source === 'link' && entry.message.includes('No application opens mailto: links'))), 'failed opener');
  await application.evaluate(() => { delete process.env.RIG_OPEN_EXIT; });
  // The link's menu offers Open Link, which asks the same, only where xdg-open is on PATH.
  await application.evaluate((_, empty) => { process.env.PATH = empty; }, empty);
  await menu(() => press('#mailto', 'right'), ['Copy Link', '-', 'Inspect Element']);
  await copied('mailto:someone@example.com?subject=Hello&attach=/etc/hostname');
  await application.evaluate((_, opener) => { process.env.PATH = opener; }, opener);
  await menu(() => press('#mailto', 'right'), ['Open Link', 'Copy Link', '-', 'Inspect Element']);
  await choose('Open Link');
  await prompted(mailto);
  await answer(0);
  await expect.poll(async () => (await handed()).length).toBe(5);
  assert.deepEqual(await handed(), [`[${mailto}]`, '[tel:+15550100]', '[mailto:script@example.com]', `[${mailto}]`, `[${mailto}]`]);
  // Escape cancels too; a question about a tab that closes goes with it.
  await api('browser', tools, 'new', undefined, pageLink);
  const [, doomed] = await toolsState((tabs, w) => tabs.length === 2 && w.activeTab === tabs[1].id && !tabs[1].loading);
  await expect.poll(() => visible(contents => contents?.getURL())).toBe(pageLink);
  // A field of the application that had the keyboard takes it back.
  await address.focus();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.focus());
  await visible(contents => contents.executeJavaScript('location.href = "mailto:closing@example.com"'));
  await prompted('mailto:closing@example.com');
  await answer('Escape');
  await expect(address).toBeFocused();
  assert.equal(await pageFocused(), false);
  const asked = await page.evaluate(() => window.rigQuestions.length);
  await visible(contents => contents.executeJavaScript('location.href = "mailto:closing@example.com"'));
  await quiet(asked, 'A tab that was answered Escape asks nothing more');
  await visible(contents => { for (const type of ['mouseDown', 'mouseUp']) contents.sendInputEvent({ type, x: 5, y: 5, button: 'left', clickCount: 1 }); });
  await page.waitForTimeout(1100);
  await visible(contents => contents.executeJavaScript('location.href = "mailto:closing@example.com"'));
  await prompted('mailto:closing@example.com');
  await api('browser', tools, 'close', doomed.id);
  await expect(question).toBeHidden();
  await toolsState((tabs, w) => tabs.length === 1 && w.activeTab === b.id);
  await page.waitForTimeout(300);
  assert.equal((await handed()).length, 5);
  await api('browser', tools, 'navigate', b.id, `${origin}/cookie`);
  await toolsState(tabs => tabs[0].url === `${origin}/cookie` && !tabs[0].loading);
  console.log('mailto:, tel: and sms: links ask before they open in another application, with only a mail link\'s recipients, subject and body; only the tab on show asks, once at a time and not after Cancel, a closed tab\'s question goes, and a failing opener reports it.');

  // Page tools
  const screenshot = join(directory, 'page.png');
  await application.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async (_window, options) => { globalThis.rigSaveOptions = options; return { canceled: false, filePath: path }; }; }, screenshot);
  await visible(contents => contents.executeJavaScript('localStorage.setItem("site", "1")'));
  await pageMenu.click();
  await choose('Save Screenshot…');
  await waitFor(async () => (await readFile(screenshot).catch(() => Buffer.alloc(0))).subarray(1, 4).toString() === 'PNG', 'saved screenshot');
  const saveOptions = await application.evaluate(({ app }) => ({ path: globalThis.rigSaveOptions.defaultPath, downloads: app.getPath('downloads') }));
  assert.equal(saveOptions.path, join(saveOptions.downloads, 'Fixture cookie.png'));
  const siteData = () => visible(async contents => ({ cookies: (await contents.session.cookies.get({})).map(cookie => cookie.name), storage: await contents.executeJavaScript('localStorage.getItem("site")') }));
  assert.deepEqual(await siteData(), { cookies: ['site'], storage: '1' });
  const loads = requests.length;
  await pageMenu.click();
  await choose('Clear Site Data');
  await waitFor(() => requests.length > loads, 'reloaded page');
  await toolsState(tabs => !tabs[0].loading);
  // The reloaded page sets its cookie again.
  await expect.poll(siteData).toEqual({ cookies: ['site'], storage: null });
  console.log('Save Screenshot saves the page as a PNG named after it in Downloads, and Clear Site Data clears the site\'s storage and reloads it.');

  // Clipboard
  await visible(contents => contents.focus());
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
  assert.equal(await visible(contents => contents.executeJavaScript('navigator.clipboard.writeText("from page").then(() => "written", error => error.name)', true)), 'written');
  await expect.poll(clipboard).toBe('from page');
  assert.equal(await visible(contents => contents.executeJavaScript('navigator.clipboard.readText().then(() => "read", error => error.name)', true)), 'NotAllowedError');
  console.log('A page writes to the clipboard but cannot read it.');

  // A crashed page
  await visible(contents => process.kill(contents.getOSProcessId(), 'SIGKILL'));
  await expect(page.locator('.browser-error')).toContainText("Couldn't Load Page");
  await expect(page.locator('.browser-error')).toContainText('Page crashed');
  await page.locator('.browser-error').getByRole('button', { name: 'Retry', exact: true }).click();
  await toolsState(tabs => !tabs[0].loading && !tabs[0].error && tabs[0].title === 'Fixture /cookie');
  await expect(page.locator('.browser-error')).toBeHidden();
  console.log('A crashed page shows the load error with Retry, which loads it again.');

  // A page that asks before it is left keeps its tab unless the user leaves it.
  await api('browser', tools, 'new', undefined, `${origin}/unload`);
  tabs = await toolsState(tabs => tabs.length === 2 && tabs[1].title === 'Unload' && !tabs[1].loading);
  // The rig's driver would answer the page's question itself; here the application asks.
  (await waitFor(() => application.windows().find(candidate => candidate.url() === `${origin}/unload`), 'the page that asks')).on('dialog', () => {});
  await at(`${origin}/unload`, contents => { for (const type of ['mouseDown', 'mouseUp']) contents.sendInputEvent({ type, x: 5, y: 5, button: 'left', clickCount: 1 }); });
  const closeTab = page.getByRole('button', { name: 'Close Tab', exact: true }).first();
  await closeTab.click();
  await expect(question).toBeVisible();
  await expect(question.getByRole('heading')).toHaveText('Leave Page?');
  await expect(question.locator('#question-detail')).toHaveText('Unload');
  assert.deepEqual(await question.getByRole('button').allTextContents(), ['Stay', 'Leave']);
  await expect(question.getByRole('button', { name: 'Leave', exact: true })).toBeFocused();
  // Closing again while it asks shares the one question.
  const again = api('browser', tools, 'close', tabs[1].id);
  await page.waitForTimeout(600);
  await expect(dialogs.locator('dialog[open]')).toHaveCount(1);
  await question.getByRole('button', { name: 'Stay', exact: true }).click();
  await expect(question).toBeHidden();
  await again;
  await expect(closeTab).toBeFocused();
  assert.equal(tabsOf(await app.state()).length, 2);
  // Escape stays too, and a renderer that reloads while it asks leaves the page open.
  await closeTab.click();
  await expect(question).toBeVisible();
  await dialogs.keyboard.press('Escape');
  await expect(question).toBeHidden();
  await page.waitForTimeout(300);
  assert.equal(tabsOf(await app.state()).length, 2);
  const questions = await page.evaluate(() => window.rigQuestions.length);
  const unanswered = api('browser', tools, 'close', tabs[1].id).catch(() => {});
  await page.waitForFunction(count => window.rigQuestions.length > count, questions);
  await page.reload();
  await unanswered;
  await page.waitForTimeout(300);
  assert.equal(tabsOf(await app.state()).length, 2);
  await page.evaluate(() => { window.rigQuestions = []; window.bartizan.onEvent(event => { if (event.type === 'question') window.rigQuestions.push(event.question); }); });
  const closing = api('browser', tools, 'close', tabs[1].id);
  await page.waitForFunction(() => window.rigQuestions.length === 1);
  const reloaded = (await app.modal()).locator('#question-dialog');
  await expect(reloaded).toBeVisible();
  await page.waitForTimeout(600);
  await reloaded.getByRole('button', { name: 'Leave', exact: true }).click();
  await closing;
  await toolsState(tabs => tabs.length === 1);
  await app.chooseConnection(connection);
  await tabRow(b.id).click();
  console.log('Closing a page that asks first offers Leave and Stay in a dialog, which concurrent closes share; only Leave closes it, and a reload stays.');

  // Offline pages load again once the connection is back.
  await api('browser', tools, 'navigate', b.id, `${origin}/form`);
  await toolsState(tabs => tabs[0].title === 'Form' && !tabs[0].loading);
  await api('browser', tools, 'new', undefined, `${origin}/loaded`);
  tabs = await toolsState(tabs => tabs.length === 2 && tabs[1].title === 'Fixture /loaded' && !tabs[1].loading);
  await api('browser', tools, 'new');
  tabs = await toolsState(tabs => tabs.length === 3);
  await api('disconnect', connection);
  await waitState(s => s.connections[0].status === 'closed', 'disconnected');
  await api('browser', tools, 'select', b.id);
  await at(`${origin}/form`, contents => contents.executeJavaScript('document.forms[0].submit()'));
  await toolsState(tabs => tabs[0].error && !tabs[0].loading);
  await api('browser', tools, 'navigate', tabs[2].id, `${origin}/offline`);
  await toolsState(tabs => tabs[2].error && !tabs[2].loading);
  const before = requests.length;
  await api('reconnect', connection);
  await toolsState(tabs => tabs[2].title === 'Fixture /offline' && !tabs[2].error && !tabs[2].loading);
  await page.waitForTimeout(1000);
  assert.deepEqual(requests.slice(before).filter(url => url !== '/favicon.ico'), ['/offline']);
  assert.deepEqual(posts, []);
  assert.ok(tabsOf(await app.state())[0].error, 'a form that is not sent again keeps its error');
  assert.deepEqual(errors, []);
  console.log('Reconnecting loads again the pages that failed while offline, without sending a form again or reloading loaded pages.');
});
