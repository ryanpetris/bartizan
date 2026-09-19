import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { join } from 'node:path';
import { launch, sshProfile, startSshd, waitFor, withDirectory } from './lib/harness.mjs';

await withDirectory('tls', async (directory, cleanup) => {
  const requests = [];
  const served = path => requests.filter(request => request.url === path);
  const certificate = async name => {
    const path = join(directory, name);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', `${path}.key`, '-out', `${path}.pem`, '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-addext', 'basicConstraints=CA:FALSE', '-addext', 'extendedKeyUsage=serverAuth', '-days', '1'], { stdio: 'ignore' });
    return { key: await readFile(`${path}.key`), cert: await readFile(`${path}.pem`) };
  };
  const fingerprint = options => new X509Certificate(options.cert).fingerprint256;
  const handler = (request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, method: request.method, body });
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'text/html');
      response.end(request.url === '/data' ? 'resource passed' : '<title>TLS fixture</title><h1>TLS fixture</h1>');
    });
  };
  const sockets = new Set();
  const listen = async server => {
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }));
    return server.address().port;
  };
  const fixture = await certificate('fixture'), dated = await certificate('dated'), named = await certificate('named');
  const secure = httpsServer(fixture, handler);
  secure.on('upgrade', (request, socket) => {
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(Buffer.from([0x81, 2, 111, 107]));
  });
  const port = await listen(secure), otherPort = await listen(httpsServer(fixture, handler)), crashPort = await listen(httpsServer(fixture, handler));
  const datedPort = await listen(httpsServer(dated, handler)), namedPort = await listen(httpsServer(named, handler));
  const plainPort = await listen(httpServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<title>Plain fixture</title><form method="post" action="https://localhost:${otherPort}/post"><input name="value" value="original body"></form>`);
  }));
  const url = (path, at = port) => `https://localhost:${at}${path}`;
  const plain = `http://localhost:${plainPort}/`;

  const sshd = await startSshd(directory); cleanup(sshd.stop);
  const config = join(directory, 'config.yaml');
  await writeFile(config, `version: 1\nprofiles:\n  fixture:\n${sshProfile(sshd)}`);
  const app = await launch(directory, config); cleanup(app.close);
  const { application, page, api, state, waitState, errors } = app;
  await application.evaluate(({ app }) => {
    globalThis.rigCertificateErrors = [];
    app.on('web-contents-created', (_event, contents) => contents.on('certificate-error', (_error, address) => globalThis.rigCertificateErrors.push(address)));
  });
  const connection = await api('connect', { profileId: 'fixture' });
  await waitState(s => s.connections[0]?.status === 'connected', 'connection');
  await app.chooseConnection(connection);

  const tabOf = (s, tabId) => s.workspaces.flatMap(workspace => workspace.tabs).find(tab => tab.id === tabId);
  const warning = async tabId => tabOf(await waitState(s => tabOf(s, tabId)?.certificate, 'certificate warning'), tabId).certificate;
  const settled = (tabId, check = () => true) => waitState(s => { const tab = tabOf(s, tabId); return tab && !tab.loading && !tab.certificate && check(tab); }, 'tab to settle');
  const loaded = tabId => settled(tabId, tab => tab.title === 'TLS fixture' && !tab.error);
  const newSession = async () => {
    const session = await api('newBrowser', connection);
    const tabs = s => s.workspaces.find(workspace => workspace.id === session)?.tabs;
    return { session, tab: tabs(await waitState(s => tabs(s)?.length, 'browser session'))[0].id };
  };
  const newestGuest = () => application.evaluate(({ BrowserWindow, webContents }) => Math.max(...webContents.getAllWebContents().filter(contents => contents.getType() === 'window' && contents !== BrowserWindow.getAllWindows()[0].webContents).map(contents => contents.id)));
  const inGuest = (id, script) => application.evaluate(({ webContents }, { id, script }) => webContents.fromId(id).executeJavaScript(script), { id, script });
  const follow = (id, address) => inGuest(id, `location.href = ${JSON.stringify(address)}; void 0`);
  const select = tabId => page.locator(`.nav-item[data-kind="tab"][data-id="${tabId}"]`).click();
  const warningView = page.locator('.certificate-warning');

  const { session, tab: first } = await newSession();
  await select(first);
  await api('browser', session, 'navigate', first, url('/initial'));
  let challenge = await warning(first);
  assert.equal(challenge.error, 'net::ERR_CERT_AUTHORITY_INVALID');
  assert.equal(served('/initial').length, 0);
  const firstGuest = await newestGuest();
  assert.equal(await application.evaluate(async ({ webContents, ipcMain }, { id, guest }) => {
    const contents = webContents.fromId(guest);
    try { await ipcMain._invokeHandlers.get('request')({ sender: contents, senderFrame: contents.mainFrame }, { id: 1, method: 'certificate-answer', args: [id, true] }); return 'answered'; }
    catch (error) { return error.message; }
  }, { id: challenge.id, guest: firstGuest }), 'Untrusted caller');
  await expect(warningView.locator('h2')).toHaveText('Untrusted Certificate');
  await expect(warningView.locator('.dialog-context')).toHaveText(`https://localhost:${port}`);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter(view => view.getVisible()).length), 0);

  // Developer tools open in a view docked beside the page, and the same control or key closes them again.
  const toolsOpen = async () => (await app.state()).workspaces.find(w => w.id === session).tabs.find(t => t.id === first).devtools;
  const toolsViews = () => application.evaluate(({ webContents }) => webContents.getAllWebContents().filter(contents => contents.getURL().startsWith('devtools://')).length);
  const closeTools = async () => {
    await api('browser', session, 'devtools', first);
    await expect.poll(toolsOpen).toBe(false);
    await expect.poll(toolsViews).toBe(0);
  };
  await page.getByRole('button', { name: 'Developer Tools', exact: true }).click();
  await expect.poll(toolsOpen).toBe(true);
  await expect(page.getByRole('button', { name: 'Developer Tools', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(toolsViews).toBe(1);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  assert.equal((await warning(first)).id, challenge.id);
  await closeTools();
  await page.getByRole('textbox', { name: 'Address', exact: true }).focus();
  await page.keyboard.press('F12');
  await expect.poll(toolsOpen).toBe(true);
  await closeTools();

  await warningView.getByRole('button', { name: 'Cancel', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(warningView.getByRole('button', { name: 'Proceed', exact: true })).toBeFocused();
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(800, 650); window.webContents.setZoomFactor(1.25); });
  await expect.poll(() => warningView.evaluate(node => node.scrollWidth <= node.clientWidth + 1 && node.clientWidth < 700)).toBe(true);
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.webContents.setZoomFactor(1); window.setSize(1250, 820); });
  await warningView.getByRole('button', { name: 'Proceed', exact: true }).click();
  await loaded(first);
  assert.equal(served('/initial').length, 1);
  assert.equal(await api('answerCertificate', challenge.id, true), false);
  for (const modifiers of [['control', 'shift'], ['meta', 'alt']]) {
    await application.evaluate(({ webContents }, { id, modifiers }) => webContents.fromId(id).sendInputEvent({ type: 'keyDown', keyCode: 'I', modifiers }), { id: firstGuest, modifiers });
    await expect.poll(toolsOpen).toBe(true);
    await closeTools();
  }
  console.log('A certificate warning holds its request until Proceed continues it once; only the app can answer it, and tab Developer Tools leave it pending.');

  await api('browser', session, 'new', undefined, url('/second'));
  const second = (await waitState(s => s.workspaces[0].tabs[1])).workspaces[0].tabs[1].id;
  await loaded(second);
  const secondGuest = await newestGuest();
  assert.deepEqual(await inGuest(secondGuest, `Promise.all([
    fetch('/data').then(response => response.text()),
    new Promise(resolve => { const frame = document.createElement('iframe'); frame.src = '/frame'; frame.onload = () => resolve('frame'); document.body.append(frame); }),
    new Promise(resolve => { const socket = new WebSocket('wss://localhost:${port}/socket'); socket.onmessage = event => { resolve(event.data); socket.close(); }; socket.onerror = () => resolve('error'); }),
    fetch('${url('/unapproved', otherPort)}', { mode: 'no-cors' }).then(() => 'loaded', () => 'blocked'),
    navigator.serviceWorker.register('/worker.js').then(() => 'registered', () => 'refused'),
  ])`), ['resource passed', 'frame', 'ok', 'blocked', 'refused']);
  assert.equal(await application.evaluate(async ({ webContents }, { id, address }) => {
    try { await webContents.fromId(id).session.fetch(address); return 'fetched'; } catch { return 'refused'; }
  }, { id: secondGuest, address: url('/background', otherPort) }), 'refused');
  assert.equal(served('/unapproved').length + served('/background').length, 0);
  assert.equal(tabOf(await state(), second).certificate, undefined);
  console.log('Tabs, fetch, frames and WebSockets in the session share an approved exception; subresources and background requests never ask.');

  const reached = async address => { await waitFor(() => application.evaluate((_, address) => globalThis.rigCertificateErrors.includes(address), address), `certificate error for ${address}`); };
  await select(second);
  await follow(secondGuest, url('/cancelled', otherPort));
  challenge = await warning(second);
  await warningView.getByRole('button', { name: 'Cancel', exact: true }).click();
  await settled(second, tab => tab.error);
  assert.equal(await api('answerCertificate', challenge.id, true), false);
  await follow(secondGuest, url('/muted', otherPort));
  await reached(url('/muted', otherPort));
  await settled(second);
  await follow(firstGuest, url('/sibling', otherPort));
  challenge = await warning(first);
  await api('answerCertificate', challenge.id, false);
  await settled(first);
  await application.evaluate(({ webContents }, id) => webContents.fromId(id).sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }), secondGuest);
  await follow(secondGuest, url('/after-enter', otherPort));
  await warning(second);
  await page.keyboard.press('Escape');
  await settled(second);
  await application.evaluate(({ webContents }, id) => {
    for (const type of ['mouseDown', 'mouseUp']) webContents.fromId(id).sendInputEvent({ type, button: 'left', x: 20, y: 20, clickCount: 1 });
  }, secondGuest);
  await follow(secondGuest, url('/after-click', otherPort));
  challenge = await warning(second);
  await api('browser', session, 'stop', second);
  await settled(second);
  assert.equal(await api('answerCertificate', challenge.id, true), false);
  await api('browser', session, 'reload', second);
  challenge = await warning(second);
  await api('browser', session, 'navigate', second, plain);
  await settled(second, tab => tab.title === 'Plain fixture');
  assert.equal(await api('answerCertificate', challenge.id, true), false);
  assert.equal(served('/cancelled').length + served('/muted').length + served('/sibling').length + served('/after-enter').length + served('/after-click').length, 0);
  console.log('Cancel, Escape, Stop and navigation end a warning; the tab alone stays quiet until a click, Enter or a navigation from the app.');

  await inGuest(secondGuest, `setTimeout(() => window.stop(), 2000); location.href = ${JSON.stringify(url('/window-stop', otherPort))}; void 0`);
  challenge = await warning(second);
  await settled(second);
  assert.equal(await api('answerCertificate', challenge.id, true), false);
  await api('browser', session, 'navigate', second, plain);
  await settled(second, tab => tab.title === 'Plain fixture');
  await inGuest(secondGuest, 'document.querySelector("form").submit(); void 0');
  challenge = await warning(second);
  assert.equal(served('/post').length, 0);
  await api('answerCertificate', challenge.id, true);
  await loaded(second);
  assert.deepEqual(served('/post'), [{ url: '/post', method: 'POST', body: 'value=original+body' }]);
  await follow(secondGuest, url('/crash', crashPort));
  challenge = await warning(second);
  await application.evaluate(({ webContents }, id) => process.kill(webContents.fromId(id).getOSProcessId(), 'SIGKILL'), secondGuest);
  await waitState(s => !tabOf(s, second).certificate, 'warning to close');
  assert.equal(await api('answerCertificate', challenge.id, true), false);
  console.log('A page stopping its navigation or a renderer crash ends a warning, and an approved form submission is sent once with its body.');

  await application.evaluate(({ webContents }, { id, codes }) => webContents.fromId(id).session.setCertificateVerifyProc((request, callback) => {
    const { X509Certificate } = process.getBuiltinModule('node:crypto');
    callback(codes[new X509Certificate(request.certificate.data).fingerprint256] ?? -3);
  }), { id: firstGuest, codes: { [fingerprint(dated)]: -201, [fingerprint(named)]: -200 } });
  for (const [at, error, title] of [[datedPort, 'net::ERR_CERT_DATE_INVALID', 'Certificate Date Invalid'], [namedPort, 'net::ERR_CERT_COMMON_NAME_INVALID', 'Certificate Name Mismatch']]) {
    await select(first);
    await api('browser', session, 'navigate', first, url('/type', at));
    assert.equal((await warning(first)).error, error);
    await expect(warningView.locator('h2')).toHaveText(title);
    await warningView.getByRole('button', { name: 'Proceed', exact: true }).click();
    await loaded(first);
  }
  await application.evaluate(async ({ webContents }, id) => { const { session } = webContents.fromId(id); session.setCertificateVerifyProc(null); await session.closeAllConnections(); }, firstGuest);
  secure.setSecureContext(await certificate('replacement'));
  await api('browser', session, 'navigate', first, url('/replaced'));
  await api('answerCertificate', (await warning(first)).id, true);
  await loaded(first);
  console.log('Date and name errors can be approved, and a changed certificate asks again.');

  const other = await newSession();
  await api('browser', other.session, 'navigate', other.tab, url('/other-session'));
  challenge = await warning(other.tab);
  assert.equal(served('/other-session').length, 0);
  await api('disconnect', connection);
  await waitState(s => s.connections[0].status === 'closed' && !tabOf(s, other.tab).certificate && s.workspaces.length === 2, 'disconnect');
  assert.equal(await api('answerCertificate', challenge.id, true), false);
  await api('reconnect', connection);
  await waitState(s => s.connections[0].status === 'connected', 'reconnect');
  await api('browser', session, 'reload', first);
  await api('answerCertificate', (await warning(first)).id, true);
  await loaded(first);
  console.log('Each browser session approves on its own, and disconnecting ends pending warnings and forgets exceptions while keeping sessions.');

  assert.equal(await application.evaluate(() => {
    const master = process._getActiveHandles().find(handle => handle.spawnfile === 'ssh' && handle.spawnargs.includes('-M'));
    return Boolean(master?.kill('SIGKILL'));
  }), true);
  await waitState(s => s.connections[0].status === 'closed' && s.workspaces.length === 2, 'severed connection');
  await api('browser', session, 'navigate', first, url('/severed'));
  await settled(first, tab => tab.error);
  assert.equal(served('/severed').length, 0);
  assert.deepEqual(errors, []);
  console.log('A severed SSH transport leaves browser sessions without a network path.');
});
