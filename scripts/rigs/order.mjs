import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDirectory, startSshd, sshProfile, launch } from './lib/harness.mjs';

await withDirectory('order', async (directory, cleanup) => {
  const sshd = await startSshd(directory);
  cleanup(sshd.stop);
  const config = join(directory, 'config.yaml');
  await writeFile(config, `version: 1\nprofiles:\n  one:\n    label: One\n${sshProfile(sshd)}  two:\n    label: Two\n${sshProfile(sshd)}`);
  const app = await launch(directory, config);
  cleanup(app.close);
  const { application, page, api, waitState, errors } = app;
  // Native menus are recorded instead of shown; the rig chooses their items.
  await application.evaluate(({ Menu }) => {
    globalThis.rigMenus = [];
    Menu.prototype.popup = function () { globalThis.rigMenus.push(this); };
  });
  const menu = async (open, labels) => {
    const count = await application.evaluate(() => globalThis.rigMenus.length);
    await open();
    await expect.poll(() => application.evaluate((_, count) => globalThis.rigMenus[count]?.items.map(item => item.enabled ? item.label : `${item.label} (disabled)`), count)).toEqual(labels);
  };
  const choose = label => application.evaluate((_, label) => globalThis.rigMenus.at(-1).items.find(item => item.label === label).click(), label);
  const rightClick = locator => () => locator.click({ button: 'right' });
  const shiftF10 = locator => async () => { await locator.focus(); await page.keyboard.press('Shift+F10'); };
  /** Drops a unit on the top edge of another, which places it before that unit. */
  const drag = (from, to) => from.dragTo(to, { targetPosition: { x: 10, y: 2 } });
  const savedOrder = () => page.evaluate(() => sessionStorage.getItem('navigation-order'));

  const group = id => page.locator(`.connection-chip[data-id="${id}"]`);
  const titles = id => group(id).locator('.connection-titles');
  const item = key => page.locator(`.connection-items > [data-order-key="${key}"] .nav-item`).first();
  const tab = id => page.locator(`.tab-items > [data-order-key="${id}"] .nav-item`);
  const connectionOrder = () => page.locator('.connection-chip').evaluateAll(nodes => nodes.map(node => node.dataset.id));
  const itemOrder = () => page.locator('.rail-panel .connection-items > li').evaluateAll(nodes => nodes.map(node => node.dataset.orderKey));
  const tabOrder = session => page.locator(`[data-order-key="session:${session}"] .tab-items > li`).evaluateAll(nodes => nodes.map(node => node.dataset.orderKey));

  const one = await api('connect', { profileId: 'one' });
  const two = await api('connect', { profileId: 'two' });
  await waitState(s => s.terminals.length === 2 && s.terminals.every(t => t.status === 'connected'), 'both connections');
  await expect.poll(connectionOrder).toEqual([one, two]);
  await drag(titles(two), titles(one));
  await expect.poll(connectionOrder).toEqual([two, one]);
  const connectionCommands = ['New Terminal', 'New Browser Session', '', 'Disconnect', 'Remove (disabled)', 'Connection Details', ''];
  await menu(rightClick(titles(one)), [...connectionCommands, 'Move Up', 'Move Down (disabled)']);
  await choose('Move Up');
  await expect.poll(connectionOrder).toEqual([one, two]);
  await menu(shiftF10(titles(one)), [...connectionCommands, 'Move Up (disabled)', 'Move Down']);
  await choose('Move Down');
  await expect.poll(connectionOrder).toEqual([two, one]);
  console.log('Connections reorder by dragging and from the Move Up and Move Down menu, by right click or Shift+F10, with moves past either end disabled.');

  await titles(one).click();
  await menu(() => page.locator('.rail-panel .connection-add').click(), ['Terminal', 'Browser Session']);
  await choose('Terminal');
  await waitState(s => s.terminals.filter(t => t.connectionId === one).length === 2, 'second terminal');
  await menu(() => page.locator('.rail-panel .connection-add').click(), ['Terminal', 'Browser Session']);
  await choose('Browser Session');
  const state = await waitState(s => s.workspaces[0]?.tabs.length === 1, 'browser session');
  const [t1, t2] = state.terminals.filter(t => t.connectionId === one).map(t => `terminal:${t.id}`);
  const sessionId = state.workspaces[0].id, session = `session:${sessionId}`;
  await expect.poll(() => itemOrder(one)).toEqual([t1, t2, session]);
  await drag(item(session), item(t1));
  await expect.poll(() => itemOrder(one)).toEqual([session, t1, t2]);
  await menu(shiftF10(item(session)), ['Rename', 'Move Up (disabled)', 'Move Down']);
  await choose('Move Down');
  await expect.poll(() => itemOrder(one)).toEqual([t1, session, t2]);
  await menu(rightClick(item(t1)), ['Move Up (disabled)', 'Move Down']);
  await choose('Move Down');
  await expect.poll(() => itemOrder(one)).toEqual([session, t1, t2]);
  console.log('Terminals and a browser session reorder within their connection by dragging and from the menu.');

  await api('browser', sessionId, 'new');
  await api('browser', sessionId, 'new');
  const [a, b, c] = (await waitState(s => s.workspaces[0].tabs.length === 3, 'three tabs')).workspaces[0].tabs.map(t => t.id);
  await expect.poll(() => tabOrder(sessionId)).toEqual([a, b, c]);
  await drag(tab(c), tab(a));
  await expect.poll(() => tabOrder(sessionId)).toEqual([c, a, b]);
  await menu(rightClick(tab(c)), ['Mute Tab', 'Move Up (disabled)', 'Move Down']);
  await choose('Move Down');
  await expect.poll(() => tabOrder(sessionId)).toEqual([a, c, b]);
  const before = await savedOrder();
  await drag(tab(b), item(t2));
  await page.waitForTimeout(200);
  assert.equal(await savedOrder(), before);
  await menu(rightClick(item(session)), ['Rename', 'Move Up (disabled)', 'Move Down']);
  await choose('Move Down');
  await expect.poll(() => itemOrder(one)).toEqual([t1, session, t2]);
  console.log('Tabs reorder within a multi-tab browser session, a tab dragged straight onto another scope stays put, and the session heading moves the whole session.');

  await api('newBrowser', two);
  await waitState(s => s.workspaces.some(w => w.connectionId === two && w.tabs.length === 1), 'browser session on the first connection');
  await titles(two).click();
  await page.locator('.rail-panel').getByRole('button', { name: /^Close Browser \d+$/ }).focus();
  await page.keyboard.press('Enter');
  await waitState(s => !s.workspaces.some(w => w.connectionId === two), 'browser session closed');
  await expect(page.locator('.rail-panel .nav-item[data-kind="terminal"]')).toBeFocused();
  console.log('Closing the last session row moves focus to the remaining terminal.');

  const kept = async () => {
    await titles(one).click();
    await expect.poll(connectionOrder).toEqual([two, one]);
    await expect.poll(() => itemOrder(one)).toEqual([t1, session, t2]);
    await expect.poll(() => tabOrder(sessionId)).toEqual([a, c, b]);
  };
  await page.reload();
  await page.waitForFunction(() => window.bartizan);
  await kept();
  await api('disconnect', one);
  await waitState(s => s.connections.find(connection => connection.id === one).status === 'closed', 'disconnected');
  await kept();
  // Reconnecting from the rail while another connection is in view shows what the connection last showed.
  await titles(two).click();
  await rightClick(titles(one))();
  await choose('Reconnect');
  await expect(titles(one)).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('.rail-panel .nav-item[aria-current="page"]')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Nothing Open', exact: true })).toBeHidden();
  await waitState(s => s.connections.find(connection => connection.id === one).status === 'connected', 'reconnected');
  await kept();
  console.log('The chosen order survives a page reload, a disconnect and a reconnect.');

  /** Presses on one row and moves over the bottom edge of another, then over `target` at `position`; dragover needs two moves. */
  const dragPast = async (from, over, target, position) => {
    const edge = { x: 10, y: (await over.boundingBox()).height - 2 };
    await from.hover({ position: { x: 10, y: 5 } });
    await page.mouse.down();
    for (const y of [edge.y, edge.y - 1]) await over.hover({ position: { x: edge.x, y } });
    await expect(page.locator('.drop-after')).toHaveCount(1);
    for (const x of [position.x, position.x + 1]) await target.hover({ position: { x, y: position.y }, force: true });
  };
  const scroll = page.locator('.rail-panel-scroll');
  const { height } = await scroll.boundingBox();
  await dragPast(item(session), item(t2), scroll, { x: 20, y: height - 10 });
  await expect(page.locator('.drop-after')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator('.drop-before, .drop-after')).toHaveCount(0);
  await expect.poll(() => itemOrder(one)).toEqual([t1, t2, session]);
  await dragPast(item(t1), item(t2), page.locator('.rail-topbar'), { x: 100, y: 20 });
  await page.mouse.up();
  await expect(page.locator('.drop-before, .drop-after')).toHaveCount(0);
  await expect.poll(() => itemOrder(one)).toEqual([t2, t1, session]);
  assert.deepEqual(errors, []);
  console.log('Dropping past the rows, in the empty panel or elsewhere in the window, uses the marked place.');
});
