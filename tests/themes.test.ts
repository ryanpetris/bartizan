import { test } from 'node:test';
import assert from 'node:assert/strict';
import { themeIds, themes } from '../src/themes';
import { settingsSchema } from '../src/core/settings';
import { defaultSettings } from '../src/shared';

test('every theme has a manifest that the main process can apply to the window controls', () => {
  assert.deepEqual(Object.keys(themes).sort(), [...themeIds].sort());
  assert.equal(new Set(themeIds.map(id => themes[id].name)).size, themeIds.length);
  for (const id of themeIds) {
    const { name, axis, controls, toasts } = themes[id];
    assert.ok(name.trim(), id);
    assert.ok(['vertical', 'horizontal'].includes(axis), id);
    assert.ok(Number.isInteger(controls.height) && controls.height >= 24 && controls.height <= 64, id);
    for (const appearance of [controls.dark, controls.light]) for (const colour of [appearance.color, appearance.symbolColor]) assert.match(colour, /^#[0-9a-f]{6}$/i, id);
    assert.equal(typeof toasts.overlay, 'boolean', id);
  }
});

test('the theme setting accepts only known themes and defaults to Rail', () => {
  assert.equal(defaultSettings.theme, 'rail');
  for (const id of themeIds) assert.equal(settingsSchema.safeParse({ ...defaultSettings, theme: id }).success, true);
  assert.equal(settingsSchema.safeParse({ ...defaultSettings, theme: 'unknown' }).success, false);
});
