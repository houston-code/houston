import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { BackgroundShellInfo } from '@shared/agent'
import { useBackgroundTasks } from './useBackgroundTasks'
import type { TermTab } from './useTerminals'

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
  it('excludes chat runs entirely — with nothing running in the background the list is empty', () => {
    // The hook no longer takes conversations/runningIds: a running chat is shown by
    // its sidebar dot, never as a background task here.
    const { result } = renderHook(() => useBackgroundTasks(NO_TERMS, NO_SHELLS, clock()))
    expect(result.current.tasks).toEqual([])
  })

  it('lists open terminals as running and exited ones as finished', () => {
    const terminals = [
      term('t1'),
      term('t2', { exited: true, exitedAt: 500, exitCode: 0 }),
      term('t3', { exited: true, exitedAt: 600, exitCode: 1 })
    ]
    const { result } = renderHook(() => useBackgroundTasks(terminals, NO_SHELLS, clock()))
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
    const { result } = renderHook(() => useBackgroundTasks(NO_TERMS, shells, clock()))
    const byId = Object.fromEntries(result.current.tasks.map((t) => [t.id, t]))
    expect(byId.s1).toMatchObject({ kind: 'shell', title: 'cmd s1', status: 'running', conversationId: 'a' })
    expect(byId.s2).toMatchObject({ status: 'done', finishedAt: 700 })
    expect(byId.s3.status).toBe('error')
    expect(byId.s4.status).toBe('error') // killed (null exit) counts as failed
  })

  it('merges terminals and shells: running first, finished newest-first', () => {
    const terminals = [term('t1'), term('t2', { exited: true, exitedAt: 9_000, exitCode: 0 })]
    const shells = [shell('s2', { running: false, exitCode: 0, exitedAt: 4_000 })]
    const { result } = renderHook(() => useBackgroundTasks(terminals, shells, clock()))
    expect(result.current.tasks[0]).toMatchObject({ id: 't1', status: 'running' })
    const finished = result.current.tasks.filter((t) => t.status !== 'running')
    // t2 finished at 9000 > s2 at 4000, so it sorts ahead among the finished.
    expect(finished.map((t) => t.id)).toEqual(['t2', 's2'])
  })

  it('hides finished items after clearFinished but keeps running ones', () => {
    const terminals = [term('t1')]
    const shells = [shell('s1'), shell('s2', { running: false, exitCode: 0, exitedAt: 500 })]
    const tick = clock()
    const { result } = renderHook(() => useBackgroundTasks(terminals, shells, tick))
    expect(result.current.tasks.some((t) => t.status !== 'running')).toBe(true)
    act(() => result.current.clearFinished())
    expect(result.current.tasks.map((t) => t.id).sort()).toEqual(['s1', 't1'])
    expect(result.current.tasks.every((t) => t.status === 'running')).toBe(true)
  })
})
