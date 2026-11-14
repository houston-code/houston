import type { AppSettings } from './types'

/**
 * Resolve a `/model` argument into a provider + model. Accepts `providerId`,
 * `providerId/model`, or a bare model id that a configured provider offers.
 */
export function resolveModelArg(
  arg: string,
  settings: AppSettings
): { providerId: string; model: string } | null {
  const slash = arg.indexOf('/')
  if (slash >= 0) {
    const providerId = arg.slice(0, slash)
    const model = arg.slice(slash + 1)
    const p = settings.providers.find((pr) => pr.id === providerId)
    if (p && model) return { providerId, model }
    return null
  }
  const byProvider = settings.providers.find((p) => p.id === arg)
  if (byProvider) {
    const model = byProvider.defaultModel ?? byProvider.models[0]?.id
    if (model) return { providerId: byProvider.id, model }
    return null
  }
  const owner = settings.providers.find((p) => p.models.some((m) => m.id === arg))
  if (owner) return { providerId: owner.id, model: arg }
  return null
}
