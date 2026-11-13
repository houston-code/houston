import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/agent'
import type { ImageAttachment } from '@shared/images'
import { MODEL_IMAGE_CACHE_BYTES, MODEL_IMAGE_MAX_EDGE, setImageDownscaler, withModelImages } from './modelImages'

afterEach(() => setImageDownscaler(null))

const big = { mediaType: 'image/png', data: 'BIG' }
const small = { mediaType: 'image/png', data: 'SMALL' }

describe('withModelImages', () => {
  it('sends images unchanged when no scaler is wired', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'x', images: [big] }]
    expect(await withModelImages(messages)).toBe(messages)
  })

  it('swaps in the model copy without touching the original messages', async () => {
    setImageDownscaler(async (img, max) => {
      expect(max).toBe(MODEL_IMAGE_MAX_EDGE)
      return img.data === 'BIG' ? { mediaType: 'image/png', data: 'SCALED' } : null
    })
    const plain: ChatMessage = { role: 'assistant', content: 'hi' }
    const messages: ChatMessage[] = [
      plain,
      { role: 'tool', content: 'shot', toolCallId: 'c', images: [big, small] }
    ]
    const out = await withModelImages(messages)
    expect(out[0]).toBe(plain)
    expect(out[1].images?.map((i) => i.data)).toEqual(['SCALED', 'SMALL'])
    expect(messages[1].images?.map((i) => i.data)).toEqual(['BIG', 'SMALL'])
  })

  it('keeps a message as the same object when none of its images shrink', async () => {
    setImageDownscaler(async () => null)
    const m: ChatMessage = { role: 'user', content: 'x', images: [small] }
    expect((await withModelImages([m]))[0]).toBe(m)
  })

  it('scales each image once per object, so turns resend identical bytes', async () => {
    const scale = vi.fn(async () => ({ mediaType: 'image/png', data: 'SCALED' }))
    setImageDownscaler(scale)
    const img = { mediaType: 'image/png', data: 'BIG' }
    const messages: ChatMessage[] = [{ role: 'user', content: 'x', images: [img] }]
    const first = await withModelImages(messages)
    const second = await withModelImages([...messages, { role: 'assistant', content: 'ok' }])
    expect(scale).toHaveBeenCalledTimes(1)
    expect(second[0].images![0]).toBe(first[0].images![0])
  })

  it('scales the same bytes once across attachment objects, as when a conversation is reloaded', async () => {
    const scale = vi.fn(async (img: ImageAttachment) => ({ mediaType: 'image/png', data: `SCALED:${img.data}` }))
    setImageDownscaler(scale)
    const turn = (): ChatMessage[] => [{ role: 'user', content: 'x', images: [{ mediaType: 'image/png', data: 'BIG' }] }]
    const first = await withModelImages(turn())
    const second = await withModelImages(turn())
    expect(scale).toHaveBeenCalledTimes(1)
    expect(second[0].images![0]).toBe(first[0].images![0])
    expect(second[0].images![0].data).toBe('SCALED:BIG')
  })

  it('sends the same bytes with the cache as a fresh scale does', async () => {
    const scaleFn = async (img: ImageAttachment): Promise<ImageAttachment | null> =>
      img.data.startsWith('BIG') ? { mediaType: 'image/png', data: `SCALED:${img.data}` } : null
    const images = (): ImageAttachment[] => [
      { mediaType: 'image/png', data: 'BIG1' },
      { mediaType: 'image/png', data: 'SMALL' },
      { mediaType: 'image/jpeg', data: 'BIG2' }
    ]
    const fresh = await Promise.all(images().map(async (img) => (await scaleFn(img)) ?? img))
    setImageDownscaler(scaleFn)
    await withModelImages([{ role: 'user', content: 'x', images: images() }])
    const cached = await withModelImages([{ role: 'user', content: 'x', images: images() }])
    expect(cached[0].images).toEqual(fresh)
  })

  it('never shares an entry between different images', async () => {
    const scale = vi.fn(async (img: ImageAttachment) => ({ mediaType: img.mediaType, data: `SCALED:${img.data}` }))
    setImageDownscaler(scale)
    const out = await withModelImages([
      {
        role: 'user',
        content: 'x',
        images: [
          { mediaType: 'image/png', data: 'AAAA' },
          { mediaType: 'image/png', data: 'AAAB' },
          // Same base64 under another media type is a different image to the model.
          { mediaType: 'image/jpeg', data: 'AAAA' }
        ]
      }
    ])
    expect(scale).toHaveBeenCalledTimes(3)
    expect(out[0].images).toEqual([
      { mediaType: 'image/png', data: 'SCALED:AAAA' },
      { mediaType: 'image/png', data: 'SCALED:AAAB' },
      { mediaType: 'image/jpeg', data: 'SCALED:AAAA' }
    ])
  })

  it('evicts past the byte budget and still returns the right copy', async () => {
    // Each copy is a third of the budget, so the fourth pushes the oldest out.
    const third = Math.floor(MODEL_IMAGE_CACHE_BYTES / 3) - 100
    const scale = vi.fn(async (img: ImageAttachment) => ({
      mediaType: 'image/png',
      data: img.data + 'x'.repeat(third)
    }))
    setImageDownscaler(scale)
    const send = async (data: string): Promise<string> =>
      (await withModelImages([{ role: 'user', content: 'x', images: [{ mediaType: 'image/png', data }] }]))[0].images![0]
        .data
    for (const d of ['A', 'B', 'C', 'D']) await send(d)
    expect(scale).toHaveBeenCalledTimes(4)
    // D is still cached; A was evicted and is scaled again, to the same bytes.
    expect((await send('D')).startsWith('D')).toBe(true)
    expect(scale).toHaveBeenCalledTimes(4)
    const again = await send('A')
    expect(scale).toHaveBeenCalledTimes(5)
    expect(again).toBe('A' + 'x'.repeat(third))
  })

  it('skips decoding an image whose header shows it is already small enough', async () => {
    const scale = vi.fn(async () => ({ mediaType: 'image/png', data: 'SCALED' }))
    setImageDownscaler(scale)
    const header = (w: number, h: number): string => {
      const b = Buffer.alloc(33)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
      b.write('IHDR', 12, 'latin1')
      b.writeUInt32BE(w, 16)
      b.writeUInt32BE(h, 20)
      return b.toString('base64')
    }
    const atCap = { mediaType: 'image/png', data: header(MODEL_IMAGE_MAX_EDGE, 900) }
    const over = { mediaType: 'image/png', data: header(MODEL_IMAGE_MAX_EDGE + 1, 900) }
    const out = await withModelImages([{ role: 'user', content: 'x', images: [atCap, over] }])
    expect(out[0].images![0]).toBe(atCap)
    expect(out[0].images![1].data).toBe('SCALED')
    expect(scale).toHaveBeenCalledTimes(1)
    expect(scale).toHaveBeenCalledWith(over, MODEL_IMAGE_MAX_EDGE)
  })

  it('tries again for a new object after a failed scale', async () => {
    const scale = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue({ mediaType: 'image/png', data: 'S' })
    setImageDownscaler(scale)
    const send = async (): Promise<string> =>
      (await withModelImages([{ role: 'user', content: 'x', images: [{ mediaType: 'image/png', data: 'BIG' }] }]))[0]
        .images![0].data
    expect(await send()).toBe('BIG')
    expect(await send()).toBe('S')
  })

  it('falls back to the original when scaling fails', async () => {
    setImageDownscaler(async () => {
      throw new Error('decode failed')
    })
    const img = { mediaType: 'image/webp', data: 'WEIRD' }
    const out = await withModelImages([{ role: 'user', content: 'x', images: [img] }])
    expect(out[0].images![0]).toBe(img)
  })
})
