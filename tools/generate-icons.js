#!/usr/bin/env node
/**
 * Generates the PWA icon set with no image dependencies.
 *
 * Draws a bookmark-ribbon glyph procedurally, supersampled for antialiasing,
 * and writes minimal PNGs (IHDR/IDAT/IEND) using Node's built-in zlib.
 *
 * Run: npm run icons
 */

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const BG = [0x3b, 0x5b, 0xdb]; // --accent
const FG = [0xff, 0xff, 0xff];

/* ------------------------------------------------------------------ PNG */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * @param {number} size
 * @param {Uint8Array} rgb raw size*size*3 pixel data
 */
function encodePng(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 3 + 1);
    raw[rowStart] = 0;
    rgb.subarray(y * size * 3, (y + 1) * size * 3).forEach((v, i) => {
      raw[rowStart + 1 + i] = v;
    });
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ----------------------------------------------------------------- glyph */

/**
 * Is the normalised point inside the bookmark ribbon?
 * `scale` shrinks the glyph about the centre so maskable icons stay inside
 * Android's safe zone.
 */
function inGlyph(x, y, scale) {
  // Normalise around centre so the glyph can be scaled uniformly.
  const nx = (x - 0.5) / scale + 0.5;
  const ny = (y - 0.5) / scale + 0.5;

  const x0 = 0.3;
  const x1 = 0.7;
  const y0 = 0.18;
  const y1 = 0.82;
  const notchApexY = 0.6; // how far up the V cuts

  if (nx < x0 || nx > x1 || ny < y0 || ny > y1) return false;

  // Round the two top corners slightly.
  const r = 0.05;
  const cornerX = nx < x0 + r ? x0 + r : nx > x1 - r ? x1 - r : nx;
  if (ny < y0 + r) {
    const dx = nx - cornerX;
    const dy = ny - (y0 + r);
    if (cornerX !== nx && dx * dx + dy * dy > r * r) return false;
  }

  // Cut the V notch out of the bottom edge.
  const halfWidth = (x1 - x0) / 2;
  const offset = Math.abs(nx - 0.5) / halfWidth; // 0 at centre, 1 at edges
  const notchTop = y1 - (y1 - notchApexY) * (1 - offset);
  if (ny >= notchTop) return false;

  return true;
}

/** Render one icon, supersampling SS×SS per pixel for smooth edges. */
function renderIcon(size, glyphScale) {
  const SS = 4;
  const rgb = new Uint8Array(size * size * 3);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / size;
          const py = (y + (sy + 0.5) / SS) / size;
          if (inGlyph(px, py, glyphScale)) hits++;
        }
      }
      const alpha = hits / (SS * SS);
      const offset = (y * size + x) * 3;
      // Composite the glyph over the background (icons stay fully opaque:
      // iOS requires a non-transparent apple-touch-icon).
      for (let c = 0; c < 3; c++) {
        rgb[offset + c] = Math.round(BG[c] * (1 - alpha) + FG[c] * alpha);
      }
    }
  }
  return encodePng(size, rgb);
}

/* ------------------------------------------------------------------ main */

const ICONS = [
  // Full-bleed icons.
  { file: 'icon-192.png', size: 192, scale: 1 },
  { file: 'icon-512.png', size: 512, scale: 1 },
  // Maskable: glyph shrunk into the safe zone so Android's mask cannot clip it.
  { file: 'icon-maskable-512.png', size: 512, scale: 0.66 },
  // iOS homescreen icons; Safari ignores the manifest and applies its own mask.
  { file: 'apple-touch-icon-180.png', size: 180, scale: 1 },
  { file: 'apple-touch-icon-167.png', size: 167, scale: 1 },
  { file: 'apple-touch-icon-152.png', size: 152, scale: 1 }
];

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const { file, size, scale } of ICONS) {
  const png = renderIcon(size, scale);
  fs.writeFileSync(path.join(OUT_DIR, file), png);
  console.log(`${file}  ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
}
console.log(`\nWrote ${ICONS.length} icons to ${path.relative(process.cwd(), OUT_DIR)}`);
