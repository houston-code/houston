import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useTerminals } from './useTerminals'

type ExitHandler = (p: { id: string; exitCode: number }) => void

/** Fake `window.api` exposing just the terminal surface, with a driver for exits. */
function installApi() {
  let onExit: ExitHandler | null = null
  let n = 0
  const api = {
    createTerminal: vi.fn((_opts: { cwd?: string }) => Promise.resolve(`t${++n}`)),
    killTerminal: vi.fn((_id: string) => Promise.resolve(true)),
    onTerminalExit: vi.fn((cb: ExitHandler) => {
      onExit = cb
      return () => {}
    })
  }
  window.api = api as unknown as typeof window.api
  return {
    api,
    exit(payload: { id: string; exitCode: number }): void {
      if (!onExit) throw new Error('useTerminals never subscribed via onTerminalExit')
      act(() => onExit!(payload))
    }
  }
}

describe('useTerminals', () => {
  it('opens a tab in the current workspace and makes it active', async () => {
    const { api } = installApi()
    const { result } = renderHook(() => useTerminals('/repo'))

    await act(async () => {
      await result.current.addTab()
    })

    expect(api.createTerminal).toHaveBeenCalledWith({ cwd: '/repo' })
    expect(result.current.tabs).toEqual([{ id: 't1', title: 'Terminal 1', exited: false }])
    expect(result.current.activeId).toBe('t1')
  })

  it('passes undefined cwd when there is no workspace', async () => {
    const { api } = installApi()
    const { result } = renderHook(() => useTerminals(null))
    await act(async () => {
      await result.current.addTab()
    })
    expect(api.createTerminal).toHaveBeenCalledWith({ cwd: undefined })
  })

  it('labels tabs with a monotonic counter', async () => {
    installApi()
    const { result } = renderHook(() => useTerminals('/repo'))
    await act(async () => {
      await result.current.addTab()
      await result.current.addTab()
    })
    expect(result.current.tabs.map((t) => t.title)).toEqual(['Terminal 1', 'Terminal 2'])
  })

  it('closing the active tab kills it and activates a neighbour', async () => {
    const { api } = installApi()
    const { result } = renderHook(() => useTerminals('/repo'))
    await act(async () => {
      await result.current.addTab()
      await result.current.addTab()
    })
    expect(result.current.activeId).toBe('t2')

    act(() => result.current.closeTab('t2'))
    expect(api.killTerminal).toHaveBeenCalledWith('t2')
    expect(result.current.tabs.map((t) => t.id)).toEqual(['t1'])
    expect(result.current.activeId).toBe('t1')
  })

  it('closing the last tab leaves no active terminal', async () => {
    installApi()
    const { result } = renderHook(() => useTerminals('/repo'))
    await act(async () => {
      await result.current.addTab()
    })
    act(() => result.current.closeTab('t1'))
    expect(result.current.tabs).toEqual([])
    expect(result.current.activeId).toBeNull()
  })

  it('marks a tab exited when its shell exits, keeping it in the list', async () => {
    const { exit } = installApi()
    const { result } = renderHook(() => useTerminals('/repo'))
    await act(async () => {
      await result.current.addTab()
    })

    exit({ id: 't1', exitCode: 0 })
    await waitFor(() => expect(result.current.tabs[0].exited).toBe(true))
    expect(result.current.tabs).toHaveLength(1)
  })
})
