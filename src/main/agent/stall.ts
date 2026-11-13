import { createHash } from 'node:crypto'
import type { ToolCall } from '@shared/agent'

/**
 * Stall / loop detection for the agent turn loop.
 *
 * A model that has lost the plot tends to fail in two recognizable ways:
 *  - it re-issues the *same* tool call with the *same* arguments over and over
 *    (re-reading a file it already read, re-running a command whose output it
 *    already has), never using the result;
 *  - it hits the *same* error repeatedly (a bad path, a failing command) and
 *    keeps retrying it verbatim instead of changing approach.
 *
 * Two quieter shapes of the same failure don't repeat back to back, so they're
 * judged over a short sliding window of recent iterations ({@link STALL_WINDOW}):
 *  - it tweaks something and reruns a command that keeps failing the SAME way (same
 *    command, same exit code, same output once timings are ignored), or alternates
 *    between two calls or two errors;
 *  - it edits a file back to a version that file already had this turn, more than
 *    once: the edits go back and forth instead of forward.
 *
 * Neither is fatal on its own, but left unchecked they burn the whole iteration
 * budget without landing a change. The detector watches the per-iteration tool
 * pattern and, when a threshold is crossed, asks the loop to inject ONE corrective
 * nudge (a real user-style message the model sees next turn). If the same pattern
 * persists after the nudge, it escalates to a stop so the run ends cleanly instead
 * of looping forever.
 *
 * (A third, weaker "no forward progress" heuristic — several read-only turns with
 * no file mutation — was removed: it fired on legitimate investigation, planning,
 * review, and Q&A, and the real budget/loop guards are `maxIterations`, the two
 * stalls below, and the optional cost ceiling.)
 *
 * This module is intentionally pure and side-effect free: the loop feeds it the
 * calls/errors of each iteration and acts on the returned decision. That keeps
 * it unit-testable in isolation (see stall.test.ts) and keeps the loop readable.
 */

/** Tunable thresholds; the loop resolves these from settings with defaults. */
export interface StallThresholds {
  /** Same (tool,args) signature repeated at least this many times → stall. */
  repeatCallLimit: number
  /** Same error signature seen at least this many times → stall. */
  repeatErrorLimit: number
}

/** Sensible defaults — conservative enough not to fire on normal exploration. */
export const DEFAULT_STALL_THRESHOLDS: StallThresholds = {
  repeatCallLimit: 3,
  repeatErrorLimit: 3
}

/**
 * How many recent iterations the windowed checks (a repeated error, a command failing
 * the same way, edits going back and forth) look over. Long enough to see an
 * edit-then-rerun cycle come round three times, short enough that a failure from much
 * earlier in a long turn doesn't count against a fresh attempt.
 */
export const STALL_WINDOW = 8

/** Times one file may be put back to an earlier version inside the window before it's a loop. */
export const REVERT_LIMIT = 2

/**
 * Resolve effective thresholds from a (possibly partial) user override, clamping
 * each to a sane minimum so a bogus 0/negative can't disable detection or make it
 * fire on the very first iteration. `undefined`/invalid falls back to the default.
 */
export function resolveStallThresholds(
  override?: Partial<StallThresholds>
): StallThresholds {
  const pick = (v: number | undefined, dflt: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 2 ? Math.floor(v) : dflt
  return {
    repeatCallLimit: pick(override?.repeatCallLimit, DEFAULT_STALL_THRESHOLDS.repeatCallLimit),
    repeatErrorLimit: pick(override?.repeatErrorLimit, DEFAULT_STALL_THRESHOLDS.repeatErrorLimit)
  }
}

/**
 * A stable, order-independent signature for a tool call: its name plus a
 * canonical hash of its arguments. Object keys are sorted so `{a:1,b:2}` and
 * `{b:2,a:1}` collapse to the same signature — the model repeating a call with
 * the keys in a different order is still the same call.
 */
export function callSignature(call: Pick<ToolCall, 'name' | 'arguments'>): string {
  return `${call.name}:${canonicalJson(call.arguments)}`
}

/** Deterministic JSON with recursively sorted object keys (arrays keep order). */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/**
 * Normalize an error string into a signature so near-identical failures collapse.
 * We strip the leading `Error: ` prefix the loop adds, collapse runs of
 * whitespace, and cap the length so a giant stack trace doesn't defeat matching
 * on its tail. Two calls that fail "the same way" should hash the same.
 */
export function errorSignature(output: string): string {
  return output
    .replace(/^Error:\s*/, '')
    // A failed edit names the closest region it found, with a line range and a
    // similarity that shift with every slightly different retry; the failure is the
    // same one, so keep only that it failed.
    .replace(/The closest match is lines? \d+(?:-\d+)? \(\d+% similar\):[\s\S]*/, 'The closest match is elsewhere.')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/**
 * The text a failed call is tracked by: its tool and target path, then its error. The
 * path keeps two files' failures apart (a failed edit's message doesn't name its file),
 * and the tool keeps a read error apart from a write error with the same wording.
 */
export function failedCallKey(call: Pick<ToolCall, 'name' | 'arguments'>, output: string): string {
  const path = typeof call.arguments.path === 'string' ? ` ${call.arguments.path}` : ''
  return `${call.name}${path}: ${output.replace(/^Error:\s*/, '')}`
}

/**
 * Tools that only read files or code structure. One of these repeated with the same
 * arguments while nothing has changed returns what the model already has.
 * `read_shell_output` is left out on purpose: polling a running server is how waiting
 * on it looks.
 */
export const FILE_READ_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_dir',
  'glob',
  'search_files',
  'ast_grep',
  'lsp_definition',
  'lsp_references',
  'lsp_hover',
  'lsp_document_symbols',
  'lsp_workspace_symbols'
])

