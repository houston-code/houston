/**
 * Reading a provider's raw model list: which ids are chat models worth surfacing, which
 * of those this build doesn't fully recognise, and what a fetch changed. Shared by the
 * Settings "fetch from provider" summary and the model-drift workflow script, so both
 * filter a listing the same way. Pure + dependency-light.
 */
import type { ModelOption, ProviderKind } from './types'
import { contextWindowFor } from './model-facts'
import { knownModelFamily } from './models'
import { resolvePricing } from './usage'

/**
 * Ids a first-party listing returns that aren't chat models this agent can drive:
 * embeddings, speech, image and video generation, moderation, legacy completions, and
 * the realtime / search / computer-use variants of chat models.
 */
const NON_CHAT =
  /embed|tts|whisper|transcribe|dall-e|gpt-image|imagen|veo|sora|moderation|davinci|babbage|realtime|audio|search|computer-use|aqa|learnlm/

/** A dated snapshot of a model that also has an undated id (`gpt-5-2025-08-07`, `claude-opus-4-20250514`). */
const DATED_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$|-\d{8}$|@\d{8}$/

/** Whether a listed id looks like a chat model (not an embedding, speech, image or dated-snapshot id). */
export function isLikelyChatModel(id: string): boolean {
  const m = id.toLowerCase()
  return !NON_CHAT.test(m) && !DATED_SNAPSHOT.test(m)
}

/** Provider kinds whose models Houston's id rules are meant to describe in full. */
const FIRST_PARTY: ReadonlySet<ProviderKind> = new Set(['anthropic', 'openai', 'gemini', 'bedrock', 'vertex', 'foundry'])

/**
 * What this build can't yet say about a model: its price, context window, or display
 * family. Host-listed metadata counts, so an aggregator entry with listed prices is fine.
 * Empty when the model is fully recognised.
 */
export function missingModelFacts(kind: ProviderKind, m: ModelOption): string[] {
  const missing: string[] = []
  if (!resolvePricing(m.id, m.caps)) missing.push('price')
  if (!(m.caps?.contextWindow ?? contextWindowFor(m.id))) missing.push('context window')
  if (!knownModelFamily(kind, m.id)) missing.push('family')
  return missing
}

export interface FetchSummary {
  /** How many models the provider listed. */
  total: number
  /** Ids the fetch added that weren't in the list before. */
  added: string[]
  /** Ids that were in the list but the provider no longer lists (the fetch dropped them). */
  removed: string[]
  /**
   * Newly added chat models from a first-party provider that this build doesn't fully
   * recognise. They work, but show no price (or sort as an unknown family) until an
   * update teaches Houston about them.
   */
  unrecognised: string[]
}

/** Compare a provider's model list before and after a fetch. */
export function summarizeFetch(
  kind: ProviderKind,
  before: ModelOption[],
  after: ModelOption[]
): FetchSummary {
  const had = new Set(before.map((m) => m.id))
  const has = new Set(after.map((m) => m.id))
  const added = after.filter((m) => !had.has(m.id))
  return {
    total: after.length,
    added: added.map((m) => m.id),
    removed: before.filter((m) => !has.has(m.id)).map((m) => m.id),
    unrecognised: FIRST_PARTY.has(kind)
      ? added.filter((m) => isLikelyChatModel(m.id) && missingModelFacts(kind, m).length > 0).map((m) => m.id)
      : []
  }
}
