// Runs inside the rig image, from scripts/screenshots.mjs, with the output directory, width and height as arguments:
// builds a synthetic workspace, shows it in each theme and writes the animated screenshot to the output directory.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDirectory, startSshd, sshProfile, launch, waitFor } from '../rigs/lib/harness.mjs';
import { writeWorkspace } from './workspace.mjs';
import { startSite } from './site.mjs';
import { encodeAnimatedPng } from './apng.mjs';

const [out, width, height] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])];
const seconds = 4;
const site = 'http://localhost:3000';

await withDirectory('screenshots', async (directory, cleanup) => {
  const demo = join(directory, 'demo');
  await mkdir(demo);
  const rc = await writeWorkspace(demo);
  const sshd = await startSshd(directory, { config: `ForceCommand /bin/bash --rcfile ${rc} -i\n` });
  cleanup(sshd.stop);
  const server = await startSite(3000);
  cleanup(() => server.close());
  const profile = (label, tags) => `    label: ${label}\n    tags: [${tags}]\n${sshProfile(sshd)}`;
  const config = join(directory, 'config.yaml');
  await writeFile(config, `version: 1\nsettings:\n  appearance: dark\nprofiles:\n  development:\n${profile('Development', 'demo')}  staging:\n${profile('Staging', 'staging')}  builds:\n${profile('Build Farm', 'ci')}`);
  const app = await launch(directory, config);
  cleanup(app.close);
  const { application, page, api, waitState, recordOutput, output, chooseConnection, errors } = app;
  await application.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), { x: 0, y: 0, width, height });
  await recordOutput();

  /** Opens a connection's first terminal, or another one, names it and runs a command in it once `clear` has cleared the screen. */
  const terminal = async (connection, name, command, done) => {
    const id = connection.first ?? (await api('newTerminal', connection.id));
    connection.first = undefined;
    await waitFor(async () => (await output(id)).includes('❯'), `${name} prompt`);
    // Input sent while `clear` runs would be echoed after it, so the command waits for the prompt that follows.
    const cleared = (await output(id)).length;
    await api('input', id, `title '${name}'; clear\n`);
    await waitFor(async () => (await output(id)).slice(cleared).includes('❯'), `${name} cleared`);
    if (command) {
      await api('input', id, `${command}\n`);
      await waitFor(async () => (await output(id)).includes(done), `${name} output`);
    }
    return id;
  };
  const connect = async profileId => {
    const id = await api('connect', { profileId });
    const state = await waitState(s => s.terminals.some(t => t.connectionId === id && t.status === 'connected'), `${profileId} terminal`);
    return { id, first: state.terminals.find(t => t.connectionId === id).id };
  };
  const development = await connect('development');
  await terminal(development, 'Workspace', 'git log --oneline --graph', 'Release 2.3.0');
  const build = await terminal(development, 'Build & tests', 'npm run check', 'Watching for changes');
  const logs = await terminal(development, 'Application logs', 'tail -f logs/app.log', 'GET /settings');
  await terminal(development, 'Release checklist', 'cat RELEASE.md', 'release notes');
  /** Opens a browser session with a tab for each path and gives it a name. */
  const session = async (name, paths) => {
    const id = await api('newBrowser', development.id);
    const tabs = s => s.workspaces.find(w => w.id === id)?.tabs ?? [];
    await api('browser', id, 'navigate', tabs(await waitState(s => tabs(s).length, `${name} session`))[0].id, site + paths[0]);
    for (const path of paths.slice(1)) await api('browser', id, 'new', undefined, site + path);
    const loaded = tab => tab.url.startsWith(site) && tab.title !== 'New Tab' && !tab.loading && !tab.error;
    await waitState(s => tabs(s).length === paths.length && tabs(s).every(loaded), `${name} pages`);
    await api('renameBrowser', id, name);
    return tabs(await app.state());
  };
  const [dashboard] = await session('Preview', ['/', '/settings']);
  await session('Docs', ['/docs/api', '/docs/changelog', '/docs/runbook']);
  for (const [profileId, name] of [['staging', 'Deploy'], ['builds', 'Runner']]) {
    const connection = await connect(profileId);
    await terminal(connection, name);
  }

  /** Captures the window with the site's page views drawn over it, as RGBA. A notification, an overlay or any other view fails it. */
  const capture = async () => {
    const { data, views } = await application.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const base = await window.webContents.capturePage();
      const views = [];
      for (const view of window.contentView.children) {
        if (!view.getVisible() || !view.webContents) continue;
        const image = await view.webContents.capturePage();
        const { width, height } = image.getSize();
        views.push({ url: view.webContents.getURL(), bounds: view.getBounds(), width, height, data: image.toBitmap().toString('base64') });
      }
      return { data: base.toBitmap().toString('base64'), views };
    });
    const pixels = Buffer.from(data, 'base64');
    if (pixels.length !== width * height * 4) throw new Error(`Expected a ${width}×${height} capture`);
    for (const { url, bounds, ...view } of views)
      if (!url.startsWith(site)) throw new Error(`A view other than the site's pages is showing: ${url}`);
      else if (bounds.x < 0 || bounds.y < 0 || view.width !== bounds.width || view.height !== bounds.height) throw new Error(`A view captured at ${view.width}×${view.height} has bounds ${JSON.stringify(bounds)}`);
    for (const view of views) {
      const source = Buffer.from(view.data, 'base64');
      for (let y = 0; y < view.height && view.bounds.y + y < height; y++) {
        const start = y * view.width * 4, end = start + Math.min(view.width, width - view.bounds.x) * 4;
        source.copy(pixels, ((view.bounds.y + y) * width + view.bounds.x) * 4, start, end);
      }
    }
    // Electron's bitmaps are BGRA. Overlays are transparent around what they show, so every pixel must be opaque.
    for (let i = 0; i < pixels.length; i += 4) {
      [pixels[i], pixels[i + 2]] = [pixels[i + 2], pixels[i]];
      if (pixels[i + 3] !== 255) throw new Error('The capture has transparent pixels');
    }
    return pixels;
  };
  const rows = { rail: `[data-kind="terminal"][data-id="${build}"]`, tabs: `[data-kind="tab"][data-id="${dashboard.id}"]`, console: `[data-kind="terminal"][data-id="${logs}"]` };
  const frames = [];
  for (const [theme, row] of Object.entries(rows)) {
    await api('settings', { theme });
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    await chooseConnection(development.id);
    await page.locator(row).click();
    await page.mouse.move(width - 300, height - 200);
    await page.waitForTimeout(1500);
    if (await page.locator('[data-sonner-toast]').count()) throw new Error(`${theme}: a notification is showing`);
    frames.push(await capture());
    console.log(`Captured ${theme}.`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  await writeFile(join(out, 'bartizan.png'), encodeAnimatedPng(frames, width, height, seconds));
});
