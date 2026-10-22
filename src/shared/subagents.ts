import { diffStat, type FileDiffPreview } from './diff'

/**
 * What Houston records about each subagent it runs (a dispatched research or writable
 * agent, a nested one, or one of review_changes' reviewers), so the clients can show
 * the agent's work instead of one overwriting progress line and a bare report.
 *
 * Display-only. The loop builds a record as the agent runs, streams it to the clients
 * (`subagent_start` / `subagent_step` / `subagent_end`), and saves the finished records
 * on the dispatch's tool-result message (`ChatMessage.subagents`). Providers never see
 * it, and it never makes an agent resumable: resume stays on the in-memory transcript
 * store (subagentSessions.ts), because a saved transcript describes a workspace that
 * has moved on.
 *
 * Every string in a record is model or tool output. The loop redacts it before it is
 * emitted, and the clients render it as text (model prose only through the markdown
 * renderer, which escapes HTML).
 */

export type SubagentKind = 'research' | 'writable' | 'reviewer'

export type SubagentStatus = 'running' | 'done' | 'error' | 'aborted' | 'step-limit' | 'stalled'

/** Who picked the model the agent ran on. */
export type SubagentModelSource = 'run' | 'argument' | 'agent-file'

export interface SubagentBudget {
  /** Steps (model turns) the agent took. */
  used: number
  /** The step limit in force when it finished (it grows while a run is productive). */
  limit: number
  /** The most it could ever have grown to. Equal to `limit` when it can't extend. */
  ceiling: number
  /** Set when a custom agent declared `max_turns`: a hard limit that never extends. */
  hardCap?: number
}

export interface SubagentUsage {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  /** Approximate cost in USD, when the model's price is known. */
  costUsd?: number
}

export interface SubagentStep {
  /** Position in the record's step list; stable, so an update replaces in place. */
  index: number
  /** The agent's model turn (1-based) the step belongs to. */
  turn: number
  /**
   * `tool`: one tool call. `text`: what the agent said alongside its tool calls.
   * `notice`: something Houston did (extended the budget, nudged a looping agent).
   */
  kind: 'tool' | 'text' | 'notice'
  /** The tool's name, for `tool` steps. */
  tool?: string
  /**
   * The tool's one-line summary (the same label the main transcript shows), or what the
   * agent said (`text` steps, capped at {@link SUBAGENT_CAPS.stepOutput}).
   */
  summary: string
  /** Unset while the call is running. */
  ok?: boolean
  /** A short outcome: "26 lines", "exit 0", "+2 −1". */
  hint?: string
  /** A preview of the result, redacted and capped at {@link SUBAGENT_CAPS.stepOutput}. */
  output?: string
  /** The output was longer than the preview. */
  outputTruncated?: boolean
  /** The real diff of a write, computed before it ran. */
  preview?: FileDiffPreview[]
  startedAt?: number
  durationMs?: number
  /** The nested agent this step dispatched. */
  childId?: string
}

export interface SubagentRecord {
  /** Unique within its tool call: "ag1" for a resumable dispatch, "ag1.1" nested, "correctness" for a reviewer. */
  id: string
  /** The nested agent's parent record, when this is one. */
  parentId?: string
  kind: SubagentKind
  /** The dispatch's short description, or the reviewer's role. */
  label: string
  /** The custom agent (from .houston/agents) it ran as. */
  agentName?: string
  model: string
  modelSource: SubagentModelSource
  /** The task the dispatching agent wrote. */
  prompt: string
  /** The full system prompt the agent ran under. */
  systemPrompt?: string
  /** The tools the agent could call. */
  tools: string[]
  /** The id the main agent can pass as `resume` to continue this agent in this app session. */
  resumeId?: string
  /** This record continues an earlier agent (a resume). */
  resumed?: boolean
  status: SubagentStatus
  startedAt: number
  endedAt?: number
  budget?: SubagentBudget
  usage?: SubagentUsage
  /** The agent's final report. */
  report?: string
  steps: SubagentStep[]
  /** Steps dropped from the middle of a very long run to stay within the cap. */
  stepsOmitted?: number
  /** Step outputs and diffs were dropped to keep the chat within its subagent history limit. */
  trimmed?: boolean
}

