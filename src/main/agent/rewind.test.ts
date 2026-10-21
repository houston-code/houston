import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ChatMessage } from '@shared/agent'
import { setUserDataDir, resetUserDataDir } from '../userData'
import {
  createConversation,
  getConversation,
  peekConversation,
  setCompaction,
  setConversationError,
  setMessages
} from '../conversations'
import {
  clearCheckpoints,
  conversationChain,
  flushCheckpoints,
  getConversationCheckpoint,
  noteConversationRun,
  recordOriginal,
  recordResult,
  restoreCheckpoint,
  setRunTurn,
  turnFingerprint
} from './checkpoints'

const active = vi.hoisted(() => ({ runId: null as string | null }))
vi.mock('./loop', () => ({ activeRunForConversation: () => active.runId }))
// Lets a test make the conversation store's rewind write fail (a full disk).
const store = vi.hoisted(() => ({ failWrite: false }))
vi.mock('../conversations', async (importOriginal) => {
  const real = await importOriginal<typeof import('../conversations')>()
  return {
    ...real,
    writeRewind: (...args: Parameters<typeof real.writeRewind>) => {
      if (store.failWrite) throw new Error('disk full')
      return real.writeRewind(...args)
    }
  }
})

import { canUndoRewind, previewRewind, rewindConversation, undoRewind } from './rewind'
import { rewindInProgress } from './rewindLock'

let ws: string
let dataDir: string
let convId: string

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'houston-rw-ws-'))
  dataDir = mkdtempSync(join(tmpdir(), 'houston-rw-data-'))
  setUserDataDir(dataDir)
  active.runId = null
  store.failWrite = false
  convId = createConversation({ workspace: ws, providerId: 'p', model: 'm' }).id
})

