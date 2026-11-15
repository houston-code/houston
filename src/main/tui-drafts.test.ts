import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  capDraft,
  createDraftSaver,
  createDraftStore,
  draftIsEmpty,
  draftKey,
  draftRestoreNote,
  draftRestoreText,
  type DraftRecord,
  type DraftStore
} from './tui-drafts'

let dir: string
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'houston-drafts-')), 'tui-drafts')
})
afterEach(() => {
  rmSync(join(dir, '..'), { recursive: true, force: true })
})

describe('createDraftStore', () => {
  it('saves and loads a chat draft, per chat', () => {
    const store = createDraftStore(dir)
    store.save('chat-a', { text: 'half a thought', queued: ['typed mid-run'] })
    store.save('chat-b', { text: 'other', queued: [] })
    expect(store.load('chat-a')).toEqual({ text: 'half a thought', queued: ['typed mid-run'] })
    expect(store.load('chat-b')).toEqual({ text: 'other', queued: [] })
    expect(store.load('chat-c')).toBeNull()
  })

  it('writes owner-only files in an owner-only folder', () => {
    if (process.platform === 'win32') return
    const store = createDraftStore(dir)
    store.save('chat-a', { text: 'secret plan', queued: [] })
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    const [file] = readdirSync(dir)
    expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600)
  })

  it('removes the file once the draft is empty', () => {
    const store = createDraftStore(dir)
    store.save('chat-a', { text: 'x', queued: [] })
    store.save('chat-a', { text: '  ', queued: [] })
    expect(readdirSync(dir)).toEqual([])
    expect(store.load('chat-a')).toBeNull()
    store.save('never-saved', null) // nothing to remove: no throw
  })

  it('keeps only the newest drafts past the cap', () => {
    const store = createDraftStore(dir, { max: 2 })
    store.save('one', { text: '1', queued: [] })
    // Make "one" clearly the oldest, whatever the filesystem's clock resolution.
    for (const f of readdirSync(dir)) utimesSync(join(dir, f), 1, 1)
    store.save('two', { text: '2', queued: [] })
    store.save('three', { text: '3', queued: [] })
    expect(readdirSync(dir)).toHaveLength(2)
    expect(store.load('one')).toBeNull()
    expect(store.load('two')).not.toBeNull()
    expect(store.load('three')).not.toBeNull()
  })

  it('reads a corrupt or foreign file as no draft', () => {
    const store = createDraftStore(dir)
    store.save('chat-a', { text: 'x', queued: [] })
    const [file] = readdirSync(dir)
    writeFileSync(join(dir, file), '{not json')
    expect(store.load('chat-a')).toBeNull()
    writeFileSync(join(dir, file), JSON.stringify({ v: 1, key: 'someone-else', text: 'x', queued: [] }))
    expect(store.load('chat-a')).toBeNull()
  })

  // Two terminals on new chats in one folder shared one file: the second opened with
  // the first one's half-typed text, and either one sending deleted the other's draft.
  it('keeps a new chat draft per terminal, and takes over only one whose terminal has gone', () => {
    const live = new Set([101, 202])
    const alive = (pid: number): boolean => live.has(pid)
    const one = createDraftStore(dir, { pid: 101, alive })
    const two = createDraftStore(dir, { pid: 202, alive })
    one.save('new:/w', { text: 'terminal one typing', queued: [] })
    // Terminal one is still running: terminal two does not get its draft.
    expect(two.load('new:/w')).toBeNull()
    two.save('new:/w', { text: 'terminal two typing', queued: [] })
    // Terminal two sends its first message: terminal one's draft is untouched.
    two.save('new:/w', null)
    expect(one.load('new:/w')).toEqual({ text: 'terminal one typing', queued: [] })
    // Terminal one quits; the next launch in the folder takes its draft over, once.
    live.delete(101)
    const three = createDraftStore(dir, { pid: 303, alive })
    expect(three.load('new:/w')).toEqual({ text: 'terminal one typing', queued: [] })
    expect(readdirSync(dir)).toHaveLength(1)
    const four = createDraftStore(dir, { pid: 404, alive: (p) => p === 303 })
    expect(four.load('new:/w')).toBeNull()
    // A draft saved before slots were per terminal (no writer recorded) is taken over too.
    rmSync(dir, { recursive: true, force: true })
    one.save('chat-x', { text: 'unused', queued: [] })
    const [file] = readdirSync(dir)
    writeFileSync(join(dir, file), JSON.stringify({ v: 1, key: 'new:/old', text: 'from before', queued: [] }))
    expect(four.load('new:/old')).toEqual({ text: 'from before', queued: [] })
  })

  it('reports a failed write instead of throwing', () => {
    const warnings: string[] = []
    writeFileSync(join(dir, '..', 'blocker'), '')
    const store = createDraftStore(join(dir, '..', 'blocker', 'sub'), { warn: (m) => warnings.push(m) })
    store.save('chat-a', { text: 'x', queued: [] })
    expect(warnings).toHaveLength(1)
  })
})

