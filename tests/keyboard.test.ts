import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortcutKey } from '../src/shared';

test('shortcuts retain Latin layout meanings and fall back to physical keys on non-Latin layouts', () => {
  assert.equal(shortcutKey({ key: 'д', code: 'KeyL' }), 'l');
  assert.equal(shortcutKey({ key: 'Т', code: 'KeyN' }), 'n');
  assert.equal(shortcutKey({ key: 'и', code: 'KeyB' }), 'b');
  assert.equal(shortcutKey({ key: 'a', code: 'KeyQ' }), 'a');
  assert.equal(shortcutKey({ key: 'N', code: 'KeyN' }), 'n');
  assert.equal(shortcutKey({ key: ' ', code: 'Space' }), ' ');
  assert.equal(shortcutKey({ key: 'ArrowLeft', code: 'ArrowLeft' }), 'arrowleft');
});
