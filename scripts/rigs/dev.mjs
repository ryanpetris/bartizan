import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { withDirectory, freePort, waitFor, modalOf, graphicsArgs, startSshd, sshProfile } from './lib/harness.mjs';

await withDirectory('dev', async (directory, cleanup) => {
  const checkout = join(directory, 'checkout');
  await mkdir(checkout);
  for (const name of ['package.json', 'electron.vite.config.mjs', 'tsconfig.json', 'src', 'assets'])
    await cp(name, join(checkout, name), { recursive: true });
  await symlink(resolve('node_modules'), join(checkout, 'node_modules'), 'dir');
  const sshd = await startSshd(directory);
  cleanup(sshd.stop);
  const config = join(directory, 'config.yaml');
  await writeFile(config, `version: 1\nprofiles:\n  rig:\n${sshProfile(sshd)}`);
  const port = await freePort();
  const child = spawn('npm', ['run', 'dev', '--', '--remoteDebuggingPort', String(port), '--', '--config', config, ...graphicsArgs], {
    cwd: checkout, detached: true,
    env: { ...process.env, BARTIZAN_DATA_DIR: join(directory, 'state') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  cleanup(async () => {
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit');
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await exited;
  });
  let browser;
  cleanup(() => browser?.close());
  try {
    const attach = async () => {
      await waitFor(async () => {
        if (child.exitCode !== null) throw new Error(log);
        return fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.ok).catch(() => false);
      }, 'development Electron debugger', 40000);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      browser.contexts()[0].setDefaultTimeout(20000);
      const page = await waitFor(() => browser.contexts()[0].pages().find(page => page.url().startsWith('http://127.0.0.1:')), 'development renderer');
      page.on('console', message => { log += `\nrenderer ${message.type()}: ${message.text()}`; });
      page.on('pageerror', error => { log += `\nrenderer error: ${error.message}`; });
      page.on('requestfailed', request => { log += `\nrequest failed: ${request.url()} ${request.failure()?.errorText}`; });
      await page.locator('.home-view').waitFor();
      return page;
    };
    let page = await attach();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const api = (name, ...values) => page.evaluate(({ name, values }) => window.bartizan[name](...values), { name, values });
    const edit = async (name, change) => {
      const path = join(checkout, 'src', name);
      await writeFile(path, change(await readFile(path, 'utf8')));
    };
    const connection = await api('connect', { profileId: 'rig' });
    await expect(page.locator('.connection-chip')).toHaveCount(1);
    const connected = () => page.evaluate(async id => (await import('/store.ts')).store.state.connections.find(item => item.id === id)?.status, connection);
    await expect.poll(connected).toBe('connected');
    await page.evaluate(() => { window.rigDocument = true; });
    await page.getByRole('button', { name: 'New Connection', exact: true }).click();
    let modal = await modalOf(page);
    const connectSearch = page.getByRole('combobox', { name: 'Profile or Host', exact: true });
    await connectSearch.fill('refresh-state');
    await edit('renderer/picker.tsx', source => source.replace('placeholder="Search"', 'placeholder="Refreshed"'));
    await expect(connectSearch).toHaveAttribute('placeholder', 'Refreshed');
    assert.equal(await page.evaluate(() => window.rigDocument), true, 'Component refresh keeps the document');
    await expect(connectSearch).toHaveValue('refresh-state');
    await edit('renderer/style.css', source => `${source}\n:root { --rig-style: refreshed; }\n`);
    for (const target of [page, modal]) await expect.poll(() => target.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--rig-style').trim())).toBe('refreshed');
    assert.equal(await page.evaluate(() => window.rigDocument), true, 'CSS updates keep the document');
    assert.equal(await page.evaluate(async () => { await document.fonts.load('13px "Bartizan JetBrains Mono"'); return document.fonts.check('13px "Bartizan JetBrains Mono"'); }), true);
    assert.equal(await page.evaluate(async () => {
      const { installedFonts } = await import('/fonts.tsx');
      return (await installedFonts()).monospace.length > 0;
    }), true, 'Local font access and its module worker work in development');
    await edit('main/preload.ts', source => `${source}\ncontextBridge.exposeInMainWorld('rigPreload', true);\n`);
    await page.waitForFunction(() => window.rigPreload === true);
    assert.equal(await page.evaluate(() => window.rigDocument), undefined, 'Preload rebuild reloads the page');
    await page.locator('.home-view').waitFor();
    assert.ok(await api('details', connection), 'The SSH connection survives a renderer reload');
    await expect.poll(connected).toBe('connected');
    modal = await modalOf(page);
    await page.getByRole('button', { name: 'New Connection', exact: true }).click();
    await expect(page.locator('.connect')).toBeVisible();
    await page.evaluate(() => { window.rigDocument = true; });
    await edit('renderer/overlay.tsx', source => `${source}\n// rig overlay edit\n`);
    await page.waitForFunction(() => window.rigDocument === undefined);
    await modalOf(page);
    await edit('main/main.ts', source => source.replace("title: 'Bartizan'", "title: 'Development rig'"));
    await waitFor(() => !browser.isConnected(), 'Electron restart');
    page = await attach();
    await expect(page.locator('.connection-chip')).toHaveCount(0);
    await api('capabilities');
    assert.deepEqual(errors, []);
    console.log('Development launch, React state, overlay CSS, fonts, preload and overlay reloads, SSH survival, and main restart passed.');
  } catch (error) {
    console.error(log);
    throw error;
  }
});
