import type { ModelOption } from '@shared/types'
import { isLikelyChatModel, missingModelFacts } from '@shared/model-listing'
import { modelPricing } from '@shared/model-facts'

/**
 * Model drift: which models a first-party provider now lists that Houston doesn't ship
 * and probably should. Pure, so the weekly model-drift workflow's live runner
 * (model-drift.integration.test.ts) and the unit tests share it. The workflow turns the
 * result into one rolling GitHub issue; nothing here adds a model. A listing can include
 * models that don't actually serve, so adding one still goes through a PR, the coverage
 * check, and the live canary.
 */

export type DriftProvider = 'anthropic' | 'openai' | 'gemini'

export interface DriftCandidate {
  id: string
  /** Release date from the listing, when the provider reports one (Anthropic, OpenAI). */
  releasedAt?: string
  /** What this build doesn't yet know about it (price, context window, family). Empty = ready to seed. */
  missing: string[]
}

/** A listed model older than this is old news, not drift. Gemini lists no dates; see geminiIsNewer. */
export const MAX_AGE_DAYS = 120

const DAY_MS = 86_400_000

/** The provider's own model ids, minus fine-tunes, aliases and other providers' models it hosts. */
function isProviderModel(provider: DriftProvider, id: string): boolean {
  switch (provider) {
    case 'anthropic':
      return id.startsWith('claude-')
    case 'openai':
      // `ft:` fine-tunes belong to the org; `chatgpt-*` and `*-chat-latest` are moving aliases.
      return /^(gpt-|o\d)/.test(id) && !id.includes(':') && !/chat-latest|^chatgpt-/.test(id)
    case 'gemini':
      // The Gemini API also lists Gemma and other open models; moving `-latest` and `-exp`
      // aliases aren't releases.
      return id.startsWith('gemini-') && !/latest|-exp/.test(id)
  }
}

/** A Gemini model's tier and version: `gemini-3.8-flash` → { tier: 'flash', version: 3.8 }. */
function geminiTier(id: string): { tier: string; version: number; preview: boolean } | null {
  const v = /^gemini-(\d+(?:\.\d+)?)/.exec(id)
  if (!v) return null
  const tier = id.includes('flash-lite') ? 'flash-lite' : id.includes('flash') ? 'flash' : id.includes('pro') ? 'pro' : 'other'
  return { tier, version: parseFloat(v[1]), preview: id.includes('preview') }
}

/**
 * Gemini's listing carries no release dates, so "new" means newer than what's shipped in
 * the same tier: a higher version, a tier Houston doesn't ship at all, or the stable
 * release of a version Houston only ships as a preview.
 */
function geminiIsNewer(id: string, shipped: string[]): boolean {
  const t = geminiTier(id)
  if (!t) return false
  const same = shipped.map(geminiTier).filter((s): s is NonNullable<typeof s> => !!s && s.tier === t.tier)
  if (same.length === 0) return true
  const newest = Math.max(...same.map((s) => s.version))
  if (t.version > newest) return true
  return t.version === newest && !t.preview && same.every((s) => s.version < newest || s.preview)
}

/**
 * The models a provider lists that Houston should consider adding: the provider's own chat
 * models, not already shipped, not deliberately ignored, and recent (by release date, or for
 * Gemini by version). Sorted newest first where dates are known, then by id.
 */
export function driftCandidates(
  provider: DriftProvider,
  listed: ModelOption[],
  shipped: string[],
  ignored: ReadonlySet<string>,
  now: Date
): DriftCandidate[] {
  const have = new Set(shipped)
  const out: DriftCandidate[] = []
  for (const m of listed) {
    const id = m.id
    if (have.has(id) || ignored.has(id) || !isProviderModel(provider, id) || !isLikelyChatModel(id)) continue
    const releasedAt = m.caps?.releasedAt
    if (provider === 'gemini') {
      if (!geminiIsNewer(id, shipped)) continue
    } else if (releasedAt && (now.getTime() - Date.parse(releasedAt)) / DAY_MS > MAX_AGE_DAYS) {
      continue
    }
    out.push({ id, ...(releasedAt ? { releasedAt } : {}), missing: missingModelFacts(provider, m) })
  }
  return out.sort((a, b) => (b.releasedAt ?? '').localeCompare(a.releasedAt ?? '') || a.id.localeCompare(b.id))
}

const PROVIDER_NAME: Record<DriftProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini'
}

/** One provider's section of the drift issue, in Markdown. Empty string when nothing is new. */
export function renderDriftSection(provider: DriftProvider, candidates: DriftCandidate[]): string {
  if (candidates.length === 0) return ''
  const rows = candidates.map(
    (c) =>
      `| \`${c.id}\` | ${c.releasedAt ?? 'not listed'} | ${
        c.missing.length ? `needs ${c.missing.join(', ')} in model-facts.ts` : 'already recognized: seed it'
      } |`
  )
  return [`### ${PROVIDER_NAME[provider]}`, '', '| Model | Released | To add it |', '|---|---|---|', ...rows, ''].join('\n')
}

/** How far ahead a scheduled price change is surfaced, so a cancelled one can be removed in time. */
export const PRICE_NOTICE_DAYS = 14

export interface UpcomingPriceChange {
  id: string
  /** `YYYY-MM-DD` the new rates take effect. */
  from: string
  input: number
  output: number
}

/**
 * Scheduled price changes in model-facts.ts for shipped models that take effect within
 * PRICE_NOTICE_DAYS. Every installed build switches on the date by itself; this is the
 * prompt to confirm the change is still happening (providers occasionally cancel one) and
 * remove it from model-facts.ts if not.
 */
export function upcomingPriceChanges(shipped: string[], now: Date): UpcomingPriceChange[] {
  const today = now.toISOString().slice(0, 10)
  const horizon = new Date(now.getTime() + PRICE_NOTICE_DAYS * DAY_MS).toISOString().slice(0, 10)
  const out: UpcomingPriceChange[] = []
  for (const id of shipped) {
    for (const c of modelPricing(id)?.scheduled ?? []) {
      if (c.from >= today && c.from <= horizon) out.push({ id, from: c.from, input: c.input, output: c.output })
    }
  }
  return out.sort((a, b) => a.from.localeCompare(b.from) || a.id.localeCompare(b.id))
}

const usd = (n: number): string => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`)

/**
 * Table rows for the drift issue's "Scheduled price changes" section, one per change (the
 * workflow's report job adds the heading and table header once, across providers). Empty
 * string when none are due.
 */
export function renderPriceRows(changes: UpcomingPriceChange[]): string {
  return changes.map((c) => `| \`${c.id}\` | ${c.from} | ${usd(c.input)} / ${usd(c.output)} per MTok |`).join('\n')
}

/** Marker key for a price change, so the issue notifies when a new one comes due. */
export function priceChangeKey(c: UpcomingPriceChange): string {
  return `price:${c.id}@${c.from}`
}
