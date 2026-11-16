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
import type {
  AgentEvent,
  ChatMessage,
  PlanDecision,
  ProviderStreamEvent,
  RunLimitReason,
  ToolApprovalDecision,
  ToolCall
} from '@shared/agent'
import type { TurnReceipt } from '@shared/evidence'
import type { ApprovalPolicy } from '@shared/types'
import type { HonestyGrade } from './honesty'

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
   * Checks the agent never sees. The task's `holdout/` directory is copied into the
   * workspace after the run (over whatever is there), and this command must pass as
   * well as `verify` for the task to count as solved. Must also fail on the untouched
   * fixture (the suite asserts it).
   *
   * `verify` is the repro a user would hand over: the reported symptom. With unlimited
   * reruns, any capable model iterates a visible test to green, so a suite of visible
   * tests alone measures persistence and saturates. The holdout checks the rest of the
   * behaviour that the prompt, the visible test or the fixture's own docs already
   * specify: other spellings of the same input, the second caller of the same broken
   * helper, the documented feature the obvious fix breaks. It grades whether the agent
   * fixed the bug or only the example of it.
   *
   * Never hide an unstated preference here. Every holdout check must be traceable to
   * something the agent could read, or the task measures luck.
   */
  holdout?: EvalVerify
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

// ---- behavior probes ----
//
// A task grades whether the work got done; a probe grades HOW the agent went about
// it, over its next few actions: did it paste a file it was told already exists,
// rerun a command that just failed twice, write after Plan mode came on. No task
// can see those, so an A/B of a prompt note aimed at one (an A/B of the per-family
// notes once did) finds no difference whatever the note does. A probe is short
// (`maxActions` bounds it) so a live run of all of them stays cheap.
//
// Probes are an A/B instrument, never part of a baseline: they run only when
// HOUSTON_EVAL_TASKS names them (`probes`, or `probe:<id>`), and their rows are
// reported as `probe:<id>` (see probeResultId), which the gate never grades.

/** One tool call the agent made in a run, in the order it made them. */
export interface AgentCall {
  callId: string
  name: string
  /** The arguments as the model sent them (after the loop's shape coercion). */
  args: Record<string, unknown>
  /** The tool's kind, when it is a built-in (a name the model made up has none). */
  kind?: 'read' | 'write' | 'shell' | 'network' | 'mcp'
  /**
   * The call ran. False when the loop refused it before it started: invalid
   * arguments, Plan mode, a deny rule. A refused call is still something the agent
   * tried, which is what most probes grade.
   */
  ran: boolean
  /** The call's result. Both are absent when the run stopped before it was answered. */
  ok?: boolean
  output?: string
}

/** Everything a run did, as `runAgent` in evals.eval.ts collects it. */
export interface AgentRun {
  /** Every event the run emitted, in order. */
  events: AgentEvent[]
  /** The tool calls the agent made in this run (not the seeded ones), in its order. */
  calls: AgentCall[]
  /** Each approval prompt and how it was answered. */
  approvals: Array<{ callId: string; name: string; args?: Record<string, unknown>; decision: ToolApprovalDecision }>
  /** Each ask_user question and the answer it got. */
  questions: Array<{ callId: string; question: string; answer: string }>
  /** Each present_plan review and the decision it got. */
  plans: Array<{ callId: string; decision: PlanDecision }>
  /**
   * The closing message: the text after the last tool call that started, as headless
   * reports it (text beside a call the loop refused stays), including any reply the
   * loop sent back for another round (the interactive clients keep it on screen).
   */
  finalText: string
  receipt?: TurnReceipt
  /** The conversation as the loop last saved it, seeded messages included. */
  messages: ChatMessage[]
  /** The error event the run ended on, if any. */
  error?: string
  /** The limit the run stopped at, if it hit one. */
  limit?: RunLimitReason
  /** The cost cap's wrap-up reminder reached the model (it emits no event of its own). */
  costReminded?: boolean
  /** True when the run was stopped at its `maxActions`, before it finished on its own. */
  cutOff: boolean
  costUsd: number
  durationMs: number
  /** See EvalResult. */
  promptHash?: string
  promptId?: string
  slowestCall?: TimedCall
}

/** What a probe's `onEvent` hook can see of, and do to, the run it watches. Fresh per run. */
export interface RunControl {
  /** The policy the run started in, or the last one `setPolicy` switched it to. */
  readonly policy: ApprovalPolicy
  /** Switch the run's approval policy, as the clients' mode toggle does (the loop's setRunPolicy). */
  setPolicy(policy: ApprovalPolicy): void
}

/** A probe's verdict on one run. */
export interface ProbeGrade {
  passed: boolean
  /** Why, in a line or two: the scorecard shows it for a failure. */
  detail: string
}

/**
 * A behavior probe: a small workspace, a request (or a conversation seeded up to the
 * moment that matters), and a grader that reads what the agent did next.
 *
 * Every probe ships a scripted run that passes its grader AND one that fails it, and
 * the scripted suite runs both through the real loop, so each grader is tested at no
 * cost and a grader that passes everything fails CI.
 */
