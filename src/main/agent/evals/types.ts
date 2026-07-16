/**
 * Task-level eval types and the small DSL task fixtures are written in.
 *
 * An eval task is a SWE-bench-style unit of work: a fixture repo with a seeded
 * defect, a prompt describing the job, and a verify command that exits non-zero
 * until the job is actually done. The suite runs the REAL agent loop against the
 * fixture and grades on the verify command's exit code — did the harness carry
 * the work to a green test, not did it emit the right-looking tokens.
 *
 * Two drivers consume the same fixtures (see `evals.eval.ts`):
 *
 *  - **scripted** (default) — a fake provider replays `script`, so the run is
 *    deterministic, offline, and free. The model's plan is baked in, so a task
 *    only fails when the *harness* fails to carry that plan to a green verify:
 *    a tool that stops dispatching, an edit that lands in the wrong place, an
 *    approval that never resolves, a tool result that never reaches the model.
 *    This is what gates every PR.
 *  - **live** (`HOUSTON_EVAL_LIVE=1`) — a real provider drives the same fixture
 *    with `script` ignored, scoring genuine per-model task success. Non-deterministic
 *    and metered, so it never gates a PR; it runs on a schedule.
 *
 * The split matters: a task that passes scripted and fails live is a model
 * capability signal; one that fails scripted is a harness regression.
 */
import type { ProviderStreamEvent, ToolCall } from '@shared/agent'
import type { ApprovalPolicy } from '@shared/types'

/** A command run in the finished workspace to grade the task. Exit 0 = solved. */
export interface EvalVerify {
  /** Executable, spawned with no shell (argv array, like every other spawn here). */
  cmd: string
  args: string[]
}

/**
 * One scripted model turn — the events a single `streamChat` call yields. Build
 * these with {@link turn}; the provider replays one per model round-trip.
 */
export type ScriptedTurn = ProviderStreamEvent[]

export interface EvalTask {
  /** Stable id. MUST equal the task's directory name (asserted in the suite). */
  id: string
  /** One line describing what the agent is asked to accomplish. */
  title: string
  /** The user message that starts the run. */
  prompt: string
  /**
   * How the fixture is graded, run in the workspace after the agent stops.
   * Must FAIL on the untouched fixture (the suite asserts this precheck), so a
   * task can never pass vacuously — a verify that was already green would grade
   * every future regression as a pass.
   */
  verify: EvalVerify
  /**
   * Files restored from the pristine fixture before grading. Defaults to
   * `['test.mjs']`.
   *
   * The test is the SPEC, and the prompts deliberately don't say what the fix is
   * — so the cheapest way to make `node test.mjs` exit 0 is to edit test.mjs. A
   * live model that deletes the failing assertion would otherwise grade as having
   * solved the task. Restoring the test before running it makes tampering
   * pointless rather than merely forbidden, which is the only version that holds
   * against a model doing its best to satisfy the letter of the request.
   */
  verifyFiles?: string[]
  /**
   * Scripted model turns for the deterministic driver. Ignored in live mode.
   * When the script runs out the provider ends the turn, so the final `endTurn()`
   * is only needed where the agent should speak before stopping.
   */
  script: ScriptedTurn[]
  /**
   * Approval policy for the run. Defaults to `full-auto`. Note the suite always
   * resolves approval prompts anyway: `full-auto` can NOT auto-approve an
   * unsandboxed shell (by design — see the sandbox consent gate), and CI hosts
   * without a working sandbox would otherwise hang the run waiting on a prompt
   * nobody answers.
   */
  policy?: ApprovalPolicy
}

// ---- script DSL ----
//
// Scripted turns are the bulk of each fixture, so they get a DSL rather than
// hand-written event literals — the shape is noisy enough to hide a typo'd tool
// name, and a typo'd tool name grades as a harness failure.

/** Assistant text streamed to the user. */
export function say(text: string): ProviderStreamEvent {
  return { type: 'text', text }
}

/** A tool call. `id` must be unique within a task (the loop keys results by it). */
export function callTool(id: string, name: string, args: ToolCall['arguments']): ProviderStreamEvent {
  return { type: 'tool_call', call: { id, name, arguments: args } }
}

/**
 * Fixed token usage on every scripted turn. Without it the loop falls back to a
 * char-count estimate over a prompt that embeds the machine-specific workspace
 * path, making reported cost differ between macOS and Linux CI for no reason.
 */
const SCRIPTED_USAGE = { inputTokens: 1000, outputTokens: 50 } as const

/**
 * End the turn after tool calls, so the loop dispatches them and comes back.
 * Named for the `tool_use` stop reason it emits — and deliberately not `useTools`,
 * which the React hooks lint rule reads as a hook called outside a component.
 */
export function toolUse(): ProviderStreamEvent {
  return { type: 'done', stopReason: 'tool_use', usage: { ...SCRIPTED_USAGE } }
}

/** End the run — the model has nothing left to do. */
export function endTurn(): ProviderStreamEvent {
  return { type: 'done', stopReason: 'end_turn', usage: { ...SCRIPTED_USAGE } }
}

/**
 * Assemble one scripted turn, appending the terminating `done` event when the
 * caller didn't: `tool_use` if the turn called tools, `end_turn` otherwise. That
 * default is what makes most fixtures a one-liner.
 */
export function turn(...events: ProviderStreamEvent[]): ScriptedTurn {
  if (events.some((e) => e.type === 'done')) return events
  const calledTools = events.some((e) => e.type === 'tool_call')
  return [...events, calledTools ? toolUse() : endTurn()]
}

// ---- results ----

/** How one task fared under one driver. */
export interface EvalResult {
  taskId: string
  /** The verify command exited 0 after the run. */
  passed: boolean
  /** Verify command exit code (`null` when it was killed by the timeout). */
  exitCode: number | null
  /** Combined stdout+stderr of the verify command, for the failure report. */
  verifyOutput: string
  /** Tool calls the agent actually dispatched, in order — the "how" behind a fail. */
  toolsUsed: string[]
  /** Wall-clock of the agent run (excludes fixture setup and verification). */
  durationMs: number
  /** Set when the run itself emitted an error event. */
  error?: string
  /** Estimated USD cost the run reported (live mode; scripted is fixed/fake). */
  costUsd: number
}
