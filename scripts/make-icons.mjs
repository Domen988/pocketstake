// Generate the PWA icons (no dependencies): a dark tile with a green
// surveyor's target — circle, crosshair, centre peg dot.
// Run: node scripts/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, draw) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x, y, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [11, 15, 20];
const FG = [56, 193, 114]; // --green

function drawIcon(x, y, size) {
  const c = size / 2;
  const dx = x - c + 0.5;
  const dy = y - c + 0.5;
  const d = Math.hypot(dx, dy);
  const u = size / 96; // stroke unit
  const ring = Math.abs(d - size * 0.3) < 3.5 * u;
  const crossLen = size * 0.42;
  const crossGap = size * 0.12;
  const cross =
    (Math.abs(dx) < 3 * u && Math.abs(dy) < crossLen && Math.abs(dy) > crossGap) ||
    (Math.abs(dy) < 3 * u && Math.abs(dx) < crossLen && Math.abs(dx) > crossGap);
  const peg = d < size * 0.055;
  const on = ring || cross || peg;
  return on ? [...FG, 255] : [...BG, 255];
}

mkdirSync('icons', { recursive: true });
for (const size of [180, 192, 512]) {
  writeFileSync(`icons/icon-${size}.png`, png(size, drawIcon));
  console.log(`icons/icon-${size}.png`);
}
