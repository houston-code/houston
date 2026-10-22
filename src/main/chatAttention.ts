import type { AgentEvent } from '@shared/agent'
import type { ChatLiveStatus, ChatStatusMap } from '@shared/chatStatus'
import { prNoticeFromToolResult } from '@shared/prNotice'
import type { ReadStateStore } from './readState'

/**
 * Decides when a chat becomes unread or read, and publishes the combined status (live
 * run state from the agent loop, plus unread marks from the read-state store) that
 * drives the sidebar's dots.
 *
 * - A run that ends while no focused window shows its chat marks the chat unread, with
 *   how it ended (finished, stopped at a step limit, failed) and where its output
 *   starts, so the next open can land on it. A run the user stopped marks nothing.
 * - A focused window showing a chat marks it read. "Viewed" needs focus: a turn that
 *   finishes in the open chat while Houston is in the background is unread until the
 *   window comes back.
 * - The user can mark a chat unread (optionally from a given message) or read by hand.
 *
 * Electron-free so it can be tested directly; the IPC layer feeds it events and
 * viewer reports and hands its snapshots to every window.
 */

export interface ChatAttentionDeps {
  store: ReadStateStore
  /** The agent loop's live status (running + blocking prompts) per conversation. */
  liveStatus: () => ChatStatusMap
  /** The run currently live on a conversation, or null. */
  activeRun: (conversationId: string) => string | null
  /** How many messages a conversation's log holds now, or undefined if it's gone. */
  messageCount: (conversationId: string) => number | undefined
  /** Whether a conversation exists (manual marks on unknown ids are ignored). */
  exists: (conversationId: string) => boolean
  /** Hand a fresh snapshot to every window. */
  broadcast: (status: ChatStatusMap) => void
  now?: () => number
}

/** What a renderer window reports it is showing, and whether it has focus. */
interface Viewer {
  conversationId: string | null
  focused: boolean
}

export interface ChatAttention {
  snapshot(): ChatStatusMap
  /** The agent loop's live status changed (a run started or ended, a prompt came or went). */
  onLiveChanged(live: ChatStatusMap): void
  /** An event from a conversation's run, as it streams to the renderer. */
  noteEvent(conversationId: string, e: AgentEvent): void
  /** A window reports which chat it shows and whether it is focused. */
  setViewing(viewerId: number, conversationId: string | null, focused: boolean): void
  /** A window closed. */
  dropViewer(viewerId: number): void
  /** Mark a chat unread by hand (from `anchor`, a message index, when given) or read. */
  setUnread(conversationId: string, unread: boolean, anchor?: number): void
  markAllRead(): void
  /** A chat was deleted. */
  forget(conversationId: string): void
}

export function createChatAttention(deps: ChatAttentionDeps): ChatAttention {
  const now = deps.now ?? Date.now
  const viewers = new Map<number, Viewer>()
  // Where each live run's output starts in its conversation's log (the log's length
  // when the run began), for the unread anchor.
  const runStart = new Map<string, number>()
  // What the live run has said about how it is ending, before its final event.
  const ending = new Map<string, { limit?: boolean; note?: string }>()
  let running = new Set<string>()

  const merge = (live: ChatStatusMap): ChatStatusMap => {
    const out: ChatStatusMap = {}
    for (const [id, s] of Object.entries(live)) out[id] = { ...s }
    for (const [id, unread] of Object.entries(deps.store.snapshot())) {
      const entry: ChatLiveStatus = out[id] ?? { running: false, pending: [] }
      out[id] = { ...entry, unread }
    }
    return out
  }

  const snapshot = (): ChatStatusMap => merge(deps.liveStatus())
  const publish = (live?: ChatStatusMap): void => deps.broadcast(merge(live ?? deps.liveStatus()))

  const isViewed = (id: string): boolean =>
    [...viewers.values()].some((v) => v.focused && v.conversationId === id)

  const finish = (id: string, outcome: 'done' | 'limit' | 'error', note?: string): void => {
    const anchor = runStart.get(id)
    runStart.delete(id)
    ending.delete(id)
    if (isViewed(id)) return
    deps.store.markUnread(id, {
      since: now(),
      outcome,
      ...(note ? { note } : {}),
      ...(anchor !== undefined ? { anchor } : {})
    })
    publish()
  }

  return {
    snapshot,

    onLiveChanged(live) {
      const next = new Set(Object.keys(live).filter((id) => live[id].running))
      for (const id of next) {
        if (running.has(id)) continue
        const count = deps.messageCount(id)
        if (count !== undefined) runStart.set(id, count)
        ending.delete(id)
      }
      running = next
      publish(live)
    },

    noteEvent(conversationId, e) {
      // An event from a run that isn't the chat's live one (a refused second start
      // reports its error while the first run is still going) says nothing about it.
      const live = deps.activeRun(conversationId)
      if (live !== null && live !== e.runId) return
      switch (e.type) {
        case 'limit':
          ending.set(conversationId, { ...ending.get(conversationId), limit: true })
          return
        case 'tool_result': {
          const pr = prNoticeFromToolResult(e.name, e.ok, e.output)
          if (!pr) return
          const num = pr.number ? ` #${pr.number}` : ''
          const note = pr.event === 'created' ? `Opened PR${num}` : `PR${num} merged`
          ending.set(conversationId, { ...ending.get(conversationId), note })
          return
        }
        case 'error':
          finish(conversationId, 'error', e.message)
          return
        case 'done': {
          if (e.stopReason === 'aborted') {
            // The user stopped it: they were there, so there is nothing unseen.
            runStart.delete(conversationId)
            ending.delete(conversationId)
            return
          }
          const how = ending.get(conversationId)
          if (e.stopReason === 'error') finish(conversationId, 'error', how?.note)
          else finish(conversationId, how?.limit ? 'limit' : 'done', how?.note)
          return
        }
        default:
          return
      }
    },

    setViewing(viewerId, conversationId, focused) {
      viewers.set(viewerId, { conversationId, focused })
      if (focused && conversationId && deps.store.markRead(conversationId)) publish()
    },

    dropViewer(viewerId) {
      viewers.delete(viewerId)
    },

    setUnread(conversationId, unread, anchor) {
      if (!unread) {
        if (deps.store.markRead(conversationId)) publish()
        return
      }
      if (!deps.exists(conversationId)) return
      deps.store.markUnread(conversationId, {
        since: now(),
        outcome: 'manual',
        ...(anchor !== undefined ? { anchor } : {})
      })
      publish()
    },

    markAllRead() {
      if (deps.store.markAllRead().length) publish()
    },

    forget(conversationId) {
      runStart.delete(conversationId)
      ending.delete(conversationId)
      if (deps.store.markRead(conversationId)) publish()
    }
  }
}