/** One iteration's worth of observations fed to the detector. */
export interface IterationObservation {
  /** The tool calls the model made this iteration (empty for a text-only turn). */
  calls: ToolCall[]
  /**
   * RAW output from this iteration's failed tool results (ok === false). The
   * detector normalizes these internally via {@link errorSignature}, so callers
   * pass the tool output verbatim — no need to signature it at the push site.
   */
  errors: string[]
  /**
   * `run_shell` commands this iteration that ran to completion and exited non-zero
   * (see {@link commandFailureOf}). A failing command is a successful tool call, so
   * these never appear in `errors`.
   */
  commandFailures?: CommandFailure[]
  /**
   * The calls this iteration that only read files (read_file, search_files, list_dir,
   * glob, ...). One repeated with nothing changed since it last ran returns what the
   * model already has.
   */
  reads?: ToolCall[]
  /** Whether a call this iteration could have changed something (any non-read call). */
  changed?: boolean
  /** Files (workspace-relative) a write this iteration put back to content they already had this turn. */
  reverts?: string[]
}

/** A shell command that ran to completion and exited non-zero. */
export interface CommandFailure {
  command: string
  exitCode: number
  /** The output the model saw, compared with timings and addresses ignored. */
  output: string
}

/**
 * The failure a `run_shell` result reports, or null when the command passed, was
 * killed, timed out, or is still running in the background. Reads the `[exit code:
 * N]` line run_shell appends (the last one, in case the command printed a lookalike).
 */
export function commandFailureOf(call: Pick<ToolCall, 'name' | 'arguments'>, output: string): CommandFailure | null {
  if (call.name !== 'run_shell' || typeof call.arguments.command !== 'string') return null
  if (call.arguments.background === true) return null
  const codes = [...output.matchAll(/^\[exit code: (\d+)\]$/gm)]
  const code = codes.length ? Number(codes[codes.length - 1]![1]) : 0
  if (!Number.isInteger(code) || code === 0) return null
  return { command: call.arguments.command, exitCode: code, output }
}

/**
 * The parts of a command's output that change between identical runs (durations,
 * clock times, ISO timestamps, memory addresses, temp paths, process ids) masked,
 * so two runs that fail the same way compare equal and two that fail differently
 * (other tests, other counts) don't.
 */
