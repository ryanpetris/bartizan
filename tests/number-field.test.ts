import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notNumber, stepNumber } from '../src/renderer/ui';

test('number fields read text as a number field does', () => {
  for (const text of ['', ' ', '13', ' 13 ', '-4', '12.5', '.5', '1e3', '1E-2', '3e38']) assert.equal(notNumber(text), false, text);
  for (const text of ['abc', '1,5', '+3', '5.', '1e', '--1', '1 2', '0x10', 'Infinity', '4e38', '1e400']) assert.equal(notNumber(text), true, text);
});

test('number fields step whole numbers within their range as spin buttons do', () => {
  assert.equal(stepNumber('13', 1, 8, 32), 14);
  assert.equal(stepNumber('13', -1, 8, 32), 12);
  assert.equal(stepNumber('12.5', 1, 8, 32), 13);
  assert.equal(stepNumber('12.5', -1, 8, 32), 12);
  assert.equal(stepNumber('32', 1, 8, 32), undefined);
  assert.equal(stepNumber('8', -1, 8, 32), undefined);
  // A value beyond the range steps to its nearer end.
  assert.equal(stepNumber('7', 1, 8, 32), 8);
  assert.equal(stepNumber('7', -1, 8, 32), undefined);
  assert.equal(stepNumber('40', -1, 8, 32), 32);
  assert.equal(stepNumber('40', 1, 8, 32), undefined);
  // Text that is no number steps from zero, into the range.
  for (const text of ['', 'abc']) {
    assert.equal(stepNumber(text, 1, 8, 32), 8);
    assert.equal(stepNumber(text, -1, 8, 32), 8);
    assert.equal(stepNumber(text, 1, 0, 100000), 1);
    assert.equal(stepNumber(text, -1, 0, 100000), 0);
    assert.equal(stepNumber(text, 1, 1, 65535), 1);
  }
});
