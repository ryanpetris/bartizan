/** Reads the OpenType fixed-pitch flag. Collections select a face by its PostScript name. */
export function isMonospace(bytes: ArrayBuffer, postscriptName: string): boolean {
  try {
    const data = new DataView(bytes);
    const table = (face: number, tag: number) => {
      const signature = data.getUint32(face);
      if (![0x00010000, 0x4f54544f, 0x74727565, 0x74797031].includes(signature)) return;
      const count = data.getUint16(face + 4);
      if (face + 12 + count * 16 > bytes.byteLength) return;
      for (let i = 0; i < count; i++) {
        const entry = face + 12 + i * 16;
        if (data.getUint32(entry) !== tag) continue;
        const offset = data.getUint32(entry + 8), length = data.getUint32(entry + 12);
        if (offset + length <= bytes.byteLength) return new DataView(bytes, offset, length);
      }
    };
    const fixed = (face: number) => {
      const post = table(face, 0x706f7374);
      return !!post && post.byteLength >= 16 && [1, 2, 3, 4].includes(post.getUint16(0)) && post.getUint32(12) !== 0;
    };
    if (data.getUint32(0) !== 0x74746366) return fixed(0);
    const count = data.getUint32(8);
    if (12 + count * 4 > bytes.byteLength) return false;
    for (let i = 0; i < count; i++) {
      const face = data.getUint32(12 + i * 4), names = table(face, 0x6e616d65);
      if (!names || names.byteLength < 6) continue;
      const records = names.getUint16(2), strings = names.getUint16(4);
      if (6 + records * 12 > names.byteLength) continue;
      for (let j = 0; j < records; j++) {
        const entry = 6 + j * 12, platform = names.getUint16(entry);
        if (names.getUint16(entry + 6) !== 6 || ![0, 1, 3].includes(platform)) continue;
        const length = names.getUint16(entry + 8), offset = strings + names.getUint16(entry + 10);
        if (offset + length > names.byteLength) continue;
        const name = new TextDecoder(platform === 1 ? 'ascii' : 'utf-16be').decode(new Uint8Array(bytes, names.byteOffset + offset, length));
        if (name === postscriptName) return fixed(face);
      }
    }
  } catch { /* Unreadable fonts are not offered as monospace choices. */ }
  return false;
}
