// Generates the demo site's (intentionally heavy) images and vendor script. No dependencies.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const out = join(fileURLToPath(new URL('..', import.meta.url)), 'public');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[p++] = r; raw[p++] = g; raw[p++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Deterministic pseudo random numbers, so the assets are reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
function photoLike(seed, hue) {
  const rand = rng(seed);
  return (x, y) => {
    const v = Math.sin(x / 90 + seed) * 40 + Math.cos(y / 70) * 40 + Math.sin((x + y) / 40) * 20;
    const noise = (rand() - 0.5) * 70;
    const base = 110 + v + noise;
    return [
      Math.max(0, Math.min(255, base * (hue[0] / 255) + 40)),
      Math.max(0, Math.min(255, base * (hue[1] / 255) + 30)),
      Math.max(0, Math.min(255, base * (hue[2] / 255) + 20)),
    ];
  };
}

const jobs = [
  ['hero.png', 1600, 900, 1, [255, 190, 120]],
  ['g1.png', 900, 600, 2, [230, 170, 110]],
  ['g2.png', 900, 600, 3, [200, 150, 100]],
  ['g3.png', 900, 600, 4, [180, 160, 130]],
  ['g4.png', 900, 600, 5, [220, 120, 90]],
  ['g5.png', 900, 600, 6, [210, 180, 150]],
  ['g6.png', 900, 600, 7, [160, 130, 100]],
];
for (const [name, w, h, seed, hue] of jobs) {
  const buf = png(w, h, photoLike(seed, hue));
  writeFileSync(join(out, 'img', name), buf);
  console.log(name, `${w}x${h}`, `${(buf.length / 1024).toFixed(0)} KB`);
}

// A large, unminified "vendor" script, mostly unused, with a small amount of work at startup.
let vendor = '/* vendor.js: bundled utility library (unminified, mostly unused) */\n';
for (let i = 0; i < 900; i++) {
  vendor += `
/**
 * Utility function number ${i}. Normalizes a list of values, applies a transformation and returns a summary.
 */
function utilityFunction${i}(values, options) {
  var result = [];
  var settings = options || { factor: ${i % 7 + 1}, offset: ${i % 13} };
  for (var index = 0; index < values.length; index++) {
    var current = values[index] * settings.factor + settings.offset;
    result.push(current);
  }
  return { count: result.length, total: result.reduce(function (a, b) { return a + b; }, 0) };
}
`;
}
vendor += '\nwindow.__vendorReady = true;\n';
writeFileSync(join(out, 'js', 'vendor.js'), vendor);
console.log('vendor.js', `${(vendor.length / 1024).toFixed(0)} KB`);
