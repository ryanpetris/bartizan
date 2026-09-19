// Encodes RGBA frames as an animated PNG. Viewers without animation show the first frame.
import { crc32, deflateSync } from 'node:zlib';

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Filters each row with whichever PNG filter leaves the smallest sum of magnitudes, which suits flat interface art. */
function filter(rgba, width, height) {
  const stride = width * 4, out = Buffer.alloc((stride + 1) * height), row = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const current = rgba.subarray(y * stride, (y + 1) * stride), above = y ? rgba.subarray((y - 1) * stride, y * stride) : undefined;
    let bestScore = Infinity;
    for (let type = 0; type < 5; type++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= 4 ? current[x - 4] : 0, b = above ? above[x] : 0, c = above && x >= 4 ? above[x - 4] : 0;
        let predicted = 0;
        if (type === 1) predicted = a;
        else if (type === 2) predicted = b;
        else if (type === 3) predicted = (a + b) >> 1;
        else if (type === 4) {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        const value = (current[x] - predicted) & 0xff;
        row[x] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        out[y * (stride + 1)] = type;
        row.copy(out, y * (stride + 1) + 1);
      }
    }
  }
  return out;
}

/** An animated PNG of `frames`, RGBA buffers of `width` by `height`, each shown for `seconds`, repeating forever. */
export function encodeAnimatedPng(frames, width, height, seconds) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const control = Buffer.alloc(8);
  control.writeUInt32BE(frames.length, 0);
  let sequence = 0;
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('acTL', control)];
  frames.forEach((rgba, index) => {
    const frame = Buffer.alloc(26);
    frame.writeUInt32BE(sequence++, 0);
    frame.writeUInt32BE(width, 4);
    frame.writeUInt32BE(height, 8);
    frame.writeUInt16BE(Math.round(seconds * 100), 20);
    frame.writeUInt16BE(100, 22);
    parts.push(chunk('fcTL', frame));
    const data = deflateSync(filter(rgba, width, height), { level: 9 });
    if (index === 0) parts.push(chunk('IDAT', data));
    else {
      const number = Buffer.alloc(4);
      number.writeUInt32BE(sequence++, 0);
      parts.push(chunk('fdAT', Buffer.concat([number, data])));
    }
  });
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
