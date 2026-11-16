// Draws the app icon and the tray glyph as PNGs without any image library.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const ss = 4; // supersampling for smooth edges
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const p = pixel((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3];
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? r / a : 0; raw[o + 1] = a ? g / a : 0; raw[o + 2] = a ? b / a : 0; raw[o + 3] = (a / (ss * ss)) * 255;
    }
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0); head.writeUInt32BE(size, 4);
  head[8] = 8; head[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
// A ring with a check mark inside: time that has been checked.
const seg = (px, py, ax, ay, bx, by) => {
  const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
};
const glyph = (x, y, ring, stroke) => {
  const d = Math.hypot(x - 0.5, y - 0.5);
  const onRing = Math.abs(d - ring) < stroke / 2;
  const check = Math.min(seg(x, y, 0.36, 0.52, 0.46, 0.62), seg(x, y, 0.46, 0.62, 0.66, 0.40)) < stroke / 2;
  return onRing || check;
};
const appIcon = (x, y) => {
  const m = 0.08, r = 0.2;
  const qx = Math.max(m + r - x, x - (1 - m - r), 0), qy = Math.max(m + r - y, y - (1 - m - r), 0);
  const inside = x > m && x < 1 - m && y > m && y < 1 - m && Math.hypot(qx, qy) <= r;
  if (!inside) return [0, 0, 0, 0];
  return glyph(x, y, 0.27, 0.07) ? [255, 255, 255, 1] : [20, 121, 74, 1];
};
const tray = (x, y) => (glyph(x, y, 0.36, 0.1) ? [0, 0, 0, 1] : [0, 0, 0, 0]);
writeFileSync("app-icon.png", png(1024, appIcon));
writeFileSync("src-tauri/icons/tray.png", png(44, tray));
