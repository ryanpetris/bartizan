import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { withDirectory, sshProfile, launch, waitFor, chooseOption } from './lib/harness.mjs';
import { password, startVncHost, vncProcesses } from './lib/vnc-server.mjs';

const red = [204, 34, 51], green = [34, 187, 68], blue = [34, 68, 204], clipboardLimit = 128 * 1024;
const reachable = (host, port) => new Promise(resolve => {
  const socket = connect({ host, port });
  const finish = value => { socket.destroy(); resolve(value); };
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
  socket.setTimeout(500, () => finish(false));
});

await withDirectory('vnc', async (directory, cleanup) => {
  const host = await startVncHost(directory, cleanup);
  assert.equal(await reachable('127.0.0.1', 5900), false, 'Remote loopback is not desktop loopback');
  assert.equal(await reachable('192.0.2.20', 5901), false, 'The non-loopback target is reachable only inside the SSH host');
  const config = join(directory, 'config.yaml');
  await writeFile(config, `version: 1\nsettings:\n  remoteSessionIntegration: false\nprofiles:\n  fixture:\n${sshProfile(host.sshd)}  other:\n${sshProfile(host.sshd)}`);
  const app = await launch(directory, config);
  cleanup(app.close);
  const { page, api, state, waitState, application } = app;
  const payload = await application.evaluate(({ app }) => ({ executable: app.getPath('exe'), root: app.getAppPath() }));
  execFileSync(payload.executable, ['-e', `
    const fs = require('node:fs');
    const root = process.argv[1] + '/out/renderer/licenses/novnc/';
    for (const file of ['LICENSE.txt', 'AUTHORS', 'docs/LICENSE.MPL-2.0', 'docs/LICENSE.BSD-2-Clause', 'docs/LICENSE.BSD-3-Clause', 'docs/LICENSE.OFL-1.1', 'vendor/pako/LICENSE', 'SOURCE']) {
      if (!fs.readFileSync(root + file, 'utf8').trim()) throw new Error('Empty noVNC notice: ' + file);
    }
  `, payload.root], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  await application.evaluate(({ BrowserWindow }) => {
    globalThis.vncHistory = [];
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const send = contents.send.bind(contents);
    contents.send = (channel, event) => {
      if (event?.type === 'state') globalThis.vncHistory.push(structuredClone({ vncs: event.state.vncs, connections: event.state.connections }));
      return send(channel, event);
    };
  });
  const connection = await api('connect', { profileId: 'fixture' });
  await waitState(s => s.connections.find(c => c.id === connection)?.status === 'connected');
  assert.equal((await state()).capabilities.vnc, true);
  await app.chooseConnection(connection);
  const row = id => page.locator(`.nav-item[data-kind="vnc"][data-id="${id}"]`);
  const canvas = () => page.locator('.vnc-surface:not([hidden]) canvas');
  const pixel = () => canvas().evaluate(node => [...node.getContext('2d').getImageData(20, 20, 1, 1).data].slice(0, 3));
  const painted = color => expect.poll(pixel, { timeout: 15000 }).toEqual(color);
  const session = async id => (await state()).vncs.find(v => v.id === id);
  const closed = id => waitState(s => s.vncs.find(v => v.id === id)?.status === 'closed', 'VNC channel closure');
  const openDialog = async () => {
    await page.locator('.connection-add').click();
    await app.menu.choose('VNC');
    const modal = await app.modal();
    const dialog = modal.locator('dialog[open]').filter({ has: modal.getByLabel('Hostname', { exact: true }) });
    await expect(dialog).toBeVisible();
    return dialog;
  };
  const create = async (destination = {}) => {
    const before = new Set((await state()).vncs.map(v => v.id));
    const dialog = await openDialog();
    await expect(dialog.getByLabel('Hostname', { exact: true })).toHaveValue('localhost');
    await expect(dialog.getByLabel('Port', { exact: true })).toHaveValue('5900');
    if (destination.host) await dialog.getByLabel('Hostname', { exact: true }).fill(destination.host);
    if (destination.port) await dialog.getByLabel('Port', { exact: true }).fill(String(destination.port));
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
    const current = await waitState(s => s.vncs.some(v => !before.has(v.id)), 'a new VNC tab');
    return current.vncs.find(v => !before.has(v.id)).id;
  };
  const credentials = async value => {
    const modal = await app.modal();
    const input = modal.getByLabel('Password', { exact: true });
    await expect(input).toBeVisible({ timeout: 15000 }).catch(async error => {
      console.error(JSON.stringify({ state: await state(), errors: app.errors, view: await page.locator('.vnc-view').innerText(), dialogs: await modal.locator('body').innerText(), host: await host.log() }, null, 2));
      throw error;
    });
    await expect(input).toHaveValue('');
    if (value === null) await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    else {
      await input.fill(value);
      await modal.getByRole('button', { name: 'Sign In', exact: true }).click();
    }
  };
  const reconnect = async id => {
    await row(id).click();
    await page.getByRole('button', { name: 'Reconnect VNC', exact: true }).click();
  };

  await (await openDialog()).getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await state()).vncs.length, 0);
  const first = await create();
  await expect(row(first)).toContainText('localhost:5900');
  await credentials('incorrect');
  await closed(first);
  await expect(page.locator('.vnc-view:not([hidden]) .vnc-error')).toContainText(/auth|password/i);
  await expect(page.getByRole('button', { name: 'Reconnect VNC', exact: true })).toBeVisible();
  const failed = await session(first);
  await reconnect(first);
  await credentials(password);
  await painted(red);
  assert.notEqual((await session(first)).attempt, failed.attempt);
  assert.equal((await session(first)).host, 'localhost');
  assert.equal((await session(first)).port, 5900);
  const remoteCanvas = canvas();
  await remoteCanvas.click({ position: { x: 160, y: 192 } });
  await painted(blue);
  await page.keyboard.press('a');
  await painted(green);
  await expect.poll(async () => (await host.inputs(0)).filter(event => event.key === 'a').map(event => event.kind)).toEqual(['key', 'release']);
  console.log('The add dialog defaults to remote localhost:5900; VNC password failure and retry reach a real desktop, and keyboard input changes its pixels.');

  const second = await create({ host: '192.0.2.20', port: 5901 });
  await painted(red);
  await expect(row(second)).toContainText('192.0.2.20:5901');
  await expect.poll(() => vncProcesses(application).length).toBe(2);
  const beforeFirst = (await host.inputs(0)).length;
  const windowSize = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const size = window.getSize(); window.setSize(800, 500); return size;
  });
  await expect.poll(async () => (await canvas().boundingBox()).width).toBeLessThan(640);
  const bounds = await canvas().boundingBox();
  await page.mouse.click(bounds.x + bounds.width / 4, bounds.y + bounds.height * 0.4);
  await painted(blue);
  const mouse = (await host.inputs(1)).filter(event => event.kind === 'mouse').at(-1);
  assert.ok(Math.abs(mouse.x - 160) <= 2 && Math.abs(mouse.y - 192) <= 2, 'Mouse coordinates follow the scaled desktop');
  await page.keyboard.press('b');
  await painted(green);
  assert.equal((await host.inputs(0)).length, beforeFirst, 'Input stays in its selected VNC tab');
  await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), windowSize);
  await row(first).click();
  await painted(green);
  console.log('A non-loopback target unreachable by Electron works through SSH; each tab isolates input and scales pointer coordinates.');

  const keys = async start => (await host.inputs(0)).slice(start).filter(event => event.kind !== 'mouse').map(event => `${event.kind} ${event.key}`);
  let start = (await host.inputs(0)).length;
  await canvas().click({ position: { x: 20, y: 20 } });
  await page.keyboard.down('Shift');
  await expect.poll(() => keys(start)).toEqual(['key Shift_L']);
  await row(second).click();
  await expect.poll(() => keys(start)).toEqual(['key Shift_L', 'release Shift_L']);
  await page.keyboard.up('Shift');
  await row(first).click();
  await canvas().click({ position: { x: 20, y: 20 } });
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.keyboard.press('N');
  await expect(page.locator('.vnc-view')).toBeHidden();
  await expect.poll(() => keys(start)).toEqual(['key Shift_L', 'release Shift_L', 'key Control_L', 'key Shift_L', 'release Control_L', 'release Shift_L']);
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  start = (await host.inputs(0)).length;
  await app.chooseConnection(connection);
  await row(first).click();
  await canvas().click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('a');
  await expect.poll(() => keys(start)).toEqual(['key a', 'release a']);
  console.log('Keys held on a desktop are released on it when another tab or view takes the keyboard, leaving no modifier down.');

  // macOS sends CapsLock keydown when the lock turns on and keyup when it turns off, and noVNC sends each as a toggle.
  await page.evaluate(() => Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true }));
  start = (await host.inputs(0)).length;
  await page.keyboard.down('CapsLock');
  await expect.poll(() => keys(start)).toEqual(['key Caps_Lock', 'release Caps_Lock']);
  await row(second).click();
  await row(first).click();
  await canvas().click({ position: { x: 20, y: 20 } });
  await page.keyboard.up('CapsLock');
  await page.evaluate(() => delete navigator.platform);
  await page.keyboard.press('a');
  await expect.poll(() => keys(start)).toEqual(['key Caps_Lock', 'release Caps_Lock', 'key Caps_Lock', 'release Caps_Lock', 'key a', 'release a']);
  console.log('With macOS CapsLock events, leaving a desktop keeps its lock state.');

  for (const theme of ['rail', 'tabs', 'console']) {
    await api('settings', { theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await row(second).click();
    await expect(row(second)).toHaveAttribute('aria-current', 'page');
    await painted(green);
    const order = () => page.evaluate(id => JSON.parse(sessionStorage.getItem('navigation-order'))[`items:${id}`], connection);
    const before = await order();
    const index = before.indexOf(`vnc:${second}`);
    assert.ok(index >= 0);
    const up = index > 0;
    await row(second).click({ button: 'right' });
    await app.menu.choose(theme !== 'rail' ? (up ? 'Move Left' : 'Move Right') : (up ? 'Move Up' : 'Move Down'));
    const reordered = [...before];
    reordered.splice(index, 1);
    reordered.splice(index + (up ? -1 : 1), 0, `vnc:${second}`);
    await expect.poll(order).toEqual(reordered);
    await row(first).click();
    await expect(row(first)).toHaveAttribute('aria-current', 'page');
    await painted(green);
    const size = await canvas().boundingBox();
    const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(size.x >= 0 && size.y >= 0 && size.x + size.width <= viewport.width + 1 && size.y + size.height <= viewport.height + 1, `${theme}: the desktop fits its view`);
  }
  await api('settings', { theme: 'rail' });

  const toolbar = page.locator('.vnc-view:not([hidden]) .vnc-toolbar');
  const tool = name => toolbar.getByRole('button', { name, exact: true });
  const scaling = tool('Scaling');
  const mode = () => scaling.locator('.select-value').textContent();
  const zoomLevel = toolbar.getByRole('spinbutton', { name: 'Zoom Level', exact: true });
  const viewHost = page.locator('.vnc-host');
  const desktop = () => canvas().evaluate(node => ({ width: node.width, height: node.height, shown: node.getBoundingClientRect().width }));
  /** Waits for the desktop to fit the view: within it, and as wide or as tall. */
  const fits = () => expect.poll(async () => {
    const [box, view] = await Promise.all([canvas().boundingBox(), viewHost.boundingBox()]);
    return box.width <= view.width + 0.5 && box.height <= view.height + 0.5 && (view.width - box.width < 1 || view.height - box.height < 1);
  }).toBe(true);
  const zoom = async text => {
    await zoomLevel.fill(text);
    await zoomLevel.press('Enter');
  };
  /**
   * Clicks the whole window pixel nearest remote point (x, y) where the desktop shows it at `scale`, and checks that the
   * desktop received the remote pixel under it.
   */
  const pointAt = async (index, x, y, scale) => {
    const box = await canvas().boundingBox(), area = await viewHost.boundingBox();
    const point = { x: Math.round(box.x + (x + 0.5) * scale), y: Math.round(box.y + (y + 0.5) * scale) };
    const expected = { x: Math.floor((point.x - box.x) / scale), y: Math.floor((point.y - box.y) / scale) };
    assert.ok(point.x > area.x && point.x < area.x + area.width && point.y > area.y && point.y < area.y + area.height, `(${x}, ${y}) at ${scale} is in view`);
    const before = (await host.inputs(index)).length;
    await page.mouse.click(point.x, point.y);
    const mouse = await waitFor(async () => (await host.inputs(index)).slice(before).find(event => event.kind === 'mouse'), `a click at (${x}, ${y})`);
    assert.ok(Math.abs(mouse.x - expected.x) <= 1 && Math.abs(mouse.y - expected.y) <= 1, `(${expected.x}, ${expected.y}) at ${scale} reached (${mouse.x}, ${mouse.y})`);
  };
  await row(first).click();
  assert.equal(await mode(), 'Scale to Fit');
  const fitted = await desktop();
  await expect(zoomLevel).toHaveValue(`${Math.round(fitted.shown / fitted.width * 100)}%`);
  await zoom('150');
  assert.equal(await mode(), 'Zoom');
  await expect(zoomLevel).toHaveValue('150%');
  await expect.poll(async () => (await desktop()).shown).toBe(960);
  await pointAt(0, 320, 240, 1.5);
  await pointAt(0, 200, 150, 1.5);
  await viewHost.evaluate(node => { node.scrollLeft = node.scrollWidth; node.scrollTop = node.scrollHeight; });
  await pointAt(0, 600, 450, 1.5);
  await zoom('300');
  await expect.poll(async () => (await desktop()).shown).toBe(1920);
  const scrolled = () => viewHost.evaluate(node => ({ left: node.scrollLeft, top: node.scrollTop }));
  const quiet = (await host.inputs(0)).length;
  await tool('Pan').click();
  await expect(tool('Pan')).toHaveAttribute('aria-pressed', 'true');
  const area = await viewHost.boundingBox(), from = await scrolled();
  const middle = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down();
  await page.mouse.move(middle.x - 150, middle.y - 100, { steps: 5 });
  await page.mouse.up();
  const dragged = await scrolled();
  assert.deepEqual([dragged.left - from.left, dragged.top - from.top], [150, 100], 'A drag pans the view');
  await row(second).click();
  await row(first).click();
  await expect.poll(scrolled).toEqual(dragged);
  // A touch drag pans the view as the mouse does, and neither it nor a tap reaches the desktop.
  const touchscreen = await page.context().newCDPSession(page);
  const touch = (type, x, y) => touchscreen.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await viewHost.evaluate(node => node.scrollTo(400, 400));
  const touched = await scrolled();
  await touch('touchStart', middle.x, middle.y);
  for (let step = 1; step <= 5; step++) await touch('touchMove', middle.x - step * 20, middle.y - step * 10);
  await touch('touchEnd');
  await expect.poll(async () => { const now = await scrolled(); return [now.left - touched.left, now.top - touched.top]; }).toEqual([100, 50]);
  await touch('touchStart', middle.x, middle.y);
  await touch('touchEnd');
  await touchscreen.detach();
  const swiped = await scrolled();
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => (await scrolled()).top).toBeGreaterThan(swiped.top);
  await page.waitForTimeout(500);
  assert.deepEqual((await host.inputs(0)).slice(quiet), [], 'Panning sends the desktop nothing');
  await tool('Pan').click();
  await pointAt(0, 320, 240, 3);
  await zoom('37');
  await expect(tool('Pan')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await desktop()).shown).toBeCloseTo(236.8, 1);
  await pointAt(0, 160, 192, 0.37);
  await pointAt(0, 600, 450, 0.37);
  await tool('Zoom In').click();
  await expect(zoomLevel).toHaveValue('50%');
  await tool('Zoom Out').click();
  await expect(zoomLevel).toHaveValue('33%');
  await zoomLevel.focus();
  await page.keyboard.press('ArrowUp');
  await expect(zoomLevel).toHaveValue('50%');
  await zoom('nonsense');
  await expect(zoomLevel).toHaveValue('50%');
  await expect.poll(async () => (await desktop()).shown).toBe(320);
  await row(second).click();
  assert.equal(await mode(), 'Scale to Fit');
  await row(first).click();
  await expect(zoomLevel).toHaveValue('50%');
  await expect.poll(async () => (await desktop()).shown).toBe(320);
  await pointAt(0, 160, 192, 0.5);
  await tool('Pan').click();
  await chooseOption(scaling, { label: 'Scale to Fit' });
  await expect(tool('Pan')).toHaveCount(0);
  await expect.poll(async () => (await desktop()).shown).toBe(fitted.shown);
  await chooseOption(scaling, { label: 'Zoom' });
  await expect(zoomLevel).toHaveValue(`${Math.round(fitted.shown / fitted.width * 100)}%`);
  await expect(tool('Pan')).toHaveAttribute('aria-pressed', 'false');
  console.log('Custom zoom scales the desktop, pans by drag, touch or wheel and maps the pointer at each scale; each tab keeps its own scaling and scroll position, and another scaling turns Pan off.');

  const canvases = () => page.locator('.vnc-surface canvas').evaluateAll(nodes => nodes.map(node => `${node.width}x${node.height}`));
  /** Waits for the desktop in view to take the size of the view, within the pixel noVNC rounds down. */
  const fillsView = async () => {
    await expect.poll(async () => {
      const [{ width, height }, view] = await Promise.all([desktop(), viewHost.evaluate(node => node.getBoundingClientRect())]);
      return view.width - width >= 0 && view.width - width < 1 && view.height - height >= 0 && view.height - height < 1;
    }, { timeout: 15000 }).toBe(true);
    return desktop();
  };
  await chooseOption(scaling, { label: 'Resize Remote' });
  const resized = await fillsView();
  await expect(zoomLevel).toHaveValue('100%');
  await pointAt(0, 160, 192, 1);
  const resizedWhileShown = `${resized.width}x${resized.height}`;
  await row(second).click();
  const windowBefore = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const size = window.getSize(); window.setSize(size[0] - 120, size[1] - 80); return size;
  });
  await expect.poll(async () => (await viewHost.boundingBox()).width).toBeLessThan(resized.width);
  await page.waitForTimeout(1000);
  assert.ok((await canvases()).includes(resizedWhileShown), 'A hidden desktop keeps its remote size');
  assert.ok(!(await canvases()).includes('0x0'), 'A hidden desktop never asks for an empty one');
  await chooseOption(scaling, { label: 'Resize Remote' });
  await page.waitForTimeout(1500);
  const refused = await desktop();
  assert.deepEqual([refused.width, refused.height], [640, 480], 'A server that refuses resizing keeps its desktop');
  await expect(zoomLevel).toHaveValue(`${Math.round(refused.shown / 640 * 100)}%`);
  await pointAt(1, 320, 240, refused.shown / 640);
  await chooseOption(scaling, { label: 'Scale to Fit' });
  await row(first).click();
  assert.ok((await fillsView()).width < resized.width, 'A desktop shown again asks for the size of the view');
  await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), windowBefore);
  assert.equal((await fillsView()).width, resized.width);
  // A view-only desktop keeps its size, whether Resize Remote is chosen or the view resizes, until input returns.
  const resizeWindow = size => application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), size);
  await chooseOption(scaling, { label: 'Scale to Fit' });
  await resizeWindow([windowBefore[0] - 120, windowBefore[1] - 80]);
  await tool('View Only').click();
  await chooseOption(scaling, { label: 'Resize Remote' });
  await page.waitForTimeout(1000);
  assert.equal((await desktop()).width, resized.width, 'A view-only desktop is not resized');
  await tool('View Only').click();
  const narrowed = await fillsView();
  assert.ok(narrowed.width < resized.width, 'A desktop resizes as input returns');
  await tool('View Only').click();
  await resizeWindow(windowBefore);
  await page.waitForTimeout(1000);
  assert.equal((await desktop()).width, narrowed.width, 'A view-only desktop is not resized as the view resizes');
  await tool('View Only').click();
  assert.equal((await fillsView()).width, resized.width);
  await chooseOption(scaling, { label: 'Scale to Fit' });
  console.log('Remote resizing follows the view while the desktop shows and takes input; a hidden desktop keeps its size, and a refusing server stays scaled to fit.');

  start = (await host.inputs(0)).length;
  await tool('Send Keys').click();
  await app.menu.choose('Hold Ctrl');
  await expect(tool('Ctrl')).toHaveAttribute('aria-pressed', 'true');
  await api('setFullscreen', 'content');
  await expect(toolbar).toBeHidden();
  await expect.poll(() => keys(start)).toEqual(['key Control_L', 'release Control_L']);
  await expect.poll(async () => (await viewHost.boundingBox()).y).toBe(0);
  await fits();
  await api('setFullscreen', false);
  await expect(toolbar).toBeVisible();
  await expect(tool('Ctrl')).toHaveCount(0);
  console.log('Fullscreen content shows the desktop alone, scaled to the screen, and releases held keys.');

  start = (await host.inputs(0)).length;
  await tool('View Only').click();
  await expect(tool('View Only')).toHaveAttribute('aria-pressed', 'true');
  await expect(tool('Send Keys')).toBeDisabled();
  await canvas().click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('a');
  await page.waitForTimeout(1000);
  assert.deepEqual((await host.inputs(0)).slice(start), [], 'A view-only desktop takes no input');
  await row(second).click();
  await row(first).click();
  await expect(tool('View Only')).toHaveAttribute('aria-pressed', 'true');
  await tool('View Only').click();
  await canvas().click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('a');
  await expect.poll(() => keys(start)).toEqual(['key a', 'release a']);
  console.log('View only stops pointer and keyboard input until it is turned off, across tab switches.');

  start = (await host.inputs(0)).length;
  await tool('Send Keys').click();
  await app.menu.choose('Ctrl+Alt+Del');
  await expect.poll(() => keys(start)).toEqual(['key Control_L', 'key Alt_L', 'key Delete', 'release Delete', 'release Alt_L', 'release Control_L']);
  start = (await host.inputs(0)).length;
  await tool('Send Keys').click();
  await app.menu.choose('Hold Ctrl');
  await expect(tool('Ctrl')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('a');
  await tool('Send Keys').click();
  await app.menu.choose('Tab');
  await tool('Ctrl').click();
  await expect(tool('Ctrl')).toHaveCount(0);
  await expect.poll(() => keys(start)).toEqual(['key Control_L', 'key a', 'release a', 'key Tab', 'release Tab', 'release Control_L']);
  start = (await host.inputs(0)).length;
  await tool('Send Keys').click();
  await app.menu.choose('Hold Alt');
  await tool('Send Keys').click();
  await app.menu.choose('Hold Super');
  await row(second).click();
  await expect.poll(async () => (await keys(start)).sort()).toEqual(['key Alt_L', 'key Super_L', 'release Alt_L', 'release Super_L']);
  await row(first).click();
  await expect(tool('Alt')).toHaveCount(0);
  await canvas().click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await keys(start)).slice(4)).toEqual(['key Escape', 'release Escape']);
  // A held key shows only while the desktop holds it: Ctrl+Alt+Del and a modifier pressed on the keyboard release it.
  /** The X modifier state of the desktop's next key press: Control is 4 and Mod1, Alt, is 8. */
  const modifierState = async () => {
    const before = (await host.inputs(0)).length;
    await page.keyboard.press('a');
    return (await waitFor(async () => (await host.inputs(0)).slice(before).find(event => event.kind === 'key' && event.key === 'a'), 'a key press')).state & 12;
  };
  await tool('Send Keys').click();
  await app.menu.choose('Hold Ctrl');
  assert.equal(await modifierState(), 4);
  await tool('Send Keys').click();
  await app.menu.choose('Ctrl+Alt+Del');
  await expect(tool('Ctrl')).toHaveCount(0);
  assert.equal(await modifierState(), 0);
  await tool('Send Keys').click();
  await app.menu.choose('Hold Alt');
  assert.equal(await modifierState(), 8);
  await tool('Send Keys').click();
  await app.menu.choose('Hold Ctrl');
  start = (await host.inputs(0)).length;
  await page.keyboard.down('Control');
  await expect(toolbar.locator('.vnc-held')).toHaveCount(0);
  await expect.poll(async () => (await keys(start)).slice(0, 2).sort()).toEqual(['release Alt_L', 'release Control_L']);
  await expect.poll(async () => (await keys(start)).slice(2)).toEqual(['key Control_L']);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await keys(start)).slice(2)).toEqual(['key Control_L', 'release Control_L']);
  assert.equal(await modifierState(), 0);
  console.log('Special keys reach the desktop; held modifiers show in the toolbar while the desktop holds them and are released when the desktop is hidden or a modifier is pressed on the keyboard.');

  await host.command('copy', 0, 'Remote clipboard text');
  await tool('Clipboard').click();
  const panel = toolbar.getByRole('dialog', { name: 'Clipboard', exact: true });
  const clipboardText = panel.getByRole('textbox', { name: 'Clipboard Text', exact: true });
  await expect(clipboardText).toBeFocused();
  await expect(clipboardText).toHaveValue('Remote clipboard text', { timeout: 15000 });
  const oversizedClipboard = 'x'.repeat(clipboardLimit + 1);
  await clipboardText.fill(oversizedClipboard);
  await expect(clipboardText).toHaveValue('Remote clipboard text');
  await panel.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect.poll(() => application.evaluate(({ clipboard }) => clipboard.readText())).toBe('Remote clipboard text');
  await clipboardText.fill('Sent from Bartizan');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel).toBeHidden();
  await expect.poll(async () => (await host.clipboard(0)).at(-1), { timeout: 15000 }).toBe('Sent from Bartizan');
  await tool('Clipboard').click();
  await expect(clipboardText).toHaveValue('Sent from Bartizan');
  let random = 0x12345678;
  const boundaryClipboard = Array.from({ length: clipboardLimit }, () => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return String.fromCharCode(0x4e00 + random % 0x5200);
  }).join('');
  await clipboardText.fill(boundaryClipboard);
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await host.clipboard(0)).at(-1) === boundaryClipboard, { timeout: 30000 }).toBe(true);
  assert.equal((await session(first)).status, 'connected', 'A boundary clipboard send keeps the VNC channel connected');
  await tool('Clipboard').click();
  assert.equal(await clipboardText.evaluate((field, text) => field.value === text, boundaryClipboard), true);
  await clipboardText.fill(`${boundaryClipboard}x`);
  assert.equal(await clipboardText.evaluate((field, text) => field.value === text, boundaryClipboard), true, 'An oversized edit is rejected whole');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(tool('Clipboard')).toBeFocused();
  await tool('Clipboard').click();
  await expect(panel).toBeVisible();
  start = (await host.inputs(0)).length;
  const surface = await canvas().boundingBox();
  await page.mouse.click(surface.x + 20, surface.y + 20);
  await expect(panel).toBeHidden();
  await page.waitForTimeout(500);
  assert.deepEqual((await host.inputs(0)).slice(start), [], 'The press that closes the panel reaches nothing else');
  await tool('Clipboard').click();
  const opener = await tool('Clipboard').boundingBox();
  await page.mouse.click(opener.x + opener.width / 2, opener.y + opener.height / 2);
  await page.waitForTimeout(300);
  await expect(panel).toBeHidden();
  console.log('The clipboard panel shows remote text, rejects oversized edits whole, copies locally and sends normal and boundary non-ASCII text to the desktop without closing the channel; a press beside it only closes it.');

  // The VNC menu opens at the window's edge, below or over the toolbar's last button, so its submenus open to its left.
  const popup = await app.popup();
  const checked = async level => popup.locator('.menu').nth(level).locator('[aria-checked="true"] .menu-label').allTextContents();
  const levels = Array.from({ length: 10 }, (_, level) => String(level));
  /**
   * Opens the VNC menu's Compression submenu with the pointer, at the application's `zoom`, and checks that the popup
   * overlay ends where it started and is never placed anywhere else, and that the menu stays drawn where it was, frame by
   * frame. The row sampled is the right half of Disconnect, below Compression, which the pointer, the submenu and its
   * shadow leave alone. Sampling starts as the menu opens, which can be before the overlay first draws, so the row the
   * menu shows once drawn is the reference that no later frame may change.
   */
  const opensInPlace = async zoom => {
    await tool('VNC Menu').click();
    const [item, still, overlay] = await Promise.all([(await app.menu.item('Compression')).boundingBox(), (await app.menu.item('Disconnect')).boundingBox(), application.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      for (const view of window.contentView.children)
        if (view.webContents && view.getVisible() && await view.webContents.executeJavaScript('document.documentElement.classList.contains("overlay-popup")').catch(() => false)) {
          globalThis.popupView = view;
          globalThis.popupPlaces = [];
          view.setBounds = bounds => { globalThis.popupPlaces.push(bounds); Object.getPrototypeOf(view).setBounds.call(view, bounds); };
          return { view: view.getBounds(), content: window.getContentBounds() };
        }
    })]);
    const sampler = spawn('python3', ['scripts/rigs/fixtures/screen-row.py', ...[
      overlay.content.x + overlay.view.x + (still.x + still.width / 2) * zoom, overlay.content.y + overlay.view.y + (still.y + still.height / 2) * zoom, (still.width / 2 - 4) * zoom,
    ].map(value => String(Math.round(value))), '3000']);
    let sampled = '';
    sampler.stdout.on('data', chunk => { sampled += chunk; });
    const sampling = new Promise(resolve => sampler.once('exit', resolve));
    await waitFor(() => sampled.includes('\n') || sampler.exitCode !== null, 'screen sampling');
    await page.waitForTimeout(500);
    const drawn = sampled.trim().split('\n').length;
    await popup.mouse.move(item.x + item.width / 2, item.y + item.height / 2, { steps: 4 });
    await expect.poll(() => app.menu.labels(1)).toEqual(levels);
    assert.equal(await sampling, 0);
    const { places, final } = await application.evaluate(() => {
      delete globalThis.popupView.setBounds;
      return { places: globalThis.popupPlaces, final: globalThis.popupView.getBounds() };
    });
    assert.deepEqual(final, overlay.view, 'The popup overlay ends where it started');
    assert.ok(places.every(place => JSON.stringify(place) === JSON.stringify(overlay.view)), `The popup overlay keeps its place: ${JSON.stringify([overlay.view, ...places])}`);
    const rows = sampled.trim().split('\n').map(line => JSON.parse(line)[1]);
    assert.ok(rows.length === drawn, `The menu stays in place as its submenu opens: ${rows.length - drawn} later frames change it`);
  };
  await opensInPlace(1);
  await app.menu.choose('5', 1);
  await expect.poll(app.menu.open).toBe(false);
  await tool('VNC Menu').focus();
  await page.keyboard.press('Enter');
  await app.menu.shown();
  await popup.keyboard.press('ArrowDown');
  await popup.keyboard.press('ArrowDown');
  await popup.keyboard.press('ArrowRight');
  await expect.poll(() => app.menu.labels(1)).toEqual(levels);
  assert.deepEqual(await checked(1), ['5']);
  await popup.keyboard.press('7');
  await popup.keyboard.press('Enter');
  await expect.poll(app.menu.open).toBe(false);
  await tool('VNC Menu').click();
  await app.menu.choose('Compression');
  await expect.poll(() => checked(1)).toEqual(['7']);
  await app.menu.close();
  console.log('The VNC menu stays in place as a submenu opens beside it, and the pointer or the keys choose a compression level.');

  // In a narrow window at a high zoom the toolbar wraps. In a shorter one the Compression submenu is taller than the room
  // the popup overlay covers: it keeps within the overlay and scrolls, and the menu stays in place.
  const fullSize = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const size = window.getSize();
    window.setSize(1000, 600);
    window.webContents.setZoomFactor(2);
    return size;
  });
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([500, 300]);
  for (const key of ['Ctrl', 'Alt', 'Super']) {
    await tool('Send Keys').click();
    await app.menu.choose(`Hold ${key}`);
  }
  for (const theme of ['rail', 'tabs', 'console']) {
    await api('settings', { theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const { bar, controls, view } = await toolbar.evaluate(node => ({
      bar: node.getBoundingClientRect().toJSON(),
      controls: [...node.querySelectorAll('button, input')].filter(control => control.getClientRects().length).map(control => [control.getAttribute('aria-label') ?? control.textContent, control.getBoundingClientRect().toJSON()]),
      view: { width: innerWidth, height: innerHeight },
    }));
    assert.ok(['Scaling', 'Zoom Level', 'Ctrl', 'Alt', 'Super', 'View Only', 'Send Keys', 'Clipboard', 'VNC Menu'].every(name => controls.some(([label]) => label === name)), `${theme}: ${JSON.stringify(controls)}`);
    for (const [name, box] of controls)
      assert.ok(box.left >= bar.left && box.right <= bar.right && box.top >= bar.top && box.bottom <= bar.bottom && box.right <= view.width && box.bottom <= view.height, `${theme}: ${name} is in the toolbar and the window: ${JSON.stringify({ box, bar })}`);
  }
  await api('settings', { theme: 'rail' });
  for (const key of ['Ctrl', 'Alt', 'Super']) await tool(key).click();
  await expect(toolbar.locator('.vnc-held')).toHaveCount(0);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 480));
  await expect.poll(() => page.evaluate(() => innerHeight)).toBeLessThan(260);
  await opensInPlace(2);
  const submenu = await popup.locator('.menu').nth(1).evaluate(node => ({ ...node.getBoundingClientRect().toJSON(), scrolls: node.scrollHeight > node.clientHeight, room: innerHeight }));
  assert.ok(submenu.top >= 0 && submenu.bottom <= submenu.room && submenu.scrolls, `The submenu fits the overlay and scrolls: ${JSON.stringify(submenu)}`);
  await app.menu.choose('9', 1);
  await expect.poll(app.menu.open).toBe(false);
  await application.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setZoomFactor(1);
    window.setSize(...size);
  }, fullSize);
  console.log('A narrow, zoomed toolbar keeps every control in reach, and a submenu taller than the room scrolls beside a menu that stays in place.');

  const processes = vncProcesses(application).length;
  await tool('VNC Menu').click();
  await app.menu.choose('Quality');
  await app.menu.choose('9', 1);
  // noVNC shows a dot in place of a remote pointer with no visible pixels, and otherwise the remote pointer.
  const remotePointer = () => canvas().evaluate(async node => {
    const url = /url\("(.*?)"\)/.exec(node.style.cursor)?.[1];
    if (!url) return node.style.cursor;
    const image = new Image();
    image.src = url;
    await image.decode();
    const context = new OffscreenCanvas(image.width, image.height).getContext('2d');
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, image.width, image.height).data.some((value, index) => index % 4 === 3 && value) ? `${image.width}x${image.height}` : 'transparent';
  });
  await expect.poll(remotePointer).toMatch(/^(transparent|none)$/);
  await tool('VNC Menu').click();
  await app.menu.choose('Show Dot Cursor');
  await expect.poll(remotePointer).toBe('3x3');
  await host.command('pointer', 0, 'arrow');
  await expect.poll(remotePointer, { timeout: 15000 }).not.toMatch(/^(transparent|none|3x3)$/);
  await host.command('pointer', 0, 'none');
  await expect.poll(remotePointer, { timeout: 15000 }).toBe('3x3');
  console.log('Show Dot Cursor shows a dot only in place of a remote pointer with no visible pixels.');
  await zoom('150');
  await tool('View Only').click();
  const disconnected = (await session(first)).attempt;
  await tool('VNC Menu').click();
  await app.menu.choose('Disconnect');
  await closed(first);
  await expect(page.locator('.vnc-view:not([hidden]) .vnc-status [role="status"]')).toHaveText('Closed');
  await expect(page.locator('.vnc-view:not([hidden]) .vnc-error')).toHaveCount(0);
  await expect(toolbar).toHaveCount(0);
  await expect.poll(() => vncProcesses(application).length).toBe(processes - 1);
  await reconnect(first);
  await credentials(password);
  await waitState(s => s.vncs.some(v => v.id === first && v.attempt !== disconnected && v.status === 'connected'));
  await expect.poll(pixel, { timeout: 15000 }).not.toEqual([0, 0, 0]);
  await expect(zoomLevel).toHaveValue('150%');
  await expect.poll(async () => { const { shown, width } = await desktop(); return shown / width; }).toBe(1.5);
  await expect(tool('View Only')).toHaveAttribute('aria-pressed', 'true');
  await tool('VNC Menu').click();
  assert.deepEqual(await checked(0), ['Show Dot Cursor']);
  await app.menu.choose('Quality');
  await expect.poll(() => checked(1)).toEqual(['9']);
  await app.menu.close();
  await tool('VNC Menu').click();
  await app.menu.choose('Compression');
  await expect.poll(() => checked(1)).toEqual(['9']);
  await app.menu.close();
  await tool('View Only').click();
  await chooseOption(scaling, { label: 'Scale to Fit' });
  await fits();
  const refitted = await desktop();
  await pointAt(0, 160, 192, refitted.shown / refitted.width);
  console.log('Disconnect closes the attempt without an error; reconnecting keeps the tab\'s zoom, view-only, quality, compression and cursor choices.');

  const cancelled = await create();
  await credentials(null);
  await closed(cancelled);
  await expect.poll(() => vncProcesses(application).length).toBe(2);
  await api('closeVnc', connection, cancelled);
  console.log('All themes select, reorder and fit VNC tabs; cancelling authentication releases its channel.');

  await row(first).click();
  const eofAttempt = (await session(first)).attempt;
  await host.command('stop', 0);
  await closed(first);
  await host.command('start', 0);
  await reconnect(first);
  await credentials(password);
  await painted(red);
  assert.notEqual((await session(first)).attempt, eofAttempt);
  assert.deepEqual({ host: (await session(first)).host, port: (await session(first)).port }, { host: 'localhost', port: 5900 });
  await host.command('stop', 1);
  await closed(second);
  await host.command('start', 1);
  const beforeDrop = (await session(first)).attempt;
  await host.command('drop-ssh');
  await waitState(s => s.connections.find(c => c.id === connection)?.status === 'closed', 'SSH master loss');
  await closed(first);
  const dropHistory = await application.evaluate(() => globalThis.vncHistory);
  const masterClosed = dropHistory.findIndex(s => s.connections.some(c => c.id === connection && c.status === 'closed'));
  const channelClosed = dropHistory.findIndex(s => s.vncs.some(v => v.id === first && v.attempt === beforeDrop && v.status === 'closed'));
  assert.ok(masterClosed >= 0 && channelClosed >= 0, 'Both SSH and VNC closures reach the renderer');
  console.log(`SSH loss publishes ${masterClosed <= channelClosed ? 'master then VNC' : 'VNC then master'} closure.`);
  await api('reconnect', connection);
  await credentials(password);
  await painted(red);
  assert.notEqual((await session(first)).attempt, beforeDrop);
  assert.equal((await session(second)).status, 'closed', 'Server-closed VNC does not resume with SSH');
  await reconnect(second);
  await painted(red);
  console.log('Server EOF and SSH master loss reconnect at the same ID and destination; only interrupted VNC tabs resume with SSH.');

  const other = await api('connect', { profileId: 'other' });
  await waitState(s => s.connections.find(c => c.id === other)?.status === 'connected');
  await assert.rejects(api('closeVnc', other, first), /does not belong/);
  await api('disconnect', other);
  await api('removeConnection', other);
  await app.chooseConnection(connection);
  const running = vncProcesses(application);
  assert.equal(running.length, 2);
  await page.reload();
  await page.waitForFunction(() => window.bartizan);
  await waitState(s => s.vncs.length === 2 && s.vncs.every(v => v.status === 'closed'), 'renderer reload cleanup');
  await expect.poll(() => vncProcesses(application)).toEqual([]);
  await app.chooseConnection(connection);
  await reconnect(first);
  await credentials(password);
  await painted(red);
  await row(first).hover();
  await row(first).locator('..').getByRole('button', { name: 'Close localhost:5900', exact: true }).click();
  await waitState(s => !s.vncs.some(v => v.id === first));
  await expect.poll(() => vncProcesses(application)).toEqual([]);
  await api('closeVnc', connection, second);
  await waitState(s => s.vncs.length === 0);
  const history = await application.evaluate(() => globalThis.vncHistory);
  assert.ok(history.some(s => s.vncs.some(v => v.id === first && v.status === 'connected')));
  assert.ok(history.some(s => s.vncs.some(v => v.id === first && v.status === 'closed')));
  assert.ok(history.every(s => s.connections.every(c => !c.processes.some(p => p.name === 'Bartizan Helper'))), 'The helper never starts');
  await host.assertNoHelper();
  assert.equal((await readFile(config, 'utf8')).includes(password), false);
  assert.equal((await readFile(config, 'utf8')).includes('192.0.2.20'), false);
  assert.deepEqual(app.errors, []);
  console.log('Renderer reload and tab close release SSH channels; manual reconnect asks for credentials again, and the helper never starts.');

  const blockViewer = block => application.evaluate(({ BrowserWindow }, block) => {
    const requests = BrowserWindow.getAllWindows()[0].webContents.session.webRequest;
    requests.onBeforeRequest(block ? { urls: ['file://*/*'] } : null, block ? ({ url }, callback) => callback({ cancel: /\/rfb-[^/]*\.js$/.test(url) }) : null);
  }, block);
  await blockViewer(true);
  await page.reload();
  await page.waitForFunction(() => window.bartizan);
  await app.chooseConnection(connection);
  const unloaded = await create();
  await closed(unloaded);
  const view = page.locator('.vnc-view:not([hidden])');
  await expect(view.getByRole('status')).toHaveText('Closed');
  await expect(view.locator('.vnc-error')).toHaveText('VNC viewer failed to load');
  await expect.poll(() => vncProcesses(application)).toEqual([]);
  const unloadedAttempt = (await session(unloaded)).attempt;
  await reconnect(unloaded);
  await waitState(s => s.vncs.some(v => v.id === unloaded && v.attempt !== unloadedAttempt && v.status === 'closed'), 'a closed reconnect attempt');
  await expect(view.locator('.vnc-error')).toHaveText('VNC viewer failed to load');
  await expect(view.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible();
  await expect.poll(() => vncProcesses(application)).toEqual([]);
  await row(unloaded).hover();
  await row(unloaded).locator('..').getByRole('button', { name: 'Close localhost:5900', exact: true }).click();
  await waitState(s => s.vncs.length === 0);
  await blockViewer(false);
  await page.reload();
  await page.waitForFunction(() => window.bartizan);
  await app.chooseConnection(connection);
  const reloaded = await create();
  await credentials(password);
  await painted(red);
  await api('closeVnc', connection, reloaded);
  await waitState(s => s.vncs.length === 0);
  await expect.poll(() => vncProcesses(application)).toEqual([]);
  assert.deepEqual(app.errors, []);
  console.log('A viewer that fails to load closes each attempt and its channel, offers reconnect and close, and loads again after a reload.');

  const server = spawn(process.execPath, ['out/main/server.cjs', '--port', '0', '--config', config], { env: { ...process.env, DISPLAY: '', BARTIZAN_DATA_DIR: join(directory, 'web-state') } });
  let log = ''; server.stdout.on('data', chunk => log += chunk); server.stderr.on('data', chunk => log += chunk);
  cleanup(async () => { if (server.exitCode === null) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill(); await exited; } });
  const url = await waitFor(() => /Bartizan listening on (http:\/\/\S+)/.exec(log)?.[1], 'web server');
  const browser = await chromium.launch({ executablePath: process.env.BARTIZAN_CHROMIUM ?? '/usr/bin/chromium', chromiumSandbox: true });
  cleanup(() => browser.close());
  const web = await browser.newPage();
  const requested = [];
  web.on('request', request => requested.push(new URL(request.url()).pathname));
  await web.goto(url);
  await web.waitForFunction(() => window.bartizan);
  assert.equal(await web.evaluate(() => window.bartizan.capabilities().then(c => c.vnc)), false);
  await assert.rejects(web.evaluate(id => window.bartizan.newVnc(id), connection), /desktop app/);
  await web.getByRole('button', { name: 'New Connection', exact: true }).click();
  await web.locator('.profile-row[data-id="fixture"] .profile-item').click();
  await expect(web.locator('.terminal-surface:not([hidden])')).toBeVisible();
  await web.locator('.connection-chip').click({ button: 'right' });
  await expect(web.getByRole('menuitem', { name: 'New VNC', exact: true })).toHaveCount(0);
  assert.ok(requested.some(path => /\/index-[^/]*\.js$/.test(path)));
  assert.equal(requested.some(path => /\/rfb-[^/]*\.js$/.test(path)), false, 'The web build does not load noVNC');
  console.log('The web build disables VNC and rejects direct API calls.');
});
