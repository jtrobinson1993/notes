// Generates the PWA icons (solid background, white "N") without any image deps.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../web/public/icons');
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixelFn) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixelFn(x, y);
      raw.writeUInt8(r, row + 1 + x * 3);
      raw.writeUInt8(g, row + 2 + x * 3);
      raw.writeUInt8(b, row + 3 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // color type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [37, 99, 235]; // blue-600
const FG = [255, 255, 255];

function makeIcon(size) {
  const m = size * 0.28; // letter margins
  const w = size * 0.11; // stroke width
  const left = m;
  const right = size - m;
  const top = m;
  const bottom = size - m;
  return png(size, (x, y) => {
    const inLetter =
      y >= top &&
      y <= bottom &&
      ((x >= left && x <= left + w) ||
        (x >= right - w && x <= right) ||
        // diagonal from (left, top) to (right - w, bottom)
        (() => {
          const t = (y - top) / (bottom - top);
          const dx = left + w / 2 + t * (right - w - left - w / 2) - x;
          return Math.abs(dx) <= w * 0.7;
        })());
    return inLetter ? FG : BG;
  });
}

for (const size of [192, 512]) {
  writeFileSync(join(outDir, `icon-${size}.png`), makeIcon(size));
  console.log(`icon-${size}.png written`);
}
