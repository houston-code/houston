import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Conversation } from '@shared/agent'

/**
 * Storage-layer behaviour for the conversation *list* projection: it strips the
 * heavy message log and the verbose `lastError`, surfacing only a lightweight
 * `errored` boolean the background-tasks indicator reads. The userData seam points
 * at a temp dir so the on-disk read path runs for real.
 */

const state = vi.hoisted(() => ({ userData: '' }))

vi.mock('./userData', () => ({
  getUserDataDir: () => state.userData
}))

// Store-issued ids are randomUUID()s; fixtures use fixed UUIDs so they pass the id guard.
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function writeConv(over: Partial<Conversation>): Conversation {
  const conv: Conversation = {
    id: ID_A,
    title: 'A chat',
    workspace: '/ws',
    providerId: 'p',
    model: 'm',
    createdAt: 0,
    updatedAt: 0,
    messages: [{ role: 'user', content: 'hello world' }],
    ...over
  }
  writeFileSync(join(state.userData, 'conversations', `${conv.id}.json`), JSON.stringify(conv), 'utf8')
  return conv
}

beforeEach(() => {
  state.userData = mkdtempSync(join(tmpdir(), 'houston-conv-'))
  mkdirSync(join(state.userData, 'conversations'), { recursive: true })
})

afterEach(() => {
  rmSync(state.userData, { recursive: true, force: true })
  vi.resetModules()
})

describe('listConversations meta projection', () => {
  it('sets errored=true and drops the lastError payload + messages', async () => {
    writeConv({ id: ID_A, lastError: { message: 'boom' } })
    const { listConversations } = await import('./conversations')
    const meta = listConversations().find((c) => c.id === ID_A)!
    expect(meta.errored).toBe(true)
    expect('lastError' in meta).toBe(false)
    expect('messages' in meta).toBe(false)
  })

  it('sets errored=false when the conversation has no stored error', async () => {
    writeConv({ id: ID_B })
    const { listConversations } = await import('./conversations')
    expect(listConversations().find((c) => c.id === ID_B)!.errored).toBe(false)
  })

  it('carries the same projection through search results', async () => {
    writeConv({ id: ID_C, lastError: { message: 'kaboom' }, messages: [{ role: 'user', content: 'parse yaml' }] })
    const { searchConversations } = await import('./conversations')
    const hit = searchConversations('yaml').find((c) => c.id === ID_C)!
    expect(hit.errored).toBe(true)
    expect('lastError' in hit).toBe(false)
  })
})
