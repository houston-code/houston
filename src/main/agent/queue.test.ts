import { describe, expect, it } from 'vitest'
import type { QueueAddRequest } from '@shared/queue'
import { addToQueue, clearQueue, listQueue, removeFromQueue, takeQueue } from './queue'

function add(conversationId: string, userText: string, over: Partial<QueueAddRequest> = {}) {
  return addToQueue({
    conversationId,
    userText,
    providerId: 'anthropic',
    model: 'claude',
    approvalPolicy: 'ask',
    ...over
  })
}

const IMG = { mediaType: 'image/png', data: 'abc' }

describe('main queue manager', () => {
  it('appends messages and returns the display list', () => {
    const cid = 'conv-append'
    expect(add(cid, 'first')).toEqual([{ id: expect.any(String), text: 'first', imageCount: 0 }])
    const list = add(cid, 'second', { images: [IMG] })
    expect(list.map((q) => q.text)).toEqual(['first', 'second'])
    expect(list[1].imageCount).toBe(1)
    clearQueue(cid)
  })

  it('sanitizes attachments into the stored count', () => {
    const cid = 'conv-sanitize'
    const list = add(cid, 'pic', { images: [IMG, { mediaType: 'text/plain', data: 'x' } as never] })
    expect(list[0].imageCount).toBe(1) // the unsupported attachment is dropped
    clearQueue(cid)
  })

  it('removes a single message by id', () => {
    const cid = 'conv-remove'
    add(cid, 'a')
    const two = add(cid, 'b')
    const firstId = two[0].id
    expect(removeFromQueue(cid, firstId).map((q) => q.text)).toEqual(['b'])
    clearQueue(cid)
  })

  it('clear empties the queue', () => {
    const cid = 'conv-clear'
    add(cid, 'a')
    expect(clearQueue(cid)).toEqual([])
    expect(listQueue(cid)).toEqual([])
  })

  it('takeQueue removes and returns everything with the latest send settings', () => {
    const cid = 'conv-take'
    add(cid, 'a', { model: 'old' })
    add(cid, 'b', { model: 'new', approvalPolicy: 'full-auto' })
    const taken = takeQueue(cid)
    expect(taken?.items.map((q) => q.text)).toEqual(['a', 'b'])
    // Newest message's settings win for the combined turn.
    expect(taken?.model).toBe('new')
    expect(taken?.approvalPolicy).toBe('full-auto')
    // The queue is now drained.
    expect(listQueue(cid)).toEqual([])
    expect(takeQueue(cid)).toBeNull()
  })

  it('isolates queues per conversation', () => {
    add('conv-x', 'x-msg')
    add('conv-y', 'y-msg')
    expect(listQueue('conv-x').map((q) => q.text)).toEqual(['x-msg'])
    expect(listQueue('conv-y').map((q) => q.text)).toEqual(['y-msg'])
    clearQueue('conv-x')
    clearQueue('conv-y')
  })
})
