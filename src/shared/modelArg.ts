import type { AppSettings } from './types'

/**
 * Resolve a `/model` argument into a provider + model. Accepts `providerId`,
 * `providerId/model`, or a model id that a configured provider lists. A listed id may
 * itself contain a slash (an aggregator's `deepseek/deepseek-r1`), so a slash only
 * names a provider when the part before it is a configured provider id.
 */
export function resolveModelArg(
  arg: string,
  settings: AppSettings
): { providerId: string; model: string } | null {
  const lists = (providerId: string, model: string): boolean =>
    settings.providers.some((p) => p.id === providerId && p.models.some((m) => m.id === model))
  const owner = settings.providers.find((p) => p.models.some((m) => m.id === arg))
  const slash = arg.indexOf('/')
  if (slash >= 0) {
    const providerId = arg.slice(0, slash)
    const model = arg.slice(slash + 1)
    const p = settings.providers.find((pr) => pr.id === providerId)
    if (p && model) {
      // `provider/model` is Houston's own form (config values, `/model` lists), so it
      // keeps its meaning when that provider lists the model, or when no provider lists
      // the whole string as an id. Only a model the named provider doesn't list gives
      // way to an exact id another provider lists (`openai/gpt-oss-120b` on OpenRouter).
      if (lists(providerId, model) || !owner) return { providerId, model }
      return { providerId: owner.id, model: arg }
    }
    // Not a provider prefix: the whole string is a model id, if anyone lists it.
    return owner ? { providerId: owner.id, model: arg } : null
  }
  const byProvider = settings.providers.find((p) => p.id === arg)
  if (byProvider) {
    const model = byProvider.defaultModel ?? byProvider.models[0]?.id
    if (model) return { providerId: byProvider.id, model }
    return null
  }
  if (owner) return { providerId: owner.id, model: arg }
  return null
}
