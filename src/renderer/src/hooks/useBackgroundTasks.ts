import { useEffect, useMemo, useRef, useState } from 'react'
import type { BackgroundShellInfo, ConversationMeta } from '@shared/agent'
import type { TermTab } from './useTerminals'

/** What kind of background work a task represents (drives its icon + click target). */
export type BackgroundTaskKind = 'chat' | 'terminal' | 'shell'
export type BackgroundTaskStatus = 'running' | 'done' | 'error'

/**
 * One unit of background work surfaced in the indicator. A "background task" is
 * anything that runs on its own while you work elsewhere:
 *  - `chat`     — an agent run on a conversation (keeps going off-screen),
 *  - `terminal` — an integrated terminal session (a long-lived shell / job),
 *  - `shell`    — a command the agent backgrounded via `run_shell` (dev server, watcher).
 * The indicator is how you notice one of these finishing when it isn't in view.
 */
export interface BackgroundTask {
  /** Unique within its kind; the click target is resolved by `(kind, id)`. */
  id: string
  kind: BackgroundTaskKind
  title: string
  /** Secondary line — repo for a chat, working dir/label for a terminal. */
  subtitle: string
  status: BackgroundTaskStatus
  /** Epoch ms the task finished; set for `done`/`error`, omitted while running. */
  finishedAt?: number
  /** Conversation to open on click; the task's own id for chats, the spawning run for shells. */
  conversationId?: string
}

/**
 * How many finished items to retain per source before the oldest drop off. Kept
 * liberal so a busy session's history stays visible; running items are never
 * capped (you always see everything in flight).
 */
const MAX_FINISHED = 50

/** Last path segment of a workspace path, for a compact location label. */
function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

/**
 * Derive the unified list of background tasks — everything in progress plus the
 * most recently finished — from the conversation list, the live running set, and
 * the integrated terminal tabs.
 *
 * Chats: the main process owns the running set (a run can start/finish from any
 * window or a queued follow-up), so in-progress chats come straight from
 * `runningConversationIds`. A run leaving that set is a completion; we stamp when
 * and then read its outcome (done vs. failed) from the conversation meta's
 * `errored` flag, which the list refresh fills in a beat later — so the status
 * self-corrects without racing the persisted error write.
 *
 * Terminals: a tab carries its own lifecycle (`exited`/`exitedAt`/`exitCode`), so
 * its status is read directly — running while the shell is alive, done/failed once
 * it exits, and gone from the list entirely when the user closes the tab.
 */
export function useBackgroundTasks(
  conversations: readonly ConversationMeta[],
  runningConversationIds: ReadonlySet<string>,
  terminals: readonly TermTab[],
  shells: readonly BackgroundShellInfo[],
  now: () => number = Date.now
): { tasks: BackgroundTask[]; clearFinished: () => void } {
  // conversation id -> epoch ms its run finished. Only chats need this; a finished
  // run is otherwise indistinguishable from one that never ran (the conversation
  // persists either way), whereas a terminal tab remembers its own exit.
  const [finishedChats, setFinishedChats] = useState<ReadonlyMap<string, number>>(() => new Map())
  // Cleared finished items are remembered so they don't immediately reappear from
  // a still-exited terminal tab; a fresh exit (newer than the clear) shows again.
  const [clearedBefore, setClearedBefore] = useState(0)
  const prevRunningRef = useRef<ReadonlySet<string>>(runningConversationIds)
  // Read the clock from a ref so passing an inline `now` doesn't re-fire the effect.
  const nowRef = useRef(now)
  nowRef.current = now

  useEffect(() => {
    const prev = prevRunningRef.current
    prevRunningRef.current = runningConversationIds
    const justFinished: string[] = []
    for (const id of prev) if (!runningConversationIds.has(id)) justFinished.push(id)
    if (justFinished.length === 0) return
    const at = nowRef.current()
    setFinishedChats((prevMap) => {
      const next = new Map(prevMap)
      for (const id of justFinished) next.set(id, at)
      if (next.size <= MAX_FINISHED) return next
      // Keep the newest MAX_FINISHED; the rest fall off the list.
      return new Map([...next.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_FINISHED))
    })
  }, [runningConversationIds])

  const tasks = useMemo(() => {
    const byId = new Map(conversations.map((c) => [c.id, c]))
    const running: BackgroundTask[] = []
    const finished: BackgroundTask[] = []

    // --- Chats ---------------------------------------------------------------
    const runningConvs = [...runningConversationIds]
      .map((id) => byId.get(id))
      .filter((c): c is ConversationMeta => !!c)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    for (const c of runningConvs) {
      running.push({
        id: c.id,
        kind: 'chat',
        title: c.title,
        subtitle: basename(c.workspace),
        status: 'running'
      })
    }
    for (const [id, finishedAt] of finishedChats) {
      if (runningConversationIds.has(id) || !byId.has(id)) continue
      const c = byId.get(id)!
      finished.push({
        id: c.id,
        kind: 'chat',
        title: c.title,
        subtitle: basename(c.workspace),
        status: c.errored ? 'error' : 'done',
        finishedAt
      })
    }

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
  }, [conversations, runningConversationIds, terminals, shells, finishedChats, clearedBefore])

  const clearFinished = useMemo(
    () => () => {
      const at = nowRef.current()
      setClearedBefore(at)
      setFinishedChats((prev) => (prev.size === 0 ? prev : new Map()))
    },
    []
  )

  return { tasks, clearFinished }
}
