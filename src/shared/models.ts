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
  { name: 'fable', test: /fable/ },
  { name: 'opus', test: /opus/ },
  { name: 'sonnet', test: /sonnet/ },
  { name: 'haiku', test: /haiku/ }
]
const OPENAI: FamilyRule[] = [
  // GPT minor versions (gpt-5.5, gpt-5.4) match the family rule for their line and sort
  // by version, exactly like Claude's Opus 4.8/4.7 — so the realistic "next model" case
  // is already covered without a speculative rule for an integer generation that doesn't
  // exist. A genuinely new family/generation lands in the curated defaults when it ships.
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

/**
 * Anthropic display name from a model id: `claude-<tier>-<x>.<y>`. The provider's
 * own model API returns dash-separated ids (`claude-opus-4-8`, sometimes with a
 * trailing release-date suffix like `-20260101`); this normalizes them to the
 * `claude-model-x.y` form so a seeded model reads identically to one added via
 * Fetch. Adjacent numeric segments are joined with a dot (the major/minor version)
 * and a trailing all-digit date token is dropped:
 *
 *   claude-opus-4-8            → claude-opus-4.8
 *   claude-opus-4-1-20260101   → claude-opus-4.1
 *   claude-sonnet-5            → claude-sonnet-5   (no minor version)
 *   claude-3-5-sonnet          → claude-3.5-sonnet (legacy version-first ids too)
 */
function anthropicDisplayName(id: string): string {
  const tokens = id.split('-')
  // Drop a trailing release-date suffix (6+ digit run, e.g. 20260101) — it's noise.
  if (tokens.length > 1 && /^\d{6,}$/.test(tokens[tokens.length - 1])) tokens.pop()
  const out: string[] = []
  for (const t of tokens) {
    const prev = out[out.length - 1]
    // Join a run of two single/short numeric tokens into a dotted version (4 + 8 → 4.8).
    if (prev !== undefined && /^\d+$/.test(prev) && /^\d+$/.test(t)) out[out.length - 1] = `${prev}.${t}`
    else out.push(t)
  }
  return out.join('-')
}

/**
 * The display name for a model id, in a single convention per provider so a seeded
 * model and a live-fetched one read the same (the fetch listing rarely carries a
 * display label — see providers/index.ts). Anthropic normalizes to the dotted
 * `claude-model-x.y` form; every other provider already returns clean lowercase ids
 * (`gpt-5.1`, `gpt-5-mini`, `gemini-2.5-pro`, `llama3.1:latest`), so the id IS the
 * name. Pure + dependency-free so the renderer, the settings migration, and the
 * fetch path can all share it.
 */
export function modelDisplayName(kind: ProviderKind, id: string): string {
  return kind === 'anthropic' ? anthropicDisplayName(id) : id
}

/** The model's version as a number (`claude-opus-4-8` → 4.8, `gemini-2.5-pro` → 2.5). 0 if none. */
function versionScore(id: string): number {
  const m = id.match(/(\d+)(?:[.-](\d+))?/)
  if (!m) return 0
  return parseFloat(`${m[1]}.${m[2] ?? 0}`)
}

/**
 * Size/capability tier within a family, smaller = more capable (sorts first):
 * base < mini < lite < nano. Also maps OpenAI's gpt-5.6 codename tiers onto the same
 * scale — sol (flagship) < terra (mid) < luna (efficient) — so the flagship sorts
 * first instead of alphabetically (luna, sol, terra). `\b` avoids the "mini" in
 * "gemini". Codenames are volatile; a live Fetch is the source of truth for the list.
 */
function sizeRank(id: string): number {
  if (/\bnano\b|\bluna\b/.test(id)) return 3
  if (/\blite\b/.test(id)) return 2
  if (/\bmini\b|\bterra\b/.test(id)) return 1
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

/**
 * The model to use for a provider when none was chosen explicitly: its
 * `defaultModel` when that id is still in the list, else the most capable model
 * by the display ordering above, else null (no models). Every "pick a default"
 * path shares this — the naive `defaultModel ?? models[0]` it replaces read the
 * STORED order, which for a live-fetched aggregator list is whatever arbitrary
 * order the provider's API returned (often newest-created first), landing new
 * logins on an obscure variant instead of a flagship.
 */
export function pickDefaultModel(p: {
  kind: ProviderKind
  defaultModel?: string
  models: ModelOption[]
}): string | null {
  if (p.defaultModel && p.models.some((m) => m.id === p.defaultModel)) return p.defaultModel
  return sortedModels(p.kind, p.models)[0]?.id ?? null
}
