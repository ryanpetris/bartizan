import { expect } from '@playwright/test';
import assert from 'node:assert/strict';

export async function testSessionUI(app, connectionId) {
  const { application, page, state } = app;
  await page.locator(`.connection-chip[data-id="${connectionId}"] .connection-titles`).click();
  const connection = page.locator('.rail-panel');
  await application.evaluate(({ Menu }) => {
    globalThis.rigPopup = Menu.prototype.popup;
    globalThis.rigMenus = [];
    Menu.prototype.popup = function (options) { globalThis.rigMenus.push({ menu: this, options }); };
  });
  const add = async label => {
    await connection.locator('.connection-add').click();
    await application.evaluate((_, label) => globalThis.rigMenus.at(-1).menu.items.find(item => item.label === label).click(), label);
  };
  try {
    const initial = await state();
    await connection.locator('.connection-add').click();
    assert.deepEqual(await application.evaluate(() => globalThis.rigMenus.at(-1).menu.items.map(item => item.label)), ['Terminal', 'Browser Session']);
    await add('Terminal');
    await expect.poll(async () => (await state()).terminals.length).toBe(initial.terminals.length + 1);
    const terminal = (await state()).terminals.find(t => !initial.terminals.some(old => old.id === t.id));
    await expect(page.locator(`[data-kind="terminal"][data-id="${terminal.id}"]`)).toHaveAttribute('aria-current', 'page');
    await page.locator(`[data-kind="terminal"][data-id="${terminal.id}"]`).locator('..').getByRole('button', { name: /^Close / }).click();
    await expect.poll(async () => (await state()).terminals.some(t => t.id === terminal.id)).toBe(false);
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('.rail-panel')))).toBe(true);
    assert.equal((await state()).connections.find(c => c.id === connectionId).status, 'connected');

    const names = await connection.locator('.session-row .row-new').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label').replace('New Tab in ', '')));
    const numbers = names.map(label => Number(/^Browser (\d+)$/.exec(label)?.[1] ?? 0));
    // Hold state events after the new session's first state, so its tab arrives after the selection can render.
    await application.evaluate(({ BrowserWindow }, known) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const send = contents.send;
      let held;
      contents.send = (...args) => {
        if (held) { held.push(args); return; }
        send(...args);
        if (args[1]?.type !== 'state' || !args[1].state.workspaces.some(w => !w.tabs.length && !known.includes(w.id))) return;
        held = []; globalThis.rigHeldTabState = true;
        setTimeout(() => { contents.send = send; for (const pending of held) send(...pending); held = undefined; }, 300);
      };
    }, initial.workspaces.map(w => w.id));
    await add('Browser Session');
    await expect.poll(async () => (await state()).workspaces.length).toBe(initial.workspaces.length + 1);
    const workspace = (await state()).workspaces.find(w => !initial.workspaces.some(old => old.id === w.id));
    const single = page.locator(`[data-kind="tab"][data-workspace="${workspace.id}"]`);
    await expect(single).toHaveCount(1);
    await expect(single.locator('..').locator('.row-new')).toHaveCount(0);
    await expect(page.locator(`[data-kind="browser"][data-id="${workspace.id}"]`)).toHaveCount(1);
    assert.equal(await application.evaluate(() => globalThis.rigHeldTabState), true);
    await expect(page.getByRole('textbox', { name: 'Address', exact: true })).toBeFocused();
    const ordinal = Math.max(0, ...numbers) + 1;
    const name = `Browser ${ordinal}`;
    await page.locator(`[data-kind="browser"][data-id="${workspace.id}"]`).locator('..').getByRole('button', { name: `New Tab in ${name}`, exact: true }).click();
    const group = page.locator(`[data-kind="browser"][data-id="${workspace.id}"]`).locator('../..');
    await expect(group.locator('.nav-item').first()).toHaveAttribute('data-kind', 'browser');
    await expect(page.locator(`[data-kind="browser"][data-id="${workspace.id}"] .nav-label`)).toHaveText(name);
    const sessionItem = page.locator(`[data-kind="browser"][data-id="${workspace.id}"]`);
    const sessionName = () => state().then(value => value.workspaces.find(w => w.id === workspace.id).name);
    const rename = async () => {
      await sessionItem.click({ button: 'right' });
      await expect.poll(() => application.evaluate(() => globalThis.rigMenus.at(-1).menu.items.map(item => item.label))).toEqual(['Rename', 'Move Up', 'Move Down']);
      await application.evaluate(() => globalThis.rigMenus.at(-1).menu.items[0].click());
      const field = connection.getByRole('textbox', { name: 'Session Name', exact: true });
      await expect(field).toBeFocused();
      return field;
    };
    await expect(await rename()).toHaveValue(name);
    await page.keyboard.type('Work & Play');
    await page.keyboard.press('Enter');
    await expect(sessionItem.locator('.nav-label')).toHaveText('Work & Play');
    await expect(sessionItem).toBeFocused();
    assert.equal(await sessionName(), 'Work & Play');
    await rename();
    await page.keyboard.type('Ignored');
    await page.keyboard.press('Escape');
    await expect(sessionItem.locator('.nav-label')).toHaveText('Work & Play');
    const field = await rename();
    await field.fill('Tab\there');
    assert.equal(await page.evaluate(() => document.hasFocus()), true);
    await field.evaluate(element => element.blur());
    await expect(sessionItem.locator('.nav-label')).toHaveText('Tab here');
    await rename();
    await page.keyboard.press('Delete');
    await page.keyboard.press('Enter');
    await expect(sessionItem.locator('.nav-label')).toHaveText(name);
    assert.equal(await sessionName(), undefined);
    await expect(group.locator('[data-kind="tab"]')).toHaveCount(2);
    const tabs = (await state()).workspaces.find(w => w.id === workspace.id).tabs;
    await group.locator(`[data-kind="tab"][data-id="${tabs[0].id}"]`).click();
    await expect.poll(async () => (await state()).workspaces.find(w => w.id === workspace.id).activeTab).toBe(tabs[0].id);
    await expect(group.locator(`[data-kind="tab"][data-id="${tabs[0].id}"]`)).toHaveAttribute('aria-current', 'page');
    await group.evaluate((node, ids) => {
      node.querySelector(`[data-kind="tab"][data-id="${ids[1]}"]`).click();
      node.querySelector(`[data-kind="tab"][data-id="${ids[0]}"]`).click();
    }, tabs.map(t => t.id));
    await page.waitForTimeout(200);
    await expect.poll(async () => (await state()).workspaces.find(w => w.id === workspace.id).activeTab).toBe(tabs[0].id);
    await group.locator(`[data-kind="tab"][data-id="${tabs[1].id}"]`).click();
    await expect.poll(async () => (await state()).workspaces.find(w => w.id === workspace.id).activeTab).toBe(tabs[1].id);
    await sessionItem.click();
    await expect.poll(async () => (await state()).workspaces.find(w => w.id === workspace.id).activeTab).toBe(tabs[0].id);
    await expect(group.locator(`[data-kind="tab"][data-id="${tabs[0].id}"]`)).toHaveAttribute('aria-current', 'page');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 700));
    await expect(group).toBeVisible();
    const colors = await connection.locator('.session').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).getPropertyValue('--session-color').trim()));
    assert.ok(colors.length && colors.every(Boolean));
    for (const tab of tabs) {
      await connection.locator(`[data-kind="tab"][data-id="${tab.id}"]`).locator('..').getByRole('button', { name: /^Close Tab/ }).click();
      await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('.rail-panel')))).toBe(true);
    }
    const tabCount = async () => (await state()).workspaces.find(w => w.id === workspace.id)?.tabs.length;
    await expect.poll(tabCount).toBe(0);
    await sessionItem.click();
    await expect.poll(tabCount).toBe(1);
    await expect(group.locator('[data-kind="tab"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('textbox', { name: 'Address', exact: true })).toBeFocused();
    await sessionItem.locator('..').getByRole('button', { name: `Close ${name}`, exact: true }).click();
    await expect.poll(async () => (await state()).workspaces.some(w => w.id === workspace.id)).toBe(false);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    console.log('Navigation controls open and close terminals, browser sessions and tabs; tab selection, session numbering, session rows above their tabs, renaming, session rows opening their first tab or a new one when empty, and address focus after late tab state passed.');
  } finally {
    await application.evaluate(({ Menu }) => { Menu.prototype.popup = globalThis.rigPopup; });
  }
}
