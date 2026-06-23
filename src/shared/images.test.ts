import { describe, expect, it } from 'vitest'
import {
  MAX_ATTACHMENTS,
  exceedsImageSizeLimit,
  imageDataUrl,
  isSupportedImageType,
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
