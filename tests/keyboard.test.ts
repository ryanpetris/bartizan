import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserShortcut, formatBytes, pageShortcuts, shortcutKey, stepZoom, type KeyPress } from '../src/shared';

test('shortcuts retain Latin layout meanings and fall back to physical keys on non-Latin layouts', () => {
  assert.equal(shortcutKey({ key: 'д', code: 'KeyL' }), 'l');
  assert.equal(shortcutKey({ key: 'Т', code: 'KeyN' }), 'n');
  assert.equal(shortcutKey({ key: 'и', code: 'KeyB' }), 'b');
  assert.equal(shortcutKey({ key: 'a', code: 'KeyQ' }), 'a');
  assert.equal(shortcutKey({ key: 'N', code: 'KeyN' }), 'n');
  assert.equal(shortcutKey({ key: ' ', code: 'Space' }), ' ');
  assert.equal(shortcutKey({ key: 'ArrowLeft', code: 'ArrowLeft' }), 'arrowleft');
});

test('the application takes its own shortcuts before a page and leaves the rest to the page', () => {
  const press = (key: string, modifiers: Partial<KeyPress> = {}, code = '') => browserShortcut({ key, code, control: false, meta: false, alt: false, shift: false, ...modifiers });
  assert.equal(press('F12'), 'devtools');
  assert.equal(press('F12', { shift: true }), undefined);
  assert.equal(press('I', { control: true, shift: true }), 'devtools');
  assert.equal(press('i', { meta: true, alt: true }), 'devtools');
  assert.equal(press('l', { control: true }), 'focus-address');
  assert.equal(press('д', { control: true }, 'KeyL'), 'focus-address');
  assert.equal(press('L', { control: true, shift: true }), undefined);
  assert.equal(press('N', { control: true, shift: true }), 'new-connection');
  assert.equal(press('n', { control: true }), undefined);
  for (const key of ['f', 'r', 'p', '=', '-', '0']) assert.equal(press(key, { control: true }), undefined);
  assert.equal(press('R', { control: true, shift: true }), undefined);
  assert.equal(press('F5'), undefined);
});

test('every page shortcut has an accelerator, and none is shared', () => {
  const accelerators = Object.values(pageShortcuts).flat();
  assert.ok(Object.values(pageShortcuts).every(list => list.length > 0));
  assert.equal(new Set(accelerators).size, accelerators.length);
});

test('zoom steps through its levels and stops at the ends', () => {
  assert.equal(stepZoom(100, 'in'), 110);
  assert.equal(stepZoom(100, 'out'), 90);
  assert.equal(stepZoom(105, 'in'), 110);
  assert.equal(stepZoom(105, 'out'), 100);
  assert.equal(stepZoom(500, 'in'), 500);
  assert.equal(stepZoom(25, 'out'), 25);
});

test('byte sizes use the largest unit that fits', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(15_300_000), '15 MB');
  assert.equal(formatBytes(2_500_000_000), '2.5 GB');
});
