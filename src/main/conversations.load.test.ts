import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Conversation } from '@shared/agent'
import { CONVERSATION_SCHEMA_VERSION } from '@shared/agent'

/**
 * Load path of the conversation store: schema versioning + migration of legacy
 * (unversioned) files, and quarantine of unreadable ones. A file that fails to
 * parse or isn't conversation-shaped must be moved aside as `<id>.json.corrupt`
 * — bytes preserved for recovery — never silently dropped. `app.getPath` points
 * at a temp dir so the real fs read/write/rename paths run.
 */

const state = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => state.userData }
}))

function convPath(id: string): string {
  return join(state.userData, 'conversations', `${id}.json`)
}

function writeRaw(id: string, contents: string): void {
  writeFileSync(convPath(id), contents, 'utf8')
}

/** A fully valid conversation as written by builds BEFORE versioning (no schemaVersion). */
function legacyConv(id: string): Conversation {
  return {
    id,
    title: 'A chat',
    workspace: '/ws',
    providerId: 'p',
    model: 'm',
    createdAt: 1,
    updatedAt: 2,
    messages: [{ role: 'user', content: 'hello world' }]
  }
}

beforeEach(() => {
  state.userData = mkdtempSync(join(tmpdir(), 'houston-conv-load-'))
  mkdirSync(join(state.userData, 'conversations'), { recursive: true })
})

afterEach(() => {
  rmSync(state.userData, { recursive: true, force: true })
  vi.resetModules()
})

describe('legacy files without schemaVersion', () => {
  it('loads and stamps the current version in memory', async () => {
    writeRaw('legacy', JSON.stringify(legacyConv('legacy')))
    const { getConversation } = await import('./conversations')
    const conv = getConversation('legacy')!
    expect(conv.schemaVersion).toBe(CONVERSATION_SCHEMA_VERSION)
    expect(conv.title).toBe('A chat')
    expect(conv.messages).toEqual([{ role: 'user', content: 'hello world' }])
    // Migration is not quarantine — the file stays where it was.
    expect(existsSync(convPath('legacy'))).toBe(true)
  })

  it('persists the stamped version on the first write-through', async () => {
    writeRaw('legacy', JSON.stringify(legacyConv('legacy')))
    const { setMessages } = await import('./conversations')
    setMessages('legacy', [{ role: 'user', content: 'edited' }])
    const onDisk = JSON.parse(readFileSync(convPath('legacy'), 'utf8')) as Conversation
    expect(onDisk.schemaVersion).toBe(CONVERSATION_SCHEMA_VERSION)
  })
})

describe('current-version round-trip', () => {
  it('createConversation stamps the version on disk and reads back identically', async () => {
    const { createConversation, getConversation } = await import('./conversations')
    const created = createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
    expect(created.schemaVersion).toBe(CONVERSATION_SCHEMA_VERSION)
    const onDisk = JSON.parse(readFileSync(convPath(created.id), 'utf8')) as Conversation
    expect(onDisk.schemaVersion).toBe(CONVERSATION_SCHEMA_VERSION)
    expect(getConversation(created.id)).toEqual(created)
  })

  it('keeps schemaVersion out of the list projection', async () => {
    const { createConversation, listConversations } = await import('./conversations')
    const created = createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
    const meta = listConversations().find((c) => c.id === created.id)!
    expect('schemaVersion' in meta).toBe(false)
  })
})

describe('corrupt JSON', () => {
  it('quarantines the file as .corrupt with its bytes intact and returns null', async () => {
    const garbage = '{ not json'
    writeRaw('bad', garbage)
    const { getConversation } = await import('./conversations')
    expect(getConversation('bad')).toBeNull()
    expect(existsSync(convPath('bad'))).toBe(false)
    expect(readFileSync(`${convPath('bad')}.corrupt`, 'utf8')).toBe(garbage)
  })

  it('one corrupt file does not take healthy neighbours out of the list', async () => {
    writeRaw('bad', '{ not json')
    writeRaw('good', JSON.stringify(legacyConv('good')))
    const { listConversations } = await import('./conversations')
    const ids = listConversations().map((c) => c.id)
    expect(ids).toEqual(['good'])
  })
})

describe('wrong-shape files', () => {
  it.each([
    ['messages is not an array', JSON.stringify({ ...legacyConv('x'), messages: 'nope' })],
    ['root is not an object', JSON.stringify([1, 2, 3])],
    ['missing core fields', JSON.stringify({ id: 'x', messages: [] })],
    [
      'message entry without string content',
      JSON.stringify({ ...legacyConv('x'), messages: [{ role: 'user', content: 42 }] })
    ]
  ])('quarantines and returns null when %s', async (_name, contents) => {
    writeRaw('shape', contents)
    const { getConversation } = await import('./conversations')
    expect(getConversation('shape')).toBeNull()
    expect(existsSync(convPath('shape'))).toBe(false)
    expect(readFileSync(`${convPath('shape')}.corrupt`, 'utf8')).toBe(contents)
  })
})
