import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Conversation } from '@shared/agent'
import { CONVERSATION_SCHEMA_VERSION } from '@shared/agent'

/**
 * Load path of the conversation store: schema versioning + migration of legacy
 * (unversioned) files, quarantine of unreadable ones, and the id guard in front
 * of every id-keyed filesystem primitive. A file that fails to parse or isn't
 * conversation-shaped must be moved aside as `<id>.json.corrupt` — bytes
 * preserved for recovery — never silently dropped; a non-UUID id must never
 * reach the filesystem at all. `app.getPath` points at a temp dir so the real
 * fs read/write/rename paths run.
 */

const state = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => state.userData }
}))

// Store-issued ids are randomUUID()s; fixtures use fixed UUIDs so they pass the id guard.
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

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
    writeRaw(ID_A, JSON.stringify(legacyConv(ID_A)))
    const { getConversation } = await import('./conversations')
    const conv = getConversation(ID_A)!
    expect(conv.schemaVersion).toBe(CONVERSATION_SCHEMA_VERSION)
    expect(conv.title).toBe('A chat')
    expect(conv.messages).toEqual([{ role: 'user', content: 'hello world' }])
    // Migration is not quarantine — the file stays where it was.
    expect(existsSync(convPath(ID_A))).toBe(true)
  })

  it('persists the stamped version on the first write-through', async () => {
    writeRaw(ID_A, JSON.stringify(legacyConv(ID_A)))
    const { setMessages } = await import('./conversations')
    setMessages(ID_A, [{ role: 'user', content: 'edited' }])
    const onDisk = JSON.parse(readFileSync(convPath(ID_A), 'utf8')) as Conversation
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
    writeRaw(ID_A, garbage)
    const { getConversation } = await import('./conversations')
    expect(getConversation(ID_A)).toBeNull()
    expect(existsSync(convPath(ID_A))).toBe(false)
    expect(readFileSync(`${convPath(ID_A)}.corrupt`, 'utf8')).toBe(garbage)
  })

  it('one corrupt file does not take healthy neighbours out of the list', async () => {
    writeRaw(ID_A, '{ not json')
    writeRaw(ID_B, JSON.stringify(legacyConv(ID_B)))
    const { listConversations } = await import('./conversations')
    const ids = listConversations().map((c) => c.id)
    expect(ids).toEqual([ID_B])
  })
})

describe('wrong-shape files', () => {
  it.each([
    ['messages is not an array', JSON.stringify({ ...legacyConv(ID_A), messages: 'nope' })],
    ['root is not an object', JSON.stringify([1, 2, 3])],
    ['missing core fields', JSON.stringify({ id: ID_A, messages: [] })],
    [
      'message entry without string content',
      JSON.stringify({ ...legacyConv(ID_A), messages: [{ role: 'user', content: 42 }] })
    ]
  ])('quarantines and returns null when %s', async (_name, contents) => {
    writeRaw(ID_A, contents)
    const { getConversation } = await import('./conversations')
    expect(getConversation(ID_A)).toBeNull()
    expect(existsSync(convPath(ID_A))).toBe(false)
    expect(readFileSync(`${convPath(ID_A)}.corrupt`, 'utf8')).toBe(contents)
  })
})

describe('conversation id guard — non-UUID ids never reach the filesystem', () => {
  it('a traversal id cannot read a conversation-shaped file outside the store dir', async () => {
    // Conversation-shaped bait one level up: reachable via id '../outside' without the guard.
    writeFileSync(join(state.userData, 'outside.json'), JSON.stringify(legacyConv(ID_A)), 'utf8')
    const { getConversation } = await import('./conversations')
    expect(getConversation('../outside')).toBeNull()
    expect(existsSync(join(state.userData, 'outside.json'))).toBe(true)
  })

  it('a traversal id cannot quarantine-rename a non-conversation file outside the store dir', async () => {
    // Unparseable bait: without the guard, read('../outside') would rename it to .corrupt.
    writeFileSync(join(state.userData, 'outside.json'), '{ not json', 'utf8')
    const { getConversation } = await import('./conversations')
    expect(getConversation('../outside')).toBeNull()
    expect(existsSync(join(state.userData, 'outside.json'))).toBe(true)
    expect(existsSync(join(state.userData, 'outside.json.corrupt'))).toBe(false)
  })

  it('a traversal id cannot delete a file outside the store dir', async () => {
    writeFileSync(join(state.userData, 'outside.json'), '{}', 'utf8')
    const { deleteConversation } = await import('./conversations')
    deleteConversation('../outside')
    expect(existsSync(join(state.userData, 'outside.json'))).toBe(true)
  })

  it('a non-UUID-named .json file inside the store dir is ignored, not quarantined', async () => {
    // Houston never writes such a file; leave it alone rather than parse or rename it.
    writeRaw('notes', JSON.stringify(legacyConv(ID_A)))
    const { getConversation, listConversations } = await import('./conversations')
    expect(getConversation('notes')).toBeNull()
    expect(listConversations()).toEqual([])
    expect(existsSync(convPath('notes'))).toBe(true)
    expect(existsSync(`${convPath('notes')}.corrupt`)).toBe(false)
  })

  it('uppercase UUIDs still pass the guard (case-insensitive filesystems)', async () => {
    const upper = ID_A.toUpperCase()
    writeRaw(upper, JSON.stringify(legacyConv(upper)))
    const { getConversation } = await import('./conversations')
    expect(getConversation(upper)?.id).toBe(upper)
  })
})
