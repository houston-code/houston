import { join } from 'node:path'
import { writeFileAtomicSync } from './atomic-write'
import { readTextOrNull } from './globalRules'
import { getUserDataDir } from './userData'
import type { EnvKeyOffer } from '@shared/types'

/**
 * Offering an API key found in the desktop app's environment for the secure store.
 *
 * The desktop app reads keys from its secure store only and never from the
 * environment (see the key seams in store.ts and wireAgentHost.ts): a variable that
 * happened to be exported must not silently decide which account a chat bills. So a
 * key in ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY is only ever *offered*:
 * the user sees the provider, the variable's name and the key's last four characters,
 * and chooses "Use it" (which checks the key with the provider and stores it) or
 * "Not now". Nothing here stores a key without that choice, and the key itself never
 * leaves the main process or reaches a log: the renderer gets only the last four
 * characters.
 */

/** The variables offered, one per built-in cloud provider. */
export const ENV_KEY_SOURCES: readonly { providerId: string; envVar: string }[] = [
  { providerId: 'anthropic', envVar: 'ANTHROPIC_API_KEY' },
  { providerId: 'openai', envVar: 'OPENAI_API_KEY' },
  { providerId: 'gemini', envVar: 'GEMINI_API_KEY' }
]

/** Shortest and longest value read as a key; anything else is not offered. */
const MIN_KEY_LENGTH = 8
const MAX_KEY_LENGTH = 4096

/**
 * The key `providerId`'s variable holds, trimmed, or null when it is unset, not one of
 * the offered providers, or doesn't look like a key (too short or long, or holding
 * whitespace or control characters, as a pasted multi-line value would).
 */
export function envKeyValue(env: NodeJS.ProcessEnv, providerId: string): string | null {
  const source = ENV_KEY_SOURCES.find((s) => s.providerId === providerId)
  if (!source) return null
  const raw = env[source.envVar]
  if (typeof raw !== 'string') return null
  const key = raw.trim()
  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) return null
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(key)) return null
  return key
}

/**
 * The keys to offer: one per provider whose variable holds a key while no key is
 * stored for it. `includeDismissed` is for the Connect panel, where the user is
 * already setting up that provider; the startup notice leaves out providers the user
 * answered "Not now" for.
 */
export function envKeyOffers(
  env: NodeJS.ProcessEnv,
  deps: {
    providers: readonly { id: string; label: string; requiresKey: boolean }[]
    hasKey: (providerId: string) => boolean
    dismissed: readonly string[]
  },
  includeDismissed = false
): EnvKeyOffer[] {
  const out: EnvKeyOffer[] = []
  for (const { providerId, envVar } of ENV_KEY_SOURCES) {
    const provider = deps.providers.find((p) => p.id === providerId)
    if (!provider?.requiresKey || deps.hasKey(providerId)) continue
    if (!includeDismissed && deps.dismissed.includes(providerId)) continue
    const key = envKeyValue(env, providerId)
    if (!key) continue
    out.push({ providerId, providerLabel: provider.label, envVar, last4: key.slice(-4) })
  }
  return out
}

// "Not now" is kept in its own small file, not settings.json: the desktop and
// terminal apps each save the whole settings object from their own cache, so a flag
// one writes there can be erased by the other's next save (see legacyRulesNotice.ts).
const FILE = 'env-key-offers.json'

function offersFile(): string {
  return join(getUserDataDir(), FILE)
}

/** Providers the user answered "Not now" for at startup. */
export function dismissedEnvKeyOffers(): string[] {
  const raw = readTextOrNull(offersFile())
  if (raw === null) return []
  try {
    const parsed = JSON.parse(raw) as { dismissed?: unknown }
    return Array.isArray(parsed.dismissed)
      ? parsed.dismissed.filter((d): d is string => typeof d === 'string')
      : []
  } catch {
    return [] // unreadable: at worst the offer shows again
  }
}

/** Record "Not now" for these providers, so the startup notice doesn't ask again. */
export function dismissEnvKeyOffers(providerIds: readonly unknown[]): void {
  const known = new Set(ENV_KEY_SOURCES.map((s) => s.providerId))
  const current = dismissedEnvKeyOffers()
  const next = [...new Set([...current, ...providerIds.filter((id): id is string => typeof id === 'string' && known.has(id))])]
  if (next.length === current.length) return
  writeFileAtomicSync(offersFile(), `${JSON.stringify({ dismissed: next }, null, 2)}\n`, 0o600)
}
