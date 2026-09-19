import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { browse } from './browser-lifecycle.mjs';

const username = 'web-user', password = 'web-password', nonce = 'fixture-nonce';
const md5 = value => createHash('md5').update(value).digest('hex');
export function handleAuthentication(req, res) {
  const url = new URL(req.url, 'http://fixture.invalid');
  if (!url.pathname.startsWith('/auth/')) return false;
  const scheme = url.pathname.includes('digest') ? 'digest' : 'basic';
  const realm = `Fixture ${url.searchParams.get('realm') ?? scheme}`;
  const authorization = req.headers.authorization ?? '';
  let authenticated = authorization === `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  if (scheme === 'digest') {
    const values = Object.fromEntries([...authorization.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map(match => [match[1], match[2] ?? match[3]]));
    const response = md5(`${md5(`${username}:${realm}:${password}`)}:${nonce}:${values.nc}:${values.cnonce}:auth:${md5(`${req.method}:${values.uri}`)}`);
    authenticated = authorization.startsWith('Digest ') && values.username === username && values.realm === realm && values.nonce === nonce && values.qop === 'auth' && values.uri === req.url && values.response === response;
  }
  res.setHeader('Content-Type', 'text/html');
  if (!authenticated || url.pathname.includes('cancel')) {
    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', scheme === 'basic' ? `Basic realm=${JSON.stringify(realm)}, charset="UTF-8"` : `Digest realm=${JSON.stringify(realm)}, nonce="${nonce}", qop="auth", algorithm=MD5`);
    res.end('<title>Authentication required</title>Authentication required');
  } else res.end(`<title>Authenticated ${scheme}</title>Authenticated ${scheme}`);
  return true;
}

export async function testAuthentication(app, port, connectionId) {
  const { application, page, state } = app;
  const wait = async predicate => {
    for (let i = 0; i < 150; i++) { const value = await state(); if (predicate(value)) return value; await page.waitForTimeout(100); }
    throw new Error('Browser authentication timed out');
  };
  const pending = value => value.challenges.filter(challenge => 'workspaceId' in challenge);
  let workspaceId;
  const workspace = value => value.workspaces.find(entry => entry.id === workspaceId);
  const action = (operation, tab, url) => page.evaluate(({ id, operation, tab, url }) => window.bartizan.browser(id, operation, tab, url), { id: workspaceId, operation, tab, url });
  const open = async url => { if (!workspace(await state())) workspaceId = await browse(app, connectionId, url); else await action('new', undefined, url); };
  const navigate = url => action('navigate', undefined, url);
  await open( `http://localhost:${port}/auth/basic`);
  let current = await wait(value => pending(value).length === 1);
  const tabId = workspace(current).activeTab;
  const first = pending(current)[0];
  assert.equal(first.workspaceId, workspaceId); assert.equal(first.origin, `http://localhost:${port}`); assert.equal(first.scheme, 'basic');
  await assert.rejects(page.evaluate(id => window.bartizan.answer(id, { username: 'web-user', password: 'x'.repeat(4097) }), first.id));
  assert.equal(pending(await state())[0].id, first.id);
  await page.evaluate(id => window.bartizan.answer(id, { username: 'wrong', password: 'wrong' }), first.id);
  current = await wait(value => pending(value).length === 1 && pending(value)[0].id !== first.id);
  const retry = pending(current)[0];
  await page.reload();
  const dialog = (await app.modal()).locator('#auth-dialog');
  await dialog.waitFor({ state: 'visible' });
  assert.equal(pending(await state())[0].id, retry.id);
  assert.ok((await dialog.textContent()).includes(`http://localhost:${port}`));
  await dialog.getByLabel('Username', { exact: true }).fill(username);
  await dialog.getByLabel('Password', { exact: true }).fill(password);
  await dialog.getByRole('button', { name: 'Sign In', exact: true }).click();
  await wait(value => !pending(value).length && workspace(value).tabs.find(tab => tab.id === tabId)?.title === 'Authenticated basic');
  assert.equal(await dialog.locator('input').count(), 0);
  assert.ok(!JSON.stringify(await state()).includes(password));

  await navigate(`http://localhost:${port}/auth/digest`);
  current = await wait(value => pending(value).length === 1);
  assert.equal(pending(current)[0].scheme, 'digest');
  await dialog.getByLabel('Username', { exact: true }).fill(username);
  await dialog.getByLabel('Password', { exact: true }).fill(password);
  await dialog.getByRole('button', { name: 'Sign In', exact: true }).click();
  await wait(value => !pending(value).length && workspace(value).tabs.find(tab => tab.id === tabId)?.title === 'Authenticated digest');

  await navigate(`http://localhost:${port}/auth/cancel?realm=cancel`);
  await wait(value => pending(value).length === 1);
  const ssh = await app.api('connect', { profileId: 'ask' });
  await wait(value => value.challenges.some(challenge => challenge.connectionId === ssh));
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await wait(value => !pending(value).length);
  assert.equal((await state()).connections.find(connection => connection.id === connectionId)?.status, 'connected');
  await dialog.getByRole('button', { name: 'Trust Host', exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await wait(value => value.connections.find(connection => connection.id === ssh)?.status === 'closed');
  const guestId = await application.evaluate(({ webContents }) => webContents.getAllWebContents().find(contents => contents.getURL().includes('/auth/cancel'))?.id);
  assert.ok(guestId);
  await application.evaluate(async ({ webContents }, id) => {
    await webContents.fromId(id).executeJavaScript("document.body.dispatchEvent(new MouseEvent('mousedown', {bubbles:true})); fetch('/auth/cancel?realm=automatic').catch(() => {}); void 0");
  }, guestId);
  await page.waitForTimeout(300);
  assert.equal(pending(await state()).length, 0);
  const tabCount = workspace(await state()).tabs.length;
  await application.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript("window.open(location.origin + '/auth/cancel?realm=popup'); void 0"), guestId);
  await page.waitForTimeout(300);
  assert.equal(workspace(await state()).tabs.length, tabCount);
  assert.equal(pending(await state()).length, 0);
  await navigate(`http://localhost:${port}/auth/cancel?realm=retry`);
  await wait(value => pending(value).length === 1);
  await action('close', tabId);
  await wait(value => !pending(value).length && workspace(value)?.tabs.length === 0);
  assert.equal(await dialog.locator('input').count(), 0);
  const longRealm = 'r'.repeat(3900);
  await open( `http://localhost:${port}/auth/cancel?realm=${longRealm}`);
  await wait(value => pending(value).length === 1);
  assert.ok((await dialog.locator('dd').last().textContent()).length <= 81);
  const originVisible = await dialog.locator('dd').first().evaluate(element => {
    const bounds = element.getBoundingClientRect(), dialog = element.closest('dialog').getBoundingClientRect();
    return bounds.top >= dialog.top && bounds.bottom <= dialog.bottom;
  });
  assert.equal(originVisible, true);
  await navigate(`http://localhost:${port}/plain`);
  await wait(value => !pending(value).length);
  await action('close');
  for (let i = 0; i < 2; i++) await open( `http://127.0.0.1:${port}/auth/basic?realm=shared`);
  current = await wait(value => pending(value).length === 2);
  await page.evaluate(id => window.bartizan.answer(id, { username: 'web-user', password: 'web-password' }), pending(current)[0].id);
  await wait(value => !pending(value).length && workspace(value).tabs.every(tab => tab.title === 'Authenticated basic'));
  for (const tab of workspace(await state()).tabs) await action('close', tab.id);
  console.log('HTTP Basic and Digest sign-in, retry, UI reload, mixed SSH authentication, cancellation suppression and tab cleanup passed through SSH.');
}