/** Size limits on what a record keeps, so a long run can't bloat IPC or the chat file. */
export const SUBAGENT_CAPS = {
  stepOutput: 2_000,
  stepSummary: 400,
  prompt: 16_000,
  systemPrompt: 8_000,
  report: 32_000,
  /** Steps kept per record; past it the middle of the run is dropped. */
  steps: 400,
  /** How many of the earliest steps survive when the middle is dropped. */
  stepsHead: 50
} as const

/** Default for `AppSettings.subagentHistoryMb`. */
export const DEFAULT_SUBAGENT_HISTORY_MB = 4

/** Cut `text` to `max` characters, marking that it was cut. */
export function clipText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: `${text.slice(0, max)}…`, truncated: true }
}

/**
 * Keep a record's step list within {@link SUBAGENT_CAPS.steps}: the first
 * `stepsHead` steps and the most recent rest, counting what was dropped. Indexes
 * are kept as they were, so a later update to a kept step still lands on it.
 */
export function capSteps(record: SubagentRecord): SubagentRecord {
  const max = SUBAGENT_CAPS.steps
  if (record.steps.length <= max) return record
  const head = record.steps.slice(0, SUBAGENT_CAPS.stepsHead)
  const tail = record.steps.slice(record.steps.length - (max - SUBAGENT_CAPS.stepsHead))
  return {
    ...record,
    steps: [...head, ...tail],
    stepsOmitted: (record.stepsOmitted ?? 0) + record.steps.length - max
  }
}

/** Insert or replace a step by its index, keeping the list in index order. */
export function upsertStep(steps: SubagentStep[], step: SubagentStep): SubagentStep[] {
  const at = steps.findIndex((s) => s.index === step.index)
  if (at >= 0) {
    const next = steps.slice()
    next[at] = { ...steps[at], ...step }
    return next
  }
  const next = [...steps, step]
  if (next.length > 1 && next[next.length - 2].index > step.index) {
    next.sort((a, b) => a.index - b.index)
  }
  return next
}

/** A record with its nested agents, for display. */
export interface SubagentNode {
  record: SubagentRecord
  children: SubagentNode[]
}

/** Arrange a flat record list (as saved and streamed) into its nesting. */
export function subagentTree(records: readonly SubagentRecord[]): SubagentNode[] {
  const nodes = new Map<string, SubagentNode>()
  for (const r of records) nodes.set(r.id, { record: r, children: [] })
  const roots: SubagentNode[] = []
  for (const r of records) {
    const node = nodes.get(r.id)!
    const parent = r.parentId ? nodes.get(r.parentId) : undefined
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

/**
 * The note the loop appends to a resumable dispatch's report, telling the main agent
 * how to continue it. The model needs it; people don't.
 */
export function resumeNote(id: string, tool: string): string {
  return `[subagent ${id}: pass resume: "${id}" to ${tool} to continue this agent with its context intact]`
}

const RESUME_NOTE = /\n*\[subagent (ag\d+): pass resume: "\1" to (dispatch_agent|dispatch_writable_agent) to continue this agent with its context intact\]\s*$/

/**
 * Split a dispatch's tool result into the report people read and the resume note the
 * loop appended for the model. Only the exact trailing note is taken off, so a report
 * that merely quotes one is left alone. Works on chats saved before records existed.
 */
export function splitSubagentReport(output: string): {
  report: string
  resumeId?: string
  tool?: string
} {
  const m = RESUME_NOTE.exec(output)
  if (!m) return { report: output }
  return { report: output.slice(0, m.index), resumeId: m[1], tool: m[2] }
}

/** Whether a tool's result is a subagent report (so it renders as markdown). */
export function isSubagentTool(name: string): boolean {
  return name === 'dispatch_agent' || name === 'dispatch_writable_agent'
}

/** "0.2s", "14s", "3m 12s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toFixed(1).replace(/\.0$/, '')}s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

/** "claude-haiku-5-5, chosen by the main agent". */
export function modelSourceLabel(source: SubagentModelSource): string {
  if (source === 'argument') return 'chosen by the main agent'
  if (source === 'agent-file') return "set in the agent's file"
  return "the chat's model"
}

/** How the agent ended, in a few words. */
export function statusLabel(r: SubagentRecord): string {
  switch (r.status) {
    case 'running':
      return 'running'
    case 'done':
      return 'finished with a report'
    case 'error':
      return 'failed'
    case 'aborted':
      return 'stopped'
    case 'step-limit':
      return r.budget?.hardCap ? `stopped at its ${r.budget.hardCap}-step limit` : 'stopped at its step limit'
    case 'stalled':
      return 'stopped after repeating itself'
  }
}

/** Steps that are tool calls (what "N steps" counts in the clients). */
export function toolStepCount(r: SubagentRecord): number {
  return r.steps.filter((s) => s.kind === 'tool').length + (r.stepsOmitted ?? 0)
}

/** Lines added and removed across a record's writes. */
export function recordDiffStat(r: SubagentRecord): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const s of r.steps) {
    for (const p of s.preview ?? []) {
      const st = diffStat(p.diff)
      added += st.added
      removed += st.removed
    }
  }
  return { added, removed }
}

