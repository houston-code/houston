import type { BackgroundShellInfo, ChatMessage, KillShellOutcome } from '@shared/agent'
import {
  formatDuration,
  recordOutcome,
  stepLine,
  type SubagentKind,
  type SubagentRecord,
  type SubagentStatus,
  type SubagentStep
} from '@shared/subagents'
import type { Painter } from './tui'
import type { PickerSpec } from './tui-picker'
import { stripControlChars, truncateVisible, visibleWidth } from './tui-wrap'

/**
 * The terminal's `/tasks` (alias `/bashes`): the background work of this chat, the
 * shells the agent started with `run_shell` background mode and the subagents it
 * dispatched, numbered so one can be read (`/tasks <n>`) or stopped (`/tasks kill <n>`).
 *
 * Pure: the driver supplies the shell registry's snapshot and the subagent records,
 * and prints what comes back. Every string here is model or command output, so each
 * one is stripped of control characters before it reaches the terminal.
 */

/** A dispatched subagent, as the terminal follows it from its `subagent_*` events. */
export interface TrackedSubagent {
  /** `${parentCallId}:${recordId}`: one agent, whether seen live or loaded from the chat. */
  key: string
  /** The run that dispatched it, when it was seen live (only those can be stopped). */
  runId?: string
  recordId: string
  /** The chat it belongs to; null for a session that isn't saved. */
  chat: string | null
  kind: SubagentKind
  label: string
  agentName?: string
  /** Its id when dispatched with `background: true` ("bg1"): it works on while the turn goes on. */
  backgroundId?: string
  model: string
  prompt: string
  status: SubagentStatus
  outcome?: SubagentRecord['outcome']
  startedAt: number
  endedAt?: number
  steps: SubagentStep[]
  report?: string
}

type SubagentEvent =
  | { type: 'subagent_start'; runId: string; parentCallId: string; record: SubagentRecord }
  | { type: 'subagent_step'; runId: string; parentCallId: string; recordId: string; step: SubagentStep }
  | {
      type: 'subagent_end'
      runId: string
      parentCallId: string
      recordId: string
      update: Pick<SubagentRecord, 'status' | 'endedAt'> & Partial<Pick<SubagentRecord, 'outcome' | 'report'>>
    }

/** Steps a tracked agent keeps: `/tasks <n>` shows the recent ones. */
const TRACKED_STEPS = 60
/** Agents the tracker remembers, oldest dropped first. */
const TRACKED_AGENTS = 100

/**
 * Follows the subagents a session's runs dispatch, from the same events the transcript
 * prints. Reviewers are left out: a review runs several at once as one tool call, and
 * stops with it.
 */
export class SubagentTracker {
  private readonly agents = new Map<string, TrackedSubagent>()

  apply(e: SubagentEvent, chat: string | null): void {
    if (e.type === 'subagent_start') {
      if (e.record.kind === 'reviewer') return
      const key = `${e.parentCallId}:${e.record.id}`
      this.agents.set(key, {
        key,
        runId: e.runId,
        recordId: e.record.id,
        chat,
        kind: e.record.kind,
        label: e.record.label,
        ...(e.record.agentName ? { agentName: e.record.agentName } : {}),
        ...(e.record.backgroundId ? { backgroundId: e.record.backgroundId } : {}),
        model: e.record.model,
        prompt: e.record.prompt,
        status: e.record.status,
        startedAt: e.record.startedAt,
        steps: []
      })
      while (this.agents.size > TRACKED_AGENTS) this.agents.delete(this.agents.keys().next().value as string)
      return
    }
    const a = this.agents.get(`${e.parentCallId}:${e.recordId}`)
    if (!a) return
    if (e.type === 'subagent_step') {
      const at = a.steps.findIndex((s) => s.index === e.step.index)
      if (at >= 0) a.steps[at] = { ...a.steps[at], ...e.step }
      else a.steps.push(e.step)
      if (a.steps.length > TRACKED_STEPS) a.steps.splice(0, a.steps.length - TRACKED_STEPS)
      return
    }
    a.status = e.update.status
    if (e.update.outcome) a.outcome = e.update.outcome
    a.endedAt = e.update.endedAt
    if (e.update.report !== undefined) a.report = e.update.report
  }

