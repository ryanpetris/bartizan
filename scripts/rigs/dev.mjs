import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { withDirectory, freePort, waitFor, modalOf, popupOf, tooltipOf, graphicsArgs, startSshd, sshProfile } from './lib/harness.mjs';

await withDirectory('dev', async (directory, cleanup) => {
  const checkout = join(directory, 'checkout');
  await mkdir(checkout);
  for (const name of ['package.json', 'electron.vite.config.mjs', 'tsconfig.json', 'src', 'assets'])
    await cp(name, join(checkout, name), { recursive: true });
  await mkdir(join(checkout, 'scripts'));
  await cp('scripts/python-archive.mjs', join(checkout, 'scripts/python-archive.mjs'));
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
    const helperDirectory = join(checkout, 'src/main/remote-helper/helper');
    await writeFile(join(helperDirectory, '.sessions.py.swp'), 'editor swap');
    await mkdir(join(helperDirectory, '__pycache__'));
    await writeFile(join(helperDirectory, '__pycache__/sessions.pyc'), 'bytecode');
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.ok(browser.isConnected(), 'Non-source helper files must not restart Electron');
    await expect.poll(connected).toBe('connected');
    // Requests from an overlay are slow, so one that drops its loaded stylesheets shows its content unstyled for a while.
    const slow = async target => {
      const session = await page.context().newCDPSession(target);
      await session.send('Network.enable');
      await session.send('Network.emulateNetworkConditions', { offline: false, latency: 500, downloadThroughput: -1, uploadThroughput: -1 });
      return session;
    };
    // Every 20 ms for `duration`, the computed `property` of the first `selector` in `target`, or `missing`.
    // With `until`, a custom property and value, sampling stops once the root has that value and fails if it takes longer than `duration`.
    const styles = (target, selector, property, duration, until) => target.evaluate(({ selector, property, duration, until }) => new Promise((resolve, reject) => {
      const seen = new Set(), start = performance.now();
      const sample = () => {
        const node = document.querySelector(selector);
        seen.add(node ? getComputedStyle(node)[property] : 'missing');
        if (until && getComputedStyle(document.documentElement).getPropertyValue(until[0]).trim() === until[1]) resolve([...seen]);
        else if (performance.now() - start < duration) setTimeout(sample, 20);
        else if (until) reject(new Error(`${until[0]} is not ${until[1]} after ${duration} ms`));
        else resolve([...seen]);
      };
      sample();
    }), { selector, property, duration, until });
    const churn = () => page.evaluate(async () => {
      const { render } = await import('/store.ts');
      const timer = setInterval(render, 20);
      setTimeout(() => clearInterval(timer), 1500);
    });
    await page.locator('.connection-titles').click();
    const popup = await popupOf(page);
    await slow(popup);
    await churn();
    await page.locator('.connection-add').click();
    await popup.locator('.menu').waitFor();
    assert.deepEqual(await styles(popup, '.menu', 'borderTopStyle', 1200), ['solid'], 'Renders keep the menu styled');
    await popup.keyboard.press('Escape');
    await expect(popup.locator('.menu')).toHaveCount(0);
    const tooltip = await tooltipOf(page);
    await slow(tooltip);
    await page.mouse.move(0, 0);
    await churn();
    await page.locator('.connection-add').hover();
    await tooltip.locator('.tooltip').waitFor();
    assert.deepEqual(await styles(tooltip, '.tooltip', 'borderTopStyle', 1200), ['solid'], 'Renders keep the tooltip styled');
    await page.mouse.move(0, 0);
    await expect(page.locator('.connection-chip')).toHaveCount(1);
    await page.evaluate(() => { window.rigDocument = true; });
    await page.getByRole('button', { name: 'New Connection', exact: true }).click();
    let modal = await modalOf(page);
    const connectSearch = page.getByRole('combobox', { name: 'Profile or Host', exact: true });
    await connectSearch.fill('refresh-state');
    await edit('renderer/picker.tsx', source => source.replace('placeholder="Search"', 'placeholder="Refreshed"'));
    await expect(connectSearch).toHaveAttribute('placeholder', 'Refreshed');
    assert.equal(await page.evaluate(() => window.rigDocument), true, 'Component refresh keeps the document');
    await expect(connectSearch).toHaveValue('refresh-state');
    const property = (target, name) => target.evaluate(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), name);
    const network = await slow(modal);
    const [reloading] = await Promise.all([
      styles(modal, 'dialog', 'paddingTop', 20000, ['--rig-style', 'refreshed']),
      edit('renderer/style.css', source => `${source}\n:root { --rig-style: refreshed; }\n`),
    ]);
    await expect.poll(() => property(page, '--rig-style')).toBe('refreshed');
    assert.deepEqual(reloading, ['0px'], 'The modal overlay keeps its styles while their replacement loads');
    const sheets = target => target.evaluate(() => [...document.querySelectorAll('link[rel="stylesheet"], style')].map(node => node.getAttribute('href') ?? node.dataset.viteDevId));
    // The modal overlay's request for the next version of the stylesheet stalls while a later version loads. The opener
    // reports every overlay's requests as its own, so the modal's request is found by its network ID.
    const fetches = await page.context().newCDPSession(page), overlay = await page.context().newCDPSession(modal);
    const paused = new Map();
    let stalled;
    const release = () => {
      if (stalled) for (const [networkId, requestId] of paused) if (networkId !== stalled) {
        paused.delete(networkId);
        void fetches.send('Fetch.continueRequest', { requestId });
      }
    };
    fetches.on('Fetch.requestPaused', ({ requestId, networkId }) => { paused.set(networkId, requestId); release(); });
    overlay.on('Network.requestWillBeSent', ({ requestId, request }) => {
      if (!stalled && request.url.includes('/style.css?')) stalled = requestId;
      release();
    });
    await overlay.send('Network.enable');
    await fetches.send('Fetch.enable', { patterns: [{ urlPattern: '*/style.css?*' }] });
    await edit('renderer/style.css', source => `${source}\n:root { --rig-held: held; }\n`);
    await expect.poll(() => property(page, '--rig-held')).toBe('held');
    await edit('renderer/style.css', source => `${source}\n:root { --rig-held: replaced; }\n`);
    for (const target of [page, modal]) await expect.poll(() => property(target, '--rig-held')).toBe('replaced');
    await fetches.send('Fetch.continueRequest', { requestId: paused.get(stalled) });
    await expect.poll(() => sheets(modal), 'The modal overlay drops replaced stylesheets once a stalled copy loads').toEqual(await sheets(page));
    await fetches.detach();
    await overlay.detach();
    await edit('renderer/themes/rail/style.css', source => `${source}\n:root { --rig-theme: refreshed; }\n`);
    for (const target of [page, modal]) await expect.poll(() => property(target, '--rig-theme')).toBe('refreshed');
    await writeFile(join(checkout, 'src/renderer/rig.css'), ':root { --rig-added: added; }\n');
    await edit('renderer/picker.tsx', source => `import './rig.css';\n${source}`);
    for (const target of [page, modal]) await expect.poll(() => property(target, '--rig-added')).toBe('added');
    await edit('renderer/picker.tsx', source => source.replace("import './rig.css';\n", ''));
    for (const target of [page, modal]) await expect.poll(() => property(target, '--rig-added')).toBe('');
    assert.deepEqual(await sheets(modal), await sheets(page), 'The modal overlay has the same stylesheets in the same order');
    await network.detach();
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
    await edit('main/remote-helper/helper/messages.py', source => source.replace('MAX_BYTES = 1024 * 1024', 'MAX_BYTES = 1024 * 1024 + 1'));
    await waitFor(() => !browser.isConnected(), 'Python archive rebuild restarts Electron');
    page = await attach();
    await api('capabilities');
    assert.deepEqual(errors, []);
    console.log('Development launch, React state, overlay styles during renders and CSS updates, fonts, preload and overlay reloads, SSH survival, main restart, and Python archive rebuild passed.');
  } catch (error) {
    console.error(log);
    throw error;
  }
});