/** Serialized size of a record, the unit the per-chat history limit counts in. */
export function recordBytes(r: SubagentRecord): number {
  return JSON.stringify(r).length
}

/** A record without its step outputs and diffs: what an old record keeps past the limit. */
export function trimRecord(r: SubagentRecord): SubagentRecord {
  if (r.trimmed) return r
  return {
    ...r,
    trimmed: true,
    steps: r.steps.map((s) => {
      const { output: _o, outputTruncated: _t, preview: _p, ...rest } = s
      return rest
    })
  }
}

/**
 * Keep a chat's saved subagent records within `maxBytes` by trimming the OLDEST
 * records' step outputs and diffs (step summaries, prompt and report stay). Returns
 * the same array when nothing changed, otherwise a copy with the trimmed messages
 * replaced. `maxBytes <= 0` trims every record.
 */
export function limitSubagentHistory<M extends { subagents?: SubagentRecord[] }>(
  messages: M[],
  maxBytes: number
): M[] {
  let total = 0
  for (const m of messages) for (const r of m.subagents ?? []) total += recordBytes(r)
  if (total <= maxBytes) return messages
  const out = messages.slice()
  for (let i = 0; i < out.length && total > maxBytes; i++) {
    const recs = out[i].subagents
    if (!recs?.length) continue
    let changed = false
    const next = recs.map((r) => {
      if (total <= maxBytes || r.trimmed) return r
      const t = trimRecord(r)
      total -= recordBytes(r) - recordBytes(t)
      changed = true
      return t
    })
    if (changed) out[i] = { ...out[i], subagents: next }
  }
  return out
}

/** Bytes for the user's `subagentHistoryMb` setting. */
export function subagentHistoryBytes(mb: number | undefined): number {
  const v = typeof mb === 'number' && Number.isFinite(mb) && mb >= 0 ? mb : DEFAULT_SUBAGENT_HISTORY_MB
  return Math.floor(v * 1024 * 1024)
}

/** One line for a step, as the terminal clients print it. */
export function stepLine(s: SubagentStep): string {
  const glyph = s.kind === 'notice' ? '↗' : s.kind === 'text' ? '·' : s.ok === undefined ? '…' : s.ok ? '✓' : '✗'
  const hint = s.hint ? ` · ${s.hint}` : ''
  return `${glyph} ${s.summary}${hint}`
}

/** The header for a record, as the terminal clients and exports print it. */
export function recordHeadline(r: SubagentRecord): string {
  const n = toolStepCount(r)
  const parts = [r.model, `${n} step${n === 1 ? '' : 's'}`]
  if (r.endedAt) parts.push(formatDuration(r.endedAt - r.startedAt))
  if (r.resumeId) parts.push(r.resumeId)
  return `${r.label} (${parts.join(', ')})`
}

/**
 * A record as Markdown, for "Copy as Markdown" in the transcript view and for the
 * HTML export. Every string is the agent's own (already redacted) text.
 */
