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
  /**
   * Open a new tab. `run`, when given, is typed into the fresh shell followed by
   * Enter, and names the tab (used for a one-click runtime install). `type` is typed
   * in WITHOUT Enter, so the user reads it and runs it themselves. `command` runs
   * as the tab's only job (the composer's `!cmd`): the tab ends when it does, and
   * its exit carries the output. Resolves with the tab's id.
   */
  addTab: (opts?: { run?: string; type?: string; command?: string; title?: string }) => Promise<string>
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

  const addTab = useCallback(
    async (opts?: { run?: string; type?: string; command?: string; title?: string }) => {
      const id = await window.api.createTerminal({
        cwd: workspace ?? undefined,
        ...(opts?.command ? { command: opts.command } : {})
      })
      counter.current += 1
      const title = opts?.title ?? `Terminal ${counter.current}`
      setTabs((prev) => [...prev, { id, title, exited: false }])
      setActiveId(id)
      // The PTY buffers input until the shell reads it, so this is safe to send
      // before the prompt has drawn.
      if (opts?.run) await window.api.writeTerminal(id, `${opts.run}\r`)
      // Typed in only: any line break is dropped so nothing can run before Enter.
      else if (opts?.type) await window.api.writeTerminal(id, opts.type.replace(/[\r\n]+/g, ' '))
      return id
    },
    [workspace]
  )

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
