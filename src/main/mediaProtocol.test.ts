import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ session: { defaultSession: { protocol: { handle: vi.fn() } } } }))
const stored = vi.hoisted(() => ({ value: null as { mediaType: string; bytes: Buffer } | null, url: '' }))
vi.mock('./conversations', () => ({
  readStoredImage: (url: unknown) => {
    stored.url = String(url)
    return stored.value
  }
}))

import { serveStoredMedia } from './mediaProtocol'

describe('serveStoredMedia', () => {
  it('serves a stored image with its type, cached as immutable and never sniffed', () => {
    stored.value = { mediaType: 'image/png', bytes: Buffer.from('png bytes') }
    const res = serveStoredMedia('houston-media://id/ref.png')
    expect(stored.url).toBe('houston-media://id/ref.png')
    expect(res.status).toBe(200)
    expect(Buffer.from(res.body!).toString()).toBe('png bytes')
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['cache-control']).toContain('immutable')
  })

  it('answers 404 for anything the store does not resolve', () => {
    stored.value = null
    const res = serveStoredMedia('houston-media://id/../../x')
    expect(res.status).toBe(404)
    expect(res.body).toBeNull()
  })
})
