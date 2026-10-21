import { describe, expect, it } from 'vitest'
import {
  galleryFiles,
  MAX_GALLERY_CAPTION,
  MAX_GALLERY_IMAGES,
  fileNameOf,
  parseGalleryArgs,
  parseGalleryArgsSafe,
  sniffImageType
} from './gallery'

const bytes = (...b: number[]): Uint8Array => new Uint8Array(b)

describe('parseGalleryArgs', () => {
  it('normalizes title, labels, and captions', () => {
    expect(
      parseGalleryArgs({
        title: '  Settings   page ',
        images: [{ path: ' shots/dark.png ', label: 'Dark', caption: 'The  dark\ntheme.' }, { path: 'shots/light.png' }]
      })
    ).toEqual({
      title: 'Settings page',
      images: [
        { path: 'shots/dark.png', label: 'Dark', caption: 'The dark theme.' },
        { path: 'shots/light.png', label: 'light.png' }
      ]
    })
  })

  it('drops blank optional text instead of keeping an empty string', () => {
    expect(parseGalleryArgs({ title: '  ', images: [{ path: 'a.png', label: ' ', caption: '' }] })).toEqual({
      images: [{ path: 'a.png', label: 'a.png' }]
    })
  })

  it('rejects malformed input with a message the model can act on', () => {
    expect(() => parseGalleryArgs({})).toThrow('images must be a non-empty array')
    expect(() => parseGalleryArgs({ images: [] })).toThrow('non-empty')
    expect(() => parseGalleryArgs({ images: ['a.png'] })).toThrow('images[0] must be an object')
    expect(() => parseGalleryArgs({ images: [{ path: '' }] })).toThrow('images[0].path')
    expect(() => parseGalleryArgs({ images: [{ path: 'a.png', label: 3 }] })).toThrow('images[0].label must be a string')
    expect(() => parseGalleryArgs({ title: 5, images: [{ path: 'a.png' }] })).toThrow('title must be a string')
    expect(() =>
      parseGalleryArgs({ images: [{ path: 'a.png', caption: 'x'.repeat(MAX_GALLERY_CAPTION + 1) }] })
    ).toThrow(`at most ${MAX_GALLERY_CAPTION}`)
  })

  it('caps the number of images per call', () => {
    const images = Array.from({ length: MAX_GALLERY_IMAGES + 1 }, (_, i) => ({ path: `${i}.png` }))
    expect(() => parseGalleryArgs({ images })).toThrow(`at most ${MAX_GALLERY_IMAGES}`)
    expect(parseGalleryArgs({ images: images.slice(1) }).images).toHaveLength(MAX_GALLERY_IMAGES)
  })

  it('has a safe variant for display code', () => {
    expect(parseGalleryArgsSafe(undefined)).toBeNull()
    expect(parseGalleryArgsSafe({ images: 'nope' })).toBeNull()
    expect(parseGalleryArgsSafe({ images: [{ path: 'a.png' }] })?.images[0].label).toBe('a.png')
  })
})

describe('fileNameOf', () => {
  it('takes the last segment of POSIX and Windows paths', () => {
    expect(fileNameOf('shots/ui/dark.png')).toBe('dark.png')
    expect(fileNameOf('C:\\shots\\dark.png')).toBe('dark.png')
    expect(fileNameOf('dark.png')).toBe('dark.png')
  })
})

describe('sniffImageType', () => {
  it('recognizes PNG, JPEG, GIF, and WebP by their leading bytes', () => {
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png')
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg')
    expect(sniffImageType(new TextEncoder().encode('GIF89a...'))).toBe('image/gif')
    expect(sniffImageType(new TextEncoder().encode('GIF87a...'))).toBe('image/gif')
    expect(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
  })

  it('rejects everything else, including text named like an image', () => {
    expect(sniffImageType(new TextEncoder().encode('API_KEY=sk-123'))).toBeNull()
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WAVEfmt '))).toBeNull()
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e))).toBeNull()
    expect(sniffImageType(bytes())).toBeNull()
  })
})

describe('compareWith', () => {
  it('parses it and lists compare files after the entries', () => {
    const g = parseGalleryArgs({ images: [{ path: 'new.png', compareWith: ' old.png ' }, { path: 'b.png' }] })
    expect(g.images[0]).toEqual({ path: 'new.png', label: 'new.png', compareWith: 'old.png' })
    expect(galleryFiles(g)).toEqual(['new.png', 'b.png', 'old.png'])
  })

  it('counts compare images toward the cap and rejects a blank one', () => {
    const images = Array.from({ length: 7 }, (_, i) => ({ path: `${i}.png`, compareWith: `old${i}.png` }))
    expect(() => parseGalleryArgs({ images })).toThrow('counting compareWith images')
    expect(() => parseGalleryArgs({ images: [{ path: 'a.png', compareWith: ' ' }] })).toThrow('compareWith')
  })
})