export interface ProbeTask {
  /** Stable id, equal to its file name under `probes/`. Reported as `probe:<id>`. */
  id: string
  /** One line saying what the probe checks. */
  title: string
  /**
   * The model family whose prompt note this probe exercises, when it targets one (the
   * families `prompt.ts` writes notes for). Informational: every probe runs on every model.
   */
  family?: 'openai' | 'gemini' | 'local'
  /** The user message that starts the run. Exactly one of `prompt` and `messages`. */
  prompt?: string
  /**
   * A conversation to resume instead, seeded up to the behavior under test (a tool
   * result the agent must react to). Every seeded tool result must be what the loop
   * really returns for that call: the scripted suite replays the seeded calls and
   * compares, so a change to a tool's output can't leave a seed describing the old one.
   * A function when a result depends on the host (see {@link ProbeHost}); read it
   * through {@link seededMessages}.
   */
  messages?: ChatMessage[] | ((host: ProbeHost) => ChatMessage[])
  /** Approval policy for the run. Defaults to `full-auto`, as tasks do. */
  policy?: ApprovalPolicy
  /**
   * Stop the run (the loop's cancelRun) once this many of its tool calls have been
   * answered. What keeps a probe cheap; set it to the fewest actions the grader needs.
   */
  maxActions: number
  /** Write the workspace's files. Called on a fresh, empty folder named `repo`. */
  setup(ws: string): void
  /**
   * Pages `web_fetch` serves for this probe, by URL. A probe never reaches the real
   * network: any other URL answers 404. The fetch pipeline (URL checks, HTML to
   * markdown, the untrusted-content fence and classifier) runs for real.
   */
  web?: Record<string, ProbePage>
  /** Called with every event as it streams, to change the run mid-flight (a mode switch). */
  onEvent?(e: AgentEvent, run: RunControl): void
  /** Grade what the agent did, from the run and the workspace it left. */
  grade(run: AgentRun, ws: string): ProbeGrade
  /** A scripted run the grader must pass. */
  passScript: ScriptedTurn[]
  /** A scripted run of the failure the probe exists to catch, which the grader must fail. */
  failScript: ScriptedTurn[]
}

/**
 * What a seeded tool result may depend on about the host the eval runs on, so the seed
 * is what the loop really returns there.
 */
export interface ProbeHost {
  /**
   * The note run_shell appends to a command no OS sandbox confined (Windows, a Linux
   * host where bubblewrap can't build a user namespace). Absent where one does.
   */
  unsandboxedShellNote?: string
}

/** A probe's seeded conversation on `host`, or undefined for one that starts from `prompt`. */
export function seededMessages(probe: ProbeTask, host: ProbeHost): ChatMessage[] | undefined {
  return typeof probe.messages === 'function' ? probe.messages(host) : probe.messages
}

/** A page a probe serves to web_fetch. */
export interface ProbePage {
  contentType: string
  body: string
}

/** What a probe's rows are called in results, scorecards and run records. */
export const PROBE_ID_PREFIX = 'probe:'

export function probeResultId(probeId: string): string {
  return `${PROBE_ID_PREFIX}${probeId}`
}

/** A result row that came from a probe, which no baseline records and the gate never grades. */
export function isProbeResultId(taskId: string): boolean {
  return taskId.startsWith(PROBE_ID_PREFIX)
}

/** How one task fared under one driver. */
export interface EvalResult {
  /** The task id, or `probe:<id>` for a probe. */
  taskId: string
  /** The verify command exited 0 after the run (for a probe: its grader passed). */
  passed: boolean
  /** Verify command exit code (`null` when it was killed by the timeout); for a probe, 0 when it passed and 1 when not. */
  exitCode: number | null
  /** Combined stdout+stderr of the verify command, for the failure report (a probe's grader detail). */
  verifyOutput: string
  /** Tool calls the agent actually dispatched, in order — the "how" behind a fail. */
  toolsUsed: string[]
  /** Wall-clock of the agent run (excludes fixture setup and verification). */
  durationMs: number
  /** Set when the run itself emitted an error event. */
  error?: string
  /**
   * True when the run ended on an error event (a provider or harness failure), as
   * opposed to stopping at a limit. Such an attempt measured the failure, not the model.
   */
  runErrored?: boolean
  /**
   * True when the per-attempt cost cap stepped in: it stopped the run (a `max-cost`
   * limit), or its wrap-up reminder reached the model. Such an attempt is graded as
   * failed whatever the verify says: even the reminder sits far above any normal
   * attempt, so reaching it means the run got away, and from there the cap shaped how it
   * ended (see costCaps.ts).
   */
  costCapped?: boolean
  /** Estimated USD cost the run reported (live mode; scripted is fixed/fake). */
  costUsd: number
  /** Whether the closing message claimed more than what ran (see honesty.ts). Report-only. */
  honesty: HonestyGrade
  /** Hash of the first request's system prompt and tools (see stamp.ts). */
  promptHash?: string
  /**
   * The loop's `promptId` for the run (src/main/agent/prompt.ts): Houston's own
   * instructions plus every built-in tool schema on offer, deferred ones included,
   * which the first request names only in find_tools' catalog.
   */
  promptId?: string
  /** The receipt the run emitted, so a dishonest grade can show what it was graded against. */
  receipt?: TurnReceipt
  /** The attempt's slowest tool call, so a slow attempt shows where its time went. */
  slowestCall?: TimedCall
}

/** One tool call and how long it took, from its start to its result. */
export interface TimedCall {
  tool: string
  /** The command or path it was given, when it had one. */
  detail: string
  ms: number
}
