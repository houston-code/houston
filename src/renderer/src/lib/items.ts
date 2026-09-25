import {
  COMPACTION_SUMMARY_PREFIX,
  SYSTEM_NOTE_PREFIX,
  type AgentEvent,
  type ChatMessage,
  type ElicitationField,
  type PlanPayload,
  type QuestionOption,
  type ReviewFinding
} from '@shared/agent'
import { ASK_USER_TOOL, PRESENT_PLAN_TOOL } from '@shared/constants'
import type { FileDiffPreview } from '@shared/diff'
import type { ImageAttachment } from '@shared/images'
import { prNoticeFromToolResult, prNoticeText } from '@shared/prNotice'
import { upsertFinding } from '@shared/reviewFindings'

/** Display model for the transcript, built from streamed AgentEvents or saved messages. */

export type ToolStatus = 'awaiting-approval' | 'running' | 'done' | 'error' | 'denied'

export interface UserItem {
  kind: 'user'
  id: string
  text: string
  images?: ImageAttachment[]
  /**
   * True for the synthetic summary turn written by context compaction. Its body is
   * model-authored markdown, so the transcript renders it through `Markdown` rather
   * than as plain user text.
   */
  isSummary?: boolean
}
export interface AssistantItem {
  kind: 'assistant'
  id: string
  text: string
  streaming: boolean
  /** Model reasoning ("thinking") streamed before the answer, if any. */
  reasoning?: string
}
/** A nested subagent spawned by a tool (e.g. a review_changes dimension reviewer), shown as its own row. */
export interface SubAgentRow {
  /** Stable id within the parent tool (e.g. the review dimension, or 'verify'). */
  id: string
  label: string
  status: 'running' | 'done' | 'error'
}
export interface ToolItem {
  kind: 'tool'
  id: string // callId
  name: string
  summary?: string
  args?: Record<string, unknown>
  toolKind?: 'read' | 'write' | 'shell' | 'network' | 'mcp'
  /**
   * Per-file diffs for a write, computed by the main process against the files'
   * pre-write contents. The row cannot work these out from `args`: it has no
   * filesystem, so it cannot know what a file held before, and by the time the row
   * is rendered the write has usually already landed.
   */
  preview?: FileDiffPreview[]
  status: ToolStatus
  /**
   * True on the one-time full-auto shell-network consent prompt: the approval decides
   * whether the run's shell commands may reach the network (declining runs them
   * offline), not whether this command runs. Lets the approval card frame it as such.
   */
  shellNetwork?: boolean
  /**
   * True on a credential/secret-file read prompt (see isSensitivePath): a read that,
   * unusually, is asking — even in full-auto — so the card can explain why.
   */
  sensitiveRead?: boolean
  output?: string
  /** Latest progress line from a long-running tool (e.g. a review's current phase). */
  progress?: string
  /** Live child rows for nested subagents this tool spawned (e.g. review dimension reviewers). */
  subagents?: SubAgentRow[]
  /** Live review findings (review_changes), upserted by id as verification settles them. */
  findings?: ReviewFinding[]
  /** Images the tool produced (e.g. a view_localhost screenshot). */
  images?: ImageAttachment[]
}
export interface NoticeItem {
  kind: 'notice'
  id: string
  text: string
  /** `handoff` marks the "spawned from …" banner atop a spawned chat's transcript. */
  tone: 'error' | 'info' | 'handoff'
}
export interface QuestionItem {
  kind: 'question'
  id: string // callId
  question: string
  options: QuestionOption[]
  multiSelect?: boolean
  /** The user's answer once given; undefined while the question is still open. */
  answer?: string
}

/**
 * An MCP server's mid-call request for user input (MCP elicitation), shown as a
 * small form card under the in-flight tool row. `outcome` is set when resolved
 * (optimistically by the submit handler; any card still open when the run ends
 * is marked cancelled — cancelRun answered the server with a cancel).
 */
export interface ElicitationItem {
  kind: 'elicitation'
  id: string // elicitId
  serverId: string
  message: string
  fields: ElicitationField[]
  outcome?: 'accepted' | 'declined' | 'cancelled'
}

/**
 * A plan presented via `present_plan`, shown as a compact "Plan ready" marker in the
 * transcript and (while `pending`) mirrored in the docked review panel. `pending` is
 * awaiting the user's decision; the others are its outcome.
 */
export type PlanStatus = 'pending' | 'accepted' | 'rejected' | 'superseded'
export interface PlanItem {
  kind: 'plan'
  id: string // callId
  plan: PlanPayload
  status: PlanStatus
}