afterEach(async () => {
  await flushCheckpoints()
  clearCheckpoints()
  resetUserDataDir()
  rmSync(ws, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

const file = (rel: string): string => join(ws, rel)
const read = (rel: string): string | null => (existsSync(file(rel)) ? readFileSync(file(rel), 'utf8') : null)

/**
 * One agent turn as the loop records it: the user's message starts a run chained to
 * it, each edit is snapshotted before and after, and the reply is persisted.
 * `null` deletes the file.
 */
async function agentTurn(text: string, edits: Record<string, string | null> = {}, runId = `run-${text}`): Promise<string> {
  const conv = peekConversation(convId)!
  const user: ChatMessage = { role: 'user', content: text }
  const msgs = [...conv.messages, user]
  setMessages(convId, msgs)
  noteConversationRun(convId, runId, { index: msgs.length - 1, fp: turnFingerprint(user) })
  for (const [rel, content] of Object.entries(edits)) {
    await recordOriginal(runId, [ws], rel)
    if (content === null) rmSync(file(rel), { force: true })
    else {
      mkdirSync(dirname(file(rel)), { recursive: true })
      writeFileSync(file(rel), content)
    }
    await recordResult(runId, [ws], rel, { expectAbsent: content === null })
  }
  setMessages(convId, [...msgs, { role: 'assistant', content: `done: ${text}` }])
  return runId
}

const messages = (): ChatMessage[] => peekConversation(convId)!.messages

/** Three turns: create a.txt, edit it and create b.txt, edit both. */
async function threeTurns(): Promise<void> {
  writeFileSync(file('a.txt'), 'a0')
  await agentTurn('one', { 'a.txt': 'a1' })
  await agentTurn('two', { 'a.txt': 'a2', 'b.txt': 'b2' })
  await agentTurn('three', { 'a.txt': 'a3', 'b.txt': 'b3' })
}

describe('checkpoint chain', () => {
  it('records each run against the user message that started it, in order', async () => {
    await threeTurns()
    const chain = conversationChain(convId)
    expect(chain.map((e) => [e.runId, e.turn, e.files])).toEqual([
      ['run-one', 0, true],
      ['run-two', 2, true],
      ['run-three', 4, true]
    ])
  })

  it('setRunTurn re-points an entry when the log moved the message', async () => {
    noteConversationRun(convId, 'run-x', { index: 0, fp: 'aaaa' })
    setRunTurn(convId, 'run-x', 1, 'bbbb')
    expect(conversationChain(convId)[0]).toMatchObject({ runId: 'run-x', turn: 1, fp: 'bbbb' })
  })

  it('survives a restart through index.json', async () => {
    await threeTurns()
    await flushCheckpoints()
    clearCheckpoints()
    expect(conversationChain(convId).map((e) => e.runId)).toEqual(['run-one', 'run-two', 'run-three'])
    const index = JSON.parse(readFileSync(join(dataDir, 'checkpoints', 'index.json'), 'utf8'))
    // Older builds read only `conversations`: it still names the latest run.
    expect(index.conversations[convId]).toBe('run-three')
    expect(index.version).toBe(3)
  })

  it('migrates a latest-run-only index.json: the old run maps to the last message', async () => {
    writeFileSync(file('a.txt'), 'a0')
    await agentTurn('one', { 'a.txt': 'a1' })
    await flushCheckpoints()
    // Rewrite the index in the shape an older build wrote: no chains.
    writeFileSync(
      join(dataDir, 'checkpoints', 'index.json'),
      JSON.stringify({ version: 2, conversations: { [convId]: 'run-one' } })
    )
    clearCheckpoints()
    expect(conversationChain(convId)).toEqual([{ runId: 'run-one', at: 0 }])

    const r = await rewindConversation(convId, 0, 'code', 'one')
    expect(r).toMatchObject({ ok: true, restored: 1 })
    expect(read('a.txt')).toBe('a0')
  })

  it('a migrated run followed by new runs maps to the turn before them', async () => {
    writeFileSync(file('a.txt'), 'a0')
    await agentTurn('one', { 'a.txt': 'a1' })
    await flushCheckpoints()
    writeFileSync(
      join(dataDir, 'checkpoints', 'index.json'),
      JSON.stringify({ version: 2, conversations: { [convId]: 'run-one' } })
    )
    clearCheckpoints()
    await agentTurn('two', { 'a.txt': 'a2' })
    expect(conversationChain(convId).map((e) => e.runId)).toEqual(['run-one', 'run-two'])

    // Rewinding to turn two leaves turn one's change in place.
    await rewindConversation(convId, 1, 'code', 'two')
    expect(read('a.txt')).toBe('a1')
    await rewindConversation(convId, 0, 'code', 'one')
    expect(read('a.txt')).toBe('a0')
  })

  it('merges runs another Houston process recorded for the same chat', async () => {
    await agentTurn('one')
    await flushCheckpoints()
    // The terminal app (another process) runs a turn on this chat and records it.
    const indexPath = join(dataDir, 'checkpoints', 'index.json')
    const index = JSON.parse(readFileSync(indexPath, 'utf8'))
    index.chains[convId].push({ runId: 'run-elsewhere', turn: 2, at: index.chains[convId][0].at })
    writeFileSync(indexPath, JSON.stringify(index))
    // This process sees it, and its own next write keeps it.
    expect(conversationChain(convId).map((e) => e.runId)).toEqual(['run-one', 'run-elsewhere'])
    noteConversationRun(convId, 'run-here', { index: 4, fp: 'x' })
    await flushCheckpoints()
    const after = JSON.parse(readFileSync(indexPath, 'utf8'))
    expect(after.chains[convId].map((e: { runId: string }) => e.runId)).toEqual([
      'run-one',
      'run-elsewhere',
      'run-here'
    ])
  })

  it('bounds index.json across chats, keeping the most recently run', async () => {
    for (let c = 0; c < 12; c++) {
      const id = `00000000-0000-4000-8000-${String(c).padStart(12, '0')}`
      for (let r = 0; r < 100; r++) noteConversationRun(id, `r-${c}-${r}`)
    }
    await flushCheckpoints()
    const index = JSON.parse(readFileSync(join(dataDir, 'checkpoints', 'index.json'), 'utf8'))
    const chains = Object.values(index.chains) as unknown[][]
    expect(chains.reduce((n, c) => n + c.length, 0)).toBeLessThanOrEqual(1000)
    expect(index.chains['00000000-0000-4000-8000-000000000011']).toHaveLength(100)
  })

  it('ignores a corrupt index.json rather than failing', async () => {
    mkdirSync(join(dataDir, 'checkpoints'), { recursive: true })
    writeFileSync(join(dataDir, 'checkpoints', 'index.json'), '{not json')
    expect(conversationChain(convId)).toEqual([])
    await agentTurn('one')
    expect(conversationChain(convId)).toHaveLength(1)
  })

  it('a rewritten log (/compact) no longer places runs whose message moved', async () => {
    await threeTurns()
    // /compact replaces the head with a summary: indices shift, fingerprints don't match.
    setMessages(convId, [
      { role: 'user', content: 'Summary of the earlier conversation (older messages were compacted to save context): …' },
      { role: 'assistant', content: 'ok' },
      ...messages().slice(4)
    ])
    // Turn 0 is now "three" at index 2, which run-three was recorded at index 4 for.
    const p = await previewRewind(convId, 0, 'code', 'three')
    expect(p).toMatchObject({ ok: true, files: 0 })
  })
})

describe('rewind', () => {
  it('code only: puts files back to before the turn and keeps the chat', async () => {
    await threeTurns()
    const before = messages()
    const r = await rewindConversation(convId, 1, 'code', 'two')
    expect(r).toMatchObject({ ok: true, restored: 2, conflicts: [], text: 'two' })
    expect(read('a.txt')).toBe('a1')
    expect(read('b.txt')).toBeNull() // created in turn two: deleted
    expect(messages()).toEqual(before)
  })

  it('conversation only: cuts the chat at the message and leaves files alone', async () => {
    await threeTurns()
    const r = await rewindConversation(convId, 1, 'conversation', 'two')
    expect(r).toMatchObject({ ok: true, restored: 0, text: 'two', undoable: true })
    expect(messages().map((m) => m.content)).toEqual(['one', 'done: one'])
    expect(read('a.txt')).toBe('a3')
    expect(read('b.txt')).toBe('b3')
    // The latest run's turn is gone, so its single-turn revert is withdrawn.
    expect(await getConversationCheckpoint(convId)).toBeNull()
    expect(conversationChain(convId).map((e) => e.detached === true)).toEqual([false, true, true])
  })

  it('both: cuts the chat and puts the files back', async () => {
    await threeTurns()
    const r = await rewindConversation(convId, 0, 'both', 'one')
    expect(r).toMatchObject({ ok: true, restored: 2 })
    if (r.ok) expect(r.messages).toEqual([])
    expect(read('a.txt')).toBe('a0')
    expect(read('b.txt')).toBeNull()
  })

  it('deletes a file the rewound turns created and restores one they deleted', async () => {
    writeFileSync(file('gone.txt'), 'keep me')
    await agentTurn('one', { 'new/dir/created.txt': 'hi', 'gone.txt': null })
    expect(read('gone.txt')).toBeNull()
    await rewindConversation(convId, 0, 'code', 'one')
    expect(read('new/dir/created.txt')).toBeNull()
    expect(read('gone.txt')).toBe('keep me')
  })

  it('skips a file changed outside the agent since, and reports it', async () => {
    await threeTurns()
    writeFileSync(file('b.txt'), 'the user edited this')
    const preview = await previewRewind(convId, 1, 'both', 'two')
    expect(preview).toMatchObject({ ok: true, turns: 2, files: 1, conflicts: ['b.txt'] })
    // The preview changed nothing.
    expect(read('a.txt')).toBe('a3')

    const r = await rewindConversation(convId, 1, 'both', 'two')
    expect(r).toMatchObject({ ok: true, restored: 1, conflicts: ['b.txt'] })
    expect(read('a.txt')).toBe('a1')
    expect(read('b.txt')).toBe('the user edited this')
  })

  it('a run with a file left alone stays open, so a later rewind finishes it', async () => {
    await threeTurns()
    writeFileSync(file('b.txt'), 'the user edited this')
    const first = await rewindConversation(convId, 1, 'code', 'two')
    expect(first).toMatchObject({ ok: true, restored: 1, conflicts: ['b.txt'] })
    // The latest turn isn't claimed as reverted: one of its files is untouched.
    expect(await getConversationCheckpoint(convId)).toMatchObject({ runId: 'run-three', reverted: false })

    // The user puts b.txt back the way the agent left it and rewinds again.
    writeFileSync(file('b.txt'), 'b3')
    const second = await rewindConversation(convId, 1, 'code', 'two')
    // a.txt was already put back (not a conflict, not counted again); b.txt goes now.
    expect(second).toMatchObject({ ok: true, restored: 1, conflicts: [] })
    expect(read('a.txt')).toBe('a1')
    expect(read('b.txt')).toBeNull()
    expect(await getConversationCheckpoint(convId)).toMatchObject({ runId: 'run-three', reverted: true })
  })

  it('neither rewrites nor counts a file the user already put back', async () => {
    writeFileSync(file('a.txt'), 'a0')
    await agentTurn('one', { 'a.txt': 'a1', 'c.txt': 'c1' })
    writeFileSync(file('a.txt'), 'a0') // put back by hand
    expect(await previewRewind(convId, 0, 'code', 'one')).toMatchObject({ ok: true, files: 1, conflicts: [] })
    const r = await rewindConversation(convId, 0, 'code', 'one')
    expect(r).toMatchObject({ ok: true, restored: 1, conflicts: [] })
    // The undo re-applies only what the rewind wrote: a.txt stays as the user left it.
    await undoRewind(convId)
    expect(read('a.txt')).toBe('a0')
    expect(read('c.txt')).toBe('c1')
  })

  it('puts the files back and changes nothing else when the rewound log cannot be saved', async () => {
    await threeTurns()
    const before = messages()
    store.failWrite = true
    const r = await rewindConversation(convId, 1, 'both', 'two')
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('disk full') })
    expect(read('a.txt')).toBe('a3')
    expect(read('b.txt')).toBe('b3')
    expect(messages()).toEqual(before)
    // Nothing detached: the latest turn's revert is still offered, and unreverted.
    expect(conversationChain(convId).some((e) => e.detached)).toBe(false)
    expect(await getConversationCheckpoint(convId)).toMatchObject({ runId: 'run-three', reverted: false })
    // And a retry once the disk is fine works from the same state.
    store.failWrite = false
    expect(await rewindConversation(convId, 1, 'both', 'two')).toMatchObject({ ok: true, restored: 2 })
  })

  it('keeps the backup out of getConversation (exports, the renderer, runs)', async () => {
    await threeTurns()
    await rewindConversation(convId, 1, 'both', 'two')
    expect(peekConversation(convId)!.rewindBackup?.messages).toHaveLength(6)
    expect(getConversation(convId)).not.toHaveProperty('rewindBackup')
  })

  it('walks a file back through every turn, and stops where the user edited between turns', async () => {
    writeFileSync(file('a.txt'), 'a0')
    await agentTurn('one', { 'a.txt': 'a1' })
    writeFileSync(file('a.txt'), 'user edit between turns')
    await agentTurn('two', { 'a.txt': 'a2' })
    const r = await rewindConversation(convId, 0, 'code', 'one')
    // Turn two's change is undone (back to the user's edit), turn one's is not.
    expect(read('a.txt')).toBe('user edit between turns')
    expect(r).toMatchObject({ ok: true, conflicts: ['a.txt'] })
  })

  it('refuses while a run is active, changing nothing', async () => {
    await threeTurns()
    active.runId = 'run-live'
    const before = messages()
    expect(await rewindConversation(convId, 0, 'both', 'one')).toEqual({
      ok: false,
      error: 'Stop the running turn before rewinding.'
    })
    expect(await previewRewind(convId, 0, 'both', 'one')).toMatchObject({ ok: false })
    expect(await undoRewind(convId)).toMatchObject({ ok: false })
    expect(messages()).toEqual(before)
    expect(read('a.txt')).toBe('a3')
  })

  it('refuses a turn that is out of range or whose text no longer matches', async () => {
    await threeTurns()
    expect(await rewindConversation(convId, 7, 'both', 'one')).toMatchObject({ ok: false })
    expect(await rewindConversation(convId, 1, 'both', 'not what it says')).toMatchObject({ ok: false })
    expect(messages()).toHaveLength(6)
  })

  it('refuses an unknown conversation', async () => {
    expect(await rewindConversation('00000000-0000-4000-8000-000000000000', 0, 'both', 'x')).toMatchObject({
      ok: false
    })
  })

  it('holds the rewind lock while it works, so a run cannot start mid-rewind', async () => {
    await threeTurns()
    const pending = rewindConversation(convId, 0, 'both', 'one')
    expect(rewindInProgress(convId)).toBe(true)
    expect(await rewindConversation(convId, 0, 'both', 'one')).toMatchObject({ ok: false })
    await pending
    expect(rewindInProgress(convId)).toBe(false)
  })

  it('skips steered messages and automated notes when numbering turns', async () => {
    setMessages(convId, [
      { role: 'user', content: 'Automated note from Houston (not from the user): stuff' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'nudge', steered: true },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'second' }
    ])
    const r = await rewindConversation(convId, 1, 'conversation', 'second')
    expect(r).toMatchObject({ ok: true })
    expect(messages()).toHaveLength(5)
  })

  it('a code rewind leaves runs already reverted alone', async () => {
    await threeTurns()
    await restoreCheckpoint('run-three') // the single-turn Revert
    const r = await rewindConversation(convId, 1, 'code', 'two')
    expect(r).toMatchObject({ ok: true, restored: 2, conflicts: [] })
    expect(read('a.txt')).toBe('a1')
  })

  // POSIX-only: Windows symlink creation needs elevated privileges in CI.
  it.skipIf(process.platform === 'win32')('refuses to restore through a symlink, leaving its target untouched', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'houston-rw-out-'))
    try {
      writeFileSync(file('a.txt'), 'a0')
      await agentTurn('one', { 'a.txt': 'a1' })
      writeFileSync(join(outside, 'secret'), 'a1')
      rmSync(file('a.txt'))
      symlinkSync(join(outside, 'secret'), file('a.txt'))
      const r = await rewindConversation(convId, 0, 'code', 'one')
      expect(r).toMatchObject({ ok: true, restored: 0, conflicts: ['a.txt'] })
      expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('a1')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  // POSIX-only: Windows symlink creation needs elevated privileges in CI.
  it.skipIf(process.platform === 'win32')('refuses to restore under a parent swapped for a symlink out of the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'houston-rw-out-'))
    try {
      await agentTurn('one', { 'sub/x.txt': 'made' })
      rmSync(file('sub'), { recursive: true })
      writeFileSync(join(outside, 'x.txt'), 'made')
      symlinkSync(outside, file('sub'))
      const r = await rewindConversation(convId, 0, 'code', 'one')
      expect(r).toMatchObject({ ok: true, restored: 0, conflicts: [join('sub', 'x.txt')] })
      expect(readFileSync(join(outside, 'x.txt'), 'utf8')).toBe('made')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('reports turns whose snapshots were pruned', async () => {
    await threeTurns()
    await flushCheckpoints()
    clearCheckpoints()
    rmSync(join(dataDir, 'checkpoints', 'run-two.json'))
    const p = await previewRewind(convId, 0, 'code', 'one')
    expect(p).toMatchObject({ ok: true, unavailable: 1 })
  })
})

describe('rewind and compaction', () => {
  const summary = 'S'
  async function sixTurns(): Promise<void> {
    for (const t of ['t0', 't1', 't2', 't3', 't4', 't5']) await agentTurn(t)
  }

  it('keeps a summary that covers only messages before the cut', async () => {
    await sixTurns()
    setCompaction(convId, { cut: 4, summary, evictBefore: 8 })
    await rewindConversation(convId, 3, 'conversation', 't3') // message index 6
    expect(peekConversation(convId)!.compaction).toEqual({ cut: 4, summary, evictBefore: 6 })
  })

  it('drops a summary that covered messages the rewind removed', async () => {
    await sixTurns()
    setCompaction(convId, { cut: 8, summary })
    await rewindConversation(convId, 2, 'conversation', 't2') // message index 4
    expect(peekConversation(convId)!.compaction).toBeUndefined()
  })

  it('keeps only the clamped eviction watermark when the summary goes', async () => {
    await sixTurns()
    setCompaction(convId, { cut: 8, summary, evictBefore: 9 })
    await rewindConversation(convId, 2, 'conversation', 't2')
    expect(peekConversation(convId)!.compaction).toEqual({ cut: 0, summary: '', evictBefore: 4 })
  })

  it('a code-only rewind leaves compaction as it was', async () => {
    await sixTurns()
    setCompaction(convId, { cut: 8, summary })
    await rewindConversation(convId, 2, 'code', 't2')
    expect(peekConversation(convId)!.compaction).toEqual({ cut: 8, summary })
  })

  it('undo brings the compaction state back', async () => {
    await sixTurns()
    setCompaction(convId, { cut: 8, summary })
    await rewindConversation(convId, 2, 'conversation', 't2')
    await undoRewind(convId)
    expect(peekConversation(convId)!.compaction).toEqual({ cut: 8, summary })
  })
})

describe('undo rewind', () => {
  it('brings back the messages and the files', async () => {
    await threeTurns()
    setConversationError(convId, { message: 'boom' } as never)
    const before = messages()
    await rewindConversation(convId, 1, 'both', 'two')
    expect(peekConversation(convId)!.lastError).toBeUndefined()
    expect(canUndoRewind(convId)).toBe(true)

    const u = await undoRewind(convId)
    expect(u).toMatchObject({ ok: true, reapplied: 2, conflicts: [] })
    expect(messages()).toEqual(before)
    expect(peekConversation(convId)!.lastError).toEqual({ message: 'boom' })
    expect(read('a.txt')).toBe('a3')
    expect(read('b.txt')).toBe('b3')
    // The turns are back in the chat, and so is the latest turn's revert.
    expect(conversationChain(convId).every((e) => !e.detached)).toBe(true)
    expect(await getConversationCheckpoint(convId)).toMatchObject({ runId: 'run-three', reverted: false })
    expect(canUndoRewind(convId)).toBe(false)
  })

  it('undoes a code-only rewind', async () => {
    await threeTurns()
    await rewindConversation(convId, 0, 'code', 'one')
    expect(read('a.txt')).toBe('a0')
    expect(await undoRewind(convId)).toMatchObject({ ok: true, reapplied: 2 })
    expect(read('a.txt')).toBe('a3')
  })

  it('leaves a file the user changed after the rewind', async () => {
    await threeTurns()
    await rewindConversation(convId, 1, 'both', 'two')
    writeFileSync(file('a.txt'), 'edited after rewinding')
    const u = await undoRewind(convId)
    expect(u).toMatchObject({ ok: true, reapplied: 1, conflicts: ['a.txt'] })
    expect(read('a.txt')).toBe('edited after rewinding')
  })

  it('is refused once the chat has moved on', async () => {
    await threeTurns()
    await rewindConversation(convId, 1, 'both', 'two')
    await agentTurn('a new direction')
    expect(canUndoRewind(convId)).toBe(false)
    expect(await undoRewind(convId)).toMatchObject({ ok: false })
    expect(peekConversation(convId)!.rewindBackup).toBeUndefined()
  })

  it('an undo whose log cannot be saved changes nothing and can be retried', async () => {
    await threeTurns()
    await rewindConversation(convId, 1, 'both', 'two')
    store.failWrite = true
    expect(await undoRewind(convId)).toMatchObject({ ok: false })
    expect(read('a.txt')).toBe('a1')
    expect(canUndoRewind(convId)).toBe(true)
    store.failWrite = false
    expect(await undoRewind(convId)).toMatchObject({ ok: true, reapplied: 2 })
    expect(read('a.txt')).toBe('a3')
  })

  it('is refused when there was no rewind', async () => {
    await threeTurns()
    expect(await undoRewind(convId)).toMatchObject({ ok: false })
  })

  it('a later rewind reaches turns an earlier one cut, so code goes fully back', async () => {
    await threeTurns()
    await rewindConversation(convId, 2, 'conversation', 'three') // cut turn three, keep its files
    await agentTurn('three again', { 'a.txt': 'a3b' })
    // Back to before turn two: turn three's cut run is included too.
    await rewindConversation(convId, 1, 'both', 'two')
    expect(read('a.txt')).toBe('a1')
    expect(read('b.txt')).toBeNull()
  })
})
