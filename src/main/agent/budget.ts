import { DEFAULT_ITERATION_CEILING, DEFAULT_MAX_ITERATIONS } from '@shared/defaults'

export { DEFAULT_ITERATION_CEILING }

/**
 * Adaptive turn-budget helper for the agent loop.
 *
 * The loop runs at most a fixed number of iterations before it gives up on a
 * turn (historically a flat MAX_ITERATIONS constant). Two problems with a hard
 * flat cap:
 *  - The run dies at the cap mid-edit, emitting a `limit` and stopping with a
 *    half-finished change. The model never got a chance to *land* — to finish
 *    the current edit or, failing that, summarize what's left.
 *  - Cost isn't considered at all: a run can chew through a large budget in a
 *    handful of very expensive turns and still be nowhere near the iteration cap.
 *
 * This module keeps the cap configurable and adds a one-time "landing" nudge:
 * when the run is within a small margin of the cap OR has crossed a cumulative
 * cost ceiling, the loop injects a single reminder telling the model it's almost
 * out of runway so it wraps up cleanly instead of being cut off. The hard cap is
 * still enforced (this only softens the *approach* to it).
 *
 * Pure and side-effect free: the loop feeds it the current iteration / remaining
 * iterations / accumulated cost and acts on the decision. Unit-tested standalone
 * in budget.test.ts.
 */

/** Tunable budget bounds; the loop resolves these from settings with defaults. */
export interface BudgetLimits {
  /** Hard cap on loop iterations for a single turn. */
  maxIterations: number
  /**
   * Iterations-remaining margin at which to inject the landing nudge. When the
   * run has `<= landingMargin` iterations left before the cap, it's told to wrap
   * up. Kept small so the nudge only fires near the end.
   */
  landingMargin: number
  /**
   * Cumulative USD cost ceiling for a single run. Once accumulated turn cost
   * crosses this, the landing nudge fires regardless of iteration count. `0`
   * disables the cost-based trigger (iterations-only landing).
   */
  costCeilingUsd: number
}

/**
 * Defaults. `maxIterations` matches the historical flat cap so behavior is
 * unchanged for users who don't tune it. `costCeilingUsd: 0` means cost never
 * triggers a landing unless the user opts in with a positive ceiling — we don't
 * want to surprise anyone with a cost-based wrap-up they didn't ask for.
 */
export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  maxIterations: DEFAULT_MAX_ITERATIONS,
  landingMargin: 3,
  costCeilingUsd: 0
}

/** Which budget threshold tripped the landing nudge. */
export type LandingTrigger = 'steps' | 'cost'

/**
 * The one-time reminder injected as the run approaches its budget. The cost-ceiling
 * trigger deliberately does NOT cite a step count: it can fire with many iterations
 * still left, so "N steps left" would be misleading — it's the accumulated cost, not
 * the iteration cap, that's forcing the wrap-up. The steps trigger keeps the precise
 * remaining-iteration count.
 */
export function landingReminder(iterationsLeft: number, trigger: LandingTrigger = 'steps'): string {
  const wrapUp =
    'Wrap up now: finish the change you are in the middle of, or if you cannot finish, ' +
    'stop and summarize what remains so the user can continue. Do not start anything ' +
    'large you cannot complete.'
  if (trigger === 'cost') {
    return `This run has reached its cost budget for the turn. ${wrapUp}`
  }
  const steps = Math.max(0, iterationsLeft)
  const count = steps === 1 ? '1 step' : `${steps} steps`
  return `You have about ${count} left before this turn's limit. ${wrapUp}`
}

/**
 * Resolve effective budget limits from a (possibly partial) user override,
 * clamping to sane minimums. `maxIterations` must be at least 1; `landingMargin`
 * is clamped to `[0, maxIterations-1]` so the nudge can't fire before the run
 * even starts; a negative cost ceiling is treated as disabled (0).
 */
export function resolveBudgetLimits(override?: Partial<BudgetLimits>): BudgetLimits {
  const maxIterations =
    typeof override?.maxIterations === 'number' &&
    Number.isFinite(override.maxIterations) &&
    override.maxIterations >= 1
      ? Math.floor(override.maxIterations)
      : DEFAULT_BUDGET_LIMITS.maxIterations

  const rawMargin =
    typeof override?.landingMargin === 'number' &&
    Number.isFinite(override.landingMargin) &&
    override.landingMargin >= 0
      ? Math.floor(override.landingMargin)
      : DEFAULT_BUDGET_LIMITS.landingMargin
  const landingMargin = Math.min(rawMargin, Math.max(0, maxIterations - 1))

  const costCeilingUsd =
    typeof override?.costCeilingUsd === 'number' &&
    Number.isFinite(override.costCeilingUsd) &&
    override.costCeilingUsd > 0
      ? override.costCeilingUsd
      : 0

  return { maxIterations, landingMargin, costCeilingUsd }
}

