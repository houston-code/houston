import { describe, expect, it } from 'vitest'
import { MAX_FILE_TEXT_BYTES } from '@shared/composerContext'
import { isLargePaste, LARGE_PASTE_CHARS, LARGE_PASTE_LINES, pasteDetail, readDroppedFile } from './composerFiles'

describe('isLargePaste', () => {
  it('folds a long or many-line paste, and leaves an ordinary one', () => {
    expect(isLargePaste('a short note')).toBe(false)
    expect(isLargePaste('x'.repeat(LARGE_PASTE_CHARS))).toBe(true)
    expect(isLargePaste(Array.from({ length: LARGE_PASTE_LINES }, () => 'l').join('\n'))).toBe(true)
    expect(isLargePaste(Array.from({ length: LARGE_PASTE_LINES - 1 }, () => 'l').join('\n'))).toBe(false)
  })
  it('names the size by lines', () => {
    expect(pasteDetail('a\nb\nc')).toBe('3 lines')
    expect(pasteDetail('a')).toBe('1 line')
  })
})

describe('readDroppedFile', () => {
  it('reads a text file like the attach path does', async () => {
    const f = await readDroppedFile(new File(['hello\nworld'], 'notes.md', { type: 'text/markdown' }))
    expect(f).toMatchObject({ name: 'notes.md', content: 'hello\nworld', binary: false, truncated: false, bytes: 11 })
  })
  it('caps a large file and says so', async () => {
    const f = await readDroppedFile(new File(['y'.repeat(MAX_FILE_TEXT_BYTES + 5)], 'big.log'))
    expect(f.truncated).toBe(true)
    expect(f.content).toHaveLength(MAX_FILE_TEXT_BYTES)
  })
  it('keeps a binary file (a PDF) to its name only', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x00, 0x0a, 0xff])
    const f = await readDroppedFile(new File([pdf], 'spec.pdf', { type: 'application/pdf' }))
    expect(f).toMatchObject({ name: 'spec.pdf', content: null, binary: true })
  })
})
