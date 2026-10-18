import { describe, expect, it } from 'vitest'
import type { ImageAttachment } from './images'
import { combineQueued, toQueuedMeta, type QueuedInput } from './queue'

function img(data: string): ImageAttachment {
  return { mediaType: 'image/png', data }
}

describe('combineQueued', () => {
  it('joins trimmed text blocks with a blank line and drops empty ones', () => {
    const inputs: QueuedInput[] = [
      { id: '1', text: '  first  ' },
      { id: '2', text: '   ' },
      { id: '3', text: 'second' }
    ]
    expect(combineQueued(inputs)).toEqual({ text: 'first\n\nsecond', images: undefined })
  })

  it('concatenates images across messages and caps them at the attachment limit', () => {
    const inputs: QueuedInput[] = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      text: '',
      images: [img(`d${i}`)]
    }))
    const { text, images } = combineQueued(inputs)
    expect(text).toBe('')
    expect(images).toHaveLength(8) // MAX_ATTACHMENTS
  })

  it('returns undefined images when there are none', () => {
    expect(combineQueued([{ id: '1', text: 'hi' }]).images).toBeUndefined()
  })
})

describe('toQueuedMeta', () => {
  it('strips image payloads down to a count and keeps text + id', () => {
    expect(
      toQueuedMeta([
        { id: 'a', text: 'one', images: [img('x'), img('y')] },
        { id: 'b', text: 'two' }
      ])
    ).toEqual([
      { id: 'a', text: 'one', imageCount: 2 },
      { id: 'b', text: 'two', imageCount: 0 }
    ])
  })
})

describe('queued first-party prompts', () => {
  const ship = { kind: 'action', label: 'Create PR', detail: 'Hands off to the agent.' } as const
  const pr: QueuedInput = { id: 'p', text: 'Create a GitHub pull request…', invokedAs: ship }

  it('keeps a lone queued prompt tagged', () => {
    expect(combineQueued([pr])).toEqual({ text: pr.text, invokedAs: ship })
  })

  it('drops the tag once merged with other text, which is no longer just that action', () => {
    expect(combineQueued([pr, { id: 'q', text: 'and add a changelog entry' }]).invokedAs).toBeUndefined()
  })

  it('lists a queued prompt by what the user did, not its text', () => {
    expect(toQueuedMeta([pr])).toEqual([{ id: 'p', text: 'Create PR', imageCount: 0 }])
  })
})
