import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { ROOT } from '../launch'
import { SHOTS } from './model'

/** A number from the environment, or `fallback` when unset or not a positive number. */
export function envNumber(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/**
 * A throwaway project for the soak model's tools: a 2 MB source file (each read_file
 * returns a 2000-line window of it) and a few ~400 KB screenshots.
 */
export function soakWorkspace(): string {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'houston-soak-ws-')))
  const lines = Array.from({ length: 40000 }, (_, i) => `export const value${i} = ${i} // padding text for size`)
  writeFileSync(join(ws, 'big.ts'), lines.join('\n'))
  writeFileSync(join(ws, 'README.md'), '# soak\n')
  mkdirSync(join(ws, 'notes'))
  for (let i = 0; i < SHOTS; i++) writeFileSync(join(ws, `shot${i}.png`), noisePng(i))
  return ws
}

/** A valid PNG of about 400 KB of noise, distinct per `seed`, so it does not compress away. */
export function noisePng(seed: number): Buffer {
  const w = 400
  const h = 330
  const row = w * 3 + 1
  const raw = randomBytes(row * h)
  for (let y = 0; y < h; y++) raw[y * row] = 0
  raw[1] = seed & 255
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** One measured value checked against its budget. */
export interface Check {
  name: string
  value: number
  limit: number
  unit: string
}

/**
 * Record a scenario's samples and checks: a JSON file under test-results/soak/ (kept as
 * a CI artifact, so a trend can be read across runs), a table in the job summary on
 * GitHub Actions, and lines in the log. Returns the checks that went over budget.
 */
export function report(scenario: string, samples: unknown[], checks: Check[]): Check[] {
  const dir = join(ROOT, 'test-results', 'soak')
  mkdirSync(dir, { recursive: true })
  const over = checks.filter((c) => c.value > c.limit)
  const file = join(dir, `${scenario}-${process.platform}-${process.arch}.json`)
  writeFileSync(file, `${JSON.stringify({ scenario, platform: process.platform, arch: process.arch, samples, checks }, null, 2)}\n`)
  for (const s of samples) console.log(`[soak] ${scenario} ${JSON.stringify(s)}`)
  for (const c of checks) {
    console.log(`[soak] ${scenario} ${c.value > c.limit ? 'OVER' : 'ok  '} ${c.name}: ${fmt(c.value)} ${c.unit} (limit ${fmt(c.limit)})`)
  }
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) {
    const rows = checks.map((c) => `| ${c.value > c.limit ? 'over' : 'ok'} | ${c.name} | ${fmt(c.value)} ${c.unit} | ${fmt(c.limit)} ${c.unit} |`)
    appendFileSync(
      summary,
      `\n### Memory soak: ${scenario} (${process.platform}-${process.arch})\n\n| | Check | Measured | Limit |\n|---|---|---|---|\n${rows.join('\n')}\n`
    )
  }
  return over
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}