  /** The agents of one chat, in the order they started. */
  forChat(chat: string | null): TrackedSubagent[] {
    return [...this.agents.values()].filter((a) => a.chat === chat)
  }

  /** Forget the agents of one chat (it was cleared or deleted). */
  forget(chat: string | null): void {
    for (const [k, a] of this.agents) if (a.chat === chat) this.agents.delete(k)
  }
}

/**
 * The finished subagents saved on a chat's messages (a resumed chat's, or this session's
 * once their dispatch returned), merged under the live ones: the live entry wins, since
 * only it knows the run that can still stop it.
 */
export function chatSubagents(messages: ChatMessage[], live: TrackedSubagent[], chat: string | null): TrackedSubagent[] {
  const byKey = new Map<string, TrackedSubagent>()
  for (const m of messages) {
    if (!m.subagents?.length || !m.toolCallId) continue
    for (const r of m.subagents) {
      if (r.kind === 'reviewer') continue
      const key = `${m.toolCallId}:${r.id}`
      byKey.set(key, {
        key,
        recordId: r.id,
        chat,
        kind: r.kind,
        label: r.label,
        ...(r.agentName ? { agentName: r.agentName } : {}),
        ...(r.backgroundId ? { backgroundId: r.backgroundId } : {}),
        model: r.model,
        prompt: r.prompt,
        // A saved record still marked running was cut off when its run died.
        status: r.status === 'running' ? 'aborted' : r.status,
        ...(r.outcome ? { outcome: r.outcome } : {}),
        startedAt: r.startedAt,
        ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}),
        steps: r.steps.slice(-TRACKED_STEPS),
        ...(r.report !== undefined ? { report: r.report } : {})
      })
    }
  }
  for (const a of live) byKey.set(a.key, a)
  return [...byKey.values()]
}

/** A shell from the registry, with the last line it printed. */
export interface TaskShell extends BackgroundShellInfo {
  lastLine?: string
}

/** One row of `/tasks`. */
export type TaskRow =
  | { kind: 'shell'; shell: TaskShell }
  | { kind: 'subagent'; agent: TrackedSubagent }

/** Whether the shell belongs to this chat (or, for an unsaved session, its folder). */
export function shellInChat(s: BackgroundShellInfo, chat: string | null, cwd: string): boolean {
  return chat ? s.conversationId === chat : !s.conversationId && s.workspace === cwd
}

/** Every task, oldest first, so a task keeps its number while newer ones start. */
export function taskRows(shells: TaskShell[], agents: TrackedSubagent[]): TaskRow[] {
  const rows: TaskRow[] = [
    ...shells.map((shell): TaskRow => ({ kind: 'shell', shell })),
    ...agents.map((agent): TaskRow => ({ kind: 'subagent', agent }))
  ]
  return rows.sort((a, b) => startOf(a) - startOf(b))
}

function startOf(r: TaskRow): number {
  return r.kind === 'shell' ? r.shell.startedAt : r.agent.startedAt
}

/** Whether a task is still going (a shell's leftover server counts: it can be stopped). */
export function taskRunning(r: TaskRow): boolean {
  return r.kind === 'shell' ? r.shell.running || r.shell.leftover === true : r.agent.status === 'running'
}

/** One line of model or command text, safe to print: whitespace collapsed, controls gone. */
export function safeLine(s: string): string {
  return stripControlChars(s.replace(/\s+/g, ' ')).trim()
}

/** What the task is: a shell's command, a subagent's name and task. */
export function taskLabel(r: TaskRow): string {
  if (r.kind === 'shell') return safeLine(r.shell.command)
  const a = r.agent
  const name = a.agentName && !a.label.includes(a.agentName) ? `${a.agentName}: ${a.label}` : a.label
  return safeLine(name)
}

/** running, exited N, killed, done, failed, stopped, cut short. */
export function taskStatus(r: TaskRow): string {
  if (r.kind === 'shell') {
    const s = r.shell
    if (s.running) return 'running'
    const ended = s.exitCode === null ? 'killed' : `exited ${s.exitCode}`
    return s.leftover ? `${ended}, still serving` : ended
  }
  const a = r.agent
  switch (a.status) {
    case 'running':
      return 'running'
    case 'aborted':
      return 'stopped'
    case 'error':
      return 'failed'
    case 'step-limit':
    case 'stalled':
      return 'cut short'
    case 'done':
      return recordOutcome(a) === 'done' ? 'done' : 'cut short'
  }
}

