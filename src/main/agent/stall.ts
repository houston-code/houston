import type { ToolCall } from '@shared/agent'
import type { ToolKind } from './tools'

/**
 * Stall / loop detection for the agent turn loop.
 *
 * A model that has lost the plot tends to fail in a few recognizable ways:
 *  - it re-issues the *same* tool call with the *same* arguments over and over
 *    (re-reading a file it already read, re-running a command whose output it
 *    already has), never using the result;
 *  - it hits the *same* error repeatedly (a bad path, a failing command) and
 *    keeps retrying it verbatim instead of changing approach;
 *  - it "spins" — several iterations of read-only tool calls with no edit or
 *    command that actually changes the workspace, making no forward progress.
 *
 * None of these is fatal on its own, but left unchecked they burn the whole
 * iteration/cost budget without landing a change. The detector watches the
 * per-iteration tool pattern and, when a threshold is crossed, asks the loop to
 * inject ONE corrective nudge (a real user-style message the model sees next
 * turn). If the same pattern persists after the nudge, it escalates to a stop
 * so the run ends cleanly instead of looping forever.
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
  /** This many consecutive iterations with no workspace-mutating call → stall. */
  noProgressLimit: number
}

/** Sensible defaults — conservative enough not to fire on normal exploration. */
export const DEFAULT_STALL_THRESHOLDS: StallThresholds = {
  repeatCallLimit: 3,
  repeatErrorLimit: 3,
  noProgressLimit: 6
}

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
    repeatErrorLimit: pick(override?.repeatErrorLimit, DEFAULT_STALL_THRESHOLDS.repeatErrorLimit),
    noProgressLimit: pick(override?.noProgressLimit, DEFAULT_STALL_THRESHOLDS.noProgressLimit)
  }
}

/**
 * Tool kinds that actually change the workspace. A run consisting only of reads
 * (or of `ask_user`, `find_tools`, etc.) is making no forward progress on the
 * task, which is what `noProgressLimit` watches for. `network`/`mcp` are treated
 * as non-mutating for progress purposes: they may have side effects, but they're
 * not edits to the tree, and counting an opaque MCP call as "progress" would let
 * a model spin on a read-only MCP query forever.
 */
const MUTATING_KINDS: ReadonlySet<ToolKind> = new Set<ToolKind>(['write', 'shell'])

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
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

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
  /** Did any call this iteration invoke a workspace-mutating (write/shell) tool? */
  mutated: boolean
}

/** What the loop should do after an iteration. */
export type StallAction =
  /** Nothing unusual — carry on. */
  | { kind: 'ok' }
  /** Inject this corrective reminder as a user message before the next turn. */
  | { kind: 'nudge'; message: string }
  /** The stall persisted past the nudge — end the run with a 'stalled' limit. */
  | { kind: 'stop'; reason: string }

/** Options controlling how aggressively the detector may end a run. */
export interface StallOptions {
  /**
   * True when a human is watching the run (the TUI or GUI). The no-progress
   * stall — several turns of read-only work with no file change — is a weak
   * signal that legitimately fires on investigation, planning, code review, and
   * plain Q&A. When a user is present to react, we nudge once but never hard-stop
   * on it, so a long read-only investigation isn't killed out from under them.
   * The stronger repeated-call / repeated-error stalls (a genuinely stuck model)
   * still stop, and headless/autonomous runs keep the no-progress stop as a
   * budget guard. Defaults to false (headless behavior) so callers opt in.
   */
  interactive?: boolean
}

/**
 * Stateful, per-run stall detector. Construct one per `startRun`, call
 * {@link StallDetector.observe} once per iteration with that iteration's calls +
 * errors, and act on the returned {@link StallAction}. All counting logic lives
 * here so the loop only has to thread observations in and react.
 */
export class StallDetector {
  private readonly thresholds: StallThresholds
  private readonly interactive: boolean
  /** Count of consecutive iterations ending with a given repeated call signature. */
  private repeatCall: { sig: string; count: number } | null = null
  /** Count of consecutive iterations ending with a given repeated error signature. */
  private repeatError: { sig: string; count: number } | null = null
  /** Consecutive iterations with no workspace-mutating call. */
  private noProgress = 0
  /**
   * True once we've injected the corrective nudge and are giving the model one
   * chance to change course. If the very next stall trips, we escalate to stop
   * rather than nudging again (a model that ignores the nudge won't be helped by
   * a second identical one).
   */
  private nudged = false

  constructor(thresholds: StallThresholds = DEFAULT_STALL_THRESHOLDS, opts: StallOptions = {}) {
    this.thresholds = thresholds
    this.interactive = opts.interactive === true
  }

