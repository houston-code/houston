import { describe, it, expect } from 'vitest'
import { imageMediaTypeForPath, isPdfPath, humanSize } from './attachments'

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

describe('humanSize', () => {
  it('formats bytes / KB / MB', () => {
    expect(humanSize(512)).toBe('512 B')
    expect(humanSize(2048)).toBe('2.0 KB')
    expect(humanSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
