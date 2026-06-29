import { useCallback, useEffect, useRef, useState } from 'react'

/** One terminal tab in the integrated terminal panel. */
export interface TermTab {
  id: string
  title: string
  /** True once the underlying shell has exited (the tab stays until closed). */
  exited: boolean
  /** Epoch ms the shell exited; set alongside `exited` for ordering/relative time. */
  exitedAt?: number
  /** The shell's exit status; nonzero marks the run as failed. Set on exit. */
  exitCode?: number
}

export interface UseTerminals {
  tabs: TermTab[]
  activeId: string | null
  addTab: () => Promise<void>
  closeTab: (id: string) => void
  setActive: (id: string) => void
}

/**
 * Tab state + lifecycle for the integrated terminal. Terminals are window-global
 * (not tied to a conversation); a new tab opens in `workspace` as its cwd, or the
 * shell's default home dir when there's no workspace yet.
 */
export function useTerminals(workspace: string | null): UseTerminals {
  const [tabs, setTabs] = useState<TermTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // Monotonic label counter so closing/reopening doesn't reuse a number.
  const counter = useRef(0)

  const addTab = useCallback(async () => {
    const id = await window.api.createTerminal({ cwd: workspace ?? undefined })
    counter.current += 1
    const title = `Terminal ${counter.current}`
    setTabs((prev) => [...prev, { id, title, exited: false }])
    setActiveId(id)
  }, [workspace])

  const closeTab = useCallback((id: string) => {
    void window.api.killTerminal(id)
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id)
      const next = prev.filter((t) => t.id !== id)
      // If we closed the active tab, fall back to its neighbour.
      setActiveId((cur) => {
        if (cur !== id) return cur
        if (next.length === 0) return null
        return next[Math.min(idx, next.length - 1)].id
      })
      return next
    })
  }, [])

  const setActive = useCallback((id: string) => setActiveId(id), [])

  // Mark a tab whose shell exited; keep it so the user can read the final output.
  // Stamp when and how it ended so the background-tasks indicator can order it and
  // flag a nonzero exit as failed.
  useEffect(() => {
    return window.api.onTerminalExit(({ id, exitCode }) => {
      setTabs((prev) =>
        prev.map((t) => (t.id === id ? { ...t, exited: true, exitedAt: Date.now(), exitCode } : t))
      )
    })
  }, [])

  return { tabs, activeId, addTab, closeTab, setActive }
}