describe('draft records', () => {
  it('caps a record, keeping waiting messages first', () => {
    const r = capDraft({ text: 'abcdef', queued: ['1234', '5678'] }, 10)
    expect(r).toEqual({ text: 'ab', queued: ['1234', '5678'] })
    expect(capDraft({ text: 'abc', queued: ['123456'] }, 4)).toEqual({ text: '', queued: ['1234'] })
  })

  it('opens the composer with what was waiting, then the draft', () => {
    const r: DraftRecord = { text: 'still typing', queued: ['first', 'second'] }
    expect(draftRestoreText(r)).toBe('first\n\nsecond\n\nstill typing')
    expect(draftRestoreNote(r)).toContain('2 messages')
    expect(draftRestoreNote({ text: 'x', queued: [] })).toBe('· restored the draft you had not sent')
  })

  it('treats blank records as empty, and keys new chats by folder', () => {
    expect(draftIsEmpty({ text: ' ', queued: [''] })).toBe(true)
    expect(draftIsEmpty(null)).toBe(true)
    expect(draftKey('abc', '/w')).toBe('abc')
    expect(draftKey(null, '/w')).toBe('new:/w')
  })
})

describe('createDraftSaver', () => {
  function fakeStore() {
    const saves: Array<[string, DraftRecord | null]> = []
    const store: DraftStore = { load: () => null, save: (k, r) => void saves.push([k, r]) }
    let fire: (() => void) | null = null
    const timeout = (fn: () => void): (() => void) => {
      fire = fn
      return () => {
        if (fire === fn) fire = null
      }
    }
    return { store, saves, timeout, fire: () => fire?.() }
  }

  it('writes a typed draft after the pause, once', () => {
    const f = fakeStore()
    const saver = createDraftSaver(f.store, f.timeout)
    saver.update('a', { text: 'h', queued: [] })
    saver.update('a', { text: 'hi', queued: [] })
    expect(f.saves).toEqual([])
    f.fire()
    expect(f.saves).toEqual([['a', { text: 'hi', queued: [] }]])
  })

  it('writes an acknowledged message at once', () => {
    const f = fakeStore()
    const saver = createDraftSaver(f.store, f.timeout)
    saver.update('a', { text: '', queued: ['queued'] }, true)
    expect(f.saves).toEqual([['a', { text: '', queued: ['queued'] }]])
  })

  it('writes the pending draft of one chat before taking another', () => {
    const f = fakeStore()
    const saver = createDraftSaver(f.store, f.timeout)
    saver.update('a', { text: 'for a', queued: [] })
    saver.update('b', { text: 'for b', queued: [] })
    expect(f.saves).toEqual([['a', { text: 'for a', queued: [] }]])
    saver.flush()
    expect(f.saves.at(-1)).toEqual(['b', { text: 'for b', queued: [] }])
    saver.flush() // nothing pending: no write
    expect(f.saves).toHaveLength(2)
  })
})
