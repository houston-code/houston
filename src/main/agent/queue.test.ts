import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QueueAddRequest } from '@shared/queue'
import {
  addToQueue,
  clearQueue,
  listQueue,
  queuedSteerIds,
  removeFromQueue,
  resetQueueCache,
  settleSteers,
  takeQueue
} from './queue'
import { createConversation, forkConversation, getConversation, listConversations } from '../conversations'
import { resetUserDataDir, setUserDataDir } from '../userData'

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
  it('carries the chat\'s effort to the drained turn, newest message winning', () => {
    const cid = 'conv-effort'
    add(cid, 'one', { reasoningEffort: 'low' })
    add(cid, 'two', { reasoningEffort: 'xhigh', approvalPolicy: 'plan' })
    expect(takeQueue(cid)).toMatchObject({ reasoningEffort: 'xhigh', approvalPolicy: 'plan' })
  })

  it('validates the policy and effort at the IPC boundary', () => {
    const cid = 'conv-validate'
    // An unknown policy fails open downstream, so it becomes the most restrictive one.
    add(cid, 'x', { approvalPolicy: 'yolo' as never, reasoningEffort: 'max' as never })
    const taken = takeQueue(cid)
    expect(taken?.approvalPolicy).toBe('plan')
    expect(taken).not.toHaveProperty('reasoningEffort')
  })

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

  it('keeps a valid invokedAs and drops a malformed one at the IPC boundary', () => {
    const cid = 'conv-invoked'
    add(cid, 'Create a GitHub pull request…', { invokedAs: { kind: 'action', label: 'Create PR' } })
    add(cid, 'x', { invokedAs: { kind: 'evil', label: 'y' } as never })
    const taken = takeQueue(cid)
    expect(taken?.items[0].invokedAs).toEqual({ kind: 'action', label: 'Create PR' })
    expect(taken?.items[1]).not.toHaveProperty('invokedAs')
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

describe('steer entries', () => {
  it('flags a steer, lists its id, and settles it into a plain follow-up', () => {
    const cid = 'conv-steer-flag'
    addToQueue({ conversationId: cid, userText: 's', providerId: 'p', model: 'm', approvalPolicy: 'ask' }, { id: 'x', steer: true })
    add(cid, 'plain')
    expect(listQueue(cid).map((q) => q.steer === true)).toEqual([true, false])
    expect(queuedSteerIds(cid)).toEqual(['x'])
    expect(settleSteers(cid)?.map((q) => q.steer)).toEqual([undefined, undefined])
    expect(queuedSteerIds(cid)).toEqual([])
    expect(settleSteers(cid)).toBeNull() // nothing left to settle
    clearQueue(cid)
  })
})

// Queued input outlives the process: a quit, a crash, or a restart to install an
// update used to drop everything queued (and every steer waiting on a run).
describe('queue persistence', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'houston-queue-'))
    setUserDataDir(dir)
    resetQueueCache()
  })
  afterEach(() => {
    resetQueueCache()
    resetUserDataDir()
    rmSync(dir, { recursive: true, force: true })
  })
  const conv = (): string => createConversation({ workspace: '/ws', providerId: 'p', model: 'm' }).id

  it('survives a restart, attachments and send settings included', () => {
    const cid = conv()
    const png = { mediaType: 'image/png', data: 'aGk=' } // stored as bytes, so real base64
    add(cid, 'first', { images: [png], reasoningEffort: 'low' })
    add(cid, 'second', { approvalPolicy: 'full-auto' })
    resetQueueCache() // a fresh process
    expect(listQueue(cid)).toEqual([
      { id: expect.any(String), text: 'first', imageCount: 1 },
      { id: expect.any(String), text: 'second', imageCount: 0 }
    ])
    const taken = takeQueue(cid)
    expect(taken?.items[0].images).toEqual([png])
    expect(taken).toMatchObject({ providerId: 'anthropic', model: 'claude', approvalPolicy: 'full-auto' })
    resetQueueCache()
    expect(listQueue(cid)).toEqual([]) // taking it cleared the disk copy too
    expect(getConversation(cid)?.queuedInput).toBeUndefined()
  })

  it('reads a steer back as a plain follow-up: its run did not survive the restart', () => {
    const cid = conv()
    addToQueue({ conversationId: cid, userText: 's', providerId: 'p', model: 'm', approvalPolicy: 'ask' }, { id: 'x', steer: true })
    resetQueueCache()
    expect(listQueue(cid)).toEqual([{ id: 'x', text: 's', imageCount: 0 }])
  })

  it('writes removals and clears through to disk', () => {
    const cid = conv()
    const [a] = add(cid, 'a')
    add(cid, 'b')
    removeFromQueue(cid, a.id)
    resetQueueCache()
    expect(listQueue(cid).map((q) => q.text)).toEqual(['b'])
    clearQueue(cid)
    resetQueueCache()
    expect(listQueue(cid)).toEqual([])
  })

  it('drops a malformed stored queue rather than crashing or failing open', () => {
    const cid = conv()
    add(cid, 'ok')
    const path = join(dir, 'conversations', `${cid}.json`)
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    raw.queuedInput.approvalPolicy = 'yolo'
    raw.queuedInput.items.push({ id: 7, text: null }, 'junk')
    writeFileSync(path, JSON.stringify(raw))
    resetQueueCache()
    expect(listQueue(cid).map((q) => q.text)).toEqual(['ok'])
    expect(takeQueue(cid)?.approvalPolicy).toBe('plan')

    raw.queuedInput = { items: 'nope' }
    writeFileSync(path, JSON.stringify(raw))
    resetQueueCache()
    expect(listQueue(cid)).toEqual([])
  })

  it('stays with its own chat when the chat is forked', () => {
    const cid = conv()
    add(cid, 'unsent')
    const fork = forkConversation(cid)!
    resetQueueCache()
    expect(listQueue(fork.id)).toEqual([])
    expect(listQueue(cid).map((q) => q.text)).toEqual(['unsent'])
  })

  it('stays out of the sidebar list payload', () => {
    const cid = conv()
    add(cid, 'private draft')
    const meta = listConversations().find((c) => c.id === cid)
    expect(meta).toBeDefined()
    expect(meta).not.toHaveProperty('queuedInput')
  })

  it("doesn't touch the chat's place in the sidebar", () => {
    const cid = conv()
    const before = getConversation(cid)!.updatedAt
    add(cid, 'later')
    expect(getConversation(cid)!.updatedAt).toBe(before)
  })
})
