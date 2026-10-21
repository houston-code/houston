import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_READ_CHARS, numberedRead, streamNumberedRead } from './read-lines'
import { contentDigest } from './readCache'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'houston-read-lines-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

let n = 0
function file(content: string | Buffer): string {
  const path = join(dir, `f${n++}.txt`)
  writeFileSync(path, content)
  return path
}

/** The stream must produce exactly what formatting the whole text in memory does. */
async function expectSame(text: string, ranges: Array<[number | undefined, number | undefined]>): Promise<void> {
  const path = file(text)
  for (const [offset, limit] of ranges) {
    const read = await streamNumberedRead(path, offset, limit)
    expect(read.binary).toBe(false)
    if (read.binary) return
    expect(read.output).toBe(numberedRead(text, offset, limit))
    expect(read.digest).toBe(contentDigest(Buffer.from(text, 'utf8')))
    expect(read.bytes).toBe(Buffer.byteLength(text))
  }
}

const RANGES: Array<[number | undefined, number | undefined]> = [
  [undefined, undefined],
  [1, 1],
  [2, 3],
  [3, undefined],
  [undefined, 2],
  [1, 0],
  [50, 5],
  [0, 2]
]

describe('streamNumberedRead matches numberedRead', () => {
  it.each([
    ['empty', ''],
    ['a lone newline', '\n'],
    ['no final newline', 'a\nb\nc'],
    ['a final newline', 'a\nb\nc\n'],
    ['blank lines at the end', 'a\n\n\n'],
    ['CRLF endings', 'one\r\ntwo\r\nthree\r\n'],
    ['a lone CR', 'x\ry\n']
  ])('%s', async (_name, text) => {
    await expectSame(text, RANGES)
  })

  it('multi-byte characters split across read chunks', async () => {
    // 64 KB chunks: put 2-, 3- and 4-byte characters across every boundary.
    const unit = 'é漢😀\n'
    const text = `${'x'.repeat(65_535)}${unit.repeat(40_000)}tail`
    await expectSame(text, [[undefined, undefined], [2, 5], [39_000, 10]])
  })

  it('a file past the listing budget, paged from the middle', async () => {
    const text = Array.from({ length: 50_000 }, (_, i) => `line ${i} ${'-'.repeat(i % 40)}`).join('\n')
    await expectSame(text, [[undefined, undefined], [20_000, undefined], [49_999, 10], [10, 3]])
  })

  it('a single line longer than the budget, alone and between others', async () => {
    const long = 'y'.repeat(MAX_READ_CHARS * 3 + 7)
    await expectSame(`${long}\nnext\n`, RANGES)
    await expectSame(`first\n${long}\nlast`, RANGES)
  })
})

describe('streamNumberedRead on large and binary files', () => {
  it('lists a few lines of a 40 MB log without reading it into memory', async () => {
    const line = `${'2026-10-22T00:00:00Z INFO request served '.padEnd(99, '.')}\n` // 100 bytes
    const lines = 400_000
    const path = file(Buffer.from(line.repeat(lines)))
    const read = await streamNumberedRead(path, 123_456, 2)
    expect(read.binary).toBe(false)
    if (read.binary) return
    expect(read.output.split('\n')[0]).toBe(`[lines 123456-123457 of ${lines}]`)
    expect(read.bytes).toBe(line.length * lines)
  })

  it('reports binary content from its first bytes', async () => {
    const read = await streamNumberedRead(file(Buffer.from([0x50, 0x4b, 0x00, 0x03, 0x41])))
    expect(read).toMatchObject({ binary: true, bytes: 5 })
    expect(read.digest).toBe(contentDigest(Buffer.from([0x50, 0x4b, 0x00, 0x03, 0x41])))
  })

  it('treats a NUL past the sniffed prefix as text, like looksBinary', async () => {
    const text = `${'a'.repeat(9_000)}\u0000b\n`
    const read = await streamNumberedRead(file(text))
    expect(read.binary).toBe(false)
  })
})