  observe(obs: IterationObservation): StallAction {
    const repeatedCallSig = this.trackRepeatedCall(obs.calls)
    const repeatedErrorSig = this.trackRepeatedError(obs.errors)
    this.noProgress = obs.mutated ? 0 : this.noProgress + 1

    const trigger = this.pickTrigger(repeatedCallSig, repeatedErrorSig)
    if (!trigger) return { kind: 'ok' }

    if (this.nudged) {
      // Already gave a nudge and the model kept stalling. Escalate to stop only
      // for stalls that may end the run; a no-progress stall in an interactive
      // session can't (see `canStop`) — a human is watching, so we stay quiet
      // rather than kill their read-only investigation. Reset so we don't
      // re-evaluate the same tally every iteration and re-enter this branch.
      if (trigger.canStop) return { kind: 'stop', reason: trigger.reason }
      this.reset()
      return { kind: 'ok' }
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
   * Update the repeated-error tally. Any error signature that recurs across
   * consecutive iterations bumps its count; an iteration with no matching error
   * resets it. Only the single most-recent error signature is tracked, which is
   * enough to catch the common "keep retrying the one broken call" loop.
   *
   * The inputs are normalized through {@link errorSignature} here, so callers can
   * pass RAW tool output (with its `Error: ` prefix, incidental whitespace, and
   * arbitrary length) and near-identical failures still collapse to the same
   * signature. `errorSignature` is idempotent, so passing an already-normalized
   * string is harmless.
   */
  private trackRepeatedError(rawErrors: string[]): string | null {
    if (rawErrors.length === 0) {
      this.repeatError = null
      return null
    }
    const errors = rawErrors.map(errorSignature)
    // Match against the running signature if present this iteration; otherwise
    // start tracking the first error seen.
    const sig =
      this.repeatError && errors.includes(this.repeatError.sig)
        ? this.repeatError.sig
        : errors[0]
    if (this.repeatError && this.repeatError.sig === sig) {
      this.repeatError.count += 1
    } else {
      this.repeatError = { sig, count: 1 }
    }
    return this.repeatError.count >= this.thresholds.repeatErrorLimit ? sig : null
  }

  /**
   * Choose which stall (if any) tripped, and build the matching human message.
   * Repeated-call and repeated-error stalls are more specific (they name the
   * offending call/error), so they win over the generic no-progress stall. Each
   * trigger reports whether it may end the run (`canStop`): the two specific
   * stalls always can, while the weak no-progress stall may only stop a
   * non-interactive run (see {@link StallOptions.interactive}).
   */
  private pickTrigger(
    repeatedCallSig: string | null,
    repeatedErrorSig: string | null
  ): { message: string; reason: string; canStop: boolean } | null {
    if (repeatedCallSig) {
      return {
        reason: 'repeated the same tool call',
        canStop: true,
        message:
          'You appear to be repeating the same tool call with the same arguments, and you ' +
          'already have that result. Do not run it again — use the result you already have and ' +
          'change your approach. If you genuinely cannot make progress this way, stop and ' +
          'summarize what you found and what is blocking you.'
      }
    }
    if (repeatedErrorSig) {
      return {
        reason: 'repeated the same failing action',
        canStop: true,
        message:
          `You keep hitting the same error ("${repeatedErrorSig}") from the same action. ` +
          'Retrying it unchanged will not help. Change your approach and fix the underlying ' +
          'cause. If you cannot get past it, stop and explain what is blocking you rather than ' +
          'retrying.'
      }
    }
    if (this.noProgress >= this.thresholds.noProgressLimit) {
      return {
        reason: 'made no progress for several turns',
        // A weak signal — read-only investigation/planning legitimately trips it.
        // Interactively it nudges only; headless it may stop as a budget guard.
        canStop: !this.interactive,
        message:
          'You have gone several turns without making any change to the project (no edits or ' +
          'commands that alter files). If you have enough information, make the change now. If ' +
          'you are stuck, change your approach; if that is not possible, stop and summarize your ' +
          'findings and what is blocking you.'
      }
    }
    return null
  }

  /** Clear the running tallies (used after a nudge so the next window is fresh). */
  private reset(): void {
    this.repeatCall = null
    this.repeatError = null
    this.noProgress = 0
  }
}

/** Whether a tool kind counts as a workspace-mutating action (edit/command). */
export function isMutatingKind(kind: ToolKind | undefined): boolean {
  return kind !== undefined && MUTATING_KINDS.has(kind)
}
