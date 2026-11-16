/**
 * Env resolution for the eval drivers, kept pure so it can be unit-tested.
 *
 * WHY THIS IS ITS OWN MODULE. This logic used to live inline in `evals.eval.ts`,
 * which can only be loaded with the mock preamble and a live provider, so nothing
 * unit-tested it — and it was wrong in the one way that mattered:
 *
 *     process.env.HOUSTON_EVAL_MODEL ?? provider.defaultModel   // BUG
 *
 * `??` falls back on null/undefined but NOT on an empty string, and an env var is
 * routinely SET-BUT-EMPTY: `FOO=` in a shell, and — the case that bit us — GitHub
 * Actions' `env: FOO: ${{ inputs.foo || '' }}`, which on a scheduled run (no inputs)
 * sets the variable to `''`. So the nightly resolved an empty model id, every API
 * call failed, and `eval:baseline` cheerfully recorded a baseline of all zeros.
 * An all-zero baseline is a DEAD gate: nothing can regress below zero, so the job
 * could never fail again while still looking like it was guarding something.
 *
 * The rule this module encodes: **an empty env var means unset.** Everything goes
 * through {@link envOr}, and the resolved config is validated rather than trusted.
 */
import type { ProviderConfig } from '@shared/types'
import { DEFAULT_ATTEMPT_MAX_COST_USD } from './costCaps'
import { isProbeResultId, PROBE_ID_PREFIX, probeResultId } from './types'

/** The model the scripted driver reports; it never reaches a real adapter. */
export const SCRIPTED_MODEL = 'claude-sonnet-5'

export const DEFAULT_LIVE_ATTEMPTS = 3
export const DEFAULT_PROVIDER_ID = 'anthropic'

export interface EvalConfig {
  live: boolean
  /** Record a baseline instead of grading against one. */
  record: boolean
  providerId: string
  model: string
  attempts: number
  /** Where to write the run record (HOUSTON_EVAL_OUT), for `npm run eval:compare`. */
  out?: string
  /** Print each attempt's tool calls, closing message, and receipt as it runs. */
  trace: boolean
  /**
   * Which tasks to run (HOUSTON_EVAL_TASKS): a comma-separated list of task ids, `hard`
   * for the harder subset, `probes` for the behavior probes and `probe:<id>` for one.
   * Absent runs every task and no probe. Resolve it against the registries with
   * {@link selectTasks}.
   */
  tasks?: string
  /**
   * Hash-only mode (HOUSTON_EVAL_HASH_OUT=<file>): write the prompt hash the live
   * provider and model would get, then stop. It drives one run against a fake
   * provider configured like the live one, so it needs no key and makes no network
   * call. The eval-ab workflow uses it to skip an A/B when the pull request leaves
   * the eval prompt unchanged.
   */
  hashOut?: string
  /**
   * Per-attempt cost cap in USD (HOUSTON_EVAL_MAX_COST_USD), passed to the loop as its
   * `maxCostUsd`. Always set: {@link DEFAULT_ATTEMPT_MAX_COST_USD} when the var is unset.
   */
  maxCostUsd: number
  /**
   * True when HOUSTON_EVAL_MAX_COST_USD set `maxCostUsd`, rather than the default: a cap
   * someone set must not pass as enforced when it can't be (see capsEnforceable).
   */
  maxCostUsdSet?: boolean
  /** Per-run cost cap in USD (HOUSTON_EVAL_MAX_RUN_USD). Absent means none. */
  maxRunUsd?: number
}

export type Env = Record<string, string | undefined>

/**
 * Read an env var, treating empty/whitespace-only as unset.
 *
 * This is the whole point of the module: `??` would return `''` here and every
 * downstream default would be silently skipped.
 */
export function envOr(env: Env, name: string, fallback: string): string {
  const v = env[name]
  return v && v.trim() !== '' ? v.trim() : fallback
}

function resolveAttempts(env: Env, live: boolean): number {
  const raw = envOr(env, 'HOUSTON_EVAL_ATTEMPTS', '')
  // Scripted runs are deterministic, so a repeat says nothing. A live model is
  // noisy enough that one attempt per task is a coin-flip signal.
  if (raw === '') return live ? DEFAULT_LIVE_ATTEMPTS : 1
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`HOUSTON_EVAL_ATTEMPTS must be a positive integer, got "${raw}".`)
  }
  return n
}

/**
 * A dollar amount from the environment, or undefined when unset. Decimal digits only, so
 * `$5`, `5 USD`, `1e2` and `-1` stop the run instead of reaching a cap as NaN or a
 * surprise: a cap that silently fails to parse is no cap at all.
 */
function resolveUsd(env: Env, name: string): number | undefined {
  const raw = envOr(env, name, '')
  if (raw === '') return undefined
  const usd = /^(\d+(\.\d*)?|\.\d+)$/.test(raw) ? Number(raw) : NaN
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error(`${name} must be a positive amount in US dollars, like 5 or 0.5, got "${raw}".`)
  }
  return usd
}

/**
 * Resolve the driver configuration from the environment.
 *
 * Throws rather than defaulting when the result would be nonsense (unknown
 * provider, no resolvable model): a run with a bad config fails EVERY task, which
 * reads like a total quality collapse instead of the typo it is.
 */
