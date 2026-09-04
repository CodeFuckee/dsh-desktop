#!/usr/bin/env node
/**
 * Generate a placeholder 1024x1024 app icon (pure Node, no deps): a DeepSeek-ish
 * blue gradient rounded square with a stylized chat mark. Writes
 * scripts/assets/icon-source.png; the `tauri icon` CLI then derives the full
 * icon set (icns/ico/png) into src-tauri/icons — run `npm run gen:icon`.
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'scripts', 'assets', 'icon-source.png')
const SIZE = 1024

// --- minimal PNG encoder (RGBA, 8-bit) -------------------------------------

function crc32(buf) {
  let c
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })())
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]
}

// --- drawing ---------------------------------------------------------------

const C_TOP = [77, 107, 254] // #4d6bfe
const C_BOTTOM = [139, 123, 255] // #8b7bff
const C_WHITE = [255, 255, 255]
const CORNER = 0.22 * SIZE

function insideRoundedSquare(x, y) {
  const r = CORNER
  if (x >= r && x <= SIZE - r) return true
  if (y >= r && y <= SIZE - r) return true
  const cx = x < r ? r : SIZE - r
  const cy = y < r ? r : SIZE - r
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

/** Chat-mark glyph: rounded speech bubble with a tail. */
function insideMark(x, y) {
  const cx = SIZE / 2
  const cy = SIZE / 2 - 30
  const bw = 330
  const bh = 250
  const br = 70
  // bubble rect with rounded corners
  const inBubble =
    (x >= cx - bw / 2 && x <= cx + bw / 2 && y >= cy - bh / 2 && y <= cy + bh / 2) &&
    (Math.abs(x - (cx - bw / 2 + br)) > br || Math.abs(y - (cy - bh / 2 + br)) > br ||
      (x - (cx - bw / 2 + br)) ** 2 + (y - (cy - bh / 2 + br)) ** 2 <= br * br) &&
    (Math.abs(x - (cx + bw / 2 - br)) > br || Math.abs(y - (cy - bh / 2 + br)) > br ||
      (x - (cx + bw / 2 - br)) ** 2 + (y - (cy - bh / 2 + br)) ** 2 <= br * br) &&
    (Math.abs(x - (cx - bw / 2 + br)) > br || Math.abs(y - (cy + bh / 2 - br)) > br ||
      (x - (cx - bw / 2 + br)) ** 2 + (y - (cy + bh / 2 - br)) ** 2 <= br * br) &&
    (Math.abs(x - (cx + bw / 2 - br)) > br || Math.abs(y - (cy + bh / 2 - br)) > br ||
      (x - (cx + bw / 2 - br)) ** 2 + (y - (cy + bh / 2 - br)) ** 2 <= br * br)
  // tail triangle
  const inTail =
    x >= cx - 70 && x <= cx + 70 && y >= cy + bh / 2 && y <= cy + bh / 2 + 90 &&
    Math.abs(x - cx) <= 70 * (1 - (y - (cy + bh / 2)) / 90)
  return inBubble || inTail
}

const rgba = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let px
    if (insideRoundedSquare(x, y)) {
      const t = y / SIZE
      px = insideMark(x, y)
        ? C_WHITE
        : mix(C_TOP, C_BOTTOM, t)
      const alpha = 1
      const i = (y * SIZE + x) * 4
      rgba[i] = Math.round(px[0])
      rgba[i + 1] = Math.round(px[1])
      rgba[i + 2] = Math.round(px[2])
      rgba[i + 3] = Math.round(alpha * 255)
    } else {
      const i = (y * SIZE + x) * 4
      rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 0
    }
  }
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, encodePng(SIZE, SIZE, rgba))
console.log('wrote', OUT, `(${SIZE}x${SIZE})`)
console.log('run: npm run gen:icon  (or: npx tauri icon scripts/assets/icon-source.png)')