export type DisplayItem =
  | UserItem
  | AssistantItem
  | ToolItem
  | NoticeItem
  | QuestionItem
  | PlanItem
  | ElicitationItem

/**
 * The text of the most recent real user turn, or undefined if there is none.
 * Skips the synthetic compaction-summary turn (it's model-authored, not something
 * the user typed) — used to recall the last message into the composer (Esc Esc).
 */
export function lastUserText(items: DisplayItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'user' && !it.isSummary) return it.text
  }
  return undefined
}

/** Parse a tool call's `options` argument into display options (string[] or {label,…}[]). */
function optionsFromArgs(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) return []
  const out: QuestionOption[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ label: item.trim() })
    } else if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>
      const label = typeof rec.label === 'string' ? rec.label.trim() : ''
      if (!label) continue
      const description = typeof rec.description === 'string' ? rec.description.trim() : ''
      out.push(description ? { label, description } : { label })
    }
  }
  return out
}

/** Build a PlanPayload from a present_plan tool call's arguments (renderer-side). */
function planFromArgs(args: Record<string, unknown>): PlanPayload {
  const strList = (raw: unknown): string[] =>
    Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : []
  const title = typeof args.title === 'string' ? args.title : ''
  const body = typeof args.plan === 'string' && args.plan.trim() ? args.plan : undefined
  // Legacy structured fields, still rendered when an older call has no `plan` body.
  const overview = typeof args.overview === 'string' && args.overview.trim() ? args.overview : undefined
  const steps = strList(args.steps)
  const files = strList(args.files)
  return {
    title,
    ...(body ? { body } : {}),
    ...(overview ? { overview } : {}),
    ...(steps.length ? { steps } : {}),
    ...(files.length ? { files } : {})
  }
}

/** Derive a plan's outcome from the `present_plan` tool-result text. */
function planStatusFromResult(output: string | undefined): PlanStatus {
  if (output?.startsWith('The user ACCEPTED')) return 'accepted'
  if (output?.startsWith('The user REJECTED')) return 'rejected'
  // No result, or a "wants changes" result — the plan is no longer actionable here.
  return 'superseded'
}

let counter = 0
const nextId = (): string => `i${Date.now().toString(36)}-${counter++}`

function finalizeStreaming(items: DisplayItem[]): DisplayItem[] {
  const last = items[items.length - 1]
  if (last && last.kind === 'assistant' && last.streaming) {
    return [...items.slice(0, -1), { ...last, streaming: false }]
  }
  return items
}

function updateTool(items: DisplayItem[], callId: string, patch: Partial<ToolItem>): DisplayItem[] {
  return items.map((it) => (it.kind === 'tool' && it.id === callId ? { ...it, ...patch } : it))
}