/** Inputs to the landing decision, evaluated once per iteration. */
export interface BudgetState {
  /** Zero-based index of the iteration about to run. */
  iteration: number
  /** Cumulative USD cost of the run so far (sum of per-turn `turnCostUsd`). */
  costUsd: number
  /** Whether the landing nudge has already been injected (it's one-time). */
  alreadyLanded: boolean
}

/**
 * Decide whether to inject the one-time landing nudge before this iteration.
 * Fires when the run is within `landingMargin` iterations of the cap, OR when a
 * positive cost ceiling has been crossed — but only once per run (guarded by
 * `alreadyLanded`). Returns the iterations-left figure and which threshold tripped
 * (`trigger`) so the caller can phrase the reminder precisely. When both trip at
 * once the cost ceiling wins, since it's the more surprising limit to hit.
 */
export function shouldLand(
  state: BudgetState,
  limits: BudgetLimits
): { land: boolean; iterationsLeft: number; trigger: LandingTrigger } {
  const iterationsLeft = limits.maxIterations - state.iteration
  const nearCap = iterationsLeft <= limits.landingMargin
  const overCost = limits.costCeilingUsd > 0 && state.costUsd >= limits.costCeilingUsd
  const trigger: LandingTrigger = overCost ? 'cost' : 'steps'
  if (state.alreadyLanded) return { land: false, iterationsLeft, trigger }
  return { land: nearCap || overCost, iterationsLeft, trigger }
}

/**
 * The note pushed before the LAST iteration of a turn. The landing reminder above is
 * advisory and a model can ignore it (seen in a real session: told "3 steps left",
 * it kept editing and the turn ended on a bare tool result with no summary). On the
 * last iteration the loop therefore also drops any tool call the model makes, so
 * this note tells it up front that tools won't run and a summary is the only useful
 * reply.
 */
export const FINAL_STEP_NOTE =
  "This is the last step of this turn: tool calls made now will NOT run. Reply to the user " +
  "in plain text only: what you finished, what is still left, and that they can say " +
  '"continue" to pick it up.'

/**
 * Shown to the user when the last iteration produced only tool calls and no text, so
 * a capped turn still ends on a readable message instead of silence. User-facing.
 */
export const FINAL_STEP_FALLBACK =
  "I reached this turn's step limit before finishing, so I've stopped here. " +
  'Say "continue" to pick up where I left off.'

/**
 * Whether iteration `iter` (zero-based) is the last one the budget allows. A one-step
 * budget never counts as "final" so the model can still use tools in it.
 */
export function isFinalStep(iter: number, limits: BudgetLimits): boolean {
  return limits.maxIterations > 1 && iter === limits.maxIterations - 1
}

/**
 * Progress-aware extension of the iteration cap.
 *
 * A flat cap can't tell a run that is looping from one that is simply big: a
 * from-scratch scaffold writes one file per step and hit the old 40-step cap
 * two thirds of the way through, so the user had to type "continue" on work
 * that was going fine. So when a run reaches the point where it would be told to
 * land, it instead gets another `step` iterations IF it is demonstrably making
 * progress: successful file writes in several of its recent steps, or steady
 * discovery (most of its recent steps turned up something it had not seen this
 * run), no stall nudge in that window, and no cost-ceiling landing. A hard
 * `ceiling` bounds the total so a productive-looking runaway still stops.
 */
export interface ExtensionLimits {
  /** Whether a productive run may grow past `maxIterations` at all. */
  enabled: boolean
  /** Absolute iteration cap the extensions can never exceed. */
  ceiling: number
  /** Iterations granted per extension (the configured base cap). */
  step: number
}

/**
 * Tools whose success counts as progress for {@link shouldExtend}: file edits and a
 * writable subagent (which edits files itself). Deliberately narrower than every
 * write-kind tool: scheduling or cancelling a run changes no project file, so a run
 * doing only that is not getting a big job done.
 */
export const PROGRESS_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'notebook_edit',
  'dispatch_writable_agent',
  'lsp_rename'
])

/**
 * Bookkeeping tools a successful, never-before-made call of which still isn't
 * discovery: they reshuffle what the run already knows (its todo list, its own
 * history, a shell it started) rather than learning anything about the project.
 */
const NON_DISCOVERY_TOOLS: ReadonlySet<string> = new Set([
  'todo_write',
  'recall_history',
  'kill_shell',
  'list_scheduled_runs',
  'skill',
  'ask_user',
  'present_plan',
  'propose_session'
])

