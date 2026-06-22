// Generates build/icon.png (1024x1024) — the Coder Pro app icon.
// Dependency-free: rasterizes with simple signed-distance fields and encodes
// the PNG by hand via node:zlib. Run: node scripts/make-icon.mjs
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 1024
const __dirname = dirname(fileURLToPath(import.meta.url))

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}
function mix(a, b, t) {
  return a + (b - a) * t
}

// distance to a rounded box centered at (cx,cy) with half extents (hw,hh) and radius r
function sdRoundedBox(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r)
  const qy = Math.abs(py - cy) - (hh - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

// distance to a capsule (segment a->b with radius rad)
function sdCapsule(px, py, ax, ay, bx, by, rad) {
  const pax = px - ax
  const pay = py - ay
  const bax = bx - ax
  const bay = by - ay
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1)
  return Math.hypot(pax - bax * h, pay - bay * h) - rad
}

const ACCENT = [0x6e, 0xa8, 0xfe]
const TOP = [0x22, 0x33, 0x57]
const BOT = [0x0d, 0x16, 0x2b]

const data = Buffer.alloc(SIZE * SIZE * 4)

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4
    let r = 0
    let g = 0
    let b = 0
    let a = 0

    // Background rounded square.
    const bgD = sdRoundedBox(x, y, SIZE / 2, SIZE / 2, 412, 412, 200)
    const bgCov = clamp(0.5 - bgD, 0, 1)
    if (bgCov > 0) {
      const t = y / SIZE
      r = mix(TOP[0], BOT[0], t)
      g = mix(TOP[1], BOT[1], t)
      b = mix(TOP[2], BOT[2], t)
      a = 255 * bgCov
    }

    // Chevron ">" (terminal prompt) — two thick capsules.
    const rad = 46
    const cx = 360
    const cy = 512
    const dChevTop = sdCapsule(x, y, cx - 70, cy - 150, cx + 110, cy, rad)
    const dChevBot = sdCapsule(x, y, cx + 110, cy, cx - 70, cy + 150, rad)
    // Underscore "_".
    const dUnder = sdCapsule(x, y, 540, cy + 150, 700, cy + 150, rad)
    const glyphD = Math.min(dChevTop, dChevBot, dUnder)
    const glyphCov = clamp(0.5 - glyphD, 0, 1) * bgCov
    if (glyphCov > 0) {
      r = mix(r, ACCENT[0], glyphCov)
      g = mix(g, ACCENT[1], glyphCov)
      b = mix(b, ACCENT[2], glyphCov)
      a = Math.max(a, 255 * glyphCov)
    }

    data[i] = Math.round(r)
    data[i + 1] = Math.round(g)
    data[i + 2] = Math.round(b)
    data[i + 3] = Math.round(a)
  }
}

// ---- Minimal PNG encoder ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, payload) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(payload.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, payload])), 0)
  return Buffer.concat([len, typeBuf, payload, crcBuf])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
// raw scanlines with filter byte 0
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0
  data.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const outPath = resolve(__dirname, '..', 'build', 'icon.png')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, png)
console.log(`Wrote ${outPath} (${png.length} bytes)`)
