'use strict';
/**
 * DeskNest 图标 = 毛玻璃半透明白球 + 黑箭头（和桌面收起态那颗球一致）
 * 手写 PNG 编码 + 4x 超采样，无依赖。输出 assets/desknest.ico (256/64/48/32/16) + assets/desknest-256.png
 *   node tools/make-ball-icon.js
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'assets');
const SS = 4;

const T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([l, body, c]); };
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const distSeg = (x, y, x1, y1, x2, y2) => {
  const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy || 1;
  let t = ((x - x1) * dx + (y - y1) * dy) / L; t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
};

function draw(size) {
  const S = size * SS, c = S / 2, R = S * 0.455;
  const thin = size <= 32 ? 1.9 : 1.0;                       // 小尺寸把线条加粗一点才看得清
  const aw = R * 0.235 * thin;                               // 箭头线宽
  const ax = R * 0.40, ay = R * 0.34;                        // 箭头臂长
  const top = c - R * 0.46, bot = c + R * 0.50, cross = c - R * 0.02;
  const big = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4, px = x + 0.5, py = y + 0.5;
      const d = Math.hypot(px - c, py - c);
      if (d > R) { big[i + 3] = 0; continue; }
      const v = (py - (c - R)) / (2 * R);                    // 0 顶 1 底
      let a = 0.97 - v * 0.20;                               // 毛玻璃：上白下略透
      const ring = d > R - R * 0.055 ? (d - (R - R * 0.055)) / (R * 0.055) : 0;
      let r = 255, g = 255, b = 255;
      r -= ring * 40; g -= ring * 32; b -= ring * 18;        // 边缘一层冷灰圈，白桌面上也看得见
      const hl = Math.max(0, 1 - Math.hypot(px - c, py - (c - R * 0.42)) / (R * 0.72)) * 0.10;
      r = r + (255 - r) * hl; g = g + (255 - g) * hl; b = b + (255 - b) * hl;
      const onArrow = distSeg(px, py, c, bot, c, top) <= aw / 2
        || distSeg(px, py, c - ax, cross - ay * 0.55, c, top) <= aw / 2
        || distSeg(px, py, c + ax, cross - ay * 0.55, c, top) <= aw / 2;
      if (onArrow) { r = 16; g = 19; b = 25; a = Math.max(a, 0.95); }
      big[i] = Math.round(r); big[i + 1] = Math.round(g); big[i + 2] = Math.round(b);
      big[i + 3] = Math.round(255 * a);
    }
  }
  const out = Buffer.alloc(size * size * 4), n = SS * SS;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const j = ((y * SS + sy) * S + (x * SS + sx)) * 4, al = big[j + 3] / 255;
      r += big[j] * al; g += big[j + 1] * al; b += big[j + 2] * al; a += al;
    }
    const i = (y * size + x) * 4;
    if (a > 0) { out[i] = Math.round(r / a); out[i + 1] = Math.round(g / a); out[i + 2] = Math.round(b / a); }
    out[i + 3] = Math.round((a / n) * 255);
  }
  return out;
}

function ico(entries) {
  const h = Buffer.alloc(6); h.writeUInt16LE(0, 0); h.writeUInt16LE(1, 2); h.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length); let off = 6 + 16 * entries.length;
  entries.forEach((e, i) => { const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size; dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.png.length, o + 8); dir.writeUInt32LE(off, o + 12); off += e.png.length; });
  return Buffer.concat([h, dir, ...entries.map((e) => e.png)]);
}

fs.mkdirSync(OUT, { recursive: true });
const sizes = [256, 64, 48, 32, 16];
const entries = sizes.map((size) => ({ size, png: png(size, size, draw(size)) }));
fs.writeFileSync(path.join(OUT, 'desknest-256.png'), entries[0].png);
fs.writeFileSync(path.join(OUT, 'desknest.ico'), ico(entries));
console.log('ball icon written:', path.join(OUT, 'desknest.ico'), entries.map((e) => `${e.size}px/${e.png.length}B`).join(' '));