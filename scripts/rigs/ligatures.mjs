import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { withDirectory, startSshd, sshProfile, launch, waitFor, graphicsArgs } from './lib/harness.mjs';

// Only the WebGL renderer joins characters, so the rig draws with software WebGL unless the harness already does.
const softwareGL = graphicsArgs.length ? [] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const sample = '=> -> === !=';
const octal = text => [...Buffer.from(text)].map(byte => `\\${byte.toString(8).padStart(3, '0')}`).join('');
// A static screen: the sample, bold and italic operators, and box drawing, with the cursor hidden.
const screen = `\\033[?25l\\033[2J\\033[H${sample}\\r\\n\\033[1m=>\\033[0m \\033[3m->\\033[0m \\033[1;3m!=\\033[0m\\r\\n${octal('┌────┐\r\n│    │\r\n└────┘')}`;
const drawn = `\x1b[?25l\x1b[2J\x1b[H${sample}`;

await withDirectory('ligatures', async (directory, cleanup) => {
  const sshd = await startSshd(directory);
  cleanup(sshd.stop);
  const config = join(directory, 'config.yaml');
  await writeFile(config, `version: 1\nprofiles:\n  joined:\n${sshProfile(sshd)}  separate:\n${sshProfile(sshd, '    terminal:\n      ligatures: false\n')}`);
  const app = await launch(directory, config, { args: softwareGL });
  cleanup(app.close);
  const { application, page, api, waitState, recordOutput, output, errors } = app;
  await application.evaluate(({ ipcMain }) => {
    globalThis.rigSizes = {};
    const request = ipcMain._invokeHandlers.get('request');
    ipcMain._invokeHandlers.set('request', (event, message) => {
      if (message.method === 'resize') { const [id, cols, rows] = message.args; globalThis.rigSizes[id] = { cols, rows }; }
      return request(event, message);
    });
  });
  const size = id => application.evaluate((_, id) => globalThis.rigSizes[id], id);
  await recordOutput();
  const view = page.locator('.terminal-surface:not([hidden]) .xterm-screen');
  const show = id => page.locator(`.nav-item[data-kind="terminal"][data-id="${id}"]`).click();
  /** Opens a profile's terminal, shows it and draws the static screen in it. */
  const open = async profileId => {
    const connection = await api('connect', { profileId });
    const state = await waitState(s => s.terminals.some(t => t.connectionId === connection && t.status === 'connected'), `${profileId} terminal`);
    const id = state.terminals.find(t => t.connectionId === connection).id;
    await show(id);
    await waitFor(() => size(id), `${profileId} size`);
    await expect(view.locator('canvas:not(.xterm-link-layer)')).toHaveCount(1);
    await api('input', id, `printf '${screen}'; sleep 600\n`);
    await waitFor(async () => (await output(id)).includes(drawn), `${profileId} screen`);
    return id;
  };
  /** The shown terminal's pixels once two frames in a row match. */
  const pixels = () => {
    let previous;
    return waitFor(async () => {
      const next = await view.screenshot();
      const stable = previous?.equals(next) && next;
      previous = next;
      return stable;
    }, 'steady terminal pixels');
  };
  const settings = patch => api('settings', patch);

  const joinedId = await open('joined');
  const joined = await pixels();
  const cells = await size(joinedId);
  await settings({ terminalLigatures: false });
  const separate = await pixels();
  assert.ok(!separate.equals(joined), 'Turning ligatures off redraws operators separately');
  assert.deepEqual(await size(joinedId), cells, 'Ligatures keep the terminal cells');
  await settings({ terminalLigatures: true });
  assert.ok((await pixels()).equals(joined), 'Turning ligatures on joins operators again');

  await open('separate');
  assert.ok((await pixels()).equals(separate), 'A connection that turns ligatures off draws operators separately');
  await settings({ terminalLigatures: false });
  assert.ok((await pixels()).equals(separate));
  await settings({ terminalLigatures: true });
  assert.ok((await pixels()).equals(separate), 'The connection setting overrides the global one');
  await show(joinedId);
  assert.ok((await pixels()).equals(joined), 'A connection without its own setting follows the global one');
  console.log('Ligatures change operator pixels without changing cells; a connection setting overrides the global setting.');

  const sameCells = async () => isDeepStrictEqual(await size(joinedId), cells);
  await settings({ terminalFont: 'DejaVu Sans Mono', terminalFontSize: 17 });
  await waitFor(async () => !(await sameCells()), 'cells for the new font');
  const plain = await pixels();
  await settings({ terminalLigatures: false });
  assert.ok((await pixels()).equals(plain), 'A font without ligatures keeps operator spacing');
  await settings({ terminalFont: 'JetBrains Mono', terminalFontSize: 13, terminalLigatures: true });
  await waitFor(sameCells, 'cells for the bundled font');
  assert.ok((await pixels()).equals(joined));
  console.log('A font without ligatures draws operators the same with ligatures on or off.');

  await application.evaluate(({ ipcMain }) => {
    globalThis.rigInput = [];
    const request = ipcMain._invokeHandlers.get('request');
    ipcMain._invokeHandlers.set('request', (event, message) => { if (message.method === 'input') globalThis.rigInput.push(message.args[1]); return request(event, message); });
  });
  const box = await view.boundingBox();
  const at = (column, row) => ({ x: box.x + column * box.width / cells.cols + 1, y: box.y + (row + 0.5) * box.height / cells.rows });
  const drag = async (from, to, shift = false) => {
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();
    if (shift) await page.keyboard.up('Shift');
  };
  const clipboard = () => application.evaluate(({ clipboard }) => clipboard.readText());
  const cleared = () => expect.poll(async () => (await pixels()).equals(joined)).toBe(true);
  await drag(at(0, 0), at(sample.length, 0));
  await expect.poll(clipboard).toBe(sample);
  await cleared();
  assert.deepEqual(await application.evaluate(() => globalThis.rigInput), []);
  console.log('Selecting joined operators copies their text, clears the selection and sends nothing to the terminal.');

  await application.evaluate(({ clipboard }) => clipboard.writeText('kept'));
  for (const [from, to] of [[at(2, 7), at(20, 7)], [at(2, 7), at(20, 8)]]) {
    await drag(from, to);
    await cleared();
  }
  assert.equal(await clipboard(), 'kept');
  console.log('Selecting blank cells or rows clears the selection and leaves the clipboard alone.');

  // The first round starts from an earlier click, the second right after a copy.
  for (const click of [true, false]) {
    await application.evaluate(({ clipboard }) => clipboard.writeText('kept'));
    if (click) await page.mouse.click(at(20, 3).x, at(20, 3).y);
    await drag(at(0, 0), at(sample.length, 0), true);
    await expect.poll(clipboard).toBe(sample);
    await cleared();
  }
  await page.keyboard.down('Shift');
  await page.mouse.click(at(20, 3).x, at(20, 3).y);
  await page.keyboard.up('Shift');
  await expect(page.locator('.terminal-surface:not([hidden]) .xterm-helper-textarea')).toBeFocused();
  assert.deepEqual(await application.evaluate(() => globalThis.rigInput), []);
  assert.deepEqual(errors, []);
  console.log('Without mouse reporting, Shift+drag selects like a plain drag, even after a click or a copy, and a Shift+click keeps focus.');
});
