/* Gera o ícone do programa (build/icon.ico, build/icon.png, app/icon.png) sem depender de
 * nenhuma biblioteca: um quadrado arredondado azul-escuro com uma lente e o ponto vermelho de "no ar". */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256, SS = 4; // supersampling para bordas suaves
const BG = [31, 42, 68], RING = [255, 255, 255], DOT = [255, 59, 59], ACC = [255, 153, 0];

function inRoundRect(x, y, r) {
  const m = 10, w = SIZE - 2 * m;
  const dx = Math.max(m + r - x, 0, x - (m + w - r)), dy = Math.max(m + r - y, 0, y - (m + w - r));
  return x >= m && x <= m + w && y >= m && y <= m + w && dx * dx + dy * dy <= r * r;
}
function shade(x, y) { // devolve [r,g,b,a] de um ponto
  const cx = SIZE / 2, cy = SIZE / 2, d = Math.hypot(x - cx, y - cy);
  if (!inRoundRect(x, y, 52)) return [0, 0, 0, 0];
  if (d <= 40) return [...DOT, 255];
  if (d >= 70 && d <= 86) return [...RING, 255];
  // "LIVE" como barra laranja embaixo
  if (y >= 196 && y <= 214 && x >= 72 && x <= 184) return [...ACC, 255];
  return [...BG, 255];
}
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filtro "none"
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let i = 0; i < SS; i++) for (let j = 0; j < SS; j++) {
      const [pr, pg, pb, pa] = shade(x + (i + 0.5) / SS, y + (j + 0.5) / SS);
      r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
    }
    const o = y * (SIZE * 4 + 1) + 1 + x * 4;
    if (a) { raw[o] = r / a; raw[o + 1] = g / a; raw[o + 2] = b / a; }
    raw[o + 3] = a / (SS * SS);
  }
}
const crcTable = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
// ICO com uma entrada PNG de 256x256 (formato aceito pelo Windows Vista+)
const hdr = Buffer.alloc(6 + 16);
hdr.writeUInt16LE(0, 0); hdr.writeUInt16LE(1, 2); hdr.writeUInt16LE(1, 4);
hdr[6] = 0; hdr[7] = 0; hdr[8] = 0; hdr[9] = 0; hdr.writeUInt16LE(1, 10); hdr.writeUInt16LE(32, 12); hdr.writeUInt32LE(png.length, 14); hdr.writeUInt32LE(22, 18);
const root = path.join(__dirname, '..');
fs.writeFileSync(path.join(root, 'build', 'icon.png'), png);
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), Buffer.concat([hdr, png]));
fs.writeFileSync(path.join(root, 'app', 'icon.png'), png);
console.log('ícone gerado:', png.length, 'bytes');
