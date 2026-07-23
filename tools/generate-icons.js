#!/usr/bin/env node
/**
 * Generates the PWA icon set from assets/logo-source.png.
 *
 * No image dependencies: decodes and encodes PNG with Node's built-in zlib and
 * downscales with a gamma-correct box filter.
 *
 * Run: npm run icons
 */

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'assets', 'logo-source.png');
const OUT_DIR = path.join(ROOT, 'public', 'icons');

/* ------------------------------------------------------------- PNG decode */

function decodePng(buffer) {
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('Not a PNG file.');
  }

  let offset = 8;
  let width, height, bitDepth, colourType, interlace;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colourType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  // Only what this project actually needs; fail loudly rather than silently
  // producing wrong pixels.
  if (bitDepth !== 8) throw new Error(`Unsupported bit depth: ${bitDepth} (expected 8).`);
  if (interlace !== 0) throw new Error('Interlaced PNGs are not supported.');
  if (colourType !== 2 && colourType !== 6) {
    throw new Error(`Unsupported colour type: ${colourType} (expected 2 or 6).`);
  }

  const channels = colourType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(height * stride);

  // Undo per-scanline filtering (PNG spec section 9).
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let value = line[x];

      switch (filter) {
        case 0:
          break;
        case 1:
          value += a;
          break;
        case 2:
          value += b;
          break;
        case 3:
          value += (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new Error(`Unknown PNG filter type: ${filter}`);
      }
      out[y * stride + x] = value & 0xff;
    }
  }

  // Flatten any alpha onto white. iOS renders transparency in an
  // apple-touch-icon as black, so icons must end up fully opaque.
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < width * height; i++) {
    const s = i * channels;
    const alpha = channels === 4 ? out[s + 3] / 255 : 1;
    rgb[j++] = Math.round(out[s] * alpha + 255 * (1 - alpha));
    rgb[j++] = Math.round(out[s + 1] * alpha + 255 * (1 - alpha));
    rgb[j++] = Math.round(out[s + 2] * alpha + 255 * (1 - alpha));
  }

  return { width, height, rgb };
}

/* ------------------------------------------------------------- resampling */

// Downscaling by averaging sRGB values directly darkens edges, because sRGB is
// not linear in light. Convert to linear light, average, convert back.
const TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function fromLinear(value) {
  const c = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

/**
 * Box-filter resize with fractional edge coverage, in linear light.
 * Exact area averaging is the right filter for downscaling flat vector art:
 * it antialiases cleanly without the ringing a sharpening kernel would add.
 */
function resize(src, sw, sh, dw, dh) {
  const dst = new Uint8Array(dw * dh * 3);
  const scaleX = sw / dw;
  const scaleY = sh / dh;

  for (let dy = 0; dy < dh; dy++) {
    const y0 = dy * scaleY;
    const y1 = (dy + 1) * scaleY;
    const yStart = Math.floor(y0);
    const yEnd = Math.min(sh - 1, Math.ceil(y1) - 1);

    for (let dx = 0; dx < dw; dx++) {
      const x0 = dx * scaleX;
      const x1 = (dx + 1) * scaleX;
      const xStart = Math.floor(x0);
      const xEnd = Math.min(sw - 1, Math.ceil(x1) - 1);

      let r = 0;
      let g = 0;
      let b = 0;
      let total = 0;

      for (let sy = yStart; sy <= yEnd; sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        if (wy <= 0) continue;

        for (let sx = xStart; sx <= xEnd; sx++) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          if (wx <= 0) continue;

          const weight = wx * wy;
          const s = (sy * sw + sx) * 3;
          r += TO_LINEAR[src[s]] * weight;
          g += TO_LINEAR[src[s + 1]] * weight;
          b += TO_LINEAR[src[s + 2]] * weight;
          total += weight;
        }
      }

      const d = (dy * dw + dx) * 3;
      dst[d] = fromLinear(r / total);
      dst[d + 1] = fromLinear(g / total);
      dst[d + 2] = fromLinear(b / total);
    }
  }
  return dst;
}

/* ------------------------------------------------------------- PNG encode */

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

function encodePng(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour RGB, no alpha
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Adaptive filtering: try every filter on each scanline and keep the one with
  // the smallest sum of absolute signed differences (the heuristic from the PNG
  // spec). On smooth gradients this is worth several times the file size versus
  // always writing filter 0.
  const stride = size * 3;
  const raw = Buffer.alloc(size * (stride + 1));
  const candidate = Buffer.alloc(stride);
  const best = Buffer.alloc(stride);

  for (let y = 0; y < size; y++) {
    const row = rgb.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgb.subarray((y - 1) * stride, y * stride) : null;

    let bestFilter = 0;
    let bestScore = Infinity;

    for (let filter = 0; filter <= 4; filter++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= 3 ? row[x - 3] : 0;
        const b = prev ? prev[x] : 0;
        const c = x >= 3 && prev ? prev[x - 3] : 0;
        let value;

        switch (filter) {
          case 0:
            value = row[x];
            break;
          case 1:
            value = row[x] - a;
            break;
          case 2:
            value = row[x] - b;
            break;
          case 3:
            value = row[x] - ((a + b) >> 1);
            break;
          default: {
            const p = a + b - c;
            const pa = Math.abs(p - a);
            const pb = Math.abs(p - b);
            const pc = Math.abs(p - c);
            value = row[x] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          }
        }
        candidate[x] = value & 0xff;
        // Interpret as a signed byte: small magnitudes deflate better.
        score += Math.abs(((value & 0xff) << 24) >> 24);
      }

      if (score < bestScore) {
        bestScore = score;
        bestFilter = filter;
        candidate.copy(best);
      }
    }

    const rowStart = y * (stride + 1);
    raw[rowStart] = bestFilter;
    best.copy(raw, rowStart + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------------ main */

// No separate maskable file: the mark sits well inside the central 80% safe
// zone already, so a maskable variant would be byte-identical to icon-512.
// The manifest declares that one icon as `purpose: "any maskable"` instead.
const ICONS = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'apple-touch-icon-180.png', size: 180 },
  { file: 'apple-touch-icon-167.png', size: 167 },
  { file: 'apple-touch-icon-152.png', size: 152 }
];

if (!fs.existsSync(SOURCE)) {
  console.error(`Missing source artwork: ${path.relative(ROOT, SOURCE)}`);
  process.exit(1);
}

const source = decodePng(fs.readFileSync(SOURCE));
if (source.width !== source.height) {
  console.warn(`Warning: source is ${source.width}x${source.height}, not square.`);
}
console.log(`Source: ${path.relative(ROOT, SOURCE)} (${source.width}x${source.height})\n`);

fs.mkdirSync(OUT_DIR, { recursive: true });

let totalBytes = 0;
for (const { file, size } of ICONS) {
  const resized = resize(source.rgb, source.width, source.height, size, size);

  // Truecolour, deliberately. Palette quantisation would cut these files by
  // roughly half again, but this artwork is a full-frame gradient: 256 entries
  // band it visibly, and dithering to hide the banding speckles the flat cube
  // faces. Faithful colour is worth the bytes; the service worker only
  // precaches the one icon the running app actually displays.
  const png = encodePng(size, resized);

  fs.writeFileSync(path.join(OUT_DIR, file), png);
  totalBytes += png.length;
  console.log(`${file.padEnd(28)} ${size}x${size}  ${(png.length / 1024).toFixed(1).padStart(6)} KB`);
}

console.log(
  `\nWrote ${ICONS.length} icons to ${path.relative(ROOT, OUT_DIR)} — ${(totalBytes / 1024).toFixed(1)} KB total`
);