function statusTone(r: TaskRow): 'cyan' | 'green' | 'red' | 'yellow' | 'dim' {
  const st = taskStatus(r)
  if (st === 'running' || st.endsWith('still serving')) return 'cyan'
  if (st === 'done' || st === 'exited 0') return 'green'
  if (st === 'failed' || st.startsWith('exited')) return 'red'
  if (st === 'cut short') return 'yellow'
  return 'dim'
}

/** How long it ran, or has been running. */
export function taskElapsed(r: TaskRow, now: number): string {
  const start = startOf(r)
  const end = r.kind === 'shell' ? (r.shell.exitedAt ?? undefined) : r.agent.endedAt
  return formatDuration(Math.max(0, (end ?? now) - start))
}

/** agent, agent (writes), agent (background), agent (background, writes). */
function agentKind(a: TrackedSubagent): string {
  const tags = [...(a.backgroundId ? ['background'] : []), ...(a.kind === 'writable' ? ['writes'] : [])]
  return tags.length ? `agent (${tags.join(', ')})` : 'agent'
}

/** The one-line summary of a task, for the list and the picker. */
function taskSummary(r: TaskRow, now: number): { kind: string; label: string; status: string; elapsed: string; last: string } {
  const last = r.kind === 'shell' ? safeLine(r.shell.lastLine ?? '') : ''
  return {
    kind: r.kind === 'shell' ? 'shell' : agentKind(r.agent),
    label: taskLabel(r),
    status: taskStatus(r),
    elapsed: taskElapsed(r, now),
    last
  }
}

/** `/tasks`: the numbered list. `width` keeps each row on one line. */
export function renderTaskList(rows: TaskRow[], now: number, paint: Painter, width = 80): string {
  if (!rows.length) {
    return paint('No background tasks in this chat yet: no background shells and no subagents.', 'dim')
  }
  const running = rows.filter(taskRunning).length
  const lines = [paint(`Background tasks (${running} running):`, 'bold')]
  const room = Math.max(20, width - 4)
  rows.forEach((r, i) => {
    const s = taskSummary(r, now)
    const head = `${String(i + 1).padStart(2)}. ${s.kind}  `
    const tail = `  ${s.status}  ${s.elapsed}`
    const label = truncateVisible(s.label, Math.max(12, room - head.length - tail.length))
    lines.push(`  ${paint(head, 'cyan')}${label}${paint(`  ${s.status}`, statusTone(r))}${paint(`  ${s.elapsed}`, 'dim')}`)
    if (s.last) lines.push(paint(`      ${truncateVisible(s.last, Math.max(12, room - 4))}`, 'dim'))
  })
  lines.push(paint('  /tasks <n> shows one, /tasks kill <n> stops one', 'dim'))
  return lines.join('\n')
}

/** The arrow-key picker over the same rows: Enter shows one, `x` stops it. */
export function taskPickerSpec(rows: TaskRow[], now: number, width = 80): PickerSpec {
  const room = Math.max(20, width - 4)
  return {
    title: `Background tasks (${rows.filter(taskRunning).length} running):`,
    enterLabel: 'view',
    actions: [{ id: 'kill', keys: ['x'], label: 'kill' }],
    options: rows.map((r, i) => {
      const s = taskSummary(r, now)
      const desc = `${s.status}, ${s.elapsed}${s.last ? `: ${s.last}` : ''}`
      const label = truncateVisible(`${i + 1}. ${s.kind}  ${s.label}`, Math.max(12, Math.floor(room * 0.6)))
      return {
        label,
        value: String(i),
        description: truncateVisible(desc, Math.max(12, room - label.length - 4))
      }
    })
  }
}

export type TasksOp = { op: 'list' } | { op: 'show'; index: number } | { op: 'kill'; index: number } | { op: 'usage' }

