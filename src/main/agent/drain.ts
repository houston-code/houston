import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentRunRequest, ChatMessage } from '@shared/agent'
import { combineQueued, type QueuedInputMeta } from '@shared/queue'
import { startRun } from './loop'
import { maybeGenerateTitle } from './title'
import { maybeSuggestNext } from './suggest'
import { listQueue, removeFromQueue, settleSteers, takeQueue } from './queue'
import { getConversation, setMessages, takeChildReports } from '../conversations'
import { getSettings } from '../agentHost'
import { activeRunForConversation } from './loop'
import { clearChildReportFlag, takeBackgroundEvents, wakeNote } from './backgroundEvents'

/** How the run orchestrator talks back to the renderer (provided by the IPC layer). */
export interface DrainIO {
  /** Stream one agent event to the renderer (persisting usage totals along the way). */
  emit: (conversationId: string, e: AgentEvent) => void
  /** Push a conversation's updated queue to the renderer (after an auto-flush). */
  emitQueueChanged: (conversationId: string, items: QueuedInputMeta[]) => void
  /** Push a conversation's freshly model-generated title to the renderer (live sidebar update). */
  emitTitleChanged?: (conversationId: string, title: string) => void
  /** Push a suggested next message for a conversation whose turn ended (when turned on). */
  emitSuggestion?: (conversationId: string, text: string) => void
  /**
   * The client draws image results as a gallery (the desktop app), so its runs,
   * queued follow-ups included, are offered show_images and render_mockup.
   */
  imageGallery?: boolean
  /** The client shows a running shell command's output as it arrives (the desktop app). */
  liveShellOutput?: boolean
}

/**
 * Run a turn and, when it finishes *naturally* (not aborted, not errored), flush
 * any messages queued during it as the next combined turn. The queue is held on
 * cancel/error so the user can retry or dispatch it deliberately. Fire-and-forget:
 * progress is streamed through `io`, so callers don't await this.
 */
export async function runAndDrain(
  io: DrainIO,
  conversationId: string,
  runReq: AgentRunRequest,
  /**
   * The WebContents id of the renderer that started this run, threaded down to the
   * loop so IPC run-control calls can be authorized against the owning window. It
   * carries through to the queue drain below so a queued follow-up turn stays owned
   * by the same window. Omitted for non-GUI callers (tests, headless).
   */
  owner?: number
): Promise<void> {
  let terminal: 'natural' | 'aborted' | 'error' = 'natural'
  const send = (e: AgentEvent): void => {
    if (e.type === 'error') terminal = 'error'
    else if (e.type === 'done') terminal = e.stopReason === 'aborted' ? 'aborted' : 'natural'
    io.emit(conversationId, e)
    // A steer has landed: the run is about to persist it into the log, so its queue
    // entry has done its job. Dropped on a microtask, after that persist: if the app
    // dies between the two writes, the message shows twice rather than not at all.
    if (e.type === 'steered' && e.id) {
      const id = e.id
      queueMicrotask(() => io.emitQueueChanged(conversationId, removeFromQueue(conversationId, id)))
    }
  }
  // The stored "last turn failed" marker (the Retry banner's record) is cleared and
  // set by the run itself (startRun), so every client's runs keep it, not only these.
  // Title the chat in parallel with its first turn rather than after it: the user
  // message is already persisted, which is all a title needs, and a long agentic turn
  // would otherwise leave the truncated placeholder up for minutes. Fire-and-forget,
  // and a no-op once the chat is titled (every later turn).
  const requestTitle = (): void =>
    void maybeGenerateTitle({
      conversationId,
      providerId: runReq.providerId,
      model: runReq.model,
      onTitle: (t) => io.emitTitleChanged?.(conversationId, t)
    })
  requestTitle()
  // Tag the run with its conversation so the loop enforces one live run per
  // conversation (a second would interleave its setMessages writes and corrupt
  // the log). The slot is freed when this run ends, before any queue drain below.
  await startRun(
    {
      ...runReq,
      conversationId,
      ...(io.imageGallery ? { imageGallery: true } : {}),
      ...(io.liveShellOutput ? { liveShellOutput: true } : {})
    },
    send,
    (msgs) => setMessages(conversationId, msgs),
    owner
  )
  // Steers the run never read are still in the queue (it is their durable copy);
  // with the run gone they are plain follow-ups: sent next on a natural finish, held
  // for the user on Stop or an error, like anything else queued. The loop's own
  // `steers_returned` event is for clients without that copy (the terminal UI).
  const settled = settleSteers(conversationId)
  if (settled) io.emitQueueChanged(conversationId, settled)
  if (terminal === 'natural') {
    // Fallback: if the turn-start attempt missed (timeout, blip), try once more now
    // that the reply is available as extra context. No-op if already titled or the
    // first attempt is still in flight. Must not delay the queue drain.
    requestTitle()
    // Nothing queued to send next: offer a suggested next message, if the user turned
    // that on (maybeSuggestNext checks the setting). A queued follow-up is the user's
    // own next message, so there is nothing to suggest then.
    if (io.emitSuggestion && listQueue(conversationId).length === 0) {
      const emit = io.emitSuggestion
      void maybeSuggestNext({
        conversationId,
        providerId: runReq.providerId,
        model: runReq.model,
        onSuggestion: (text) => emit(conversationId, text)
      })
    }
    drainQueue(io, conversationId, owner)
  }
}

