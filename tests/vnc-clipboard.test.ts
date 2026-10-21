import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changesVncClipboard, fitsVncClipboard, vncClipboardLimit } from '../src/renderer/vnc-clipboard';

test('VNC clipboard text stops at its retention and send limit', () => {
  assert.equal(fitsVncClipboard('a'.repeat(vncClipboardLimit)), true);
  assert.equal(fitsVncClipboard('a'.repeat(vncClipboardLimit + 1)), false);
  assert.equal(changesVncClipboard('current', 'current'), false);
  assert.equal(changesVncClipboard('current', 'a'.repeat(vncClipboardLimit + 1)), false);
  assert.equal(changesVncClipboard('current', 'next'), true);
});
