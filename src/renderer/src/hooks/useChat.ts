import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApprovalPolicy } from '@shared/types'
import type {
  AgentEvent,
  ConversationError,
  ElicitationResult,
  PlanDecision,
  PlanPayload,
  ReasoningEffort,
  ToolApprovalDecision
} from '@shared/agent'
import type { ImageAttachment } from '@shared/images'
import type { PromptInvocation } from '@shared/promptInvocation'
import type { SessionUsage } from '@shared/usage'
import { reduceEvent, systemNoteSummary, type DisplayItem, type PlanStatus } from '../lib/items'
import { meterOnEvent, startMeter, type RunMeter } from '../lib/runMeter'
import { SYSTEM_NOTE_PREFIX } from '@shared/agent'

/**
 * A plan the agent has presented and is now blocking on, shown in the docked review
 * panel. `revising` is set after the user requests changes — the panel stays up in a
 * working state until the agent sends the revised plan (a fresh `plan_ready`).
 */
export interface PendingPlan {
  callId: string
  plan: PlanPayload
  revising?: boolean
}

interface SendParams {
  conversationId: string
  userText: string
  images?: ImageAttachment[]
  invokedAs?: PromptInvocation
  providerId: string
  model: string
  approvalPolicy: ApprovalPolicy
  reasoningEffort?: ReasoningEffort
}

type RetryParams = Omit<SendParams, 'userText' | 'images' | 'invokedAs'>

/** A revertable set of file changes from the most recent turn. */
export interface Checkpoint {
  runId: string
  files: number
  /** True once reverted — the changes can now be re-applied (redone). */
  reverted: boolean
}

export interface ChatController {
  items: DisplayItem[]
  running: boolean
  /** The open conversation's persisted running token usage, or null. */
  usage: SessionUsage | null
  /** The running turn's clock and output-token count, or null when no turn runs. */
  meter: RunMeter | null
  /** The current/last turn's revertable file changes, or null. */
  checkpoint: Checkpoint | null
  /** True when the last finished run ended in an error (offer a retry). */
  errored: boolean
  /** What the last failed run reported (its message and kind), or null. */
  failure: ConversationError | null
  send: (params: SendParams) => Promise<void>
  /** Re-run the last turn after a failure, without re-sending the user message. */
  retry: (params: RetryParams) => Promise<void>
  cancel: () => void
  /** `note` is optional guidance sent to the model with the verdict. */
  approve: (callId: string, decision: ToolApprovalDecision, note?: string) => void
  /** Answer a pending `ask_user` question from the in-flight run. */
  answerQuestion: (callId: string, answer: string) => void
  answerElicitation: (elicitId: string, result: ElicitationResult) => void
  /** The plan the in-flight run is presenting for review, or null. Drives the panel. */
  pendingPlan: PendingPlan | null
  /** Resolve the pending `present_plan` review (accept / suggest changes / reject). */
  resolvePlan: (callId: string, decision: PlanDecision) => void
  /** Change the approval policy of the in-flight run, if any (live mode switch). */
  setPolicy: (policy: ApprovalPolicy) => void
  /** Push a reasoning-effort change into the live run (its next model turn). No-op when idle. */
  setEffort: (effort: ReasoningEffort) => void
  /**
   * Restore the revert/redo affordance when re-opening a conversation — the
   * checkpoint state is otherwise built only from live events and lost on a
   * transcript rebuild. Pass the conversation's latest-run checkpoint, or null.
   * Call after {@link reset}.
   */
  seedCheckpoint: (checkpoint: Checkpoint | null) => void
  /**
   * Revert the current checkpoint's file changes. Returns the count restored, or null
   * when the call failed (a notice says so in the chat it was made in).
   */
  revertCheckpoint: () => Promise<number | null>
  /** Re-apply a reverted checkpoint's file changes. Returns the count re-applied, or null on failure. */
  reapplyCheckpoint: () => Promise<number | null>
  /**
   * Replace the transcript and (optionally) seed usage and the errored flag, e.g.
   * when switching conversations — `errored` restores the persisted Retry banner.
   */
  reset: (items: DisplayItem[], usage?: SessionUsage | null, errored?: boolean, failure?: ConversationError | null) => void
  /**
   * Re-attach to a run already in flight in the main process — e.g. after
   * switching back to a conversation whose run kept going in the background.
   * Restores the running UI (Stop button) and routes subsequent events,
   * approvals, and cancel back to that run. Call after {@link reset}.
   *
   * `liveTranscript` is the in-flight turn's streamed output not yet persisted to
   * disk (assistant text still streaming, tools mid-execution); replaying it
   * restores output that would otherwise vanish on switch-back, most visibly on a
   * freshly spawned session. `pendingPrompts` are the approval/question events still
   * blocking that run; they're folded in so a prompt that was awaiting the user
   * re-renders its UI (the live events are one-shot and already fired). Both replay
   * through reduceEvent, which upserts by id/callId, so it's idempotent against the
   * transcript just rebuilt from the log. `startedAt` is when the run began (from the
   * main process's chat status), so the status bar's clock counts from the turn's
   * start rather than from the switch back.
   *
   * `since` are the run's events that arrived after `liveTranscript` was read but
   * before this call (the reopen's other reads were still in flight). They are in
   * neither, so they are handled last, as if they had just arrived.
   */
  adopt: (
    runId: string,
    pendingPrompts?: AgentEvent[],
    liveTranscript?: AgentEvent[],
    startedAt?: number,
    since?: AgentEvent[]
  ) => void
  /**
   * Start a turn in a conversation that is not (or no longer) the one in view, without
   * touching this view: its events stream to that chat, which shows the run when it is
   * reopened. Resolves false when the turn could not be started.
   */
  startDetached: (params: SendParams) => Promise<boolean>
  /** Append a transient notice to the transcript (e.g. slash-command feedback). */
  notify: (text: string, tone?: 'info' | 'error') => void
}