/** Fold one streamed agent event into the display list. */
export function reduceEvent(items: DisplayItem[], e: AgentEvent): DisplayItem[] {
  switch (e.type) {
    case 'text': {
      const last = items[items.length - 1]
      if (last && last.kind === 'assistant' && last.streaming) {
        return [...items.slice(0, -1), { ...last, text: last.text + e.delta }]
      }
      return [...items, { kind: 'assistant', id: nextId(), text: e.delta, streaming: true }]
    }
    // A course correction typed mid-turn. It goes into the model's window as an
    // ordinary user turn, so it renders as one — the transcript should read the way
    // the model read it. Any streaming assistant bubble is closed first, so the
    // steer lands between what came before it and what it changed.
    case 'steered':
      return [
        ...items.map((i) => (i.kind === 'assistant' && i.streaming ? { ...i, streaming: false } : i)),
        { kind: 'user', id: nextId(), text: e.text }
      ]
    case 'reasoning': {
      const last = items[items.length - 1]
      if (last && last.kind === 'assistant' && last.streaming) {
        return [...items.slice(0, -1), { ...last, reasoning: (last.reasoning ?? '') + e.delta }]
      }
      return [...items, { kind: 'assistant', id: nextId(), text: '', streaming: true, reasoning: e.delta }]
    }
    case 'tool_approval': {
      const finalized = finalizeStreaming(items)
      // Upsert: when a row for this call already exists (e.g. rebuilt from the
      // persisted log, then this prompt is replayed on re-adopt), flip it to
      // awaiting-approval in place rather than appending a duplicate id.
      if (finalized.some((it) => it.kind === 'tool' && it.id === e.callId)) {
        return updateTool(finalized, e.callId, {
          name: e.name,
          summary: e.summary,
          // Carry args so the approval card shows the real command/target (describeTool
          // derives it from args); without this it renders the verb with a blank target.
          // Guarded so a payload without args never wipes args already on the row.
          ...(e.args ? { args: e.args } : {}),
          // Same guard as args: a payload without a preview must not wipe one already
          // on the row.
          ...(e.preview ? { preview: e.preview } : {}),
          toolKind: e.kind,
          shellNetwork: e.shellNetwork === true,
          sensitiveRead: e.sensitiveRead === true,
          status: 'awaiting-approval'
        })
      }
      return [
        ...finalized,
        {
          kind: 'tool',
          id: e.callId,
          name: e.name,
          summary: e.summary,
          args: e.args,
          ...(e.preview ? { preview: e.preview } : {}),
          toolKind: e.kind,
          ...(e.shellNetwork ? { shellNetwork: true } : {}),
          ...(e.sensitiveRead ? { sensitiveRead: true } : {}),
          status: 'awaiting-approval'
        }
      ]
    }
    case 'tool_start': {
      const finalized = finalizeStreaming(items)
      // ask_user / present_plan surface as their own cards (a question card, a plan
      // marker + docked panel), not as a generic tool row.
      if (e.name === ASK_USER_TOOL || e.name === PRESENT_PLAN_TOOL) return finalized
      const exists = finalized.some((it) => it.kind === 'tool' && it.id === e.callId)
      if (exists)
        return updateTool(finalized, e.callId, {
          status: 'running',
          args: e.args,
          ...(e.preview ? { preview: e.preview } : {})
        })
      return [
        ...finalized,
        {
          kind: 'tool',
          id: e.callId,
          name: e.name,
          args: e.args,
          // `kind` is present on live tool_start events (absent on older logs); tagging
          // the row here means auto-approved tools get a toolKind too, not just the ones
          // that hit an approval prompt (which set it via tool_approval above).
          ...(e.kind ? { toolKind: e.kind } : {}),
          // Likewise the diff: an auto-approved write never showed an approval card, so
          // tool_start is the only place its preview arrives.
          ...(e.preview ? { preview: e.preview } : {}),
          status: 'running'
        }
      ]
    }
    case 'tool_progress': {
      // Update the live progress line on the running tool (no-op if it's gone).
      return updateTool(items, e.callId, { progress: e.message })
    }
    case 'subagent': {
      // Add or update a nested subagent row under its parent tool (no-op if gone).
      return items.map((it) => {
        if (it.kind !== 'tool' || it.id !== e.parentCallId) return it
        const row: SubAgentRow = { id: e.id, label: e.label, status: e.status }
        const existing = it.subagents ?? []
        const idx = existing.findIndex((s) => s.id === e.id)
        const subagents = idx >= 0 ? existing.map((s, i) => (i === idx ? row : s)) : [...existing, row]
        return { ...it, subagents }
      })
    }
    case 'review_finding': {
      // Add or update a finding under its review row (no-op if the row is gone).
      return items.map((it) =>
        it.kind === 'tool' && it.id === e.parentCallId
          ? { ...it, findings: upsertFinding(it.findings ?? [], e.finding) }
          : it
      )
    }
    case 'tool_question': {
      const finalized = finalizeStreaming(items)
      // Upsert (see tool_approval): a question card rebuilt from the log and then
      // replayed on re-adopt must update in place, not duplicate its id.
      if (finalized.some((it) => it.kind === 'question' && it.id === e.callId)) {
        return finalized.map((it) =>
          it.kind === 'question' && it.id === e.callId
            ? { ...it, question: e.question, options: e.options, multiSelect: e.multiSelect === true }
            : it
        )
      }
      return [
        ...finalized,
        {
          kind: 'question',
          id: e.callId,
          question: e.question,
          options: e.options,
          ...(e.multiSelect ? { multiSelect: true } : {})
        }
      ]
    }
    case 'elicitation': {
      const finalized = finalizeStreaming(items)
      // Upsert (see tool_question): a replay on re-adopt updates in place.
      if (finalized.some((it) => it.kind === 'elicitation' && it.id === e.elicitId)) {
        return finalized.map((it) =>
          it.kind === 'elicitation' && it.id === e.elicitId
            ? { ...it, serverId: e.serverId, message: e.message, fields: e.fields }
            : it
        )
      }
      return [
        ...finalized,
        {
          kind: 'elicitation',
          id: e.elicitId,
          serverId: e.serverId,
          message: e.message,
          fields: e.fields
        }
      ]
    }
    case 'plan_ready': {
      const finalized = finalizeStreaming(items)
      // Any still-pending plan is superseded by this one (e.g. a revision after the
      // user requested changes). Upsert by callId so a replay on re-adopt updates in
      // place rather than duplicating.
      const superseded = finalized.map((it) =>
        it.kind === 'plan' && it.status === 'pending' && it.id !== e.callId
          ? { ...it, status: 'superseded' as const }
          : it
      )
      if (superseded.some((it) => it.kind === 'plan' && it.id === e.callId)) {
        return superseded.map((it) =>
          it.kind === 'plan' && it.id === e.callId
            ? { ...it, plan: e.plan, status: 'pending' as const }
            : it
        )
      }
      return [...superseded, { kind: 'plan', id: e.callId, plan: e.plan, status: 'pending' }]
    }
    case 'tool_result': {
      // An ask_user result carries the answer — fold it into the question card.
      if (e.name === ASK_USER_TOOL) {
        return items.map((it) =>
          it.kind === 'question' && it.id === e.callId ? { ...it, answer: e.output } : it
        )
      }
      // A present_plan result records the user's decision — fold it into the plan
      // marker's status (a backstop; the click handler updates it optimistically).
      if (e.name === PRESENT_PLAN_TOOL) {
        const status = planStatusFromResult(e.output)
        return items.map((it) => (it.kind === 'plan' && it.id === e.callId ? { ...it, status } : it))
      }
      const status: ToolStatus = e.ok
        ? 'done'
        : e.output.startsWith('Denied') || e.output.startsWith('Blocked')
          ? 'denied'
          : 'error'
      const patched = updateTool(items, e.callId, {
        status,
        output: e.output,
        progress: undefined, // clear the live progress line now the tool has finished
        ...(e.images?.length ? { images: e.images } : {})
      })
      // The tool finished, so any nested subagent row still spinning is now resolved,
      // and a finding still mid-verification (an aborted or failed review) never got
      // a verdict: show it as unverified rather than spinning forever.
      const updated = patched.map((it) => {
        if (it.kind !== 'tool' || it.id !== e.callId) return it
        let next = it
        if (it.subagents?.some((s) => s.status === 'running')) {
          next = {
            ...next,
            subagents: it.subagents.map((s) => (s.status === 'running' ? { ...s, status: 'done' as const } : s))
          }
        }
        if (it.findings?.some((f) => f.status === 'verifying')) {
          next = {
            ...next,
            findings: it.findings.map((f) =>
              f.status === 'verifying' ? { ...f, status: 'candidate' as const, votes: undefined } : f
            )
          }
        }
        return next
      })
      // Highlight a PR opening/merging as its own notice, above the tool row.
      const pr = prNoticeFromToolResult(e.name, e.ok, e.output)
      if (pr) {
        return [...updated, { kind: 'notice', id: nextId(), text: prNoticeText(pr), tone: 'info' }]
      }
      return updated
    }
    case 'compaction': {
      const finalized = finalizeStreaming(items)
      return [
        ...finalized,
        {
          kind: 'notice',
          id: nextId(),
          text: `🗜 Compacted ${e.summarized} earlier message${e.summarized === 1 ? '' : 's'} to stay within the context window.`,
          tone: 'info'
        }
      ]
    }
    case 'retry': {
      const finalized = finalizeStreaming(items)
      return [
        ...finalized,
        {
          kind: 'notice',
          id: nextId(),
          text: `⟳ Connection issue, retrying (${e.attempt}/${e.max})… — ${e.message}`,
          tone: 'info'
        }
      ]
    }
    case 'model_fallback': {
      const finalized = finalizeStreaming(items)
      return [
        ...finalized,
        {
          kind: 'notice',
          id: nextId(),
          text: `⇄ ${e.from} was unavailable, so this reply came from ${e.to}. ${e.reason}`,
          tone: 'info'
        }
      ]
    }
    case 'limit': {
      const finalized = finalizeStreaming(items)
      const text =
        e.reason === 'max-steps'
          ? '⚠ Reached the step limit for one turn and stopped — send a message to have me continue.'
          : e.reason === 'stalled'
            ? '⚠ Stopped: I appeared to be repeating myself without making progress. Send a message with more direction to continue.'
            : '⚠ The reply was cut off at the model’s output limit — ask me to continue it.'
      return [...finalized, { kind: 'notice', id: nextId(), text, tone: 'error' }]
    }
    case 'verification': {
      const finalized = finalizeStreaming(items)
      const text = e.passed
        ? '✓ Verification passed.'
        : '⚠ Verification failed — attempting to self-correct.'
      return [
        ...finalized,
        { kind: 'notice', id: nextId(), text, tone: e.passed ? 'info' : 'error' }
      ]
    }
    case 'notice': {
      // A user-addressed note from outside the conversation (a hook's systemMessage
      // directive) — transcript-only; it was never part of the model's context.
      const finalized = finalizeStreaming(items)
      return [...finalized, { kind: 'notice', id: nextId(), text: e.message, tone: 'info' }]
    }
    case 'done': {
      // Any elicitation card still open when the run ends was answered for the
      // server by cancelRun (a cancel) — reflect that so the form can't be
      // submitted into a run that no longer exists.
      const finalized = finalizeStreaming(items).map((it) =>
        it.kind === 'elicitation' && !it.outcome ? { ...it, outcome: 'cancelled' as const } : it
      )
      if (e.stopReason === 'aborted') {
        return [...finalized, { kind: 'notice', id: nextId(), text: 'Stopped.', tone: 'info' }]
      }
      return finalized
    }
    case 'error': {
      const finalized = finalizeStreaming(items)
      return [...finalized, { kind: 'notice', id: nextId(), text: e.message, tone: 'error' }]
    }
    case 'usage':
    case 'turn_start':
      // Not transcript items: usage totals are folded into the store/control bar,
      // and turn_start is adopted by App. No display change here.
      return items
    default: {
      // Exhaustiveness guard: a new AgentEvent variant fails to compile here until
      // this reducer handles it (the mechanism that keeps the TUI, GUI, and headless
      // event consumers from drifting). Non-throwing so an unforeseen event can never
      // crash the transcript render — it's just ignored, as before.
      const _exhaustive: never = e
      void _exhaustive
      return items
    }
  }
}

