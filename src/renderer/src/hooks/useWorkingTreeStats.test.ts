import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WorkingTreeStats as StatsPayload } from '@shared/workingTree'
import { sameStats, useWorkingTreeStats } from './useWorkingTreeStats'

function stats(over: Partial<StatsPayload> = {}): StatsPayload {
  return { isRepo: true, branch: 'main', fileCount: 0, added: 0, removed: 0, ...over }
}

/** Fake `window.api` exposing just the working-tree surface, with a setter for the test. */
function installApi(initial: StatsPayload) {
  let current = initial
  const getWorkingTreeStats = vi.fn(() => Promise.resolve(current))
  const getWorkingTreeChanges = vi.fn()
  window.api = { getWorkingTreeStats, getWorkingTreeChanges } as unknown as typeof window.api
  return {
    getWorkingTreeStats,
    getWorkingTreeChanges,
    set(next: StatsPayload): void {
      current = next
    }
  }
}

describe('useWorkingTreeStats', () => {
  it('fetches on mount and exposes the change counts', async () => {
    const api = installApi(stats({ fileCount: 3, added: 12, removed: 4 }))
    const { result } = renderHook(() => useWorkingTreeStats('/repo', false))

    expect(api.getWorkingTreeStats).toHaveBeenCalledWith('/repo')
    await waitFor(() => expect(result.current).toEqual({ fileCount: 3, added: 12, removed: 4, branch: 'main' }))
  })

  it('asks for the counts only, never the full diff', async () => {
    const api = installApi(stats({ fileCount: 1, added: 1 }))
    const { result } = renderHook(() => useWorkingTreeStats('/repo', false))
    await waitFor(() => expect(result.current.fileCount).toBe(1))
    expect(api.getWorkingTreeChanges).not.toHaveBeenCalled()
  })

  it('reports zero when the workspace is not a repo', async () => {
    installApi(stats({ isRepo: false, fileCount: 5 }))
    const { result } = renderHook(() => useWorkingTreeStats('/repo', false))
    await waitFor(() => expect(result.current).toEqual({ fileCount: 0, added: 0, removed: 0 }))
  })

  it('carries the checked-out branch, or null when the repo has none checked out', async () => {
    const api = installApi(stats({ branch: 'feature/x' }))
    const { result, rerender } = renderHook(({ running }) => useWorkingTreeStats('/repo', running), {
      initialProps: { running: true }
    })
    await waitFor(() => expect(result.current.branch).toBe('feature/x'))
    api.set(stats({ branch: null }))
    rerender({ running: false })
    await waitFor(() => expect(result.current.branch).toBeNull())
  })

  it('does not fetch when there is no workspace', () => {
    const api = installApi(stats())
    const { result } = renderHook(() => useWorkingTreeStats(null, false))
    expect(api.getWorkingTreeStats).not.toHaveBeenCalled()
    expect(result.current).toEqual({ fileCount: 0, added: 0, removed: 0 })
  })

  it('refetches when a run finishes (running goes true → false)', async () => {
    const api = installApi(stats({ fileCount: 1, added: 1, removed: 0 }))
    const { result, rerender } = renderHook(
      ({ running }: { running: boolean }) => useWorkingTreeStats('/repo', running),
      { initialProps: { running: true } }
    )
    await waitFor(() => expect(result.current.fileCount).toBe(1))
    expect(api.getWorkingTreeStats).toHaveBeenCalledTimes(1)

    // The run lands a second file before it finishes.
    api.set(stats({ fileCount: 2, added: 9, removed: 2 }))
    rerender({ running: false })

    await waitFor(() => expect(result.current).toEqual({ fileCount: 2, added: 9, removed: 2, branch: 'main' }))
    expect(api.getWorkingTreeStats).toHaveBeenCalledTimes(2)
  })

  it('refetches when the window regains focus', async () => {
    const api = installApi(stats({ fileCount: 1, added: 1, removed: 0 }))
    const { result } = renderHook(() => useWorkingTreeStats('/repo', false))
    await waitFor(() => expect(result.current.fileCount).toBe(1))

    api.set(stats({ fileCount: 0, added: 0, removed: 0 }))
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(result.current.fileCount).toBe(0))
  })

  it('keeps the same object (no re-render) when a refresh finds the same numbers', async () => {
    const ship = { hasCommits: true, remote: { name: 'origin', host: 'github' as const } }
    const api = installApi(stats({ fileCount: 2, added: 3, removed: 1, ship }))
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useWorkingTreeStats('/repo', false)
    })
    await waitFor(() => expect(result.current.fileCount).toBe(2))
    const first = result.current
    const rendersBefore = renders

    // A fresh but equal payload, as every IPC round trip produces.
    api.set(stats({ fileCount: 2, added: 3, removed: 1, ship: { ...ship, remote: { ...ship.remote } } }))
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(api.getWorkingTreeStats).toHaveBeenCalledTimes(2))
    expect(result.current).toBe(first)
    expect(renders).toBe(rendersBefore)
  })
})

describe('sameStats', () => {
  const base = { fileCount: 1, added: 2, removed: 3 }
  it('compares counts and ship facts by value', () => {
    expect(sameStats(base, { ...base })).toBe(true)
    expect(sameStats(base, { ...base, added: 9 })).toBe(false)
    expect(sameStats({ ...base, branch: 'main' }, { ...base, branch: 'main' })).toBe(true)
    expect(sameStats({ ...base, branch: 'main' }, { ...base, branch: null })).toBe(false)
    expect(sameStats(base, { ...base, ship: { hasCommits: true, remote: null } })).toBe(false)
    expect(
      sameStats({ ...base, ship: { hasCommits: true, remote: null } }, { ...base, ship: { hasCommits: true, remote: null } })
    ).toBe(true)
    expect(
      sameStats(
        { ...base, ship: { hasCommits: true, remote: { name: 'origin', host: 'github' } } },
        { ...base, ship: { hasCommits: true, remote: { name: 'origin', host: 'other' } } }
      )
    ).toBe(false)
    expect(
      sameStats({ ...base, ship: { hasCommits: false, remote: null } }, { ...base, ship: { hasCommits: true, remote: null } })
    ).toBe(false)
  })
})
