/**
 * Failure signals: counts of the ways a run tends to go wrong, mined from the chats
 * saved on this computer so Houston's own behavior can be measured without sending
 * anything anywhere (Houston has no telemetry). Each detector was chosen because it
 * rarely fires on a run that went fine, so a count is worth a look, but they are
 * heuristics: read them as a trend, not a score.
 *
 * Unlike {@link ./scorecard}, which never looks at message content, this module reads
 * the text of replies and tool results, because most of these signals only show
 * there. What it returns is counts only, never any of the text it read. Pure and
 * dependency-free like the scorecard: the main process reads the conversation files
 * and hands them in, and nothing here does I/O.
 *
 * Signals are counted in the same rows as the scorecard ({@link messageGroups}): a
 * reply's signals in its own model's row (and prompt version's, when grouped so), a
 * tool result's in the row of the reply that made the call, and a run's stop in the
 * row of that run's last reply.
 */
import { COMPACTION_SUMMARY_PREFIX, SYSTEM_NOTE_PREFIX, type ChatMessage } from './agent'
import { runEndRecords } from './runEnd'
import {
  groupKeyId,
  messageGroups,
  type Scorecard,
  type ScorecardConversationInput,
  type ScorecardGroupBy,
  type ScorecardGroupKey
} from './scorecard'
import { isShellEscapeRecord } from './shellEscape'

export const FAILURE_SIGNALS = [
  'unanswered',
  'stepLimit',
  'stalled',
  'toolArgError',
  'repeatedError',
  'toolCallAsText',
  'silentTurnEnd',
  'askUserBurst',
  'todoGap',
  'testEdit'
] as const

/**
 * - `unanswered`: a run that ended before the model replied at all (it failed, was
 *   stopped, or hit a limit first), from the record the run left; in a chat saved
 *   before runs left records, a turn the next message followed with no reply.
 * - `stepLimit` / `stalled`: a run the step limit or the stall check ended, from its
 *   record. The scorecard's run-end counts read the same records; they are here so
 *   one row's signals are complete on their own.
 * - `toolArgError`: a tool call refused for its arguments (a missing or mistyped
 *   field, an empty or no-op edit).
 * - `repeatedError`: the same tool failing with the same error for the third time
 *   in one chat.
 * - `toolCallAsText`: a reply that wrote a tool call out as text (or leaked call
 *   markup into a call's arguments) instead of making it.
 * - `silentTurnEnd`: a turn that ended on a tool result with no closing message and
 *   no record of being stopped, failing, or hitting a limit. Like the unanswered turn
 *   without a record, never the chat's latest turn, which may still be running.
 * - `askUserBurst`: a turn that asked the user three or more questions before
 *   changing any file.
 * - `todoGap`: a turn that marked a todo done whose claimed check never passed (the
 *   receipt's `todoGaps`).
 * - `testEdit`: a turn that deleted, skipped, focused or weakened a test (the
 *   receipt's `testEdits`).
 */
export type FailureSignal = (typeof FAILURE_SIGNALS)[number]

export type FailureSignalCounts = Record<FailureSignal, number>

/** How the clients name each signal: a short label, and a sentence for a tooltip or guide. */
export const FAILURE_SIGNAL_INFO: Record<FailureSignal, { label: string; hint: string }> = {
  unanswered: { label: 'no reply', hint: 'Runs that ended before the model replied (an error, a stop, or a limit)' },
  stepLimit: { label: 'step limit', hint: 'Runs the step limit ended' },
  stalled: { label: 'stalled', hint: 'Runs stopped for repeating themselves without progress' },
  toolArgError: { label: 'malformed tool calls', hint: 'Tool calls refused for invalid arguments or an empty edit' },
  repeatedError: { label: 'repeated errors', hint: 'The same tool error a third time in one chat' },
  toolCallAsText: { label: 'tool calls as text', hint: 'Replies that wrote a tool call out as text instead of making it' },
  silentTurnEnd: { label: 'silent ends', hint: 'Turns that ended on a tool result with no closing message' },
  askUserBurst: { label: 'question bursts', hint: 'Turns that asked three or more questions before changing a file' },
  todoGap: { label: 'unchecked todos', hint: 'Todos marked done whose check never passed' },
  testEdit: { label: 'loosened tests', hint: 'Turns that deleted, skipped or weakened a test' }
}

/**
 * The signals the clients list. The step limit and stall stops are left out because
 * the scorecard's run-end counts beside them already show those, from the same records.
 */
export const LISTED_FAILURE_SIGNALS: readonly FailureSignal[] = FAILURE_SIGNALS.filter(
  (s) => s !== 'stepLimit' && s !== 'stalled'
)

