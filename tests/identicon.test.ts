import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identiconCells } from '../src/renderer/identicon';

test('profile identicons are stable, symmetric, bounded and distinct for nearby IDs', () => {
  const patterns = new Set<string>();
  for (const seed of ['', '🌙', ...Array.from({ length: 200 }, (_, i) => `profile-${i}`)]) {
    const cells = identiconCells(seed);
    assert.deepEqual(identiconCells(seed), cells);
    const positions = new Set(cells.map(([x, y]) => `${x},${y}`));
    assert.equal(positions.size, cells.length);
    assert.ok(cells.length >= 13);
    for (const [x, y] of cells) {
      assert.ok(x >= 0 && x < 7 && y >= 0 && y < 7);
      assert.ok(positions.has(`${6 - x},${y}`));
    }
    assert.ok(!positions.has('2,3') && !positions.has('4,3'));
    patterns.add(JSON.stringify(cells));
  }
  assert.equal(patterns.size, 202);
});