/** Tool kinds whose calls can find something out: reads, commands, and outside lookups. */
const DISCOVERY_KINDS: ReadonlySet<string> = new Set(['read', 'shell', 'network', 'mcp'])

/**
 * Whether a successful call of tool `name` (of kind `kind`) can count as discovery for
 * {@link shouldExtend}, when the run hasn't made that exact call before. A debugging or
 * investigation turn spends most of its steps reading, searching, and running commands
 * before the one edit that fixes the bug, so counting file writes alone wrapped those
 * turns up at the cap with the fix still unwritten. Write-kind tools never count here:
 * file edits are counted by {@link PROGRESS_TOOLS}, and the rest (scheduling) changes no
 * project file.
 */
export function isDiscoveryTool(name: string, kind: string | undefined): boolean {
  return kind !== undefined && DISCOVERY_KINDS.has(kind) && !NON_DISCOVERY_TOOLS.has(name)
}

/** How many recent iterations the progress test looks back over. */
export const PROGRESS_WINDOW = 10

/** Iterations with a successful file write needed inside the window. */
export const MIN_PRODUCTIVE_STEPS = 3

/**
 * Iterations that wrote a file or discovered something new needed inside the window
 * when there aren't {@link MIN_PRODUCTIVE_STEPS} writes. Higher than the write bar
 * because a new call is weaker evidence than a landed edit: most of the window has to
 * be finding things out, so a model trading a few fresh reads for a run of repeats
 * still wraps up.
 */
export const MIN_ACTIVE_STEPS = 6

/**
 * Resolve extension limits against the already-resolved base cap. A ceiling at
 * or below the base cap (including a user who raised `maxIterations` above the
 * default ceiling) simply means no extension.
 */
export function resolveExtensionLimits(
  base: BudgetLimits,
  override?: { autoExtend?: boolean; ceiling?: number }
): ExtensionLimits {
  const rawCeiling =
    typeof override?.ceiling === 'number' &&
    Number.isFinite(override.ceiling) &&
    override.ceiling >= 1
      ? Math.floor(override.ceiling)
      : DEFAULT_ITERATION_CEILING
  const ceiling = Math.max(rawCeiling, base.maxIterations)
  return {
    enabled: override?.autoExtend !== false && ceiling > base.maxIterations,
    ceiling,
    step: base.maxIterations
  }
}

/** Inputs to the extension decision, evaluated once per iteration before landing. */
export interface ExtensionState {
  /** Zero-based index of the iteration about to run. */
  iteration: number
  /** Iterations (zero-based) in which at least one file write succeeded. */
  writeIterations: ReadonlySet<number>
  /**
   * Iterations (zero-based) in which at least one discovery call (see
   * {@link isDiscoveryTool}) succeeded that the run had not made before.
   */
  discoveryIterations: ReadonlySet<number>
  /** Iteration of the most recent stall nudge, or null if none fired. */
  lastStallNudge: number | null
  /** Whether the landing nudge already fired (e.g. the cost ceiling tripped). */
  alreadyLanded: boolean
}

/**
 * Whether to raise the cap before this iteration, and to what. Only considered
 * when the run is at the point the landing nudge would fire, so an extension
 * always pre-empts the wrap-up rather than contradicting one already sent.
 */
export function shouldExtend(
  state: ExtensionState,
  limits: BudgetLimits,
  ext: ExtensionLimits
): { extend: false } | { extend: true; maxIterations: number } {
  if (!ext.enabled || state.alreadyLanded) return { extend: false }
  if (limits.maxIterations >= ext.ceiling) return { extend: false }
  const iterationsLeft = limits.maxIterations - state.iteration
  if (iterationsLeft > Math.max(limits.landingMargin, 1)) return { extend: false }

  const from = state.iteration - PROGRESS_WINDOW
  if (state.lastStallNudge !== null && state.lastStallNudge >= from) return { extend: false }
  let writes = 0
  let active = 0
  for (let i = Math.max(0, from); i < state.iteration; i++) {
    const wrote = state.writeIterations.has(i)
    if (wrote) writes++
    if (wrote || state.discoveryIterations.has(i)) active++
  }
  if (writes < MIN_PRODUCTIVE_STEPS && active < MIN_ACTIVE_STEPS) return { extend: false }

  return { extend: true, maxIterations: Math.min(ext.ceiling, limits.maxIterations + ext.step) }
}

/** The transcript notice shown when a productive turn's budget is extended. User-facing. */
export function extensionNotice(maxIterations: number, ceiling: number): string {
  return (
    `Still making progress, so this turn can run up to ${maxIterations} steps ` +
    `(hard limit ${ceiling}). Stop it any time.`
  )
}
