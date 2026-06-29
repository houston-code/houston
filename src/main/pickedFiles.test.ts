import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_FILE_TEXT_BYTES } from '@shared/composerContext'
import { readPickedFile } from './pickedFiles'

describe('readPickedFile', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'houston-picked-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('reads a text file into UTF-8 content', () => {
    const p = join(dir, 'a.txt')
    writeFileSync(p, 'hello world')
    expect(readPickedFile(p)).toMatchObject({
      name: 'a.txt',
      content: 'hello world',
      binary: false,
      truncated: false,
      bytes: 11
    })
  })

  it('flags a binary file and omits its contents', () => {
    const p = join(dir, 'b.bin')
    writeFileSync(p, Buffer.from([1, 2, 0, 3, 4]))
    const f = readPickedFile(p)
    expect(f.binary).toBe(true)
    expect(f.content).toBeNull()
  })

  it('caps an oversized file and marks it truncated (without reading it whole)', () => {
    const p = join(dir, 'big.txt')
    writeFileSync(p, 'a'.repeat(MAX_FILE_TEXT_BYTES + 100))
    const f = readPickedFile(p)
    expect(f.truncated).toBe(true)
    expect(f.content?.length).toBe(MAX_FILE_TEXT_BYTES)
    expect(f.bytes).toBe(MAX_FILE_TEXT_BYTES + 100)
  })

  it('degrades to null content for an unreadable path', () => {
    const f = readPickedFile(join(dir, 'does-not-exist'))
    expect(f.content).toBeNull()
    expect(f.binary).toBe(false)
    expect(f.bytes).toBe(0)
  })
})
