import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Conversation } from '@shared/agent'

/**
 * Storage-layer behaviour for the conversation *list* projection: it strips the
 * heavy message log and the verbose `lastError`, surfacing only a lightweight
 * `errored` boolean the background-tasks indicator reads. `app.getPath` points at
 * a temp dir so the on-disk read path runs for real.
 */

const state = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => state.userData }
}))

function writeConv(over: Partial<Conversation>): Conversation {
  const conv: Conversation = {
    id: 'x',
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
    writeConv({ id: 'a', lastError: { message: 'boom' } })
    const { listConversations } = await import('./conversations')
    const meta = listConversations().find((c) => c.id === 'a')!
    expect(meta.errored).toBe(true)
    expect('lastError' in meta).toBe(false)
    expect('messages' in meta).toBe(false)
  })

  it('sets errored=false when the conversation has no stored error', async () => {
    writeConv({ id: 'b' })
    const { listConversations } = await import('./conversations')
    expect(listConversations().find((c) => c.id === 'b')!.errored).toBe(false)
  })

  it('carries the same projection through search results', async () => {
    writeConv({ id: 'c', lastError: { message: 'kaboom' }, messages: [{ role: 'user', content: 'parse yaml' }] })
    const { searchConversations } = await import('./conversations')
    const hit = searchConversations('yaml').find((c) => c.id === 'c')!
    expect(hit.errored).toBe(true)
    expect('lastError' in hit).toBe(false)
  })
})
