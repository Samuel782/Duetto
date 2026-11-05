// Genera build/icon.png senza dipendenze: fumetto scuro con due righe di sottotitoli.
import fs from 'node:fs';
import zlib from 'node:zlib';

const SIZE = 1024;
const rgba = Buffer.alloc(SIZE * SIZE * 4);

const roundedBox = (x, y, x0, y0, x1, y1, r) => {
  const dx = Math.max(x0 + r - x, x - (x1 - r), 0);
  const dy = Math.max(y0 + r - y, y - (y1 - r), 0);
  return Math.hypot(dx, dy) <= r;
};

function shade(x, y) {
  if (!roundedBox(x, y, 90, 90, 934, 934, 190)) return null;
  if (roundedBox(x, y, 220, 560, 804, 650, 45)) return [255, 255, 255];
  if (roundedBox(x, y, 300, 700, 724, 790, 45)) return [255, 212, 0];
  const t = (y - 90) / 844;
  return [Math.round(30 + t * 10), Math.round(70 - t * 30), Math.round(160 - t * 90)];
}

// Quattro campioni per pixel: bordi morbidi.
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let [r, g, b, hits] = [0, 0, 0, 0];
    for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const c = shade(x + ox, y + oy);
      if (c) { r += c[0]; g += c[1]; b += c[2]; hits += 1; }
    }
    if (!hits) continue;
    const i = (y * SIZE + x) * 4;
    rgba[i] = r / hits; rgba[i + 1] = g / hits; rgba[i + 2] = b / hits; rgba[i + 3] = (hits / 4) * 255;
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 6;
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/icon.png', Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]));
