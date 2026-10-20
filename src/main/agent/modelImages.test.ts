import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/agent'
import { MODEL_IMAGE_MAX_EDGE, setImageDownscaler, withModelImages } from './modelImages'

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

  it('falls back to the original when scaling fails', async () => {
    setImageDownscaler(async () => {
      throw new Error('decode failed')
    })
    const img = { mediaType: 'image/webp', data: 'WEIRD' }
    const out = await withModelImages([{ role: 'user', content: 'x', images: [img] }])
    expect(out[0].images![0]).toBe(img)
  })
})
