import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { openSettings, closeSettings, chooseAppearance } from './settings.mjs';

export async function testBrowserInteractions(app, httpPort, first) {
  const { application, page, state, api } = app;
  const waitState = (_page, predicate) => app.waitState(predicate);
  const connectionId = (await state()).terminals.find(t => t.id === first).connectionId;
  for (const w of (await state()).workspaces) await api('browser', w.id, 'close-workspace');
  let linkDialogs = 0;
  page.on('dialog', dialog => { linkDialogs++; void dialog.dismiss(); });
  const clickTerminalLink = async uri => {
    await page.locator(`[data-kind="terminal"][data-id="${first}"]`).click();
    await page.evaluate(({id, uri}) => window.bartizan.input(id, `printf '\\033[2J\\033[H\\033]8;;${uri}\\033\\\\OPEN REMOTE\\033]8;;\\033\\\\\\n'\n`), { id: first, uri });
    await page.waitForTimeout(500);
    const box = await page.locator('.terminal-surface:not([hidden]) .xterm-screen').boundingBox();
    await page.mouse.move(box.x + 35, box.y + 8);
    await page.waitForTimeout(300);
    await page.mouse.click(box.x + 35, box.y + 8);
  };
  await clickTerminalLink(`http://localhost:${httpPort}/`);
  await waitState(page, s => s.workspaces[0]?.tabs[0]?.title === 'Remote fixture' && !s.workspaces[0]?.tabs[0]?.loading);
  const { id: workspaceId, tabs: [{ id: firstTabId }] } = (await state()).workspaces[0];
  const firstTabRow = page.locator(`[data-kind="tab"][data-id="${firstTabId}"]`);
  assert.equal(await firstTabRow.getAttribute('aria-current'), 'page');
  await clickTerminalLink('file:///nonexistent-bartizan-fixture');
  await page.waitForTimeout(300);
  assert.equal((await state()).workspaces[0].tabs.length, 1);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  assert.equal(linkDialogs, 0);
  console.log('OSC 8 HTTP links open in a browser session; other schemes open nothing.');
  await waitState(page, s => s.workspaces[0]?.tabs[0]?.title === 'Remote fixture' && !s.workspaces[0]?.tabs[0]?.loading);
  const values = await application.evaluate(async ({ webContents }) => {
    const browser = webContents.getAllWebContents().find(w => w.getURL().startsWith('http://localhost:'));
    return { persistent: browser.session.isPersistent(), cookies: await browser.session.cookies.get({}), storage: await browser.executeJavaScript('localStorage.getItem("rig")') };
  });
  assert.equal(values.persistent, false); assert.equal(values.storage, 'present'); assert.ok(values.cookies.some(c => c.name === 'rig'));
  await firstTabRow.click();
  const chrome = [];
  const nativeViews = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter(view => view.getVisible()).length);
  await expect.poll(nativeViews).toBe(1);
  const toastBounds = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter(view => view.getVisible()).map(view => view.getBounds()));
  const boundsBeforeToast = await toastBounds();
  await page.evaluate(() => window.bartizan.reportError({ source: 'rig', message: 'Browser notification fixture' }));
  await expect(page.locator('[data-sonner-toaster]')).toContainText('Browser notification fixture');
  assert.deepEqual(await toastBounds(), boundsBeforeToast, 'A toast does not hide or resize the native page');
  await page.locator('[data-sonner-toaster]').getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.getByRole('button', { name: 'Errors', exact: true }).click();
  await expect(page.locator('.error-panel')).toBeVisible();
  await expect.poll(nativeViews).toBe(0);
  await page.keyboard.press('Escape');
  await expect.poll(nativeViews).toBe(1);
  assert.deepEqual(await toastBounds(), boundsBeforeToast);
  console.log('Error toasts preserve native page visibility and bounds; the panel restores the page on close.');
  for (const mode of ['dark', 'light']) {
    await expect.poll(nativeViews).toBe(1);
    const settings = await openSettings(page);
    await expect.poll(nativeViews).toBe(0);
    await settings.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption(mode);
    await expect.poll(async () => (await state()).settings.appearance).toBe(mode);
    await closeSettings(page);
    await expect.poll(nativeViews).toBe(1);
    await page.waitForFunction(mode => getComputedStyle(document.documentElement).colorScheme === mode, mode);
    await expect.poll(() => application.evaluate(async ({ webContents }) => {
      const browser = webContents.getAllWebContents().find(w => w.getURL().startsWith('http://localhost:'));
      return browser.executeJavaScript('matchMedia("(prefers-color-scheme: dark)").matches');
    })).toBe(mode === 'dark');
    chrome.push(await page.locator('.browser-toolbar').evaluate(e => getComputedStyle(e).backgroundColor));
  }
  assert.notEqual(chrome[0], chrome[1]);
  await chooseAppearance(app, 'system');
  console.log('Settings hides and restores the visible page; browser controls and remote page color preference follow application appearance.');
  await expect(page.locator('.rail-topbar').getByRole('heading', { level: 1 })).toContainText('Browser');
  const tabs = async () => (await state()).workspaces.find(w => w.id === workspaceId).tabs;
  const existingTabs = await tabs();
  await page.locator('.browser-toolbar').getByRole('button', { name: 'New Tab', exact: true }).click();
  await expect.poll(async () => (await tabs()).length).toBe(existingTabs.length + 1);
  await page.locator('.browser-toolbar').getByRole('button', { name: 'Close Tab', exact: true }).click();
  await expect.poll(async () => (await tabs()).length).toBe(existingTabs.length);
  await page.locator(`[data-kind="tab"][data-id="${existingTabs[0].id}"]`).click();
  await expect.poll(nativeViews).toBe(1);
  console.log('Browser context appears in the title bar; the address toolbar opens and closes tabs.');
  await application.evaluate(async ({ webContents }) => {
    const browser = webContents.getAllWebContents().find(w => w.getURL().startsWith('http://localhost:'));
    browser.focus(); await browser.executeJavaScript('document.querySelector("#draft").focus()');
    browser.sendInputEvent({ type: 'char', keyCode: 'a' });
  });
  assert.equal(await application.evaluate(async ({ webContents }) => webContents.getAllWebContents().find(w => w.getURL().startsWith('http://localhost:')).executeJavaScript('document.querySelector("#draft").value')), 'a');
  const browserKey = async (keyCode, modifiers) => application.evaluate(({ webContents }, input) => {
    const browser = webContents.getAllWebContents().find(w => w.getURL().startsWith('http://localhost:'));
    browser.focus(); browser.sendInputEvent({ type: 'keyDown', ...input }); browser.sendInputEvent({ type: 'keyUp', ...input });
  }, { keyCode, modifiers });
  await browserKey('L', ['control']);
  await page.waitForFunction(() => document.activeElement?.getAttribute('name') === 'address');
  assert.equal(await page.locator('[name="address"]').evaluate(input => input.selectionEnd - input.selectionStart), await page.locator('[name="address"]').evaluate(input => input.value.length));
  await browserKey('N', ['control', 'shift']);
  await page.waitForFunction(() => document.querySelector('#connection-dialog')?.open);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  console.log('Focused browser pages retain ordinary input and forward address/new-connection shortcuts.');
  const selections = await page.locator('[name="address"]').evaluate(async input => {
    const results = [];
    for (const action of ['focus', 'typing', 'paste', 'caret', 'blur']) {
      input.blur();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'address fixture');
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      input.focus();
      input.setSelectionRange(3, 3);
      if (action === 'typing' || action === 'paste') input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: action === 'paste' ? 'insertFromPaste' : 'insertText' }));
      if (action === 'caret') input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      if (action === 'blur') input.blur();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      results.push([input.selectionStart, input.selectionEnd]);
    }
    return results;
  });
  assert.deepEqual(selections, [[0, 15], [3, 3], [3, 3], [3, 3], [3, 3]]);
  await page.locator('[name="address"]').fill('editing');
  await page.locator('[name="address"]').press('Control+a');
  await page.keyboard.type('replacement');
  assert.equal(await page.locator('[name="address"]').inputValue(), 'replacement');
  await page.locator('[name="address"]').press('Control+z');
  assert.equal(await page.locator('[name="address"]').inputValue(), 'editing');
  console.log('Application fields retain selection and undo without menu roles.');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.2));
  await page.waitForTimeout(250);
  const slot = await page.locator('.browser-slot').boundingBox();
  const nativeBounds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find(view => view.getVisible()).getBounds());
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(nativeBounds[key] - slot[key] * 1.2) <= 2, `Zoomed ${key} aligns`);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  await page.waitForTimeout(250);
  await application.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getURL().startsWith('http://localhost:')).focus());
  await page.evaluate(() => { location.href = 'https://example.invalid/'; });
  await page.waitForTimeout(200);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter(view => view.getVisible()).length), 1);
  await page.reload();
  await page.locator('.home-view').waitFor();
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter(view => view.getVisible()).length), 0);
  await page.locator('.rail').getByRole('button', { name: 'New Connection', exact: true }).click();
  await page.locator('#connection-dialog').waitFor({ state: 'visible' });
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter(view => view.getVisible()).length), 0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await app.chooseConnection(connectionId);
  await firstTabRow.click();
  await application.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getURL().startsWith('http://localhost:')).focus());
  const challenged = await api('connect', { profileId: 'ask' });
  await page.locator('#auth-dialog').waitFor({ state: 'visible' });
  const draft = await api('profileDraft', 'ask');
  const preview = await api('profilePreview', { token: draft.token, values: {}, reset: [] });
  const details = await page.evaluate(id => window.bartizan.details(id), challenged);
  assert.equal(details.status, 'connecting');
  assert.equal(preview[preview.indexOf('-D') + 1], '127.0.0.1:<allocated port>');
  for (const command of [preview]) {
    assert.ok(command.includes('ExitOnForwardFailure=yes'));
    assert.ok(command.includes('UserKnownHostsFile="<application trust store>"'));
    assert.ok(!JSON.stringify(command).includes('rig-passphrase'));
  }
  const pendingChallenge = (await state()).challenges[0].id;
  await page.reload();
  await page.locator('#auth-dialog').waitFor({ state: 'visible' });
  assert.equal((await state()).challenges[0].id, pendingChallenge);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter(view => view.getVisible()).length), 0);

  await page.waitForFunction(() => document.hasFocus());
  await page.keyboard.press('Escape');
  await waitState(page, s => s.connections.find(c => c.id === challenged)?.status === 'closed');
  await app.chooseConnection(connectionId);
  await firstTabRow.click();
  console.log('Zoom and modal focus work; UI reload hides browser views and recovers pending authentication.');
  const originalTab = (await state()).workspaces[0].activeTab;
  await application.evaluate(async ({ webContents }) => {
    const browser = webContents.getAllWebContents().find(w => w.getURL().startsWith('http://localhost:'));
    await browser.executeJavaScript('for(let i=0;i<400;i++) window.open(location.origin + "/popup")');
  });
  assert.equal((await state()).workspaces[0].tabs.length, 2);
  await page.evaluate(async id => {
    for (let i = 0; i < 30; i++) await window.bartizan.browser(id, 'new');
  }, workspaceId);
  await assert.rejects(page.evaluate(id => window.bartizan.browser(id, 'new'), workspaceId), /Tab limit reached/);
  for (const tab of (await state()).workspaces[0].tabs) if (tab.id !== originalTab) await api('browser', workspaceId, 'close', tab.id);
  console.log('New-window links open within their session; popup floods and total tabs are bounded.');

  await page.evaluate(({id, port}) => window.bartizan.browser(id, 'navigate', undefined, `http://localhost:${port}/second`), {id:workspaceId, port:httpPort});
  await waitState(page, s => s.workspaces[0]?.tabs[0]?.url.endsWith('/second') && !s.workspaces[0]?.tabs[0]?.loading);
  await application.evaluate(({ webContents }) => {
    webContents.getAllWebContents().find(w => w.getURL().startsWith('http://localhost:')).session.webRequest.onBeforeRequest({ urls: ['http://localhost:*/*'] }, (_details, callback) => callback({ cancel: true }));
  });
  await page.evaluate(id => window.bartizan.browser(id, 'back'), workspaceId);
  const backFailure = await waitState(page, s => s.workspaces[0]?.tabs[0]?.error === 'ERR_BLOCKED_BY_CLIENT' && !s.workspaces[0]?.tabs[0]?.loading && !s.workspaces[0]?.tabs[0]?.url.endsWith('/second'));
  await page.locator('.browser-error').waitFor({ state: 'visible' });
  await page.evaluate(id => window.bartizan.browser(id, 'forward'), workspaceId);
  const forwardFailure = await waitState(page, s => s.workspaces[0]?.tabs[0]?.error === 'ERR_BLOCKED_BY_CLIENT' && !s.workspaces[0]?.tabs[0]?.loading && s.workspaces[0]?.tabs[0]?.url.endsWith('/second'));
  assert.equal(forwardFailure.workspaces[0].tabs[0].error, backFailure.workspaces[0].tabs[0].error);
  await page.locator('.browser-error').waitFor({ state: 'visible' });
  await application.evaluate(({ webContents }) => {
    webContents.getAllWebContents().find(w => w.getURL().startsWith('http://localhost:')).session.webRequest.onBeforeRequest(null);
  });
  await page.evaluate(id => window.bartizan.browser(id, 'reload'), workspaceId);
  await waitState(page, s => !s.workspaces[0]?.tabs[0]?.error && !s.workspaces[0]?.tabs[0]?.loading && s.workspaces[0]?.tabs[0]?.title === 'Remote fixture');
  await page.locator('.browser-error').waitFor({ state: 'hidden' });
  console.log('Repeated identical history errors remain visible, and successful navigation clears them.');
}
