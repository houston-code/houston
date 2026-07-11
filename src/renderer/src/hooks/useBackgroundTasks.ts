import { useMemo, useRef, useState } from 'react'
import type { BackgroundShellInfo } from '@shared/agent'
import type { TermTab } from './useTerminals'

/** What kind of background work a task represents (drives its icon + click target). */
export type BackgroundTaskKind = 'terminal' | 'shell'
export type BackgroundTaskStatus = 'running' | 'done' | 'error'

/**
 * One unit of background work surfaced in the indicator. A "background task" is
 * something that runs on its own while you work elsewhere:
 *  - `terminal` — an integrated terminal session (a long-lived shell / job),
 *  - `shell`    — a command the agent backgrounded via `run_shell` (dev server, watcher).
 *
 * Agent chat runs are deliberately NOT background tasks: a running chat is already
 * represented by its own Stop button and its per-chat dot in the sidebar, so
 * surfacing it here too — where the one you're viewing can't be told apart from the
 * rest — only adds noise. The indicator is how you notice a terminal or backgrounded
 * command finishing when it isn't in view.
 */
export interface BackgroundTask {
  /** Unique within its kind; the click target is resolved by `(kind, id)`. */
  id: string
  kind: BackgroundTaskKind
  title: string
  /** Secondary line; terminals/shells have none today, kept for row-layout parity. */
  subtitle: string
  status: BackgroundTaskStatus
  /** Epoch ms the task finished; set for `done`/`error`, omitted while running. */
  finishedAt?: number
  /** Conversation to open on click — the run that spawned a background shell. */
  conversationId?: string
}

/**
 * Derive the unified list of background tasks — everything in progress plus the
 * most recently finished — from the integrated terminal tabs and the agent's
 * backgrounded shells.
 *
 * Terminals: a tab carries its own lifecycle (`exited`/`exitedAt`/`exitCode`), so
 * its status is read directly — running while the shell is alive, done/failed once
 * it exits, and gone from the list entirely when the user closes the tab.
 *
 * Shells: a `run_shell` background command reports `running` + `exitCode`, and
 * carries the id of the conversation that spawned it so a click can reopen it.
 */
export function useBackgroundTasks(
  terminals: readonly TermTab[],
  shells: readonly BackgroundShellInfo[],
  now: () => number = Date.now
): { tasks: BackgroundTask[]; clearFinished: () => void } {
  // Finished items the user cleared stay hidden until something exits anew (a
  // fresh exit, newer than the clear, shows again).
  const [clearedBefore, setClearedBefore] = useState(0)
  // Read the clock from a ref so passing an inline `now` doesn't re-fire memos.
  const nowRef = useRef(now)
  nowRef.current = now

  const tasks = useMemo(() => {
    const running: BackgroundTask[] = []
    const finished: BackgroundTask[] = []

    // --- Terminals -----------------------------------------------------------
    for (const t of terminals) {
      if (!t.exited) {
        running.push({ id: t.id, kind: 'terminal', title: t.title, subtitle: '', status: 'running' })
      } else if (!(t.exitedAt !== undefined && t.exitedAt <= clearedBefore)) {
        finished.push({
          id: t.id,
          kind: 'terminal',
          title: t.title,
          subtitle: '',
          status: t.exitCode ? 'error' : 'done',
          finishedAt: t.exitedAt
        })
      }
    }

    // --- Background shells (run_shell background mode) ------------------------
    for (const s of shells) {
      const base = {
        id: s.id,
        kind: 'shell' as const,
        title: s.command,
        subtitle: '',
        ...(s.conversationId ? { conversationId: s.conversationId } : {})
      }
      if (s.running) {
        running.push({ ...base, status: 'running' })
      } else if (!(s.exitedAt !== null && s.exitedAt <= clearedBefore)) {
        // exitCode 0 is a clean finish; nonzero or null (killed) is a failure.
        finished.push({
          ...base,
          status: s.exitCode === 0 ? 'done' : 'error',
          finishedAt: s.exitedAt ?? undefined
        })
      }
    }

    // Running first, then finished — each newest-first within its group.
    finished.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    return [...running, ...finished]
  }, [terminals, shells, clearedBefore])

  const clearFinished = useMemo(() => () => setClearedBefore(nowRef.current()), [])

  return { tasks, clearFinished }
}