/** The part of a conversation the detectors read. */
export type FailureSignalsInput = Pick<ScorecardConversationInput, 'model' | 'messages' | 'inherited'>

/** One row's signals. */
export interface FailureSignalGroup extends ScorecardGroupKey {
  /** Conversations with a reply or a signal counted here. */
  chats: number
  /** Replies counted here: the denominator for a rate. */
  replies: number
  signals: FailureSignalCounts
}

export interface FailureSignalReport {
  groupBy: ScorecardGroupBy
  /** Most signals first, then by model id and prompt id. */
  groups: FailureSignalGroup[]
  /** Every group's signals added up. */
  totals: FailureSignalCounts
}

export function emptyFailureSignalCounts(): FailureSignalCounts {
  return Object.fromEntries(FAILURE_SIGNALS.map((s) => [s, 0])) as FailureSignalCounts
}

/** The tools that change files: a question asked after one of these isn't "before any work". */
const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'multi_edit', 'apply_patch', 'notebook_edit'])

/** Injected notes from versions of Houston that wrote them without {@link SYSTEM_NOTE_PREFIX}. */
const LEGACY_NOTE = /^(?:You have about \d+ steps left|You have gone several turns)/

/**
 * The refusals a malformed call gets: the argument validator's, and the edit tools'
 * own for an empty edit list, an empty `old_string`, or an edit that changes nothing.
 * A hook's invalid rewrite is the hook's fault, not the model's, and isn't matched.
 */
const TOOL_ARG_ERROR =
  /^(?:Invalid arguments for tool |Error: (?:edits must be a non-empty array|(?:edit \d+: )?old_string must not be empty|(?:edit \d+: )?old_string and new_string are identical))/

/** A tool call written into a reply's text: JSON call shapes, or tool-call markup. */
const TOOL_CALL_TEXT = /"name"\s*:\s*"\w+",\s*"arguments"|<tool_response>|<parameter name=/

/** A failed tool result: a tool's error, or a shell command's non-zero exit. */
function isErrorResult(content: string): boolean {
  return /^(?:Error|ERR|gh failed)/.test(content) || /^\[?exit code: [1-9]\d*\]?$/m.test(content)
}

/**
 * Whether a user-role message starts a turn: something the user sent that started a
 * run. Houston's injected notes, a compaction summary, a message steered into a
 * running turn, and the record of a `!cmd` the user ran are not.
 */
function startsTurn(m: ChatMessage): boolean {
  if (m.role !== 'user' || m.steered) return false
  const text = m.content
  return (
    !text.startsWith(SYSTEM_NOTE_PREFIX) &&
    !text.startsWith(COMPACTION_SUMMARY_PREFIX) &&
    !LEGACY_NOTE.test(text) &&
    !isShellEscapeRecord(text)
  )
}

function argsHoldCallMarkup(args: unknown): boolean {
  try {
    return (JSON.stringify(args) ?? '').includes('<parameter')
  } catch {
    return false
  }
}

/**
 * Count the signals in one conversation, each at the index of the message it was
 * found on. Only the chat's own messages (after `inherited`) are counted; the copied
 * part is still walked, so a turn that began there is read whole.
 */
