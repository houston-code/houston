import { DEFAULT_MAX_ITERATIONS } from '@shared/defaults'

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
