import { describe, it, expect } from 'vitest'
import { defaultProviders } from '@shared/defaults'
import { contextWindowFor, modelCapabilities, modelPricing } from '@shared/usage'
import {
  anthropicSupportsThinking,
  geminiSupportsThinking,
  openaiSupportsReasoning
} from './reasoning'

/**
 * Drift guards between the shared UI heuristics (`@shared/usage`) and the
 * per-provider request gates (`./reasoning`).
 *
 * The UI decides whether to OFFER a reasoning control from
 * `modelCapabilities(id).reasoning`; the adapters decide whether to SEND a
 * thinking/reasoning parameter from the gates in reasoning.ts. Until now the two
 * were kept in sync by comment only ("intentionally mirrors…"). If they drift,
 * either the UI offers a toggle the adapter silently ignores, or the adapter
 * could reason on a model the UI never exposes it for. This test makes the
 * mirror mechanical: one shared id matrix, both sides must agree on every id.
 */

/** The per-provider request gate that applies to a model id, by family. */
function providerReasoningGate(id: string): boolean | null {
  const m = id.toLowerCase()
  if (m.includes('claude')) return anthropicSupportsThinking(id)
  if (m.includes('gemini')) return geminiSupportsThinking(id)
  // The OpenAI gate keys on the id's lead (o-series / gpt-5); scope the parity
  // check the same way so unrelated ids (llama, qwen) don't hit this gate.
  if (/^(o\d|gpt-)/i.test(m)) return openaiSupportsReasoning(id)
  return null // no provider gate applies (local/open models)
}

// Every shipped default model, plus curated edge ids per family: reasoning and
// non-reasoning representatives, future-shaped ids, and local/open ids that no
// gate should claim.
const DEFAULT_MODEL_IDS = defaultProviders().flatMap((p) => p.models.map((m) => m.id))
const EDGE_IDS = [
  // Anthropic: thinking arrived in 3.7; 3.5 predates it. Fable/Mythos flagship tier.
  'claude-3-5-sonnet-20241022',
  'claude-3-7-sonnet-20250219',
  'claude-sonnet-4-20250514',
  'claude-sonnet-4-5',
  'claude-opus-4-1',
  'claude-fable-5',
  'claude-mythos-5',
  // OpenAI: o-series and gpt-5.x reason; 4o / 4.1 don't.
  'o3',
  'o4-mini',
  'gpt-5',
  'gpt-5.6-luna-pro',
  'gpt-4o',
  'gpt-4.1',
  // Google: 2.5 thinks; earlier families don't unless the id says "thinking".
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-pro',
  'gemini-2.0-flash-thinking-exp',
  // Local/open ids: no provider gate; the heuristic must stay conservative (false).
  'llama-3.1-8b',
  'qwen2.5-coder',
  'deepseek-r1'
]
const MATRIX = [...new Set([...DEFAULT_MODEL_IDS, ...EDGE_IDS])]

describe('reasoning heuristic parity (usage.ts vs reasoning.ts gates)', () => {
  // A defaults refactor emptying the model lists would silently gut the matrix.
  it('covers the shipped default models', () => {
    expect(DEFAULT_MODEL_IDS.length).toBeGreaterThan(0)
  })

  it.each(MATRIX.filter((id) => providerReasoningGate(id) !== null))(
    'agrees with the provider gate for %s',
    (id) => {
      expect(modelCapabilities(id).reasoning).toBe(providerReasoningGate(id))
    }
  )

  it('stays conservative (no reasoning) for ids no provider gate claims', () => {
    for (const id of MATRIX.filter((id) => providerReasoningGate(id) === null)) {
      expect(modelCapabilities(id).reasoning).toBe(false)
    }
  })
})

describe('shipped default models have usage metadata', () => {
  // Guards the add-a-default-model checklist: a new default id must be matched
  // by the pricing and context-window heuristics in the same change, or cost
  // shows $0 and the context meter falls back to a raw count.
  const CLOUD_DEFAULT_IDS = defaultProviders()
    .filter((p) => p.kind !== 'openai-compatible')
    .flatMap((p) => p.models.map((m) => m.id))

  it.each(CLOUD_DEFAULT_IDS)('%s has pricing and a context window', (id) => {
    expect(modelPricing(id)).not.toBeNull()
    expect(contextWindowFor(id)).not.toBeNull()
  })
})
