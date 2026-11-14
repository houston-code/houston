import { describe, expect, it } from 'vitest'
import { imageDataUrl, type ImageAttachment } from '@shared/images'
import { cachedImageDataUrl } from './imageUrl'

describe('cachedImageDataUrl', () => {
  it('builds the same URL as imageDataUrl', () => {
    const a: ImageAttachment = { mediaType: 'image/png', data: 'AAAA' }
    expect(cachedImageDataUrl(a)).toBe(imageDataUrl(a))
  })

  it('keeps one URL per attachment, so equal bytes in two attachments do not share it', () => {
    const a: ImageAttachment = { mediaType: 'image/png', data: 'AAAA' }
    const b: ImageAttachment = { mediaType: 'image/jpeg', data: 'AAAA' }
    expect(cachedImageDataUrl(a)).toBe('data:image/png;base64,AAAA')
    expect(cachedImageDataUrl(b)).toBe('data:image/jpeg;base64,AAAA')
    // Asked again, the first attachment still gets its own.
    expect(cachedImageDataUrl(a)).toBe('data:image/png;base64,AAAA')
  })

  it('uses a stored image\'s URL when the window was given one instead of bytes', () => {
    const a: ImageAttachment = { mediaType: 'image/png', data: '', src: 'houston-media://x/y.png' }
    expect(cachedImageDataUrl(a)).toBe('houston-media://x/y.png')
  })
})
