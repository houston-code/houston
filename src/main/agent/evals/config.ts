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

  if (!live) {
    return { live, record, providerId, model: SCRIPTED_MODEL, attempts }
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
  return { live, record, providerId, model, attempts }
}
