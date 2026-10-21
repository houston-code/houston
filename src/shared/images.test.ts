import { describe, expect, it } from 'vitest'
import {
  MAX_ATTACHMENTS,
  exceedsImageSizeLimit,
  imageDataUrl,
  isSupportedImageType,
  imageFileName,
  parseImageDataUrl,
  sanitizeAttachments
} from './images'

describe('exceedsImageSizeLimit', () => {
  it('passes small payloads and rejects huge ones', () => {
    expect(exceedsImageSizeLimit('abc')).toBe(false)
    expect(exceedsImageSizeLimit('a'.repeat(8 * 1024 * 1024))).toBe(true)
  })
})

describe('isSupportedImageType', () => {
  it('accepts known image types and rejects others', () => {
    expect(isSupportedImageType('image/png')).toBe(true)
    expect(isSupportedImageType('image/webp')).toBe(true)
    expect(isSupportedImageType('application/pdf')).toBe(false)
    expect(isSupportedImageType('text/plain')).toBe(false)
  })
})

describe('imageDataUrl', () => {
  it('builds a data URL', () => {
    expect(imageDataUrl({ mediaType: 'image/png', data: 'AAAA' })).toBe('data:image/png;base64,AAAA')
  })
})

describe('sanitizeAttachments', () => {
  it('keeps valid attachments', () => {
    const out = sanitizeAttachments([{ mediaType: 'image/png', data: 'abc' }])
    expect(out).toEqual([{ mediaType: 'image/png', data: 'abc' }])
  })

  it('drops unsupported types, empty data, and non-objects', () => {
    expect(
      sanitizeAttachments([
        { mediaType: 'image/svg+xml', data: 'x' },
        { mediaType: 'image/png', data: '' },
        'nope',
        null,
        { mediaType: 'image/jpeg', data: 'ok' }
      ])
    ).toEqual([{ mediaType: 'image/jpeg', data: 'ok' }])
  })

  it('caps the number of attachments', () => {
    const many = Array.from({ length: MAX_ATTACHMENTS + 5 }, () => ({ mediaType: 'image/png', data: 'x' }))
    expect(sanitizeAttachments(many)).toHaveLength(MAX_ATTACHMENTS)
  })

  it('rejects oversized payloads', () => {
    const huge = { mediaType: 'image/png', data: 'a'.repeat(8 * 1024 * 1024) }
    expect(sanitizeAttachments([huge])).toEqual([])
  })

  it('returns [] for non-arrays', () => {
    expect(sanitizeAttachments(undefined)).toEqual([])
    expect(sanitizeAttachments('x')).toEqual([])
  })
})

describe('parseImageDataUrl', () => {
  it('accepts supported base64 image data URLs', () => {
    expect(parseImageDataUrl('data:image/png;base64,iVBORw0K')).toEqual({ mediaType: 'image/png', data: 'iVBORw0K' })
    expect(parseImageDataUrl('data:image/webp;base64,UklGRg==')?.mediaType).toBe('image/webp')
  })

  it('rejects anything else from across the IPC boundary', () => {
    for (const v of [
      'data:image/svg+xml;base64,PHN2Zz4=',
      'data:text/html;base64,PGgxPg==',
      'data:image/png,not-base64',
      'data:image/png;base64,bad chars!',
      'file:///etc/passwd',
      42,
      null
    ]) {
      expect(parseImageDataUrl(v)).toBeNull()
    }
  })
})

describe('imageFileName', () => {
  it('builds a safe name with the right extension', () => {
    expect(imageFileName('Mobile, dark', 'image/png')).toBe('Mobile-dark.png')
    expect(imageFileName('../../etc/passwd', 'image/jpeg')).toBe('..-..-etc-passwd.jpg')
    expect(imageFileName('', 'image/webp')).toBe('image.webp')
  })
})