export function recordToMarkdown(node: SubagentNode, depth = 0): string {
  const r = node.record
  const h = '#'.repeat(Math.min(6, depth + 2))
  const out: string[] = [`${h} ${r.label}`, '']
  out.push(`- Agent: ${r.agentName ?? (r.kind === 'writable' ? 'default writable agent' : r.kind === 'reviewer' ? 'reviewer' : 'default research agent')}`)
  out.push(`- Model: ${r.model} (${modelSourceLabel(r.modelSource)})`)
  out.push(`- Steps: ${toolStepCount(r)}${r.budget ? ` of ${r.budget.limit}` : ''}`)
  if (r.endedAt) out.push(`- Time: ${formatDuration(r.endedAt - r.startedAt)}`)
  out.push(`- Status: ${statusLabel(r)}`, '', `**Task**`, '', r.prompt, '')
  if (r.steps.length) {
    out.push('**Steps**', '')
    for (const s of r.steps) out.push(`${s.turn}. ${stepLine(s)}`)
    if (r.stepsOmitted) out.push(`(${r.stepsOmitted} steps omitted)`)
    out.push('')
  }
  for (const c of node.children) out.push(recordToMarkdown(c, depth + 1), '')
  if (r.report) out.push('**Report**', '', r.report)
  return out.join('\n').trimEnd()
}

/** Count lines of tool output, ignoring a trailing blank. */
function lineCount(text: string): number {
  const t = text.replace(/\s+$/, '')
  return t ? t.split('\n').length : 0
}

/**
 * A short outcome for a finished step: "26 lines", "3 matches", "exit 0 · 0.2s",
 * "+2 −1". Derived from the tool's output text (and a write's diff), so it works the
 * same for every client. Empty when nothing useful can be said.
 */
export function stepHint(
  tool: string,
  output: string,
  ok: boolean,
  opts: { preview?: FileDiffPreview[]; durationMs?: number } = {}
): string {
  const time = opts.durationMs !== undefined && opts.durationMs >= 1000 ? formatDuration(opts.durationMs) : ''
  const join = (...p: string[]): string => p.filter(Boolean).join(' · ')
  if (opts.preview?.length) {
    let added = 0
    let removed = 0
    for (const p of opts.preview) {
      const st = diffStat(p.diff)
      added += st.added
      removed += st.removed
    }
    return `+${added} −${removed}`
  }
  if (tool === 'run_shell') {
    const all = [...output.matchAll(/\[exit code: (\d+|killed)\]/g)]
    const code = all.at(-1)?.[1]
    const shellTime = opts.durationMs !== undefined ? formatDuration(opts.durationMs) : ''
    return join(code === undefined ? (ok ? '' : 'failed') : code === 'killed' ? 'killed' : `exit ${code}`, shellTime)
  }
  if (!ok) return join('failed', time)
  const n = lineCount(output)
  switch (tool) {
    case 'read_file':
      return join(`${n} line${n === 1 ? '' : 's'}`, time)
    case 'search_files':
    case 'ast_grep':
      return join(/^no (matches|results)/i.test(output.trim()) || n === 0 ? 'no matches' : `${n} match${n === 1 ? '' : 'es'}`, time)
    case 'glob':
      return join(/^no /i.test(output.trim()) || n === 0 ? 'no files' : `${n} file${n === 1 ? '' : 's'}`, time)
    case 'list_dir':
      return join(`${n} entr${n === 1 ? 'y' : 'ies'}`, time)
    case 'web_fetch':
    case 'web_search':
      return join(`${Math.max(1, Math.round(output.length / 1024))} KB`, time)
    default:
      return time
  }
}

/** Drop C0, DEL and C1 control characters, so agent text can't drive a terminal. */
function terminalSafe(s: string): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
}

/** One line a terminal client prints for a subagent event. */
export interface SubagentTermLine {
  /** Nesting under the parent tool row: 1 for a dispatched agent, 2 for its nested one. */
  depth: number
  text: string
  tone: 'dim' | 'red' | 'yellow' | 'plain'
}

