import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { withDirectory, startSshd, sshProfile, launch, waitFor } from './lib/harness.mjs';

await withDirectory('links', async (directory, cleanup) => {
  const http = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<title>Fixture ${request.url}</title><a href="/page" style="font-size: 40px">Page link</a>`);
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  cleanup(() => { http.closeAllConnections(); http.close(); });
  const origin = `http://127.0.0.1:${http.address().port}`;
  const plain = `${origin}/plain?q=one#part`, osc = `${origin}/osc`, pageLink = `${origin}/page`;
  // A plain shell keeps the screen to what the rig prints.
  const sshd = await startSshd(directory, { config: 'ForceCommand /bin/sh\n' });
  cleanup(sshd.stop);
  const config = join(directory, 'config.yaml');
  await writeFile(config, `version: 1\nprofiles:\n  rig:\n    label: Fixture\n${sshProfile(sshd)}`);
  const app = await launch(directory, config);
  cleanup(app.close);
  const { application, page, api, waitState, recordOutput, output, errors } = app;
  // An xdg-open on PATH makes the external browser available; opening it is recorded instead.
  const bin = join(directory, 'bin'), empty = join(directory, 'empty');
  await mkdir(bin);
  await mkdir(empty);
  await writeFile(join(bin, 'xdg-open'), '#!/bin/sh\n');
  await chmod(join(bin, 'xdg-open'), 0o755);
  const opener = await application.evaluate((_, bin) => { process.env.PATH = `${bin}:${process.env.PATH}`; return process.env.PATH; }, bin);
  await application.evaluate(({ Menu, ipcMain, shell }) => {
    globalThis.rigMenus = [];
    Menu.prototype.popup = function () { globalThis.rigMenus.push(this); };
    globalThis.rigInputs = [];
    const request = ipcMain._invokeHandlers.get('request');
    ipcMain._invokeHandlers.set('request', (event, message) => { if (message.method === 'input') globalThis.rigInputs.push(message.args[1]); return request(event, message); });
    globalThis.rigExternal = [];
    shell.openExternal = async url => { globalThis.rigExternal.push(url); };
  });
  await page.evaluate(() => window.bartizan.onEvent(event => { if (event.type === 'errors') window.rigErrors = event.log.history; }));
  const menuCount = () => application.evaluate(() => globalThis.rigMenus.length);
  /** Opens a menu and checks the items of the menu it shows. */
  const menu = async (open, expected) => {
    const count = await menuCount();
    await open();
    await expect.poll(() => application.evaluate((_, count) => globalThis.rigMenus[count]?.items.map(item => item.type === 'separator' ? '-' : item.enabled ? item.label : `${item.label} (disabled)`), count)).toEqual(expected);
  };
  const choose = label => application.evaluate((_, label) => globalThis.rigMenus.at(-1).items.find(item => item.label === label).click(), label);
  const clipboard = () => application.evaluate(({ clipboard }) => clipboard.readText());
  const copied = async url => {
    await application.evaluate(({ clipboard }) => clipboard.writeText(''));
    await choose('Copy Link');
    await expect.poll(clipboard).toBe(url);
  };
  const noMenu = async open => {
    const count = await menuCount();
    await open();
    await page.waitForTimeout(300);
    assert.equal(await menuCount(), count);
  };
  const reports = () => application.evaluate(() => globalThis.rigInputs.filter(data => data.startsWith('\x1b[<')));

  await recordOutput();
  const connection = await api('connect', { profileId: 'rig' });
  const terminal = (await waitState(s => s.terminals[0]?.status === 'connected', 'terminal')).terminals[0].id;
  await waitFor(async () => (await output(terminal)).includes('$ '), 'shell prompt');
  const showTerminal = async () => {
    await page.locator(`.nav-item[data-kind="terminal"][data-id="${terminal}"]`).click();
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-screen')).toBeVisible();
  };
  await showTerminal();
  const newBrowserTab = page.locator('.titlebar').getByRole('button', { name: 'New Browser Tab', exact: true });
  await newBrowserTab.click();
  const blank = (await waitState(s => s.workspaces.length === 1 && s.workspaces[0].tabs.length === 1, 'session from the title bar')).workspaces[0];
  await api('browser', blank.id, 'close-workspace');
  await waitState(s => !s.workspaces.length, 'title bar session closed');
  await showTerminal();
  console.log('New Browser Tab opens a new session when the connection has none.');
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

  await show(`${plain}\r\n\x1b]8;;${osc}\x07Linked label\x1b]8;;\x07\x1b[?1000h\x1b[?1006h`);
  await noMenu(rightClick(5, false));
  await expect.poll(reports).toHaveLength(2);
  await menu(rightClick(0), single);
  await copied(plain);
  await menu(rightClick(1), single);
  await copied(osc);
  assert.equal((await reports()).length, 2);
  await page.mouse.move(0, 0);
  await menu(shiftF10, [plain, osc]);
  const submenus = await application.evaluate(() => globalThis.rigMenus.at(-1).items.map(item => item.submenu.items.map(entry => entry.label)));
  assert.deepEqual(submenus.map(items => items.at(-1)), ['Copy Link', 'Copy Link']);
  console.log('With remote mouse reporting on, right clicks on plain and OSC 8 links open the link menu without reaching the remote side, and Shift+F10 offers every link on screen.');

  await show(`\x1b[?1000l\x1b[?1006l\x1b]8;;https://user:secret@example.invalid/\x07credentials link\x1b]8;;\x07\r\n\x1b]8;;javascript:alert(1)\x07script link\x1b]8;;\x07\r\n\x1b]8;;https://example.invalid/${'x'.repeat(8200)}\x07long link\x1b]8;;\x07\r\nftp://example.invalid/file`);
  for (const [row, link] of [[0, true], [1, false], [2, true], [3, false]]) await noMenu(rightClick(row, link));
  await menu(shiftF10, single);
  await copied(osc);
  console.log('Links with credentials, other schemes or excessive length offer no menu, and Shift+F10 falls back to recent valid hyperlinks.');

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
  const withBrowser = ['Open Link', 'Open in New Browser Session', 'Open in Browser 1', 'Open in External Browser', '-', 'Copy Link'];
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
  assert.deepEqual([second.ordinal, second.tabs.map(tab => tab.url)], [2, [osc]]);
  await showTerminal();
  await menu(rightClick(0), ['Open Link', 'Open in New Browser Session', 'Open in Browser 1', 'Open in Browser 2', 'Open in External Browser', '-', 'Copy Link']);
  await choose('Open in Browser 2');
  await waitState(s => s.workspaces.find(w => w.id === second.id)?.tabs.length === 2, 'tab in Browser 2');
  await showTerminal();
  await menu(rightClick(1), ['Open Link', 'Open in New Browser Session', 'Open in Browser 1', 'Open in Browser 2', 'Open in External Browser', '-', 'Copy Link']);
  await choose('Open Link');
  await waitState(s => s.workspaces.find(w => w.id === first).tabs.length === 3, 'third tab in Browser 1');
  console.log('The link menu opens links in the first, a new or a named browser session, and offers the external browser only when xdg-open is on PATH.');

  await page.locator(`.session-row .nav-item[data-id="${second.id}"]`).click();
  await waitState(s => s.workspaces.find(w => w.id === second.id).tabs.every(tab => !tab.loading && tab.title.startsWith('Fixture')), 'Browser 2 pages');
  const rightClickPage = () => application.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const contents = window.contentView.children.find(view => view.webContents && view.webContents !== window.webContents && view.getVisible()).webContents;
    const { x, y } = await contents.executeJavaScript('(() => { const r = document.querySelector("a").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()');
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 });
  });
  await menu(rightClickPage, ['Open Link', 'Open in New Browser Session', 'Open in Browser 1', 'Open in External Browser', '-', 'Copy Link', '-', 'Inspect Element']);
  await copied(pageLink);
  await menu(rightClickPage, ['Open Link', 'Open in New Browser Session', 'Open in Browser 1', 'Open in External Browser', '-', 'Copy Link', '-', 'Inspect Element']);
  await choose('Open Link');
  state = await waitState(s => s.workspaces.find(w => w.id === second.id).tabs.length === 3, 'page link in Browser 2');
  assert.equal(state.workspaces.find(w => w.id === second.id).tabs[2].url, pageLink);
  console.log('A link right-clicked in a page opens the same menu, where Open Link stays in that session.');

  const tabCounts = async () => Object.fromEntries((await app.state()).workspaces.map(w => [w.id, w.tabs.length]));
  await assert.rejects(api('renameBrowser', second.id, 'A\nB'));
  await api('renameBrowser', second.id, 'A & B');
  await showTerminal();
  await menu(rightClick(1), ['Open Link', 'Open in New Browser Session', 'Open in Browser 1', 'Open in A && B', 'Open in External Browser', '-', 'Copy Link']);
  await api('renameBrowser', second.id, '');
  console.log('Renamed sessions appear in the link menu with their names escaped.');
  await menu(() => page.locator(`.session-row .nav-item[data-id="${second.id}"]`).click({ button: 'right' }), ['Rename', 'Move Up', 'Move Down (disabled)']);
  await choose('Move Up');
  await expect(page.locator('.session-row .nav-item').first()).toHaveAttribute('data-id', second.id);
  await showTerminal();
  await leftClick(0);
  await waitState(s => s.workspaces.find(w => w.id === second.id).tabs.length === 4, 'link in the first session in the sidebar');
  await showTerminal();
  await menu(rightClick(1), ['Open Link', 'Open in New Browser Session', 'Open in Browser 1', 'Open in Browser 2', 'Open in External Browser', '-', 'Copy Link']);
  await choose('Open Link');
  await waitState(s => s.workspaces.find(w => w.id === second.id).tabs.length === 5, 'menu link in the first session in the sidebar');
  await showTerminal();
  await newBrowserTab.click();
  await waitState(s => s.workspaces.find(w => w.id === second.id).tabs.length === 6, 'title bar tab in the first session in the sidebar');
  await page.locator(`.nav-item[data-kind="tab"][data-workspace="${first}"]`).first().click();
  await newBrowserTab.click();
  await waitState(s => s.workspaces.find(w => w.id === first).tabs.length === 4, 'title bar tab in the selected session');
  assert.deepEqual(await tabCounts(), { [first]: 4, [second.id]: 6 });
  console.log('Terminal links and New Browser Tab use the session highest in the sidebar, and New Browser Tab uses the session on screen.');

  await showTerminal();
  await menu(rightClick(0), ['Open Link', 'Open in New Browser Session', 'Open in Browser 1', 'Open in Browser 2', 'Open in External Browser', '-', 'Copy Link']);
  await api('browser', second.id, 'close-workspace');
  await waitState(s => s.workspaces.length === 1, 'Browser 2 closed');
  await choose('Open in Browser 2');
  await waitFor(() => page.evaluate(() => window.rigErrors?.some(entry => entry.source === 'link' && entry.message.includes('Browser session is closed'))), 'stale session error');
  assert.equal((await app.state()).workspaces.length, 1);
  const linkErrors = () => page.evaluate(() => window.rigErrors.filter(entry => entry.source === 'link').reduce((sum, entry) => sum + entry.count, 0));
  const reported = await linkErrors();
  await choose('Open Link');
  await waitState(s => s.workspaces[0].tabs.length === 5, 'Open Link in the remaining session');
  await api('openLink', terminal, plain, second.id);
  await waitState(s => s.workspaces[0].tabs.length === 6, 'terminal link in the remaining session');
  await page.waitForTimeout(200);
  assert.equal(await linkErrors(), reported);
  await showTerminal();
  await api('disconnect', connection);
  await waitState(s => s.connections[0].status === 'closed', 'disconnected');
  await menu(rightClick(1), ['Open Link', 'Open in New Browser Session (disabled)', 'Open in Browser 1', 'Open in External Browser', '-', 'Copy Link']);
  await copied(osc);
  assert.deepEqual(errors, []);
  console.log('Choosing a closed session reports an error, a closed first session falls back to the remaining one, and a disconnected terminal still offers its links for existing sessions and copying.');
});
