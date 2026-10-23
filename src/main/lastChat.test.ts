import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('./logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

const { LastChatStore, LAST_CHAT_SCHEMA_VERSION, launchChat, isDirectory } = await import('./lastChat')

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hx-lastchat-'))
  file = join(dir, 'last-chat.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('LastChatStore', () => {
  it('remembers nothing on a fresh install', () => {
    expect(new LastChatStore(file).get()).toBeNull()
  })

  it('persists the open chat across instances, owner-only', () => {
    new LastChatStore(file).set('c1')
    expect(new LastChatStore(file).get()).toBe('c1')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8')).schemaVersion).toBe(LAST_CHAT_SCHEMA_VERSION)
  })

  it('forgets the chat when the window moves to a new chat', () => {
    const s = new LastChatStore(file)
    s.set('c1')
    s.set(null)
    expect(new LastChatStore(file).get()).toBeNull()
  })

  it('writes only when the chat changes', () => {
    const s = new LastChatStore(file)
    s.set('c1')
    writeFileSync(file, 'sentinel')
    s.set('c1')
    expect(readFileSync(file, 'utf8')).toBe('sentinel')
  })

  it('starts on a new chat from a corrupt, newer or malformed file', () => {
    writeFileSync(file, '{not json')
    expect(new LastChatStore(file).get()).toBeNull()
    writeFileSync(file, JSON.stringify({ schemaVersion: LAST_CHAT_SCHEMA_VERSION + 1, conversationId: 'c1' }))
    expect(new LastChatStore(file).get()).toBeNull()
    writeFileSync(file, JSON.stringify({ conversationId: 'c1' }))
    expect(new LastChatStore(file).get()).toBeNull()
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, conversationId: 42 }))
    expect(new LastChatStore(file).get()).toBeNull()
  })
})

describe('launchChat', () => {
  const folders = new Set(['/repo', '/repo/.worktrees/feature'])
  const chats: Record<string, string> = {
    plain: '/repo',
    worktree: '/repo/.worktrees/feature',
    gone: '/deleted-folder',
    removedWorktree: '/repo/.worktrees/removed'
  }
  const pick = (id: string | null): string | null =>
    launchChat(id, (c) => chats[c] ?? null, (p) => folders.has(p))

  it('opens nothing when no chat was open', () => {
    expect(pick(null)).toBeNull()
  })

  it('reopens a chat whose folder is still there, worktrees included', () => {
    expect(pick('plain')).toBe('plain')
    expect(pick('worktree')).toBe('worktree')
  })

  it('falls back to a new chat when the chat was deleted', () => {
    expect(pick('deleted')).toBeNull()
  })

  it('falls back when the folder or worktree is gone', () => {
    expect(pick('gone')).toBeNull()
    expect(pick('removedWorktree')).toBeNull()
  })

  it('falls back when the chat has no folder on record', () => {
    expect(launchChat('c', () => '', () => true)).toBeNull()
  })
})

describe('isDirectory', () => {
  it('is true for a folder, false for a file or a missing path', () => {
    const sub = join(dir, 'sub')
    mkdirSync(sub)
    writeFileSync(join(dir, 'f.txt'), 'x')
    expect(isDirectory(sub)).toBe(true)
    expect(isDirectory(join(dir, 'f.txt'))).toBe(false)
    expect(isDirectory(join(dir, 'missing'))).toBe(false)
  })
})