type TermEvent =
  | { type: 'subagent_start'; parentCallId: string; record: SubagentRecord }
  | { type: 'subagent_step'; parentCallId: string; recordId: string; step: SubagentStep }
  | {
      type: 'subagent_end'
      parentCallId: string
      recordId: string
      update: Pick<SubagentRecord, 'status' | 'endedAt'> & Partial<Pick<SubagentRecord, 'budget' | 'resumeId'>>
    }

/**
 * Turns the record events into the lines the terminal clients print (they can't update
 * a row in place): a start line, one line per finished step, and an end line, indented
 * by nesting. Reviewer steps are left out unless `verbose`, since a review runs many
 * agents at once. All text has control characters removed.
 */
export class SubagentTermLines {
  private readonly agents = new Map<string, { depth: number; kind: SubagentKind; label: string; startedAt: number; steps: number }>()

  constructor(private readonly opts: { verbose?: boolean } = {}) {}

  line(e: TermEvent): SubagentTermLine | null {
    if (e.type === 'subagent_start') {
      const parent = e.record.parentId ? this.agents.get(`${e.parentCallId}:${e.record.parentId}`) : undefined
      const depth = parent ? parent.depth + 1 : 1
      this.agents.set(`${e.parentCallId}:${e.record.id}`, {
        depth,
        kind: e.record.kind,
        label: e.record.label,
        startedAt: e.record.startedAt,
        steps: 0
      })
      if (e.record.kind === 'reviewer' && !this.opts.verbose) return null
      return { depth, text: terminalSafe(`▷ ${e.record.label} (${e.record.model})`), tone: 'dim' }
    }
    const agent = this.agents.get(`${e.parentCallId}:${e.recordId}`)
    if (!agent) return null
    const quiet = agent.kind === 'reviewer' && !this.opts.verbose
    if (e.type === 'subagent_step') {
      const s = e.step
      if (s.kind === 'tool' && s.ok === undefined) return null
      if (s.kind === 'tool') agent.steps++
      if (quiet) return null
      const tone = s.kind === 'notice' ? 'yellow' : s.ok === false ? 'red' : 'dim'
      return { depth: agent.depth + 1, text: terminalSafe(stepLine({ ...s, summary: truncateLine(s.summary, 160) })), tone }
    }
    if (quiet) return null
    const u = e.update
    const time = u.endedAt ? formatDuration(u.endedAt - agent.startedAt) : ''
    const status = statusLabel({ status: u.status, budget: u.budget } as SubagentRecord)
    const facts = [`${agent.steps} step${agent.steps === 1 ? '' : 's'}`, time, u.resumeId ?? ''].filter(Boolean).join(', ')
    const glyph = u.status === 'done' ? '✓' : u.status === 'running' ? '…' : u.status === 'step-limit' || u.status === 'stalled' ? '!' : '✗'
    const tone = u.status === 'done' ? 'dim' : u.status === 'step-limit' || u.status === 'stalled' ? 'yellow' : 'red'
    return { depth: agent.depth, text: terminalSafe(`${glyph} ${agent.label}: ${status} (${facts})`), tone }
  }
}

function truncateLine(s: string, max: number): string {
  const one = s.replace(/\s*\n\s*/g, ' ')
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** One subagent's spend, for the cost breakdown. */
export interface SubagentSpend {
  id: string
  label: string
  model: string
  input: number
  output: number
  costUsd: number
}

/**
 * Every finished subagent's spend in a chat, most expensive first. Its tokens are
 * already in the per-model totals; this says which agent spent them.
 */
export function subagentSpend(records: Iterable<SubagentRecord>): SubagentSpend[] {
  const out: SubagentSpend[] = []
  for (const r of records) {
    if (!r.usage) continue
    out.push({
      id: r.id,
      label: r.resumeId ? `${r.resumeId} · ${r.label}` : r.label,
      model: r.model,
      input: r.usage.input,
      output: r.usage.output,
      costUsd: r.usage.costUsd ?? 0
    })
  }
  return out.sort((a, b) => b.costUsd - a.costUsd || b.output - a.output)
}
