import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@shared/agent'
import type { ChatStatusMap } from '@shared/chatStatus'

vi.mock('./logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

const { ReadStateStore } = await import('./readState')
const { createChatAttention } = await import('./chatAttention')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hx-attn-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function setup() {
  const store = new ReadStateStore(join(dir, 'rs.json'))
  let live: ChatStatusMap = {}
  const active = new Map<string, string>()
  const counts = new Map<string, number>([['c', 4]])
  // The saved log of 'c' holds two replies, at indexes 1 and 3.
  const replies = new Map<string, number[]>([['c', [1, 3]]])
  const sent: ChatStatusMap[] = []
  const attn = createChatAttention({
    store,
    liveStatus: () => live,
    activeRun: (id) => active.get(id) ?? null,
    messageCount: (id) => counts.get(id),
    replyIndexes: (id) => replies.get(id) ?? [],
    exists: (id) => id === 'c' || id === 'd',
    broadcast: (s) => sent.push(s),
    now: () => 1000
  })
  return {
    attn,
    store,
    sent,
    /** Start a run on `id` as the loop would: live status + active run. */
    start(id: string, runId = 'r1') {
      live = { ...live, [id]: { running: true, pending: [] } }
      active.set(id, runId)
      attn.onLiveChanged(live)
    },
    /** End the run (after its final event was emitted). */
    end(id: string) {
      const { [id]: _gone, ...rest } = live
      live = rest
      active.delete(id)
      attn.onLiveChanged(live)
    }
  }
}

const done = (stopReason: 'end_turn' | 'aborted' | 'error' = 'end_turn', runId = 'r1'): AgentEvent => ({
  runId,
  type: 'done',
  stopReason
})

describe('chat attention', () => {
  it('marks a chat unread when its run finishes out of view, anchored where the run began', () => {
    const t = setup()
    t.start('c')
    t.attn.noteEvent('c', done())
    t.end('c')
    expect(t.store.get('c')).toEqual({ since: 1000, outcome: 'done', anchor: 4 })
    expect(t.sent.at(-1)?.c).toEqual({
      running: false,
      pending: [],
      unread: { since: 1000, outcome: 'done', anchor: 4 }
    })
  })

  it('leaves a chat read when a focused window was showing it', () => {
    const t = setup()
    t.attn.setViewing(1, 'c', true)
    t.start('c')
    t.attn.noteEvent('c', done())
    expect(t.store.get('c')).toBeUndefined()
  })

  it('counts an unfocused window as not looking, and clears the mark once it is focused again', () => {
    const t = setup()
    t.attn.setViewing(1, 'c', false)
    t.start('c')
    t.attn.noteEvent('c', done())
    expect(t.store.get('c')?.outcome).toBe('done')
    t.attn.setViewing(1, 'c', true)
    expect(t.store.get('c')).toBeUndefined()
    expect(t.sent.at(-1)?.c?.unread).toBeUndefined()
  })

  it('any focused window viewing the chat counts, across several windows', () => {
    const t = setup()
    t.attn.setViewing(1, 'd', true)
    t.attn.setViewing(2, 'c', true)
    t.start('c')
    t.attn.noteEvent('c', done())
    expect(t.store.get('c')).toBeUndefined()
    // That window closes: the next finish is unseen.
    t.attn.dropViewer(2)
    t.start('c', 'r2')
    t.attn.noteEvent('c', done('end_turn', 'r2'))
    expect(t.store.get('c')?.outcome).toBe('done')
  })

  it('marks nothing when the user stopped the run', () => {
    const t = setup()
    t.start('c')
    t.attn.noteEvent('c', done('aborted'))
    expect(t.store.get('c')).toBeUndefined()
  })

  it('records a failure with its message', () => {
    const t = setup()
    t.start('c')
    t.attn.noteEvent('c', { runId: 'r1', type: 'error', message: 'rate limited (429)' })
    expect(t.store.get('c')).toMatchObject({ outcome: 'error', note: 'rate limited (429)' })
  })

  it('records a step-limit stop and an opened PR', () => {
    const t = setup()
    t.start('c')
    t.attn.noteEvent('c', {
      runId: 'r1',
      type: 'tool_result',
      callId: 'x',
      name: 'gh_pr_create',
      ok: true,
      output: 'https://github.com/o/r/pull/412'
    })
    t.attn.noteEvent('c', done())
    expect(t.store.get('c')).toMatchObject({ outcome: 'done', note: 'Opened PR #412' })
    t.attn.setViewing(1, 'c', true)
    t.attn.setViewing(1, null, true)
    t.start('c', 'r2')
    t.attn.noteEvent('c', { runId: 'r2', type: 'limit', reason: 'max-steps' })
    t.attn.noteEvent('c', done('end_turn', 'r2'))
    expect(t.store.get('c')).toMatchObject({ outcome: 'limit', note: 'Stopped at step limit' })
  })

  it('keeps the first unseen anchor when more turns finish before the user looks', () => {
    const t = setup()
    t.start('c')
    t.attn.noteEvent('c', done())
    // A queued follow-up runs straight after: its start is never seen on its own.
    t.attn.noteEvent('c', done('end_turn', 'r1'))
    expect(t.store.get('c')?.anchor).toBe(4)
  })

  it('names which limit a run stopped at', () => {
    const t = setup()
    t.start('c')
    t.attn.noteEvent('c', { runId: 'r1', type: 'limit', reason: 'max-output' })
    t.attn.noteEvent('c', done())
    expect(t.store.get('c')).toMatchObject({ outcome: 'limit', note: 'Stopped: reply hit the output limit' })
  })

  it("doesn't caption a failure with a PR the run opened", () => {
    const t = setup()
    t.start('c')
    t.attn.noteEvent('c', {
      runId: 'r1',
      type: 'tool_result',
      callId: 'x',
      name: 'gh_pr_create',
      ok: true,
      output: 'https://github.com/o/r/pull/9'
    })
    t.attn.noteEvent('c', done('error'))
    expect(t.store.get('c')).toEqual({ since: 1000, outcome: 'error', anchor: 4 })
  })

  it("ignores events from a run that isn't the chat's live one", () => {
    const t = setup()
    t.start('c', 'live')
    // A refused second start reports an error under its own runId.
    t.attn.noteEvent('c', { runId: 'refused', type: 'error', message: 'A run is already in progress' })
    expect(t.store.get('c')).toBeUndefined()
  })

  it('marks unread and read by hand, with an optional anchor, only for real chats', () => {
    const t = setup()
    t.attn.setUnread('c', true, 7)
    expect(t.store.get('c')).toEqual({ since: 1000, outcome: 'manual', anchor: 7 })
    t.attn.setUnread('nope', true)
    expect(t.store.get('nope')).toBeUndefined()
    t.attn.setUnread('c', false)
    expect(t.store.get('c')).toBeUndefined()
  })

  it('marks unread from a saved reply at that reply', () => {
    const t = setup()
    t.attn.setUnreadFromReply('c', 1)
    expect(t.store.get('c')).toEqual({ since: 1000, outcome: 'manual', anchor: 3 })
  })

  it('marks unread from a reply of the running turn at where that run began', () => {
    const t = setup()
    t.start('c') // the run starts with the log at 4 messages
    // Reply 2 is the running turn's own: not in the saved log yet.
    t.attn.setUnreadFromReply('c', 2)
    expect(t.store.get('c')).toEqual({ since: 1000, outcome: 'manual', anchor: 4 })
    // The run's end keeps the mark's anchor (the unseen part starts there).
    t.attn.noteEvent('c', done())
    t.end('c')
    expect(t.store.get('c')?.anchor).toBe(4)
  })

  it('marks unread with no anchor for a reply it can\'t place and no run going', () => {
    const t = setup()
    t.attn.setUnreadFromReply('c', 9)
    expect(t.store.get('c')).toEqual({ since: 1000, outcome: 'manual' })
  })

  it('a manual mark on the viewed chat survives until the view changes', () => {
    const t = setup()
    t.attn.setViewing(1, 'c', true)
    t.attn.setUnread('c', true)
    expect(t.store.get('c')?.outcome).toBe('manual')
    t.attn.setViewing(1, 'd', true)
    expect(t.store.get('c')?.outcome).toBe('manual')
  })

  it('marks everything read and forgets deleted chats', () => {
    const t = setup()
    t.attn.setUnread('c', true)
    t.attn.setUnread('d', true)
    t.attn.forget('d')
    expect(t.store.get('d')).toBeUndefined()
    t.attn.markAllRead()
    expect(t.attn.snapshot()).toEqual({})
  })

  it('merges live state with unread marks in the snapshot', () => {
    const t = setup()
    t.attn.setUnread('c', true)
    t.start('c')
    expect(t.attn.snapshot().c).toEqual({
      running: true,
      pending: [],
      unread: { since: 1000, outcome: 'manual' }
    })
  })
})
