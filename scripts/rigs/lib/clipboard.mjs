import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export async function testClipboard({ application, page }, id) {
  await page.locator(`[data-kind="terminal"][data-id="${id}"]`).click();
  console.log('Clipboard rig started.');
  const read = () => application.evaluate(({ clipboard }) => clipboard.readText());
  const send = data => page.evaluate(({ id, data }) => window.bartizan.input(id, data), { id, data });
  const output = async text => {
    const encoded = Buffer.from(text).toString('base64');
    await send(`printf '%s' '${encoded}' | base64 -d\n`);
    await page.waitForTimeout(200);
  };
  for (const ending of ['\x07', '\x1b\\']) {
    const text = `Clipboard λ 終 ${ending.length}`;
    await output(`\x1b]52;c;${Buffer.from(text).toString('base64')}${ending}`);
    await expect.poll(read).toBe(text);
  }
  console.log('Unicode clipboard passed.');
  await send("printf '\\033]52;;'; sleep 0.1; printf 'ZnJhZ21lbnRlZCDOuw==\\007'\n");
  await expect.poll(read).toBe('fragmented λ');
  console.log('Fragmented clipboard passed.');
  for (const selection of ['cp', 's0']) {
    await output(`\x1b]52;${selection};${Buffer.from(selection).toString('base64')}\x07`);
    await expect.poll(read).toBe(selection);
  }
  await page.evaluate(() => window.bartizan.copy('a'.repeat(1024 * 1024 + 1)));
  assert.equal((await read()).length, 1024 * 1024 + 1);
  await application.evaluate(({ clipboard }) => {
    globalThis.rigClipboardWrites = [];
    globalThis.rigClipboardWrite = clipboard.writeText;
    clipboard.writeText = function (text) {
      globalThis.rigClipboardWrites.push(text);
      return globalThis.rigClipboardWrite.call(this, text);
    };
  });
  for (const payload of ['c;?', 'c;!!!', 'p;YQ==', 'c;/w==']) {
    await output(`\x1b]52;${payload}\x07`);
  }
  await assert.rejects(page.evaluate(() => window.bartizan.copy(123)));
  await output('\x1b]52;c;c2VudGluZWw=\x07');
  await expect.poll(read).toBe('sentinel');
  assert.deepEqual(await application.evaluate(() => globalThis.rigClipboardWrites), ['sentinel']);

  console.log('Clipboard validation passed.');
  // A raw remote process records all input, including mouse reports and control keys.
  const python = `import os,tty,termios,select,base64\nf=0\ns=termios.tcgetattr(f)\ntry:\n tty.setraw(f)\n os.write(1,b'\\x1b[2J\\x1b[HLOCAL_SELECTION\\x1b[?1000h\\x1b[?1006h\\x1b]52;c;?\\x07\\x1b]52;c;cmF3cmVhZHk=\\x07')\n data=b''\n while True:\n  b=os.read(f,1024)\n  data+=b.split(b'!',1)[0]\n  if b'!' in b: break\n os.write(1,b'\\x1b[?1000l\\x1b[?1006l\\r\\nINPUT_BYTES:'+base64.b64encode(data)+b':END\\r\\n')\nfinally:\n termios.tcsetattr(f,termios.TCSANOW,s)`;
  await send(`python3 -c "exec(__import__('base64').b64decode('${Buffer.from(python).toString('base64')}'))"\n`);
  await expect.poll(read, { timeout: 20000 }).toBe('rawready').catch(async error => { console.error('Raw ready sequence received:', await page.evaluate(() => window.rigOutput.includes('\x1b]52;c;cmF3cmVhZHk=\x07'))); throw error; });
  const box = await page.locator('.terminal-surface:not([hidden]) .xterm-screen').boundingBox();
  await page.mouse.click(box.x + 1, box.y + 7);
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + 1, box.y + 7);
  await page.mouse.down();
  await page.mouse.move(box.x + 125, box.y + 7, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect.poll(read).toBe('LOCAL_SELECTION');
  await page.keyboard.type('x');
  await page.keyboard.press('Control+C');
  await page.keyboard.type('!');
  await page.waitForFunction(() => /INPUT_BYTES:[A-Za-z0-9+/=]*:END/.test(window.rigOutput), null, { timeout: 5000 });
  const recorded = await page.evaluate(() => window.rigOutput.match(/INPUT_BYTES:([A-Za-z0-9+/=]*):END/)[1]);
  assert.equal(Buffer.from(recorded, 'base64').toString(), '\x1b[<0;1;1M\x1b[<0;1;1mx\x03');
  await output('\x1b]52;c;ZG9uZQ==\x07');
  await expect.poll(read).toBe('done');
  assert.deepEqual(await application.evaluate(() => globalThis.rigClipboardWrites), ['sentinel', 'rawready', 'LOCAL_SELECTION', 'done']);
  await application.evaluate(({ clipboard }) => { clipboard.writeText = globalThis.rigClipboardWrite; });
  console.log('OSC 52 Unicode copy, ignored queries/invalid data and copying a Shift selection passed; Ctrl+C reaches the PTY.');
}
