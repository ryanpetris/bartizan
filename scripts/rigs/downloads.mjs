// Drives the browser sessions' native save dialogs. The rig bundles the browser module and runs it in Electron under a
// private D-Bus session, so the dialog is a GTK window that xdotool can answer.
import electron from 'electron';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { app, BrowserWindow } = electron;

if (typeof electron === 'string') {
  const { build } = await import('esbuild');
  const { withDirectory } = await import('./lib/harness.mjs');
  await withDirectory('downloads', async directory => {
    await build({ entryPoints: [fileURLToPath(new URL('../../src/main/browser.ts', import.meta.url))], outfile: join(directory, 'browser.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['electron'], logLevel: 'error' });
    const home = name => { mkdirSync(join(directory, name)); return join(directory, name); };
    // Services the session bus starts can keep output pipes open after Electron exits, so the rig waits for the exit.
    const child = spawn('dbus-run-session', ['--', electron, fileURLToPath(import.meta.url)], {
      env: { ...process.env, BARTIZAN_DOWNLOADS_RIG: directory, XDG_CONFIG_HOME: home('config'), XDG_CACHE_HOME: home('cache'), XDG_DATA_HOME: home('data'), LC_ALL: 'C' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise(resolve => child.once('exit', resolve));
    child.stdout.destroy(); child.stderr.destroy();
    process.stdout.write(stdout);
    if (code !== 0) throw new Error(`Download rig failed with ${code}\n${stderr}`);
  });
} else {
  const directory = process.env.BARTIZAN_DOWNLOADS_RIG;
  app.setPath('userData', join(directory, 'state'));
  app.setPath('downloads', join(directory, 'downloads'));
  app.enableSandbox();
  app.whenReady()
    .then(() => import(pathToFileURL(join(directory, 'browser.mjs')).href))
    .then(({ Browsers }) => run(Browsers))
    .then(() => app.exit(0), error => { console.error(error); app.exit(1); });
}

async function run(Browsers) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (predicate, message) => {
    for (const deadline = Date.now() + 20000; !predicate(); await sleep(50)) if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
  };
  const dialogs = () => execFileSync('xwininfo', ['-root', '-tree'], { encoding: 'utf8' }).split('\n').filter(line => line.includes('"Save Download"'));
  /** Answers the open save dialog with keys: Escape cancels it and Alt+S saves under the suggested name. */
  const press = async key => {
    execFileSync('xdotool', ['windowfocus', '--sync', dialogs()[0].trim().split(' ')[0], 'key', key]);
    await until(() => dialogs().length === 0, 'the save dialog to close');
  };

  const server = createServer((request, response) => {
    if (request.url.startsWith('/slow')) {
      response.setHeader('Content-Disposition', `attachment; filename="ongoing-${request.url.slice(-1)}.bin"`);
      response.setHeader('Content-Length', 64 * 1024 * 1024);
      const timer = setInterval(() => response.write(Buffer.alloc(32768)), 20);
      response.once('close', () => clearInterval(timer));
    } else if (request.url.startsWith('/download')) {
      response.setHeader('Content-Disposition', 'attachment; filename="fixture.txt"');
      response.end('fixture');
    } else response.end('<title>Fixture</title><body>Downloads</body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const downloads = app.getPath('downloads');
  mkdirSync(downloads);
  const window = new BrowserWindow({ width: 900, height: 700, webPreferences: { sandbox: true } });
  await window.loadURL('data:text/html,Host');
  const browsers = new Browsers(window, () => {}, () => {}, () => {});
  const connection = { info: { id: 'fixture', profileId: 'fixture', status: 'connected' }, port: 1 };

  const counts = { accepted: 0, rejected: 0, cancelled: 0, completed: 0 };
  const total = () => counts.accepted + counts.rejected;
  const observe = (event, item) => {
    if (event.defaultPrevented) { counts.rejected++; return; }
    counts.accepted++;
    counts.last = item;
    item.once('done', (_event, state) => { if (state === 'cancelled') counts.cancelled++; if (state === 'completed') counts.completed++; });
  };
  /** Opens a tab on the fixture page, in a new browser session unless one is given, and shows it. */
  const tab = async session => {
    const id = await browsers.open(connection, undefined, session ?? 'new');
    const entry = browsers.entries.get(id);
    if (!session) {
      await entry.session.setProxy({ mode: 'direct' });
      entry.session.on('will-download', observe);
    }
    const [tabId, view] = [...entry.views].at(-1);
    await view.webContents.loadURL(`${origin}/`);
    browsers.show(id, { x: 0, y: 0, width: 900, height: 700 });
    return { id, entry, tabId, view };
  };
  const inPage = (view, script) => view.webContents.executeJavaScript(script);
  const burst = view => inPage(view, 'for (let i = 0; i < 10; i++) { const frame = document.createElement("iframe"); frame.src = "/download?" + i; document.body.append(frame); }');
  const closeItself = view => inPage(view, 'setTimeout(() => window.close(), 0)');

  const a = await tab();
  await burst(a.view);
  await until(() => total() === 10 && dialogs().length === 1, 'the first burst');
  assert.equal(counts.accepted, 1);
  const b = await tab(a.id);
  await burst(b.view);
  await until(() => total() === 20, 'the second tab burst');
  assert.equal(counts.accepted, 1);
  assert.equal(dialogs().length, 1);
  await assert.rejects(browsers.close(a.id), /Close the download dialog first/);
  await assert.rejects(browsers.action(a.id, 'close', b.tabId), /Close the download dialog first/);
  assert.equal(a.entry.views.size, 2);
  console.log('A browser session shows one save dialog at a time and keeps its tabs while it is open.');

  await press('Escape');
  await until(() => counts.cancelled === 1, 'the cancelled download');
  await burst(a.view);
  await until(() => total() === 30, 'the burst after cancelling');
  assert.equal(counts.accepted, 1);
  assert.equal(dialogs().length, 0);
  await burst(b.view);
  await until(() => total() === 40 && dialogs().length === 1, 'the other tab dialog');
  assert.equal(counts.accepted, 2);
  await press('Escape');
  await browsers.action(a.id, 'select', a.tabId);
  for (const type of ['mouseDown', 'mouseUp']) a.view.webContents.sendInputEvent({ type, button: 'left', x: 30, y: 30, clickCount: 1 });
  await burst(a.view);
  await until(() => total() === 50 && dialogs().length === 1, 'the dialog after a click');
  assert.equal(counts.accepted, 3);
  await press('Escape');
  await until(() => counts.cancelled === 3, 'the cancelled downloads');
  a.entry.session.off('will-download', observe);
  await browsers.close(a.id);
  const late = new Promise(resolve => a.entry.session.once('will-download', event => resolve(event.defaultPrevented)));
  a.entry.session.downloadURL(`${origin}/download?closed`);
  assert.equal(await late, true);
  assert.equal(dialogs().length, 0);
  console.log('Cancelling a save dialog quiets only its tab until the user clicks in it, and a closed session refuses downloads.');

  const d = await tab();
  await burst(d.view);
  await until(() => counts.accepted === 4 && dialogs().length === 1, 'the dialog before the page closes');
  await closeItself(d.view);
  await until(() => d.entry.views.size === 0, 'the page to close');
  assert.deepEqual(d.entry.info.tabs, []);
  await press('alt+s');
  await until(() => counts.completed === 1, 'the saved download');
  assert.ok(browsers.entries.has(d.id));
  assert.equal(counts.cancelled, 3);
  const saved = join(downloads, 'fixture.txt');
  assert.equal(readFileSync(saved, 'utf8'), 'fixture');
  rmSync(saved);
  await browsers.close(d.id);
  console.log('A page that closes itself leaves its download to be saved and its session open.');

  const c = await tab();
  await burst(c.view);
  await until(() => counts.accepted === 5 && dialogs().length === 1, 'the dialog before disconnecting');
  await browsers.closeConnection('fixture');
  assert.equal(browsers.entries.size, 0);
  await press('alt+s');
  await sleep(500);
  assert.deepEqual(readdirSync(downloads), []);
  console.log('Removing the connection closes its sessions, and saving a download from a dialog left open creates no file.');

  const unrelated = await tab();
  const e = await tab();
  await inPage(e.view, 'const frame = document.createElement("iframe"); frame.src = "/slow1"; document.body.append(frame)');
  await until(() => dialogs().length === 1, 'the dialog for the transfer');
  await closeItself(e.view);
  await until(() => e.entry.views.size === 0, 'the page to close');
  await press('alt+s');
  await until(() => counts.last.getReceivedBytes() > 0, 'the transfer to run');
  assert.equal(counts.last.getState(), 'progressing');
  let cancelled = counts.cancelled;
  assert.ok(browsers.entries.has(e.id));
  await browsers.close(e.id);
  await until(() => counts.last.getState() === 'cancelled', 'the transfer to stop');
  assert.equal(counts.cancelled, cancelled + 1);
  assert.equal(unrelated.entry.views.size, 1);
  await browsers.close(unrelated.id);
  console.log('A saved transfer continues after its page closes, and closing its session cancels it.');

  const f = await tab();
  await inPage(f.view, 'const frame = document.createElement("iframe"); frame.src = "/slow2"; document.body.append(frame)');
  await until(() => dialogs().length === 1, 'the dialog before disconnecting');
  await press('alt+s');
  await until(() => counts.last.getReceivedBytes() > 0, 'the transfer before disconnecting');
  assert.equal(counts.last.getState(), 'progressing');
  cancelled = counts.cancelled;
  browsers.sync([]);
  await until(() => counts.last.getState() === 'cancelled', 'the transfer to stop on disconnect');
  assert.equal(counts.cancelled, cancelled + 1);
  assert.ok(browsers.entries.has(f.id));
  await browsers.close(f.id);
  await until(() => readdirSync(downloads).length === 0, 'the cancelled transfers to remove their files');
  console.log('Disconnecting cancels running downloads and keeps the session.');
  server.close();
}