/** `/tasks`, `/tasks <n>`, `/tasks kill <n>` (also `stop <n>`). */
export function parseTasksArgs(arg: string): TasksOp {
  const words = arg.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return { op: 'list' }
  const num = (w: string | undefined): number | null => {
    const n = Number(w)
    return w !== undefined && /^\d+$/.test(w) && n >= 1 ? n : null
  }
  if (words.length === 1) {
    const n = num(words[0])
    return n !== null ? { op: 'show', index: n } : { op: 'usage' }
  }
  if (words.length === 2 && (words[0] === 'kill' || words[0] === 'stop')) {
    const n = num(words[1])
    return n !== null ? { op: 'kill', index: n } : { op: 'usage' }
  }
  return { op: 'usage' }
}

export const TASKS_USAGE = '· usage: /tasks, /tasks <n> to show one, /tasks kill <n> to stop one'

/** Lines of a shell's output `/tasks <n>` shows. */
export const TASK_TAIL_LINES = 40
/** Steps of a subagent `/tasks <n>` shows. */
const DETAIL_STEPS = 20
/** Lines of a subagent's report `/tasks <n>` shows. */
const DETAIL_REPORT_LINES = 40

function header(r: TaskRow, n: number, now: number, paint: Painter): string {
  const s = taskSummary(r, now)
  return `${paint(`Task ${n}`, 'bold')} ${paint(`(${s.kind})`, 'dim')}  ${paint(s.status, statusTone(r))}${paint(`  ${s.elapsed}`, 'dim')}`
}

/** `/tasks <n>` for a shell: the command and its last lines (secrets already masked). */
export function renderShellDetail(r: Extract<TaskRow, { kind: 'shell' }>, n: number, tail: string[] | undefined, now: number, paint: Painter): string {
  const lines = [header(r, n, now, paint), `  $ ${taskLabel(r)}`]
  if (r.shell.urls?.length) lines.push(paint(`  serving ${r.shell.urls.map(safeLine).join(', ')}`, 'dim'))
  const out = (tail ?? []).map((l) => stripControlChars(l).trimEnd()).filter((l) => l.length > 0)
  if (!out.length) lines.push(paint('  (no output yet)', 'dim'))
  else {
    lines.push(paint(`  last ${out.length} line${out.length === 1 ? '' : 's'}:`, 'dim'))
    for (const l of out.slice(-TASK_TAIL_LINES)) lines.push(`    ${l}`)
  }
  if (taskRunning(r)) lines.push(paint(`  /tasks kill ${n} stops it`, 'dim'))
  return lines.join('\n')
}

/** `/tasks <n>` for a subagent: its task, its recent steps, and its report once it ends. */
export function renderSubagentDetail(r: Extract<TaskRow, { kind: 'subagent' }>, n: number, now: number, paint: Painter, width = 80): string {
  const a = r.agent
  const room = Math.max(20, width - 6)
  const lines = [header(r, n, now, paint), `  ${taskLabel(r)}`, paint(`  model ${safeLine(a.model)}`, 'dim')]
  if (a.backgroundId) lines.push(paint(`  background agent ${safeLine(a.backgroundId)}: the turn goes on while it works`, 'dim'))
  const task = safeLine(a.prompt)
  if (task) lines.push(paint(`  task: ${truncateVisible(task, room * 2)}`, 'dim'))
  const steps = a.steps.filter((s) => s.kind !== 'text' || s.summary.trim())
  if (steps.length) {
    const shown = steps.slice(-DETAIL_STEPS)
    lines.push(paint(`  ${steps.length > shown.length ? `last ${shown.length} of ${steps.length}` : `${steps.length}`} step${steps.length === 1 ? '' : 's'}:`, 'dim'))
    for (const s of shown) lines.push(`    ${truncateVisible(safeLine(stepLine(s)), room)}`)
  } else lines.push(paint('  (no steps yet)', 'dim'))
  if (a.report !== undefined && a.status !== 'running') {
    const report = a.report
      .split('\n')
      .map((l) => stripControlChars(l).trimEnd())
    while (report.length && !report[report.length - 1]) report.pop()
    if (report.some((l) => l)) {
      lines.push(paint('  report:', 'dim'))
      for (const l of report.slice(0, DETAIL_REPORT_LINES)) lines.push(`    ${l}`)
      if (report.length > DETAIL_REPORT_LINES) lines.push(paint(`    … ${report.length - DETAIL_REPORT_LINES} more lines`, 'dim'))
    }
  }
  if (a.status === 'running' && a.runId) lines.push(paint(`  /tasks kill ${n} stops it`, 'dim'))
  return lines.join('\n')
}

