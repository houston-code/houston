import { curatedSmallModel } from './model-facts'
import type { ProviderConfig } from './types'
import { resolvePricing } from './usage'

/**
 * Which model a provider's side requests run on (chat titles, compaction summaries,
 * next-message suggestions, the isolated reader for flagged web content). They need
 * far less than the chat's model, and on a flagship model they were most of a short
 * chat's cost. Pure, so the settings control and the main process agree.
 */

/** The `smallModel` value that means "always use the chat's model". */
export const SMALL_MODEL_SAME_AS_CHAT = ''

/**
 * The model to try first for a side request made on behalf of `runModel`, or null to
 * use `runModel` itself:
 *  - `smallModel: ''`: always the chat's model.
 *  - `smallModel` set: that model.
 *  - absent: the kind's curated sibling, when the provider's model list has it and it
 *    costs less than the chat's model (when both prices are known).
 */
export function smallModelFor(
  cfg: Pick<ProviderConfig, 'kind' | 'smallModel' | 'models'>,
  runModel: string
): string | null {
  if (cfg.smallModel === SMALL_MODEL_SAME_AS_CHAT) return null
  const explicit = cfg.smallModel?.trim()
  if (explicit) return explicit === runModel ? null : explicit
  const curated = curatedSmallModel(cfg.kind)
  if (!curated || curated === runModel) return null
  const listed = cfg.models.find((m) => m.id === curated)
  if (!listed) return null
  const small = resolvePricing(curated, listed.caps)
  const run = resolvePricing(runModel, cfg.models.find((m) => m.id === runModel)?.caps)
  if (small && run && small.input >= run.input) return null
  return curated
}

/**
 * What the settings control shows for "Automatic": the curated sibling, when the
 * provider's model list has it (a chat already on a cheaper model keeps its own).
 */
export function automaticSmallModel(cfg: Pick<ProviderConfig, 'kind' | 'models'>): string | null {
  const curated = curatedSmallModel(cfg.kind)
  return curated && cfg.models.some((m) => m.id === curated) ? curated : null
}

/**
 * Run a side request on `small` first, then on `runModel` if that throws or, unless
 * `retryEmpty` is false (where "nothing" is a fair answer), yields nothing usable
 * (`null`, `undefined` or `''`). An abort is never retried: it is rethrown as is.
 * With no small model, the call runs once on `runModel`.
 */
export async function withSmallModel<T>(
  small: string | null,
  runModel: string,
  call: (model: string) => Promise<T>,
  signal?: AbortSignal,
  opts: { retryEmpty?: boolean } = {}
): Promise<T> {
  if (!small || small === runModel) return call(runModel)
  try {
    const out = await call(small)
    if (opts.retryEmpty === false || (out !== null && out !== undefined && out !== '')) return out
  } catch (e) {
    if (signal?.aborted) throw e
  }
  if (signal?.aborted) throw new Error('aborted')
  return call(runModel)
}
