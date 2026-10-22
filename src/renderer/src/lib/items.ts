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
import type { TurnReceipt } from '@shared/evidence'
import type { ImageAttachment } from '@shared/images'
import { sanitizeInvocation, type PromptInvocation } from '@shared/promptInvocation'
import { prNoticeFromToolResult, prNoticeText } from '@shared/prNotice'
import { planOutcome } from '@shared/promptOutcome'
import { rendersAsReply } from '@shared/chatStatus'
import { upsertFinding } from '@shared/reviewFindings'
import { capSteps, upsertStep, type SubagentRecord } from '@shared/subagents'
import { turnLabel, turnText } from '@shared/rewind'

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
  /**
   * Set when `text` is a first-party prompt (`/review`, a ship button, `/agent`, a
   * handed-off brief): the bubble shows this, with `text` behind a disclosure.
   */
  invokedAs?: PromptInvocation
  /**
   * A course correction steered into a running turn (rather than sent as its own
   * turn). Rendered like any other user message; kept for the record.
   * Set live from the `steered` event and, on reload, from the saved message.
   */
  steered?: boolean
}
export interface AssistantItem {
  kind: 'assistant'
  id: string
  text: string
  streaming: boolean
  /** Model reasoning ("thinking") streamed before the answer, if any. */
  reasoning?: string
  /**
   * The message's index in the conversation's persisted log, for items rebuilt from
   * it (absent on live-streamed ones). Lets an unread anchor, which is a log index,
   * find the reply to put the "New" divider above.
   */
  messageIndex?: number
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
   * True on the full-auto shell-network question, raised after a command failed for
   * lack of network: the approval decides whether the chat's shell commands may reach
   * the network (declining keeps them offline), not whether this command runs (it
   * already has). Lets the approval card frame it as such.
   */
  shellNetwork?: boolean
  /**
   * True on a shell prompt whose command runs offline unless the user picks "Allow for
   * run" (the run has no shell-network grant yet), so the card can say so up front.
   */
  shellOffline?: boolean
  /**
   * True on a credential/secret-file read prompt (see isSensitivePath): a read that,
   * unusually, is asking — even in full-auto — so the card can explain why.
   */
  sensitiveRead?: boolean
  /** The awaited call writes a credential / secret file, so it prompts even in full auto. */
  sensitiveWrite?: boolean
  /** On a network prompt: what "Allow for run" grants (see the tool_approval event). */
  networkScope?: string
  output?: string
  /** Latest progress line from a long-running tool (e.g. a review's current phase). */
  progress?: string
  /** Live child rows for nested subagents this tool spawned (e.g. review dimension reviewers). */
  subagents?: SubAgentRow[]
  /** Live review findings (review_changes), upserted by id as verification settles them. */
  findings?: ReviewFinding[]
  /**
   * What each subagent this call ran did (dispatched, nested, reviewers): streamed as
   * it runs, then rebuilt from the tool result's saved records on reload. Flat; nested
   * agents point at their parent (see subagentTree).
   */
  records?: SubagentRecord[]
  /** Images the tool produced (e.g. a view_localhost screenshot). */
  images?: ImageAttachment[]
}
export interface NoticeItem {
  kind: 'notice'
  id: string
  text: string
  /** `handoff` marks the "spawned from …" banner atop a spawned chat's transcript. */
  tone: 'error' | 'info' | 'handoff'
  /** A missing language runtime, rendered with a one-click install. */
  runtime?: { label: string; installCommand?: string; url: string }
  /**
   * A "retrying" notice and the attempt it reports; the next attempt updates it in
   * place instead of stacking, and a final failure rewrites it in the past tense.
   */
  retry?: { attempt: number }
  /** On a `handoff` banner: the chat that spawned this one, which the banner links to. */
  openConversationId?: string
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

/**
 * What Houston recorded running during a turn (see TurnReceipt), shown under the
 * turn's last message. Comes from the `receipt` event live and from the assistant
 * message it was saved on when the transcript is rebuilt.
 */
export interface ReceiptItem {
  kind: 'receipt'
  id: string
  receipt: TurnReceipt
}

export type DisplayItem =
  | UserItem
  | AssistantItem
  | ToolItem
  | NoticeItem
  | QuestionItem
  | ReceiptItem
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
    if (it.kind !== 'user' || it.isSummary) continue
    // Recall what the user typed (`/review`), never the prompt Houston wrote for it.
    // A button press or a handoff has nothing to recall, so look further back.
    if (it.invokedAs) {
      if (it.invokedAs.typed) return it.invokedAs.typed
      continue
    }
    return it.text
  }
  return undefined
}

