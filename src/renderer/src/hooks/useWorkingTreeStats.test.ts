import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { FileDiff, WorkingTreeChanges } from '@shared/workingTree'
import { useWorkingTreeStats } from './useWorkingTreeStats'

function files(n: number): FileDiff[] {
  return Array.from({ length: n }, () => ({}) as unknown as FileDiff)
}

function changes(over: Partial<WorkingTreeChanges> = {}): WorkingTreeChanges {
  return { isRepo: true, branch: 'main', files: [], added: 0, removed: 0, ...over }
}

/** Fake `window.api` exposing just the working-tree surface, with a setter for the test. */
function installApi(initial: WorkingTreeChanges) {
  let current = initial
  const getWorkingTreeChanges = vi.fn(() => Promise.resolve(current))
  window.api = { getWorkingTreeChanges } as unknown as typeof window.api
  return {
    getWorkingTreeChanges,
    set(next: WorkingTreeChanges): void {
      current = next
    }
  }
}

describe('useWorkingTreeStats', () => {
  it('fetches on mount and exposes the change counts', async () => {
    const api = installApi(changes({ files: files(3), added: 12, removed: 4 }))
    const { result } = renderHook(() => useWorkingTreeStats('/repo', false))

    expect(api.getWorkingTreeChanges).toHaveBeenCalledWith('/repo')
    await waitFor(() => expect(result.current).toEqual({ fileCount: 3, added: 12, removed: 4 }))
  })

  it('reports zero when the workspace is not a repo', async () => {
    installApi(changes({ isRepo: false }))
    const { result } = renderHook(() => useWorkingTreeStats('/repo', false))
    await waitFor(() => expect(result.current).toEqual({ fileCount: 0, added: 0, removed: 0 }))
  })

  it('does not fetch when there is no workspace', () => {
    const api = installApi(changes())
    const { result } = renderHook(() => useWorkingTreeStats(null, false))
    expect(api.getWorkingTreeChanges).not.toHaveBeenCalled()
    expect(result.current).toEqual({ fileCount: 0, added: 0, removed: 0 })
  })

  it('refetches when a run finishes (running goes true → false)', async () => {
    const api = installApi(changes({ files: files(1), added: 1, removed: 0 }))
    const { result, rerender } = renderHook(
      ({ running }: { running: boolean }) => useWorkingTreeStats('/repo', running),
      { initialProps: { running: true } }
    )
    await waitFor(() => expect(result.current.fileCount).toBe(1))
    expect(api.getWorkingTreeChanges).toHaveBeenCalledTimes(1)

    // The run lands a second file before it finishes.
    api.set(changes({ files: files(2), added: 9, removed: 2 }))
    rerender({ running: false })

    await waitFor(() => expect(result.current).toEqual({ fileCount: 2, added: 9, removed: 2 }))
    expect(api.getWorkingTreeChanges).toHaveBeenCalledTimes(2)
  })

  it('refetches when the window regains focus', async () => {
    const api = installApi(changes({ files: files(1), added: 1, removed: 0 }))
    const { result } = renderHook(() => useWorkingTreeStats('/repo', false))
    await waitFor(() => expect(result.current.fileCount).toBe(1))

    api.set(changes({ files: files(0), added: 0, removed: 0 }))
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(result.current.fileCount).toBe(0))
  })
})
