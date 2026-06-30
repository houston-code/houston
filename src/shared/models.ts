/**
 * Display ordering for a provider's model list. Pure + dependency-free so the
 * renderer and unit tests can share it.
 *
 * Models are ordered most-advanced → least within a provider, with same-family models
 * kept together and newest release first inside a family (Opus 4.8 before Opus 4.7).
 * The order is derived from the model id, not from where the id happens to sit in the
 * stored list — the stored order drifts (the settings migration appends new defaults;
 * a live `Fetch` returns whatever order the provider's API gives) so we can't rely on
 * it. The sort key per model is:
 *
 *   [familyRank, family, -version, sizeRank, naturalName]
 *
 *   familyRank — the family's capability rank within the provider (Opus < Sonnet <
 *                Haiku; GPT-5 < GPT-4o < o-series < …). Lower sorts first. The primary
 *                key, so a family's members are always contiguous.
 *   family     — family name, to keep unrecognized families that share a rank grouped.
 *   version    — the model's version number (4.8, 2.5, 5), sorted descending.
 *   sizeRank   — base < mini < lite < nano, so GPT-5 precedes GPT-5 mini precedes nano.
 *   naturalName— final numeric-aware tie-break for full determinism.
 */
import type { ModelOption, ProviderKind } from './types'

interface FamilyRule {
  /** Canonical family name, used to keep the family's members grouped. */
  name: string
  /** Matches a (lowercased) model id belonging to this family. */
  test: RegExp
}

// Family capability order per provider kind — earlier = more advanced. Rules are
// tried in order, so more specific patterns must precede broader ones (gpt-4o before
// the legacy gpt-4 catch-all). An id matching no rule sorts after all known families.
const ANTHROPIC: FamilyRule[] = [
  { name: 'opus', test: /opus/ },
  { name: 'sonnet', test: /sonnet/ },
  { name: 'haiku', test: /haiku/ }
]
const OPENAI: FamilyRule[] = [
  // GPT *minor* versions (gpt-5.5, gpt-5.4) stay in the gpt-5 family below and sort by
  // version, exactly like Claude's Opus 4.8/4.7. This catch-all is only for a new
  // integer *generation* (gpt-6+, gpt-10+): ranked top so a new flagship leads its
  // provider instead of dropping to the unknown bucket. It must precede the gpt-5 rule
  // and must NOT match gpt-5.x — a dot is a minor bump, which `\d\d` (two adjacent
  // digits) doesn't match, so gpt-5.5 falls through to the gpt-5 family.
  { name: 'gpt-next', test: /gpt-(?:[6-9]|\d\d)/ },
  { name: 'gpt-5', test: /gpt-5/ },
  { name: 'gpt-4.1', test: /gpt-4\.1/ },
  { name: 'gpt-4o', test: /gpt-4o/ },
  { name: 'o-series', test: /(^|[^a-z0-9])o\d/ },
  { name: 'gpt-4', test: /gpt-4/ },
  { name: 'gpt-3', test: /gpt-3/ }
]
const GEMINI: FamilyRule[] = [
  { name: 'pro', test: /pro/ },
  { name: 'flash', test: /flash/ }
]

const FAMILIES: Record<ProviderKind, FamilyRule[]> = {
  anthropic: ANTHROPIC,
  openai: OPENAI,
  // OpenAI-compatible endpoints (proxies, Ollama, LM Studio) often serve GPT/o ids;
  // those that don't fall through to the generic family grouping below.
  'openai-compatible': OPENAI,
  gemini: GEMINI
}

/** Numeric-aware, case-insensitive compare so `gpt-4o` < `gpt-4o mini` and `9` < `10`. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

/** The model's version as a number (`claude-opus-4-8` → 4.8, `gemini-2.5-pro` → 2.5). 0 if none. */
function versionScore(id: string): number {
  const m = id.match(/(\d+)(?:[.-](\d+))?/)
  if (!m) return 0
  return parseFloat(`${m[1]}.${m[2] ?? 0}`)
}

/** Size tier within a family: base < mini < lite < nano. `\b` avoids the "mini" in "gemini". */
function sizeRank(id: string): number {
  if (/\bnano\b/.test(id)) return 3
  if (/\blite\b/.test(id)) return 2
  if (/\bmini\b/.test(id)) return 1
  return 0
}

/** A grouping key for ids that match no known family: the alphabetic stem (`llama-3.1` → `llama`). */
function genericFamily(id: string): string {
  return id
    .replace(/(\d+)([.-]\d+)*/g, ' ')
    .replace(/\b(mini|nano|lite|pro|flash|turbo|preview|latest|instruct|chat)\b/g, ' ')
    .replace(/[^a-z]+/g, ' ')
    .trim()
}

interface SortKey {
  rank: number
  family: string
  version: number
  size: number
}

function sortKey(kind: ProviderKind, id: string): SortKey {
  const lower = id.toLowerCase()
  const rules = FAMILIES[kind] ?? OPENAI
  for (let i = 0; i < rules.length; i++) {
    if (rules[i].test.test(lower)) {
      return { rank: i, family: rules[i].name, version: versionScore(lower), size: sizeRank(lower) }
    }
  }
  // Unknown family: sort after all known ones, grouped by its stem.
  return { rank: rules.length, family: genericFamily(lower), version: versionScore(lower), size: sizeRank(lower) }
}

/**
 * A provider's models ordered most-advanced first, families grouped, newest version
 * first within a family. Stable and non-mutating.
 */
export function sortedModels(kind: ProviderKind, models: ModelOption[]): ModelOption[] {
  return [...models].sort((a, b) => {
    const ka = sortKey(kind, a.id)
    const kb = sortKey(kind, b.id)
    if (ka.rank !== kb.rank) return ka.rank - kb.rank
    if (ka.family !== kb.family) return naturalCompare(ka.family, kb.family)
    if (ka.version !== kb.version) return kb.version - ka.version // newest first
    if (ka.size !== kb.size) return ka.size - kb.size
    return naturalCompare(a.label ?? a.id, b.label ?? b.id)
  })
}
