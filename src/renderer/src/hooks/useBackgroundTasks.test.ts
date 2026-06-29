import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { BackgroundShellInfo, ConversationMeta } from '@shared/agent'
import { useBackgroundTasks } from './useBackgroundTasks'
import type { TermTab } from './useTerminals'

function conv(id: string, over: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id,
    title: `Chat ${id}`,
    workspace: `/repos/${id}`,
    providerId: 'p',
    model: 'm',
    createdAt: 0,
    updatedAt: 0,
    ...over
  }
}

function term(id: string, over: Partial<TermTab> = {}): TermTab {
  return { id, title: `Terminal ${id}`, exited: false, ...over }
}

function shell(id: string, over: Partial<BackgroundShellInfo> = {}): BackgroundShellInfo {
  return { id, command: `cmd ${id}`, running: true, exitCode: null, startedAt: 1, exitedAt: null, ...over }
}

/** A monotonic clock so finished timestamps are deterministic and orderable. */
function clock(start = 1000): () => number {
  let t = start
  return () => (t += 1000)
}

const NO_TERMS: TermTab[] = []
const NO_SHELLS: BackgroundShellInfo[] = []

describe('useBackgroundTasks', () => {
  it('lists running conversations as in-progress chat tasks, most recent first', () => {
    const conversations = [conv('a', { updatedAt: 1 }), conv('b', { updatedAt: 2 })]
    const { result } = renderHook(() =>
      useBackgroundTasks(conversations, new Set(['a', 'b']), NO_TERMS, NO_SHELLS, clock())
    )
    expect(result.current.tasks.map((t) => t.id)).toEqual(['b', 'a'])
    expect(result.current.tasks.every((t) => t.kind === 'chat' && t.status === 'running')).toBe(true)
  })

  it('moves a chat run to "done" when it leaves the running set', () => {
    const conversations = [conv('a')]
    const { result, rerender } = renderHook(
      ({ running }) => useBackgroundTasks(conversations, running, NO_TERMS, NO_SHELLS, clock()),
      { initialProps: { running: new Set(['a']) as ReadonlySet<string> } }
    )
    expect(result.current.tasks[0].status).toBe('running')

    act(() => rerender({ running: new Set<string>() }))
    expect(result.current.tasks).toHaveLength(1)
    expect(result.current.tasks[0].status).toBe('done')
    expect(result.current.tasks[0].finishedAt).toBeGreaterThan(0)
  })

  it('marks a finished chat run as failed when its meta is errored', () => {
    let conversations = [conv('a')]
    const { result, rerender } = renderHook(
      ({ running }) => useBackgroundTasks(conversations, running, NO_TERMS, NO_SHELLS, clock()),
      { initialProps: { running: new Set(['a']) as ReadonlySet<string> } }
    )
    // The list refreshes a beat after the run ends, surfacing the persisted error.
    conversations = [conv('a', { errored: true })]
    act(() => rerender({ running: new Set<string>() }))
    expect(result.current.tasks[0].status).toBe('error')
  })

  it('lists open terminals as running and exited ones as finished', () => {
    const terminals = [
      term('t1'),
      term('t2', { exited: true, exitedAt: 500, exitCode: 0 }),
      term('t3', { exited: true, exitedAt: 600, exitCode: 1 })
    ]
    const { result } = renderHook(() =>
      useBackgroundTasks([], new Set(), terminals, NO_SHELLS, clock())
    )
    const byId = Object.fromEntries(result.current.tasks.map((t) => [t.id, t]))
    expect(byId.t1).toMatchObject({ kind: 'terminal', status: 'running' })
    expect(byId.t2).toMatchObject({ kind: 'terminal', status: 'done' })
    expect(byId.t3).toMatchObject({ kind: 'terminal', status: 'error' })
  })

  it('lists background shells with status from running/exit code and carries the spawning conversation', () => {
    const shells = [
      shell('s1', { conversationId: 'a' }),
      shell('s2', { running: false, exitCode: 0, exitedAt: 700 }),
      shell('s3', { running: false, exitCode: 2, exitedAt: 800 }),
      shell('s4', { running: false, exitCode: null, exitedAt: 900 }) // killed
    ]
    const { result } = renderHook(() => useBackgroundTasks([], new Set(), NO_TERMS, shells, clock()))
    const byId = Object.fromEntries(result.current.tasks.map((t) => [t.id, t]))
    expect(byId.s1).toMatchObject({ kind: 'shell', title: 'cmd s1', status: 'running', conversationId: 'a' })
    expect(byId.s2).toMatchObject({ status: 'done', finishedAt: 700 })
    expect(byId.s3.status).toBe('error')
    expect(byId.s4.status).toBe('error') // killed (null exit) counts as failed
  })

  it('hides finished shells after clearFinished but keeps a running one', () => {
    const shells = [shell('s1'), shell('s2', { running: false, exitCode: 0, exitedAt: 500 })]
    const tick = clock()
    const { result } = renderHook(() =>
      useBackgroundTasks([], new Set(), NO_TERMS, shells, tick)
    )
    expect(result.current.tasks.some((t) => t.status !== 'running')).toBe(true)
    act(() => result.current.clearFinished())
    expect(result.current.tasks.map((t) => t.id)).toEqual(['s1'])
  })

  it('merges chats and terminals: running first, finished newest-first', () => {
    const conversations = [conv('a', { updatedAt: 5 })]
    const terminals = [term('t1'), term('t2', { exited: true, exitedAt: 9_000, exitCode: 0 })]
    const { result, rerender } = renderHook(
      ({ running }) => useBackgroundTasks(conversations, running, terminals, NO_SHELLS, clock()),
      { initialProps: { running: new Set(['a']) as ReadonlySet<string> } }
    )
    // 'a' finishes at clock tick 2000; terminal t2 already finished at 9000.
    act(() => rerender({ running: new Set<string>() }))
    const statuses = result.current.tasks.map((t) => t.status)
    // Two running (chat a is now done; t1 still running) then finished by recency.
    expect(result.current.tasks[0].status).toBe('running') // t1
    expect(statuses.filter((s) => s !== 'running')).toEqual(['done', 'done'])
    // t2 finished at 9000 > a's 2000, so it sorts ahead among the finished.
    const finished = result.current.tasks.filter((t) => t.status !== 'running')
    expect(finished.map((t) => t.id)).toEqual(['t2', 'a'])
  })

  it('drops a finished chat entry while the same conversation is running again', () => {
    const conversations = [conv('a')]
    const { result, rerender } = renderHook(
      ({ running }) => useBackgroundTasks(conversations, running, NO_TERMS, NO_SHELLS, clock()),
      { initialProps: { running: new Set(['a']) as ReadonlySet<string> } }
    )
    act(() => rerender({ running: new Set<string>() }))
    expect(result.current.tasks[0].status).toBe('done')

    act(() => rerender({ running: new Set(['a']) }))
    expect(result.current.tasks).toHaveLength(1)
    expect(result.current.tasks[0].status).toBe('running')
  })

  it('clearFinished hides finished chats and terminals but keeps running ones', () => {
    const conversations = [conv('a'), conv('b')]
    const terminals = [term('t1'), term('t2', { exited: true, exitedAt: 500, exitCode: 0 })]
    const tick = clock()
    const { result, rerender } = renderHook(
      ({ running }) => useBackgroundTasks(conversations, running, terminals, NO_SHELLS, tick),
      { initialProps: { running: new Set(['a', 'b']) as ReadonlySet<string> } }
    )
    act(() => rerender({ running: new Set(['a']) }))
    // a (done), t2 (done) finished; a, t1 running.
    expect(result.current.tasks.some((t) => t.status !== 'running')).toBe(true)

    act(() => result.current.clearFinished())
    const ids = result.current.tasks.map((t) => t.id).sort()
    expect(ids).toEqual(['a', 't1'])
    expect(result.current.tasks.every((t) => t.status === 'running')).toBe(true)
  })

  it('caps the finished chat list to the most recent fifty', () => {
    const ids = Array.from({ length: 60 }, (_, i) => `c${i}`)
    const conversations = ids.map((id) => conv(id))
    const tick = clock()
    const { result, rerender } = renderHook(
      ({ running }) => useBackgroundTasks(conversations, running, NO_TERMS, NO_SHELLS, tick),
      { initialProps: { running: new Set(ids) as ReadonlySet<string> } }
    )
    const remaining = new Set(ids)
    for (const id of ids) {
      remaining.delete(id)
      act(() => rerender({ running: new Set(remaining) }))
    }
    const finished = result.current.tasks.filter((t) => t.status !== 'running')
    expect(finished).toHaveLength(50)
    expect(finished.map((t) => t.id)).not.toContain('c0')
    expect(finished[0].id).toBe('c59')
  })

  it('ignores running/finished ids with no matching conversation', () => {
    const conversations = [conv('a')]
    const { result } = renderHook(() =>
      useBackgroundTasks(conversations, new Set(['a', 'ghost']), NO_TERMS, NO_SHELLS, clock())
    )
    expect(result.current.tasks.map((t) => t.id)).toEqual(['a'])
  })
})