/**
 * Tools whose successful result means the turn changed files on disk, so it has a
 * revertable checkpoint: every file-writing tool records one in the main process.
 * Tracking only write_file and edit_file left a turn that used multi_edit,
 * apply_patch, or notebook_edit without a revert affordance until it was reopened.
 */
const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'apply_patch', 'notebook_edit'])

/** A writable subagent's edits land in the dispatching turn's checkpoint too. */
const DELEGATED_WRITE_TOOLS = new Set(['dispatch_writable_agent'])

export function useChat(conversationId: string | null = null): ChatController {
  const [items, setItems] = useState<DisplayItem[]>([])
  const [running, setRunning] = useState(false)
  const [usage, setUsage] = useState<SessionUsage | null>(null)
  const [meter, setMeter] = useState<RunMeter | null>(null)
  // The chat's cumulative output count as last seen, so a usage event (which carries
  // running totals) can tell the meter how much this round added.
  const outputSeenRef = useRef(0)
  const [checkpoint, setCheckpoint] = useState<Checkpoint | null>(null)
  const [errored, setErrored] = useState(false)
  const [failure, setFailure] = useState<ConversationError | null>(null)
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null)
  const runIdRef = useRef<string | null>(null)
  // The open conversation, so we can adopt a main-initiated follow-up run (queued
  // input) that targets it and ignore background runs on other conversations.
  const convIdRef = useRef<string | null>(conversationId)
  convIdRef.current = conversationId

  // One handler for live events and for the ones adopt replays. It reads only refs
  // and state setters, so it never goes stale.
  const onEvent = useCallback((e: AgentEvent) => {
    if (e.type === 'turn_start') {
      // The main process auto-started a follow-up turn from the queue. Adopt it
      // only when it's for the conversation we're viewing; otherwise it's a
      // background run whose result we'll see from disk on next open.
      if (e.conversationId !== convIdRef.current) return
      runIdRef.current = e.runId
      setRunning(true)
      setMeter(startMeter(Date.now()))
      setErrored(false)
      setFailure(null)
      setCheckpoint(null)
      // A turn Houston started on its own (background work finished while the
      // chat was idle) opens with its automated note: shown as a notice, the way
      // the saved log shows it, never as a message the user sent.
      if (e.userText.startsWith(SYSTEM_NOTE_PREFIX)) {
        const text = systemNoteSummary(e.userText)
        setItems((prev) => [...prev, { kind: 'notice', id: `u-${e.runId}`, text, tone: 'info' }])
        return
      }
      setItems((prev) => [
        ...prev,
        {
          kind: 'user',
          id: `u-${e.runId}`,
          text: e.userText,
          ...(e.images?.length ? { images: e.images } : {}),
          ...(e.invokedAs ? { invokedAs: e.invokedAs } : {}),
          at: new Date().toISOString()
        }
      ])
      return
    }
    if (e.runId !== runIdRef.current) return
    if (e.type === 'usage') {
      // The main process accumulates and persists; the event carries the
      // conversation's cumulative totals, so we set rather than sum.
      const delta = e.outputTokens ? e.outputTokens - outputSeenRef.current : 0
      if (e.outputTokens) outputSeenRef.current = e.outputTokens
      setMeter((m) => (m ? meterOnEvent(m, e, delta) : m))
      setUsage((prev) => ({
        context: e.inputTokens || prev?.context || 0,
        output: e.outputTokens || prev?.output || 0,
        cost: e.cost || prev?.cost || 0,
        cacheRead: e.cacheReadTokens ?? prev?.cacheRead,
        perModel: e.perModel ?? prev?.perModel,
        ...(e.context ?? prev?.contextParts ? { contextParts: e.context ?? prev?.contextParts } : {})
      }))
      // ...and the round's own numbers go on the turn, for its details line.
      setItems((prev) => reduceEvent(prev, e))
      return
    }
    // Track successful file writes so the turn's changes can be reverted.
    if (
      e.type === 'tool_result' &&
      e.ok &&
      (FILE_WRITE_TOOLS.has(e.name) || DELEGATED_WRITE_TOOLS.has(e.name))
    ) {
      const runId = e.runId
      // Count the call at once, so the affordance arrives with the result...
      if (FILE_WRITE_TOOLS.has(e.name)) {
        setCheckpoint((prev) => ({
          runId,
          files: (prev?.runId === runId ? prev.files : 0) + 1,
          reverted: false
        }))
      }
      // ...then take the main process's checkpoint, which counts distinct files (an
      // apply_patch can touch several; two edits of one file are one change) and is
      // the only place a writable subagent's edits show up. Ignored if the user has
      // since moved to another conversation or started another turn.
      const conv = convIdRef.current
      if (conv && window.api.getCheckpoint) {
        void window.api
          .getCheckpoint(conv)
          .then((cp) => {
            const sameTurn = runIdRef.current === runId || runIdRef.current === null
            if (cp && cp.runId === runId && sameTurn && convIdRef.current === conv) setCheckpoint(cp)
          })
          .catch(() => {})
      }
    }
    // A fresh plan (initial, or a revision after "suggest changes") opens/refreshes
    // the review panel; the previous one, if any, is superseded in the transcript.
    if (e.type === 'text' || e.type === 'reasoning' || e.type === 'turn_discarded') {
      setMeter((m) => (m ? meterOnEvent(m, e) : m))
    }
    if (e.type === 'plan_ready') setPendingPlan({ callId: e.callId, plan: e.plan })
    setItems((prev) => reduceEvent(prev, e))
    if (e.type === 'error') {
      setErrored(true)
      setFailure({ message: e.message, ...(e.cause ? { cause: e.cause } : {}) })
    }
    if (e.type === 'done' || e.type === 'error') {
      setRunning(false)
      setMeter(null)
      runIdRef.current = null
      // A run can only finish once its plan review is resolved (the tool unblocks
      // it), so a plan still pending here means the run ended some other way — drop
      // the now-unresolvable panel.
      setPendingPlan(null)
    }
  }, [])

  useEffect(() => window.api.onAgentEvent(onEvent), [onEvent])

  const send = useCallback(async (params: SendParams) => {
    const runId = crypto.randomUUID()
    runIdRef.current = runId
    setItems((prev) => [
      ...prev,
      {
        kind: 'user',
        id: `u-${runId}`,
        text: params.userText,
        ...(params.images?.length ? { images: params.images } : {}),
        ...(params.invokedAs ? { invokedAs: params.invokedAs } : {}),
        at: new Date().toISOString()
      }
    ])
    setRunning(true)
    setMeter(startMeter(Date.now()))
    setCheckpoint(null)
    setErrored(false)
    setFailure(null)
    try {
      const started = await window.api.startAgent({
        runId,
        conversationId: params.conversationId,
        userText: params.userText,
        images: params.images,
        ...(params.invokedAs ? { invokedAs: params.invokedAs } : {}),
        providerId: params.providerId,
        model: params.model,
        approvalPolicy: params.approvalPolicy,
        ...(params.reasoningEffort ? { reasoningEffort: params.reasoningEffort } : {})
      })
      // A run was already live (one this window hadn't caught up with yet), so main
      // queued the message behind it instead of starting a turn. Its chip is in the
      // queue bar now; drop the bubble drawn for a turn that didn't start, and follow
      // the live run so its events (and Stop) reach this view.
      if (started?.queuedBehind) {
        setItems((prev) => prev.filter((it) => it.id !== `u-${runId}`))
        // Unless this view already adopted it (its turn_start beat this reply here).
        if (runIdRef.current === runId) runIdRef.current = started.queuedBehind
      }
    } catch {
      // The IPC call itself failed (bridge/serialization) before any run started —
      // otherwise the Stop button would stay lit forever with no run behind it.
      // A run that starts and then fails reports back via an `error` event instead.
      if (runIdRef.current === runId) {
        setRunning(false)
        setMeter(null)
        runIdRef.current = null
        setErrored(true)
      }
    }
  }, [])

  const retry = useCallback(async (params: RetryParams) => {
    const runId = crypto.randomUUID()
    runIdRef.current = runId
    setRunning(true)
    setMeter(startMeter(Date.now()))
    setErrored(false)
    setFailure(null)
    try {
      await window.api.retryAgent({ runId, ...params })
    } catch {
      if (runIdRef.current === runId) {
        setRunning(false)
        setMeter(null)
        runIdRef.current = null
        setErrored(true)
      }
    }
  }, [])

  const cancel = useCallback(() => {
    if (runIdRef.current) void window.api.cancelAgent(runIdRef.current)
  }, [])

  const approve = useCallback((callId: string, decision: ToolApprovalDecision, note?: string) => {
    if (runIdRef.current) void window.api.approveTool(runIdRef.current, callId, decision, note)
  }, [])

  const answerQuestion = useCallback((callId: string, answer: string) => {
    if (runIdRef.current) void window.api.answerQuestion(runIdRef.current, callId, answer)
  }, [])

  const answerElicitation = useCallback((elicitId: string, result: ElicitationResult) => {
    if (!runIdRef.current) return
    void window.api.answerElicitation(runIdRef.current, elicitId, result)
    // Optimistic UI: collapse the form to its outcome immediately (there is no
    // dedicated result event — the in-flight MCP tool call simply continues).
    const outcome = result.action === 'accept' ? ('accepted' as const) : ('declined' as const)
    setItems((prev) =>
      prev.map((it) => (it.kind === 'elicitation' && it.id === elicitId ? { ...it, outcome } : it))
    )
  }, [])

  const resolvePlan = useCallback((callId: string, decision: PlanDecision) => {
    if (!runIdRef.current) return
    void window.api.resolvePlan(runIdRef.current, callId, decision)
    // Optimistic UI: reflect the decision on the transcript marker immediately, and
    // either close the panel (accept/reject) or hold it in a "revising" state until
    // the agent sends the revised plan (suggest).
    const status: PlanStatus =
      decision.kind === 'accept' ? 'accepted' : decision.kind === 'reject' ? 'rejected' : 'superseded'
    const editedBody = decision.kind === 'accept' ? decision.editedBody : undefined
    setItems((prev) =>
      prev.map((it) => {
        if (it.kind !== 'plan' || it.id !== callId) return it
        // Record a hand-edited plan on the marker so reopening it shows what was approved.
        return editedBody ? { ...it, status, plan: { ...it.plan, body: editedBody } } : { ...it, status }
      })
    )
    setPendingPlan((prev) => {
      if (!prev || prev.callId !== callId) return prev
      return decision.kind === 'suggest' ? { ...prev, revising: true } : null
    })
  }, [])

  const setPolicy = useCallback((policy: ApprovalPolicy) => {
    if (runIdRef.current) void window.api.setAgentPolicy(runIdRef.current, policy)
  }, [])

  const setEffort = useCallback((effort: ReasoningEffort) => {
    if (runIdRef.current) void window.api.setAgentEffort(runIdRef.current, effort)
  }, [])

  const notify = useCallback((text: string, tone: 'info' | 'error' = 'info') => {
    setItems((prev) => [...prev, { kind: 'notice', id: crypto.randomUUID(), text, tone }])
  }, [])

  // Revert / Redo the turn's changes. The bar flips only if the user is still on the
  // chat it was clicked in: the reply can arrive after they've opened another chat,
  // whose own checkpoint must not be overwritten. A failed call says so there.
  const applyCheckpoint = useCallback(
    async (action: 'revert' | 'redo'): Promise<number | null> => {
      if (!checkpoint) return 0
      const conv = convIdRef.current
      const cp = checkpoint
      try {
        const n =
          action === 'revert'
            ? await window.api.restoreCheckpoint(cp.runId)
            : await window.api.reapplyCheckpoint(cp.runId)
        // Keep the checkpoint (now reverted) so the change can be redone, and back.
        if (convIdRef.current === conv) setCheckpoint({ ...cp, reverted: action === 'revert' })
        return n
      } catch (e) {
        if (convIdRef.current === conv) {
          notify(`Couldn't ${action} this turn's changes: ${(e as Error)?.message ?? 'unknown error'}`, 'error')
        }
        return null
      }
    },
    [checkpoint, notify]
  )
  const revertCheckpoint = useCallback(() => applyCheckpoint('revert'), [applyCheckpoint])
  const reapplyCheckpoint = useCallback(() => applyCheckpoint('redo'), [applyCheckpoint])

  const startDetached = useCallback(async (params: SendParams): Promise<boolean> => {
    try {
      await window.api.startAgent({
        runId: crypto.randomUUID(),
        conversationId: params.conversationId,
        userText: params.userText,
        images: params.images,
        ...(params.invokedAs ? { invokedAs: params.invokedAs } : {}),
        providerId: params.providerId,
        model: params.model,
        approvalPolicy: params.approvalPolicy,
        ...(params.reasoningEffort ? { reasoningEffort: params.reasoningEffort } : {})
      })
      return true
    } catch {
      return false
    }
  }, [])

  const reset = useCallback(
    (
      next: DisplayItem[],
      nextUsage: SessionUsage | null = null,
      nextErrored = false,
      nextFailure: ConversationError | null = null
    ) => {
      setItems(next)
      setRunning(false)
      setMeter(null)
      setUsage(nextUsage)
      outputSeenRef.current = nextUsage?.output ?? 0
      setCheckpoint(null)
      setPendingPlan(null)
      // Seed from the conversation's persisted failure so a reload restores the
      // "last turn failed" banner; a live run we adopt afterwards clears it.
      setErrored(nextErrored)
      setFailure(nextErrored ? nextFailure : null)
      runIdRef.current = null
    },
    []
  )

  const adopt = useCallback(
    (
      runId: string,
      pendingPrompts: AgentEvent[] = [],
      liveTranscript: AgentEvent[] = [],
      startedAt?: number,
      since: AgentEvent[] = []
    ) => {
      runIdRef.current = runId
      setRunning(true)
      // The clock counts from the run's start. The token count can't recover rounds that
      // finished while this chat wasn't open (only the chat's total was saved), so it
      // starts from the open round's streamed text and grows from there.
      setMeter(liveTranscript.reduce((m, ev) => meterOnEvent(m, ev), startMeter(startedAt ?? Date.now())))
      setErrored(false)
      setFailure(null)
      // Replay, in order, the in-flight turn's streamed-but-unpersisted output
      // (liveTranscript) then the prompts still blocking the run (pendingPrompts, a
      // subset re-applied so it also drives the plan panel below). reduceEvent upserts
      // by id/callId, so replaying onto a transcript rebuilt from the log updates the
      // matching rows and rebuilds the streamed assistant text rather than duplicating.
      const replay = [...liveTranscript, ...pendingPrompts]
      if (replay.length > 0) {
        setItems((prev) => replay.reduce((acc, ev) => reduceEvent(acc, ev), prev))
      }
      // Re-open the review panel for a plan that was still awaiting a decision.
      const plan = [...pendingPrompts].reverse().find((ev) => ev.type === 'plan_ready')
      if (plan?.type === 'plan_ready') setPendingPlan({ callId: plan.callId, plan: plan.plan })
      // Then what arrived while the reopen was still reading: through the live handler,
      // so a run that finished in that gap ends here too.
      for (const ev of since) onEvent(ev)
    },
    [onEvent]
  )

  const seedCheckpoint = useCallback((next: Checkpoint | null) => {
    setCheckpoint(next)
  }, [])

  return {
    items,
    running,
    usage,
    meter,
    checkpoint,
    errored,
    failure,
    send,
    retry,
    cancel,
    approve,
    answerQuestion,
    answerElicitation,
    pendingPlan,
    resolvePlan,
    setPolicy,
    setEffort,
    seedCheckpoint,
    revertCheckpoint,
    reapplyCheckpoint,
    reset,
    adopt,
    startDetached,
    notify
  }
}