function detect(input: FailureSignalsInput, hit: (signal: FailureSignal, index: number) => void): void {
  const msgs = input.messages
  const start = Math.max(0, input.inherited ?? 0)
  // Turns, as [first, last] message index; the part before the first turn (a
  // compaction summary, say) is a stretch of its own that no user message started.
  const turns: Array<{ from: number; to: number; started: boolean }> = []
  for (let i = 0; i < msgs.length; i++) {
    if (i === 0 || startsTurn(msgs[i])) turns.push({ from: i, to: i, started: startsTurn(msgs[i]) })
    else turns[turns.length - 1].to = i
  }
  // Failures by tool and error, across the chat: the third of one is a signal.
  const errors = new Map<string, number>()
  turns.forEach((t, ti) => {
    let replied = false
    let recorded = false
    let wrote = false
    let asks = 0
    for (let i = t.from; i <= t.to; i++) {
      const m = msgs[i]
      const own = i >= start
      if (m.role === 'assistant') {
        replied = true
        if (own) {
          if (TOOL_CALL_TEXT.test(m.content) || (m.toolCalls ?? []).some((c) => argsHoldCallMarkup(c.arguments))) {
            hit('toolCallAsText', i)
          }
          if (m.receipt?.todoGaps?.length) hit('todoGap', i)
          if ((m.receipt?.testEdits?.length ?? 0) + (m.receipt?.testEditsOmitted ?? 0) > 0) hit('testEdit', i)
        }
        for (const c of m.toolCalls ?? []) {
          if (c.name === 'ask_user' && !wrote && ++asks === 3 && own) hit('askUserBurst', i)
          if (FILE_EDIT_TOOLS.has(c.name)) wrote = true
        }
      } else if (m.role === 'tool' && own) {
        const head = m.content.slice(0, 200)
        if (TOOL_ARG_ERROR.test(head)) hit('toolArgError', i)
        if (isErrorResult(m.content)) {
          const key = `${m.toolName ?? ''}\u0000${head.slice(0, 80).replace(/\d+/g, 'N')}`
          const n = (errors.get(key) ?? 0) + 1
          errors.set(key, n)
          if (n === 3) hit('repeatedError', i)
        }
      }
      for (const r of runEndRecords(m)) {
        recorded = true
        if (!own) continue
        if (!replied) hit('unanswered', i)
        if (r.reason === 'limit' && (r.limit ?? 'max-steps') === 'max-steps') hit('stepLimit', i)
        if (r.reason === 'limit' && r.limit === 'stalled') hit('stalled', i)
      }
    }
    // The checks on how a turn ended skip the latest one: it may still be running.
    const followed = ti < turns.length - 1
    const last = msgs[t.to]
    if (
      followed &&
      t.to > t.from &&
      t.to >= start &&
      last.role === 'tool' &&
      runEndRecords(last).length === 0 &&
      !/^(?:Denied|No result)/.test(last.content)
    ) {
      hit('silentTurnEnd', t.to)
    }
    // A chat saved before runs left records: a turn the user followed with another
    // message, with no reply between.
    if (followed && t.started && t.from >= start && !replied && !recorded) hit('unanswered', t.from)
  })
}

/**
 * Count the failure signals across a set of conversations, per model (or per model
 * and prompt version). Pure: no I/O, no clock, and nothing but counts in the result.
 */
export function buildFailureSignals(
  conversations: readonly FailureSignalsInput[],
  options: { groupBy?: ScorecardGroupBy } = {}
): FailureSignalReport {
  const groupBy = options.groupBy ?? 'model'
  const groups = new Map<string, FailureSignalGroup>()
  const groupFor = (key: ScorecardGroupKey): FailureSignalGroup => {
    const id = groupKeyId(key)
    let g = groups.get(id)
    if (!g) {
      g = { ...key, chats: 0, replies: 0, signals: emptyFailureSignalCounts() }
      groups.set(id, g)
    }
    return g
  }

  for (const input of conversations) {
    const keys = messageGroups(input.messages, input.model, groupBy)
    const start = Math.max(0, input.inherited ?? 0)
    const touched = new Set<FailureSignalGroup>()
    for (let i = start; i < input.messages.length; i++) {
      if (input.messages[i].role !== 'assistant') continue
      const g = groupFor(keys[i])
      g.replies++
      touched.add(g)
    }
    detect(input, (signal, i) => {
      const g = groupFor(keys[i])
      g.signals[signal]++
      touched.add(g)
    })
    for (const g of touched) g.chats++
  }

  const sum = (c: FailureSignalCounts): number => FAILURE_SIGNALS.reduce((n, s) => n + c[s], 0)
  const list = [...groups.values()].sort(
    (x, y) =>
      sum(y.signals) - sum(x.signals) ||
      x.model.localeCompare(y.model) ||
      (x.promptId ?? '').localeCompare(y.promptId ?? '')
  )
  const totals = emptyFailureSignalCounts()
  for (const g of list) for (const s of FAILURE_SIGNALS) totals[s] += g.signals[s]
  return { groupBy, groups: list, totals }
}

/**
 * The scorecard with each row's failure signals attached (zero for a row with none),
 * for clients that show the two together. Both must have been built with the same
 * grouping; a report grouped differently attaches nothing.
 */
export function attachFailureSignals(card: Scorecard, report: FailureSignalReport): Scorecard {
  if (card.groupBy !== report.groupBy) return card
  const byKey = new Map(report.groups.map((g) => [groupKeyId(g), g.signals]))
  return {
    ...card,
    models: card.models.map((row) => ({
      ...row,
      signals: { ...(byKey.get(groupKeyId(row)) ?? emptyFailureSignalCounts()) }
    }))
  }
}

/** A row's listed signals that fired, as labeled counts in {@link LISTED_FAILURE_SIGNALS} order. */
export function signalParts(c: FailureSignalCounts): Array<{ signal: FailureSignal; label: string; count: number }> {
  return LISTED_FAILURE_SIGNALS.filter((s) => c[s] > 0).map((s) => ({
    signal: s,
    label: FAILURE_SIGNAL_INFO[s].label,
    count: c[s]
  }))
}
