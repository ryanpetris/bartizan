import assert from 'node:assert/strict';
import test from 'node:test';
import type { Terminal } from '@xterm/xterm';

test('ligature checks finish for fresh visible runs after a full cache', async () => {
  const frames: FrameRequestCallback[] = [];
  const globals = ['window', 'document', 'OffscreenCanvas', 'requestAnimationFrame'] as const;
  const previous = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  let draws = 0;
  const context = {
    measureText: () => ({ width: 16 }), clearRect: () => { draws = 0; },
    fillText: () => { draws++; },
    getImageData: () => ({ data: Uint8ClampedArray.from({ length: 64 }, (_, index) => index % 4 === 3 && draws === 1 ? 255 : 0) }),
  };
  Object.assign(globalThis, {
    window: {}, document: { fonts: { check: () => true } },
    OffscreenCanvas: class { getContext() { return context; } },
    requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
  });
  try {
    const { operatorJoiner } = await import('../src/renderer/ligatures');
    let visible: string[] = [], joined: number[] = [];
    const terminal = { options: { fontFamily: 'Fixture' }, rows: 120, cols: 80, refresh: () => render() };
    const join = operatorJoiner(terminal as unknown as Terminal);
    const render = () => { joined = visible.map(line => join(line).length); };
    const settle = () => {
      let count = 0;
      while (frames.length && count++ < 200) frames.splice(0).forEach(callback => callback(count));
      assert.equal(frames.length, 0, 'Rendering must settle without an endless redraw loop');
    };
    const run = (index: number) => index.toString(2).padStart(14, '0').replaceAll('0', '=').replaceAll('1', '>');
    for (let offset = 0; offset < 10200; offset += 30) {
      visible = Array.from({ length: 30 }, (_, index) => run(offset + index)); render(); settle();
    }
    visible = Array.from({ length: 100 }, (_, index) => run(12000 + index));
    render(); settle();
    assert.equal(joined.every(count => count === 1), true, 'All visible shaping runs must finish after cache saturation');
    visible = Array.from({ length: 120 }, (_, row) => Array.from({ length: 5 }, (_, column) => run(14000 + row * 5 + column)).join(' '));
    render(); settle();
    assert.equal(joined.every(count => count === 5), true, 'A large visible working set must converge');
    terminal.rows = 40;
    terminal.options.fontFamily = 'Styled Fixture';
    const punctuation = '!#$%&*+-./:;<=>?@\\^_|~[]{}()';
    const pairs = [...punctuation].flatMap(a => [...punctuation].map(b => a + b)).slice(0, 600);
    // Adjacent attribute spans need no separator. Alternating two and three cells fits this screen.
    visible = pairs.flatMap(pair => [pair, pair + '=']);
    render(); settle();
    assert.equal(joined.every(count => count === 1), true, 'Adjacent styled runs must converge');
  } finally {
    globals.forEach((key, index) => { const descriptor = previous[index]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
  }
});