export function resolveEvalConfig(env: Env, providers: ProviderConfig[]): EvalConfig {
  const live = env.HOUSTON_EVAL_LIVE === '1'
  const record = env.HOUSTON_EVAL_RECORD === '1'
  const providerId = envOr(env, 'HOUSTON_EVAL_PROVIDER', DEFAULT_PROVIDER_ID)
  const attempts = resolveAttempts(env, live)
  const out = envOr(env, 'HOUSTON_EVAL_OUT', '') || undefined
  const trace = env.HOUSTON_EVAL_TRACE === '1'
  const tasks = envOr(env, 'HOUSTON_EVAL_TASKS', '') || undefined
  // A baseline records every task, and the gate reads a task missing from it as
  // unrecorded. Recording a subset would overwrite the file with only those tasks and
  // quietly drop the rest from the weekly gate.
  if (record && tasks) {
    throw new Error('HOUSTON_EVAL_RECORD=1 records every task; unset HOUSTON_EVAL_TASKS to record a baseline.')
  }
  const hashOut = envOr(env, 'HOUSTON_EVAL_HASH_OUT', '') || undefined
  // Hash-only stops before any model call, so it can neither score nor record.
  if (hashOut && (live || record)) {
    throw new Error('HOUSTON_EVAL_HASH_OUT only hashes the prompt; unset HOUSTON_EVAL_LIVE and HOUSTON_EVAL_RECORD.')
  }
  // Both drivers run under the caps: the scripted one never comes near them, and a cap
  // that only the live driver passed would leave its path untested on every PR.
  const attemptUsd = resolveUsd(env, 'HOUSTON_EVAL_MAX_COST_USD')
  const maxCostUsd = attemptUsd ?? DEFAULT_ATTEMPT_MAX_COST_USD
  const maxRunUsd = resolveUsd(env, 'HOUSTON_EVAL_MAX_RUN_USD')
  const common = {
    maxCostUsd,
    ...(attemptUsd !== undefined ? { maxCostUsdSet: true } : {}),
    ...(out ? { out } : {}),
    ...(tasks ? { tasks } : {}),
    ...(hashOut ? { hashOut } : {}),
    ...(maxRunUsd !== undefined ? { maxRunUsd } : {})
  }

  // Hash-only resolves the provider and model exactly as a live run would: the
  // prompt depends on both (the model family picks per-model prompt notes).
  if (!live && !hashOut) {
    return { live, record, providerId, model: SCRIPTED_MODEL, attempts, trace, ...common }
  }

  const provider = providers.find((p) => p.id === providerId)
  if (!provider) {
    const known = providers.map((p) => p.id).join(', ')
    throw new Error(`HOUSTON_EVAL_PROVIDER="${providerId}" is not a known provider id. Known: ${known}.`)
  }
  const model = envOr(env, 'HOUSTON_EVAL_MODEL', provider.defaultModel ?? '')
  if (model === '') {
    throw new Error(
      `No model to evaluate: HOUSTON_EVAL_MODEL is unset and provider "${providerId}" has no defaultModel. ` +
        'Set HOUSTON_EVAL_MODEL explicitly.'
    )
  }
  return { live, record, providerId, model, attempts, trace, ...common }
}

/** The HOUSTON_EVAL_TASKS keyword for the harder subset (see `HARD_TASKS` in tasks/index.ts). */
export const HARD_SUBSET = 'hard'

/** The HOUSTON_EVAL_TASKS keyword for every behavior probe (see `PROBES` in probes/index.ts). */
export const PROBES_SUBSET = 'probes'

/** What a run covers: tasks and probes, each in registry order. */
export interface Selection<T, P> {
  tasks: T[]
  probes: P[]
}

/**
 * The tasks and probes a run covers. No spec runs every task and no probe: probes
 * are an A/B instrument, never part of the scheduled run or a baseline. Otherwise the
 * spec is a comma-separated list of `hard` (the harder subset), `probes` (every
 * probe), `probe:<id>` (one probe) and task ids, each kept in registry order.
 *
 * Throws on an id that isn't registered rather than skipping it: a typo would
 * otherwise run fewer tasks than asked and still report green.
 */
export function selectTasks<T extends { id: string }, P extends { id: string }>(
  all: T[],
  hard: T[],
  spec: string | undefined,
  probes: P[] = []
): Selection<T, P> {
  if (spec === undefined || spec.trim() === '') return { tasks: all, probes: [] }
  const tokens = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const taskIds = new Set<string>()
  const probeIds = new Set<string>()
  const unknown: string[] = []
  for (const token of tokens) {
    if (token === HARD_SUBSET) for (const t of hard) taskIds.add(t.id)
    else if (token === PROBES_SUBSET) for (const p of probes) probeIds.add(p.id)
    else if (isProbeResultId(token) && probes.some((p) => probeResultId(p.id) === token)) {
      probeIds.add(token.slice(PROBE_ID_PREFIX.length))
    } else if (all.some((t) => t.id === token)) taskIds.add(token)
    else unknown.push(token)
  }
  if (unknown.length) {
    throw new Error(
      `HOUSTON_EVAL_TASKS names tasks that aren't registered: ${unknown.join(', ')}. ` +
        `Use "${HARD_SUBSET}", "${PROBES_SUBSET}", ${PROBE_ID_PREFIX}<id> for one probe, ` +
        'or ids from src/main/agent/evals/tasks.'
    )
  }
  const picked = { tasks: all.filter((t) => taskIds.has(t.id)), probes: probes.filter((p) => probeIds.has(p.id)) }
  if (picked.tasks.length + picked.probes.length === 0) throw new Error('HOUSTON_EVAL_TASKS selects no tasks.')
  return picked
}
