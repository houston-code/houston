import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('./logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

const { ReadStateStore, READ_STATE_SCHEMA_VERSION, MAX_NOTE_LENGTH, clampNote } = await import('./readState')

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hx-readstate-'))
  file = join(dir, 'read-state.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('ReadStateStore', () => {
  it('starts with everything read when there is no file', () => {
    expect(new ReadStateStore(file).snapshot()).toEqual({})
  })

  it('persists unread marks across instances, owner-only', () => {
    const a = new ReadStateStore(file)
    a.markUnread('c1', { since: 5, outcome: 'done', note: 'Opened PR #4', anchor: 3 })
    const b = new ReadStateStore(file)
    expect(b.get('c1')).toEqual({ since: 5, outcome: 'done', note: 'Opened PR #4', anchor: 3 })
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8')).schemaVersion).toBe(READ_STATE_SCHEMA_VERSION)
  })

  it('marks read, all read, and reports whether anything changed', () => {
    const s = new ReadStateStore(file)
    s.markUnread('a', { since: 1, outcome: 'done' })
    s.markUnread('b', { since: 1, outcome: 'error' })
    expect(s.markRead('a')).toBe(true)
    expect(s.markRead('a')).toBe(false)
    expect(s.markAllRead()).toEqual(['b'])
    expect(s.markAllRead()).toEqual([])
    expect(new ReadStateStore(file).snapshot()).toEqual({})
  })

  it('replaces an older mark with the newest outcome', () => {
    const s = new ReadStateStore(file)
    s.markUnread('a', { since: 1, outcome: 'error', note: 'boom' })
    s.markUnread('a', { since: 2, outcome: 'done' })
    expect(s.get('a')).toEqual({ since: 2, outcome: 'done' })
  })

  it('treats a corrupt file as everything read, and repairs it on the next change', () => {
    writeFileSync(file, '{not json')
    const s = new ReadStateStore(file)
    expect(s.snapshot()).toEqual({})
    s.markUnread('a', { since: 1, outcome: 'manual' })
    expect(new ReadStateStore(file).get('a')?.outcome).toBe('manual')
  })

  it('ignores a file from a newer schema rather than misreading it', () => {
    writeFileSync(
      file,
      JSON.stringify({ schemaVersion: READ_STATE_SCHEMA_VERSION + 1, unread: { a: { since: 1, outcome: 'done' } } })
    )
    expect(new ReadStateStore(file).snapshot()).toEqual({})
  })

  it('drops malformed entries and keeps the good ones', () => {
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        unread: {
          good: { since: 1, outcome: 'limit', anchor: 2 },
          badOutcome: { since: 1, outcome: 'exploded' },
          badSince: { since: 'yesterday', outcome: 'done' },
          badAnchor: { since: 1, outcome: 'done', anchor: -4 },
          notObject: 7
        }
      })
    )
    expect(new ReadStateStore(file).snapshot()).toEqual({
      good: { since: 1, outcome: 'limit', anchor: 2 },
      badAnchor: { since: 1, outcome: 'done' }
    })
  })

  it('prunes entries for chats that no longer exist', () => {
    const s = new ReadStateStore(file)
    s.markUnread('keep', { since: 1, outcome: 'done' })
    s.markUnread('gone', { since: 1, outcome: 'done' })
    expect(s.prune((id) => id === 'keep')).toBe(true)
    expect(s.prune((id) => id === 'keep')).toBe(false)
    expect(Object.keys(new ReadStateStore(file).snapshot())).toEqual(['keep'])
  })

  it('clamps notes to one short line', () => {
    expect(clampNote('  line one\n line two ')).toBe('line one line two')
    const long = clampNote('x'.repeat(500))
    expect(long).toHaveLength(MAX_NOTE_LENGTH)
    expect(long.endsWith('…')).toBe(true)
  })
})