/** Dispatch a conversation's queued messages as one combined follow-up turn. */
export function drainQueue(io: DrainIO, conversationId: string, owner?: number): void {
  const taken = takeQueue(conversationId)
  if (!taken) return
  const { text, images, invokedAs } = combineQueued(taken.items)
  if (!text && !images) return
  const conv = getConversation(conversationId)
  if (!conv) return

  const runId = randomUUID()
  const userMessage: ChatMessage = {
    role: 'user',
    content: text,
    ...(images?.length ? { images } : {}),
    ...(invokedAs ? { invokedAs } : {}),
    at: new Date().toISOString()
  }
  const messages = [...conv.messages, userMessage]
  setMessages(conv.id, messages, {
    providerId: taken.providerId,
    model: taken.model,
    approvalPolicy: taken.approvalPolicy,
    ...(taken.reasoningEffort !== undefined ? { reasoningEffort: taken.reasoningEffort } : {})
  })

  // Tell a renderer viewing this conversation to render the user bubble and adopt
  // the run; the queue is now empty, so refresh its bar too.
  io.emit(conversationId, {
    runId,
    type: 'turn_start',
    conversationId,
    userText: text,
    ...(images?.length ? { images } : {}),
    ...(invokedAs ? { invokedAs } : {})
  })
  io.emitQueueChanged(conversationId, [])

  void runAndDrain(
    io,
    conversationId,
    {
      runId,
      workspace: conv.workspace,
      providerId: taken.providerId,
      model: taken.model,
      approvalPolicy: taken.approvalPolicy,
      ...(taken.reasoningEffort !== undefined ? { reasoningEffort: taken.reasoningEffort } : {}),
      messages
    },
    owner
  )
}

/**
 * Start a turn on an idle chat because background work it started finished (see
 * backgroundEvents.ts, whose wake policy decides when this is called). The turn's only
 * input is an automated note carrying the news; the chat runs under its own model and
 * approval policy, so anything needing an approval still asks. Returns whether a turn
 * started: not when the chat is running, gone, or the news was already taken.
 */
export function startWakeTurn(io: DrainIO, conversationId: string): boolean {
  if (activeRunForConversation(conversationId)) return false
  const conv = getConversation(conversationId)
  if (!conv) return false
  clearChildReportFlag(conversationId)
  const note = wakeNote(takeBackgroundEvents(conversationId), takeChildReports(conversationId))
  if (!note) return false
  const defaults = getSettings()
  const approvalPolicy = conv.approvalPolicy ?? defaults.approvalPolicy ?? 'ask'
  const reasoningEffort = conv.reasoningEffort ?? defaults.reasoningEffort
  const runId = randomUUID()
  const messages = [...conv.messages, note]
  setMessages(conv.id, messages)
  io.emit(conversationId, { runId, type: 'turn_start', conversationId, userText: note.content })
  void runAndDrain(io, conversationId, {
    runId,
    workspace: conv.workspace,
    providerId: conv.providerId,
    model: conv.model,
    approvalPolicy,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    messages,
    wake: true
  })
  return true
}