/** One of the user's messages as a rewind point (see RewindDialog), keyed to its bubble. */
export interface RewindItemTarget {
  /** The transcript item it belongs to. */
  id: string
  turn: number
  text: string
  label: string
  /** The message's attachments, so edit and resend sends them again. */
  images?: ImageAttachment[]
}

/**
 * The user's messages the transcript can rewind to, oldest first, numbered the way
 * main numbers the stored log (`rewindableTurnIndices`): every user bubble except the
 * compaction summary and a steered correction. Automated notes are notices here, so
 * they never count.
 */
export function rewindTargets(items: DisplayItem[]): RewindItemTarget[] {
  const out: RewindItemTarget[] = []
  for (const it of items) {
    if (it.kind !== 'user' || it.isSummary || it.steered) continue
    const m: ChatMessage = {
      role: 'user',
      content: it.text,
      ...(it.images ? { images: it.images } : {}),
      ...(it.invokedAs ? { invokedAs: it.invokedAs } : {})
    }
    out.push({
      id: it.id,
      turn: out.length,
      text: turnText(m),
      label: turnLabel(m),
      ...(it.images?.length ? { images: it.images } : {})
    })
  }
  return out
}

/**
 * Whether a spawned chat still holds its hand-off message (at `historyLength`, after
 * any history copied from the parent), so the "Handoff from" banner has something to
 * sit above. A rewind to before it removes the hand-off, and the banner with it.
 */