function failureDigest(f: CommandFailure): string {
  const body = f.output
    .replace(/^\[exit code: \d+\]$/gm, '')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ns|µs|us|ms|s|sec|secs|seconds|m|min)\b/g, '<dur>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<addr>')
    .replace(/\/(?:private\/)?(?:var\/folders|tmp)\/[^\s'"]+/g, '<tmp>')
    .replace(/\bpid[ =:]?\d+\b/gi, '<pid>')
    .replace(/\s+/g, ' ')
    .trim()
  const tail = body.slice(-4000)
  return createHash('sha256').update(`${f.command}\u0000${f.exitCode}\u0000${tail}`).digest('hex').slice(0, 16)
}

/** A command as quoted back to the model: one line, cut short. */
function shownCommand(command: string): string {
  const line = command.replace(/\s+/g, ' ').trim()
  return line.length > 120 ? `${line.slice(0, 117)}...` : line
}

/**
 * The note before the extra step a stalled run gets once the stall persisted past the
 * nudge: tools are off and the model is asked for a reply, so the turn ends on an
 * explanation instead of a bare tool result. `reason` is a {@link StallAction} stop reason.
 */
export function stallFinalNote(reason: string): string {
  return (
    `You ${reason} even after being told to change approach, so this turn is ending now. ` +
    'This is its last step: tool calls made now will NOT run. Reply to the user in plain text ' +
    'only: what you were trying to do, what you tried, what keeps going wrong, and what would ' +
    'get past it (something they could check or decide, or a different approach to take next).'
  )
}

/**
 * Shown to the user when that last step produced no text, so a stalled turn still ends
 * on a readable message. User-facing.
 */
export const STALL_STOP_FALLBACK =
  'I stopped because I kept repeating the same steps without making progress. ' +
  'Say "continue" with any guidance and I will try a different approach.'

/** One iteration as the windowed checks remember it. */
interface WindowEntry {
  errors: Set<string>
  failures: Map<string, CommandFailure>
  reverts: Set<string>
}

/** What the loop should do after an iteration. */
export type StallAction =
  /** Nothing unusual — carry on. */
  | { kind: 'ok' }
  /** Inject this corrective reminder as a user message before the next turn. */
  | { kind: 'nudge'; message: string }
  /** The stall persisted past the nudge — end the run with a 'stalled' limit. */
  | { kind: 'stop'; reason: string }

/**
 * Stateful, per-run stall detector. Construct one per `startRun`, call
 * {@link StallDetector.observe} once per iteration with that iteration's calls +
 * errors, and act on the returned {@link StallAction}. All counting logic lives
 * here so the loop only has to thread observations in and react.
 */
export class StallDetector {
  private readonly thresholds: StallThresholds
  /** Count of consecutive iterations ending with a given repeated call signature. */
  private repeatCall: { sig: string; count: number } | null = null
  /** File-read calls made since the last iteration that could have changed something. */
  private readsSinceChange = new Map<string, number>()
  /** The last {@link STALL_WINDOW} iterations, newest last, for the windowed checks. */
  private window: WindowEntry[] = []
  /**
   * True once we've injected the corrective nudge and are giving the model one
   * chance to change course. If the very next stall trips, we escalate to stop
   * rather than nudging again (a model that ignores the nudge won't be helped by
   * a second identical one).
   */
  private nudged = false

  constructor(thresholds: StallThresholds = DEFAULT_STALL_THRESHOLDS) {
    this.thresholds = thresholds
  }

  observe(obs: IterationObservation): StallAction {
    const repeatedCallSig = this.trackRepeatedCall(obs.calls) ?? this.trackRepeatedReads(obs)
    this.remember(obs)
    const repeatedErrorSig = this.repeatedInWindow((e) => e.errors, this.thresholds.repeatErrorLimit)
    const failureSig = this.repeatedInWindow((e) => new Set(e.failures.keys()), this.thresholds.repeatErrorLimit)
    const failure = failureSig ? this.window[this.window.length - 1]!.failures.get(failureSig)! : null
    const reverted = this.repeatedInWindow((e) => e.reverts, REVERT_LIMIT)

    const trigger = this.pickTrigger(repeatedCallSig, repeatedErrorSig, failure, reverted)
    if (!trigger) return { kind: 'ok' }

    if (this.nudged) {
      // Already gave a nudge and the model kept stalling — end the run cleanly.
      return { kind: 'stop', reason: trigger.reason }
    }
    // First offense: inject one corrective reminder and reset the counters so we
    // don't immediately re-trip on the same tally next iteration; give the model
    // a clean window to change approach.
    this.nudged = true
    this.reset()
    return { kind: 'nudge', message: trigger.message }
  }

  /**
   * Update the repeated-call tally. A "repeat" only counts calls that recur
   * across iterations: if this iteration made the exact same single call as the
   * running signature, bump the count; any different call pattern resets it. We
   * key on the *set* of call signatures this iteration so a lone repeated read is
   * caught while a genuinely varied multi-call turn resets progress.
   */
  private trackRepeatedCall(calls: ToolCall[]): string | null {
    if (calls.length === 0) {
      this.repeatCall = null
      return null
    }
    const sigs = calls.map(callSignature)
    // The signature of this iteration's call pattern: sorted+joined so a turn that
    // reissues the same batch (in any order) matches its predecessor.
    const patternSig = [...sigs].sort().join('|')
    if (this.repeatCall && this.repeatCall.sig === patternSig) {
      this.repeatCall.count += 1
    } else {
      this.repeatCall = { sig: patternSig, count: 1 }
    }
    return this.repeatCall.count >= this.thresholds.repeatCallLimit ? patternSig : null
  }

  /**
   * The same file read made again and again with nothing changed in between, even when
   * other calls sit between the repeats (read a, read b, read a, read b, ...). Any
   * iteration that could have changed something (a write, a command) starts the count
   * over, since a read after it may see something new.
   */
  private trackRepeatedReads(obs: IterationObservation): string | null {
    let hit: string | null = null
    for (const call of obs.reads ?? []) {
      const sig = callSignature(call)
      const count = (this.readsSinceChange.get(sig) ?? 0) + 1
      this.readsSinceChange.set(sig, count)
      if (count >= this.thresholds.repeatCallLimit && hit === null) hit = sig
    }
    if (obs.changed) this.readsSinceChange.clear()
    return hit
  }

  /** Add this iteration to the sliding window, dropping the oldest past its length. */
  private remember(obs: IterationObservation): void {
    const failures = new Map<string, CommandFailure>()
    for (const f of obs.commandFailures ?? []) failures.set(failureDigest(f), f)
    this.window.push({
      errors: new Set(obs.errors.map(errorSignature)),
      failures,
      reverts: new Set(obs.reverts ?? [])
    })
    if (this.window.length > STALL_WINDOW) this.window.shift()
  }

  /**
   * A signature from the newest iteration that appears in at least `limit` iterations
   * of the window (the newest included), or null. Only the newest iteration's
   * signatures are candidates, so a loop trips on the iteration that completes it.
   */
  private repeatedInWindow(pick: (e: WindowEntry) => Set<string>, limit: number): string | null {
    const newest = this.window[this.window.length - 1]
    if (!newest) return null
    for (const sig of pick(newest)) {
      let count = 0
      for (const entry of this.window) if (pick(entry).has(sig)) count++
      if (count >= limit) return sig
    }
    return null
  }

  /**
   * Choose which stall (if any) tripped, and build the matching human message.
   * The repeated-call stall wins (it names the offending call directly), then a
   * repeated error, then a command failing the same way, then edits going back and
   * forth. Any of them may end the run once it persists past the nudge.
   */
  private pickTrigger(
    repeatedCallSig: string | null,
    repeatedErrorSig: string | null,
    failure: CommandFailure | null,
    reverted: string | null
  ): { message: string; reason: string } | null {
    if (repeatedCallSig) {
      return {
        reason: 'repeated the same tool call',
        message:
          'You appear to be repeating the same tool call with the same arguments, and you ' +
          'already have that result. Do not run it again. Use the result you already have and ' +
          'change your approach. If you genuinely cannot make progress this way, stop and ' +
          'summarize what you found and what is blocking you.'
      }
    }
    if (repeatedErrorSig) {
      return {
        reason: 'repeated the same failing action',
        message:
          `You keep hitting the same error ("${repeatedErrorSig}") from the same action. ` +
          'Retrying it unchanged will not help. Change your approach and fix the underlying ' +
          'cause. If you cannot get past it, stop and explain what is blocking you rather than ' +
          'retrying.'
      }
    }
    if (failure) {
      return {
        reason: 'reran a command that kept failing the same way',
        message:
          `The command \`${shownCommand(failure.command)}\` keeps failing the same way (exit code ` +
          `${failure.exitCode}, same output) even though you changed things between runs, so those ` +
          'changes are not reaching the cause. Stop rerunning it after small tweaks. Read its output ' +
          'and the code it points at closely, work out why it fails, and fix that. If you cannot get ' +
          'past it, stop and explain what is blocking you.'
      }
    }
    if (reverted) {
      return {
        reason: 'kept undoing the same edits',
        message:
          `You have put ${reverted} back to a version it already had earlier in this turn more than ` +
          'once, so your edits are going back and forth instead of forward. Stop alternating between ' +
          'the same changes. Work out why neither version works before you edit it again, or stop and ' +
          'explain what is blocking you.'
      }
    }
    return null
  }

  /** Clear the running tallies (used after a nudge so the next window is fresh). */
  private reset(): void {
    this.repeatCall = null
    this.readsSinceChange.clear()
    this.window = []
  }
}