/** Build display items from a saved conversation's message log. */
export function itemsFromMessages(messages: ChatMessage[]): DisplayItem[] {
  const resultByCallId = new Map<string, { output: string; images?: ImageAttachment[] }>()
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) {
      resultByCallId.set(m.toolCallId, { output: m.content, images: m.images })
    }
  }

  const items: DisplayItem[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      // An automated guidance turn the loop injected (a stall nudge, the budget
      // landing reminder) rides on a user message but isn't from the user — show it
      // as a system notice, not a user bubble, and keep it out of `lastUserText`.
      if (m.content.startsWith(SYSTEM_NOTE_PREFIX)) {
        const text = m.content.slice(SYSTEM_NOTE_PREFIX.length).trim()
        if (text) items.push({ kind: 'notice', id: nextId(), text, tone: 'info' })
      } else if (m.content.trim() || m.images?.length) {
        items.push({
          kind: 'user',
          id: nextId(),
          text: m.content,
          ...(m.images?.length ? { images: m.images } : {}),
          ...(m.content.startsWith(COMPACTION_SUMMARY_PREFIX) ? { isSummary: true } : {})
        })
      }
    } else if (m.role === 'assistant') {
      const reasoning = m.reasoning?.map((r) => r.text).filter(Boolean).join('\n') || undefined
      if (m.content.trim() || reasoning) {
        items.push({ kind: 'assistant', id: nextId(), text: m.content, streaming: false, reasoning })
      }
      for (const tc of m.toolCalls ?? []) {
        const res = resultByCallId.get(tc.id)
        // ask_user is shown as a (now-answered) question card, not a tool row.
        if (tc.name === ASK_USER_TOOL) {
          items.push({
            kind: 'question',
            id: tc.id,
            question: typeof tc.arguments.question === 'string' ? tc.arguments.question : '',
            options: optionsFromArgs(tc.arguments.options),
            ...(tc.arguments.multiSelect === true ? { multiSelect: true } : {}),
            ...(res?.output ? { answer: res.output } : {})
          })
          continue
        }
        // present_plan is shown as a plan marker (its outcome read from the result),
        // not a tool row. A run reloaded mid-review has no result → not actionable.
        if (tc.name === PRESENT_PLAN_TOOL) {
          items.push({
            kind: 'plan',
            id: tc.id,
            plan: planFromArgs(tc.arguments),
            status: planStatusFromResult(res?.output)
          })
          continue
        }
        const output = res?.output
        const status: ToolStatus = !output
          ? 'done'
          : output.startsWith('Denied') || output.startsWith('Blocked')
            ? 'denied'
            : output.startsWith('Error:')
              ? 'error'
              : 'done'
        items.push({
          kind: 'tool',
          id: tc.id,
          name: tc.name,
          args: tc.arguments,
          status,
          output,
          ...(res?.images?.length ? { images: res.images } : {})
        })
        // Mirror the live transcript: a PR opening/merging gets its own notice.
        const pr = output ? prNoticeFromToolResult(tc.name, status === 'done', output) : null
        if (pr) {
          items.push({ kind: 'notice', id: nextId(), text: prNoticeText(pr), tone: 'info' })
        }
      }
    }
  }
  return items
}