/** What stopping a shell did, for the line `/tasks kill` prints. */
export function shellKillPhrase(n: number, outcome: KillShellOutcome): string {
  switch (outcome) {
    case 'killed':
      return `· stopping task ${n}: asked it to stop, and it is forced to after a few seconds`
    case 'killed-leftovers':
      return `· task ${n} had exited; stopped what it left running`
    case 'already-exited':
      return `· task ${n} had already finished; nothing was running`
    case 'not-found':
      return `· task ${n} is no longer tracked`
  }
}

/** Agents the live panel names before it says how many more there are. */
const PANEL_AGENTS = 4

/** The step an agent is on, or last finished, as one line. */
function lastStep(a: TrackedSubagent): string {
  for (let i = a.steps.length - 1; i >= 0; i--) {
    const s = a.steps[i]
    if (s.kind === 'text' && !s.summary.trim()) continue
    return safeLine(stepLine(s))
  }
  return 'starting'
}

/** Tool calls an agent has finished so far. */
function stepCount(a: TrackedSubagent): number {
  return a.steps.filter((s) => s.kind === 'tool' && s.ok !== undefined).length
}

/**
 * The live panel under the spinner while subagents run: one row per agent (its name,
 * step count, elapsed time and the step it is on), then how to watch them. Every row
 * fits `width`, since the panel is redrawn in place and a wrapped row could not be.
 * Empty when none is running.
 */
export function liveAgentPanel(agents: TrackedSubagent[], now: number, paint: Painter, width = 80): string[] {
  const running = agents.filter((a) => a.status === 'running')
  if (!running.length) return []
  const room = Math.max(20, width - 1)
  const rows = running.slice(0, PANEL_AGENTS).map((a) => {
    const name = truncateVisible(taskLabel({ kind: 'subagent', agent: a }), Math.max(12, Math.floor(room * 0.4)))
    const n = stepCount(a)
    const facts = `${n} step${n === 1 ? '' : 's'} · ${formatDuration(Math.max(0, now - a.startedAt))}`
    const used = 4 + visibleWidth(name) + 2 + facts.length + 2
    const step = truncateVisible(lastStep(a), Math.max(8, room - used))
    return truncateVisible(`  ${paint(`▸ ${name}`, 'cyan')}${paint(`  ${facts}`, 'dim')}  ${step}`, room)
  })
  const more = running.length - PANEL_AGENTS
  const hint = `${more > 0 ? `+${more} more · ` : ''}Enter watches ${running.length === 1 ? 'it' : 'them'} live`
  rows.push(paint(truncateVisible(`    ${hint}`, room), 'dim'))
  return rows
}

/**
 * The live view of a turn's subagents (Enter on the panel): each agent's task and
 * every step it has taken so far, as plain lines, oldest agent first. The viewer
 * renders it again as steps arrive.
 */
export function liveAgentLines(agents: TrackedSubagent[], now: number): string[] {
  if (!agents.length) return ['No subagents in this turn yet.']
  const lines: string[] = []
  for (const a of agents) {
    if (lines.length) lines.push('')
    const status = taskStatus({ kind: 'subagent', agent: a })
    const elapsed = formatDuration(Math.max(0, (a.endedAt ?? now) - a.startedAt))
    lines.push(`${taskLabel({ kind: 'subagent', agent: a })}  (${status}, ${elapsed}, ${safeLine(a.model)})`)
    const task = safeLine(a.prompt)
    if (task) lines.push(`  task: ${task}`)
    const steps = a.steps.filter((s) => s.kind !== 'text' || s.summary.trim())
    if (!steps.length) lines.push('  (no steps yet)')
    for (const s of steps) lines.push(`  ${s.turn}. ${safeLine(stepLine(s))}`)
  }
  return lines
}
