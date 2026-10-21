import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseZoom, stepZoom, zoomRange } from '../src/renderer/vnc-zoom';

test('VNC zoom steps through the usual percentages from any value and stops at the ends of the range', () => {
  assert.equal(stepZoom(100, 1), 110);
  assert.equal(stepZoom(100, -1), 90);
  assert.equal(stepZoom(137, 1), 150);
  assert.equal(stepZoom(137, -1), 125);
  assert.equal(stepZoom(25, -1), zoomRange.min);
  assert.equal(stepZoom(zoomRange.min, -1), zoomRange.min);
  assert.equal(stepZoom(400, 1), zoomRange.max);
  assert.equal(stepZoom(zoomRange.max, 1), zoomRange.max);
});

test('VNC zoom reads a typed percentage, rounds it and keeps it within the range', () => {
  assert.equal(parseZoom('150'), 150);
  assert.equal(parseZoom(' 150 % '), 150);
  assert.equal(parseZoom('87.6%'), 88);
  assert.equal(parseZoom('.5'), zoomRange.min);
  assert.equal(parseZoom('0'), zoomRange.min);
  assert.equal(parseZoom('9000'), zoomRange.max);
  for (const text of ['', '%', 'abc', '-50', '1e3', '50%%', '1,5']) assert.equal(parseZoom(text), undefined, text);
});
