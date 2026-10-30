'use strict';
/**
 * 生成 DeskNest 应用图标（无任何依赖）：
 *   - 纯手写 PNG 编码（zlib + CRC32），4 倍超采样抗锯齿
 *   - 图形 = 蓝色渐变圆角方 + 2×2 白色圆点（对应 App 内的「九宫格收纳」）
 *   - 输出 assets/desknest.ico（含 256/48/32/16 四档 PNG-in-ICO）+ assets/desknest-256.png
 *   node tools/make-icon.js
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.join(__dirname, '..', 'assets');
const SS = 4;                                  // 超采样倍数
const BRAND = [[79, 140, 255], [55, 213, 255]]; // #4f8cff -> #37d5ff

/* ---------- CRC32 / PNG 编码 ---------- */
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;                                  // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- 图形（在 SS 倍画布上绘制，再盒式降采样） ---------- */
const mix = (a, b, t) => a + (b - a) * t;
function roundedRectAlpha(x, y, size, radius) {          // 圆角方形的覆盖率（硬边，靠超采样平滑）
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const dx = x - cx, dy = y - cy;
  return (dx * dx + dy * dy) <= radius * radius ? 1 : 0;
}
function drawRoundedRectCoverage(size, radius) {
  const cov = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) cov[y * size + x] = roundedRectAlpha(x + 0.5, y + 0.5, size, radius);
  return cov;
}
function drawIcon(size) {
  const S = size * SS;
  const pad = Math.round(S * 0.055);
  const inner = S - pad * 2;
  const radius = Math.round(inner * 0.235);               // squircle 感
  const cov = drawRoundedRectCoverage(S, radius);

  const dots = [];                                        // 2×2 白点
  const dR = inner * 0.145;
  const off = inner * 0.155;
  const c = S / 2;
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) dots.push([c + sx * off, c + sy * off, dR]);

  const big = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const px = x + 0.5 - pad, py = y + 0.5 - pad;
      const inside = (px >= 0 && py >= 0 && px < inner && py < inner) ? cov[y * S + x] : 0;
      if (!inside) continue;
      const t = Math.min(1, Math.max(0, (px / inner) * 0.55 + (py / inner) * 0.75));  // 斜向渐变
      let r = mix(BRAND[0][0], BRAND[1][0], t);
      let g = mix(BRAND[0][1], BRAND[1][1], t);
      let b = mix(BRAND[0][2], BRAND[1][2], t);
      // 顶部高光 + 底部压暗，做出玻璃感
      const v = (py / inner);
      const hi = Math.max(0, 1 - v * 2.1) * 0.20;
      const lo = Math.max(0, (v - 0.62) / 0.38) * 0.16;
      r = r + (255 - r) * hi - r * lo;
      g = g + (255 - g) * hi - g * lo;
      b = b + (255 - b) * hi - b * lo;
      // 白点（覆盖率硬边，交给降采样平滑）
      let a = 1;
      for (const [dx0, dy0, dr] of dots) {
        if (dx0 >= pad && dx0 <= S - pad) {
          const ddx = (x + 0.5 - dx0), ddy = (y + 0.5 - dy0);
          if (ddx * ddx + ddy * ddy <= dr * dr) { r = 255; g = 255; b = 255; a = 1; }
        }
      }
      big[i] = Math.round(Math.min(255, Math.max(0, r)));
      big[i + 1] = Math.round(Math.min(255, Math.max(0, g)));
      big[i + 2] = Math.round(Math.min(255, Math.max(0, b)));
      big[i + 3] = Math.round(255 * a * inside);
    }
  }

  // 盒式降采样 -> size×size
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const j = ((y * SS + sy) * S + (x * SS + sx)) * 4;
        const al = big[j + 3] / 255;
        r += big[j] * al; g += big[j + 1] * al; b += big[j + 2] * al; a += al;
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      if (a > 0) { out[i] = Math.round(r / a); out[i + 1] = Math.round(g / a); out[i + 2] = Math.round(b / a); }
      out[i + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

/* ---------- ICO 容器（PNG-in-ICO，Vista+ 全支持） ---------- */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0; dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.png.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map(e => e.png)]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const sizes = [256, 48, 32, 16];
const entries = sizes.map(size => ({ size, png: encodePng(size, size, drawIcon(size)) }));
fs.writeFileSync(path.join(OUT_DIR, 'desknest-256.png'), entries[0].png);
fs.writeFileSync(path.join(OUT_DIR, 'desknest.ico'), buildIco(entries));
console.log('icon written:', path.join(OUT_DIR, 'desknest.ico'),
  entries.map(e => `${e.size}px/${e.png.length}B`).join(' '));