export function showsHandoff(historyLength: number, messageCount: number): boolean {
  return historyLength < messageCount
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
  const verify = strList(args.verify)
  return {
    title,
    ...(body ? { body } : {}),
    ...(overview ? { overview } : {}),
    ...(steps.length ? { steps } : {}),
    ...(files.length ? { files } : {}),
    ...(verify.length ? { verify } : {})
  }
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

/**
 * Take back the last `textChars` of streamed text and `reasoningChars` of streamed
 * reasoning from the streaming assistant bubble. While a model turn streams, only its
 * text and reasoning deltas arrive, and they all append to that one bubble, so a
 * discarded turn is exactly its tail. Earlier text in the same bubble (a reply the
 * previous iteration began, which this turn was continuing) stays. A bubble left
 * with nothing in it is removed rather than shown empty.
 */
function retractStreamed(items: DisplayItem[], textChars: number, reasoningChars: number): DisplayItem[] {
  const last = items[items.length - 1]
  if (!last || last.kind !== 'assistant' || !last.streaming) return items
  if (textChars <= 0 && reasoningChars <= 0) return items
  const text = last.text.slice(0, Math.max(0, last.text.length - Math.max(0, textChars)))
  const prior = last.reasoning ?? ''
  const reasoning = prior.slice(0, Math.max(0, prior.length - Math.max(0, reasoningChars)))
  if (!text && !reasoning) return items.slice(0, -1)
  const kept: AssistantItem = { kind: 'assistant', id: last.id, text, streaming: true }
  if (reasoning) kept.reasoning = reasoning
  return [...items.slice(0, -1), kept]
}

function updateTool(items: DisplayItem[], callId: string, patch: Partial<ToolItem>): DisplayItem[] {
  return items.map((it) => (it.kind === 'tool' && it.id === callId ? { ...it, ...patch } : it))
}

/** Apply `fn` to the subagent records of tool call `callId` (no-op if the row is gone). */
function mapRecords(
  items: DisplayItem[],
  callId: string,
  fn: (records: SubagentRecord[]) => SubagentRecord[]
): DisplayItem[] {
  return items.map((it) => (it.kind === 'tool' && it.id === callId ? { ...it, records: fn(it.records ?? []) } : it))
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
        { kind: 'user', id: nextId(), text: e.text, steered: true }
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
          shellOffline: e.shellOffline === true,
          sensitiveRead: e.sensitiveRead === true,
          sensitiveWrite: e.sensitiveWrite === true,
          ...(e.networkScope ? { networkScope: e.networkScope } : {}),
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
          ...(e.shellOffline ? { shellOffline: true } : {}),
          ...(e.sensitiveRead ? { sensitiveRead: true } : {}),
          ...(e.sensitiveWrite ? { sensitiveWrite: true } : {}),
          ...(e.networkScope ? { networkScope: e.networkScope } : {}),
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
    case 'subagent_start': {
      // A subagent began under this call. Upsert by id, so a re-adopt replay of the
      // same event doesn't add it twice.
      return mapRecords(items, e.parentCallId, (records) => {
        const at = records.findIndex((r) => r.id === e.record.id)
        if (at < 0) return [...records, e.record]
        const next = records.slice()
        next[at] = { ...e.record, steps: records[at].steps }
        return next
      })
    }
    case 'subagent_step': {
      return mapRecords(items, e.parentCallId, (records) =>
        records.map((r) => (r.id === e.recordId ? capSteps({ ...r, steps: upsertStep(r.steps, e.step) }) : r))
      )
    }
    case 'subagent_end': {
      return mapRecords(items, e.parentCallId, (records) =>
        records.map((r) => (r.id === e.recordId ? { ...r, ...e.update } : r))
      )
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
        const status = planOutcome(e.output)
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
        // A subagent that never reported its end (the run was stopped) isn't running.
        if (it.records?.some((r) => r.status === 'running')) {
          next = {
            ...next,
            records: it.records.map((r) => (r.status === 'running' ? { ...r, status: 'aborted' as const } : r))
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
      const text = `⟳ Connection issue, retrying (${e.attempt}/${e.max}): ${e.message}`
      // Back-to-back attempts update one line ("retrying (3/6)") rather than stacking
      // a row per attempt down the transcript.
      const last = finalized[finalized.length - 1]
      const retry = { attempt: e.attempt }
      if (last?.kind === 'notice' && last.retry) return [...finalized.slice(0, -1), { ...last, text, retry }]
      return [...finalized, { kind: 'notice', id: nextId(), text, tone: 'info', retry }]
    }
    // A model turn dropped mid-stream and is being redone. Retract what it showed so
    // the redo is the only copy of the reply; the retry or fallback notice that always
    // follows says why it vanished. The loop never persisted it, so a reload agrees.
    case 'turn_discarded':
      return retractStreamed(items, e.textChars, e.reasoningChars)
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
          ? '⚠ Reached the step limit for one turn and stopped. Send a message to have me continue.'
          : e.reason === 'stalled'
            ? '⚠ Stopped: I appeared to be repeating myself without making progress. Send a message with more direction to continue.'
            : '⚠ The reply was cut off at the model’s output limit. Ask me to continue it.'
      return [...finalized, { kind: 'notice', id: nextId(), text, tone: 'error' }]
    }
    case 'receipt': {
      // A turn has one receipt, and it comes last. A renderer that re-opened the chat
      // in the moment between the receipt being saved and the run ending rebuilt it
      // from disk and then replays the event, so a receipt already at the end is
      // replaced rather than doubled.
      const finalized = finalizeStreaming(items)
      const kept = finalized.at(-1)?.kind === 'receipt' ? finalized.slice(0, -1) : finalized
      return [...kept, { kind: 'receipt', id: nextId(), receipt: e.receipt }]
    }
    case 'verification': {
      const finalized = finalizeStreaming(items)
      const text = e.passed
        ? '✓ Verification passed.'
        : '⚠ Verification failed, attempting to self-correct.'
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
    case 'runtime_missing': {
      const finalized = finalizeStreaming(items)
      return [
        ...finalized,
        {
          kind: 'notice',
          id: nextId(),
          text: `${e.label} isn't installed, or isn't on the PATH Houston sees.`,
          tone: 'error',
          runtime: {
            label: e.label,
            url: e.url,
            ...(e.installCommand ? { installCommand: e.installCommand } : {})
          }
        }
      ]
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
      // The run gave up while a "retrying (6/6)" line was the last thing shown: say
      // the retries are over, so it doesn't read as still in progress above the error.
      const last = finalized[finalized.length - 1]
      const settled =
        last?.kind === 'notice' && last.retry
          ? [
              ...finalized.slice(0, -1),
              {
                ...last,
                text: `⟳ Connection issue: tried ${last.retry.attempt} more time${last.retry.attempt === 1 ? '' : 's'}, then stopped.`,
                retry: undefined
              }
            ]
          : finalized
      return [...settled, { kind: 'notice', id: nextId(), text: e.message, tone: 'error' }]
    }
    case 'usage':
    case 'turn_start':
    case 'run_info':
    case 'steers_returned':
      // Not transcript items: usage totals are folded into the store/control bar,
      // turn_start is adopted by App, run_info goes only to the headless client
      // that asks for it (announceTools), and a returned steer is already in the
      // queue bar (main keeps the desktop's steers there). No display change here.
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

/**
 * The notice text for a saved system note: its opening paragraph. A note can carry
 * a payload meant for the model (a failed verification's full test output), which
 * would swamp a one-line notice; the opening says what happened.
 */
export function systemNoteSummary(content: string): string {
  const body = content.slice(SYSTEM_NOTE_PREFIX.length).trim()
  const first = body.split(/\n\s*\n/)[0]?.trim() ?? ''
  return first.replace(/:$/, '.')
}

/** Build display items from a saved conversation's message log. */
export function itemsFromMessages(
  messages: ChatMessage[],
  /** Where `messages` starts in the full log (a slice of it), for `messageIndex`. */
  offset = 0
): DisplayItem[] {
  const resultByCallId = new Map<
    string,
    { output: string; images?: ImageAttachment[]; subagents?: SubagentRecord[] }
  >()
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) {
      resultByCallId.set(m.toolCallId, {
        output: m.content,
        images: m.images,
        ...(Array.isArray(m.subagents) && m.subagents.length ? { subagents: m.subagents } : {})
      })
    }
  }

  const items: DisplayItem[] = []
  for (const [i, m] of messages.entries()) {
    if (m.role === 'user') {
      // An automated guidance turn the loop injected (a stall nudge, the budget
      // landing reminder) rides on a user message but isn't from the user — show it
      // as a system notice, not a user bubble, and keep it out of `lastUserText`.
      if (m.content.startsWith(SYSTEM_NOTE_PREFIX)) {
        const text = systemNoteSummary(m.content)
        if (text) items.push({ kind: 'notice', id: nextId(), text, tone: 'info' })
      } else if (m.content.trim() || m.images?.length) {
        const invokedAs = sanitizeInvocation(m.invokedAs)
        items.push({
          kind: 'user',
          id: nextId(),
          text: m.content,
          ...(m.images?.length ? { images: m.images } : {}),
          ...(invokedAs ? { invokedAs } : {}),
          ...(m.steered === true ? { steered: true } : {}),
          ...(m.content.startsWith(COMPACTION_SUMMARY_PREFIX) ? { isSummary: true } : {})
        })
      }
    } else if (m.role === 'assistant') {
      const reasoning = m.reasoning?.map((r) => r.text).filter(Boolean).join('\n') || undefined
      if (rendersAsReply(m)) {
        items.push({
          kind: 'assistant',
          id: nextId(),
          text: m.content,
          streaming: false,
          reasoning,
          messageIndex: offset + i
        })
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
            status: planOutcome(res?.output)
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
          ...(res?.images?.length ? { images: res.images } : {}),
          ...(res?.subagents ? { records: res.subagents } : {})
        })
        // Mirror the live transcript: a PR opening/merging gets its own notice.
        const pr = output ? prNoticeFromToolResult(tc.name, status === 'done', output) : null
        if (pr) {
          items.push({ kind: 'notice', id: nextId(), text: prNoticeText(pr), tone: 'info' })
        }
      }
      // Saved on the turn's last assistant message, after everything that turn did.
      if (m.receipt) items.push({ kind: 'receipt', id: nextId(), receipt: m.receipt })
    }
    // Runs started from this message that ended with no reply: the notice each one
    // showed live (the error it failed on, or "Stopped."), so a reload still says why.
    for (const r of m.unanswered ?? []) {
      items.push(
        r.reason === 'aborted' || !r.message
          ? { kind: 'notice', id: nextId(), text: 'Stopped.', tone: 'info' }
          : { kind: 'notice', id: nextId(), text: r.message, tone: 'error' }
      )
    }
  }
  return items
}

/**
 * Whether the log's last message already records `message` as the error its latest
 * run ended on, so the reopened chat shows it there and not a second time as the
 * conversation's last-error notice.
 */
export function endsWithRecordedError(messages: ChatMessage[], message: string): boolean {
  const latest = messages.at(-1)?.unanswered?.at(-1)
  return latest?.reason === 'error' && latest.message === message
}
