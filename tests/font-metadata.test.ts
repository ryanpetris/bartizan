import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isMonospace } from '../src/renderer/font-metadata';

function font(fixed: number, signature = 0x00010000) {
  const bytes = new ArrayBuffer(44), data = new DataView(bytes);
  data.setUint32(0, signature);
  data.setUint16(4, 1);
  data.setUint32(12, 0x706f7374);
  data.setUint32(20, 28);
  data.setUint32(24, 16);
  data.setUint32(28, 0x00030000);
  data.setUint32(40, fixed);
  return bytes;
}

test('reads fixed pitch from TrueType and CFF metadata', () => {
  for (const signature of [0x00010000, 0x4f54544f]) {
    assert.equal(isMonospace(font(1, signature), ''), true);
    assert.equal(isMonospace(font(0, signature), ''), false);
  }
  const bytes = readFileSync('assets/fonts/jetbrains-mono.ttf');
  assert.equal(isMonospace(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), ''), true);
});

test('unreadable or missing metadata does not classify a font as monospace', () => {
  for (let length = 0; length < 44; length++) assert.equal(isMonospace(font(1).slice(0, length), ''), false);
  for (const [offset, value] of [[0, 0], [12, 0], [20, 0xffffffff], [24, 4], [28, 0x00050000]]) {
    const bytes = font(1);
    new DataView(bytes).setUint32(offset, value);
    assert.equal(isMonospace(bytes, ''), false);
  }
});

test('selects the named face in a collection with different spacing', () => {
  const bytes = new ArrayBuffer(256), data = new DataView(bytes);
  data.setUint32(0, 0x74746366);
  data.setUint32(4, 0x00010000);
  data.setUint32(8, 2);
  for (const [i, name] of ['Wide', 'Mono'].entries()) {
    const face = 20 + i * 100, post = face + 44, names = post + 16;
    data.setUint32(12 + i * 4, face);
    data.setUint32(face, 0x00010000);
    data.setUint16(face + 4, 2);
    data.setUint32(face + 12, 0x706f7374);
    data.setUint32(face + 20, post);
    data.setUint32(face + 24, 16);
    data.setUint32(face + 28, 0x6e616d65);
    data.setUint32(face + 36, names);
    data.setUint32(face + 40, 26);
    data.setUint32(post, 0x00030000);
    data.setUint32(post + 12, i);
    data.setUint16(names + 2, 1);
    data.setUint16(names + 4, 18);
    data.setUint16(names + 6, 3);
    data.setUint16(names + 12, 6);
    data.setUint16(names + 14, 8);
    for (let j = 0; j < name.length; j++) data.setUint16(names + 18 + j * 2, name.charCodeAt(j));
  }
  assert.equal(isMonospace(bytes, 'Wide'), false);
  assert.equal(isMonospace(bytes, 'Mono'), true);
  assert.equal(isMonospace(bytes, 'Absent'), false);
});
