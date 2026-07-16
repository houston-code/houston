import { describe, it, expect } from 'vitest'
import { BINARY_SNIFF_BYTES, imageMediaTypeForPath, isPdfPath, humanSize, looksBinary } from './attachments'

describe('imageMediaTypeForPath', () => {
  it('maps known image extensions (case-insensitive)', () => {
    expect(imageMediaTypeForPath('a/b/logo.png')).toBe('image/png')
    expect(imageMediaTypeForPath('shot.JPG')).toBe('image/jpeg')
    expect(imageMediaTypeForPath('x.jpeg')).toBe('image/jpeg')
    expect(imageMediaTypeForPath('anim.gif')).toBe('image/gif')
    expect(imageMediaTypeForPath('pic.webp')).toBe('image/webp')
  })

  it('returns null for non-images', () => {
    expect(imageMediaTypeForPath('main.ts')).toBeNull()
    expect(imageMediaTypeForPath('doc.pdf')).toBeNull()
    expect(imageMediaTypeForPath('noext')).toBeNull()
    expect(imageMediaTypeForPath('image.svg')).toBeNull() // svg is text, not a raster image type
  })
})

describe('isPdfPath', () => {
  it('detects .pdf (case-insensitive)', () => {
    expect(isPdfPath('report.pdf')).toBe(true)
    expect(isPdfPath('REPORT.PDF')).toBe(true)
    expect(isPdfPath('notes.txt')).toBe(false)
  })
})

describe('looksBinary', () => {
  it('treats ordinary text, including unicode and empty files, as text', () => {
    expect(looksBinary(Buffer.from('const x = 1\n'))).toBe(false)
    expect(looksBinary(Buffer.from('héllo — 世界 🎉', 'utf8'))).toBe(false)
    expect(looksBinary(Buffer.from(''))).toBe(false)
  })

  it('treats text with tabs, CRLF, and form feeds as text', () => {
    // Control characters other than NUL appear in perfectly ordinary source files.
    expect(looksBinary(Buffer.from('a\tb\r\nc\x0c\n'))).toBe(false)
  })

  it('detects a NUL byte anywhere in the sniffed head', () => {
    expect(looksBinary(Buffer.from([0x00]))).toBe(true)
    expect(looksBinary(Buffer.from('ELF\x00\x01\x02'))).toBe(true)
    expect(looksBinary(Buffer.concat([Buffer.from('x'.repeat(100)), Buffer.from([0x00])]))).toBe(true)
  })

  it('detects a real PNG header — the case an extension check misses', () => {
    // A .png saved as .txt is exactly what extension-only detection got wrong.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
    expect(looksBinary(png)).toBe(true)
  })

  it('only sniffs the head, matching git', () => {
    // A NUL past the window is not seen: a deliberate, documented limit.
    const late = Buffer.concat([Buffer.from('a'.repeat(BINARY_SNIFF_BYTES)), Buffer.from([0x00])])
    expect(looksBinary(late)).toBe(false)
    const justInside = Buffer.concat([Buffer.from('a'.repeat(BINARY_SNIFF_BYTES - 1)), Buffer.from([0x00])])
    expect(looksBinary(justInside)).toBe(true)
  })

  it('reads UTF-16 as binary, as git does', () => {
    expect(looksBinary(Buffer.from('hi', 'utf16le'))).toBe(true)
  })
})

describe('humanSize', () => {
  it('formats bytes / KB / MB', () => {
    expect(humanSize(512)).toBe('512 B')
    expect(humanSize(2048)).toBe('2.0 KB')
    expect(humanSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
