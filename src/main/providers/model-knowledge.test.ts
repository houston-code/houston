import { describe, it, expect } from 'vitest'
import { contextWindowFor, modelCapabilities, modelPricing } from '@shared/usage'
import { sortedModels } from '@shared/models'
import type { ProviderKind } from '@shared/types'
import {
  anthropicPreservesThinking,
  anthropicSupportsInterleavedThinking,
  anthropicSupportsThinking,
  anthropicSupportsXhigh,
  anthropicUsesLegacyThinking,
  geminiSupportsThinking,
  openaiSupportsReasoning
} from './reasoning'

/**
 * Every id-derived fact Houston knows about a model, pinned across a broad corpus of
 * real ids (current, superseded, host-prefixed, dated, and unknown). Model knowledge
 * is spread over pricing, context windows, capabilities, reasoning gates and display
 * order; this golden makes any change to what an id resolves to show up as a reviewed
 * diff, so a refactor of where that knowledge lives can't silently move a model.
 * Regenerate with `npx vitest run src/main/providers/model-knowledge.test.ts -u`.
 */
const CORPUS = [
  // Anthropic: current, superseded, legacy, and as the cloud hosts address them.
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-mythos-5-1',
  'claude-mythos-5',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-opus-4-1',
  'claude-opus-4-20250514',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-20250514',
  'claude-haiku-4-5',
  'claude-3-7-sonnet-20250219',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229',
  'claude-3-haiku-20240307',
  'claude-2.1',
  'claude-instant-1.2',
  'anthropic.claude-opus-5-5',
  'anthropic.claude-fable-5-1',
  'anthropic.claude-sonnet-4-6',
  'claude-opus-4-5@20251101',
  'claude-sonnet-4@20250514',
  'claude-sonnet-5-5@20260901',
  'anthropic/claude-sonnet-5',
  // OpenAI: GPT-6, GPT-5.x tiers and variants, GPT-4.x, o-series.
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.6',
  'gpt-5.5',
  'gpt-5.5-pro',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.4-pro',
  'gpt-5.2',
  'gpt-5.2-pro',
  'gpt-5.1',
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-5-pro',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-turbo',
  'gpt-3.5-turbo',
  'o1',
  'o1-pro',
  'o1-preview',
  'o3',
  'o3-mini',
  'o3-pro',
  'o4-mini',
  'openai/gpt-6.1-sol',
  'openai/gpt-5.6-luna',
  'openai/o3',
  // Gemini: current, preview, superseded.
  'gemini-3.1-pro-preview',
  'gemini-3-pro-preview',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-thinking-exp',
  'gemini-1.5-pro',
  'gemini-pro',
  'google/gemini-3.8-flash',
  // Unknown / local / aggregator ids, which must resolve to "nothing known".
  'llama3.1:latest',
  'qwen2.5-coder',
  'deepseek/deepseek-r1',
  'mistral-nemo',
  'my-gpt-4o-deployment'
]

const KINDS: ProviderKind[] = ['anthropic', 'openai', 'gemini', 'openai-compatible', 'bedrock']

describe('model knowledge golden', () => {
  it('pins every id-derived fact across the corpus', async () => {
    const facts = Object.fromEntries(
      CORPUS.map((id) => [
        id,
        {
          window: contextWindowFor(id),
          pricing: modelPricing(id),
          caps: modelCapabilities(id),
          gates: {
            anthropicThinking: anthropicSupportsThinking(id),
            anthropicLegacy: anthropicUsesLegacyThinking(id),
            anthropicInterleaved: anthropicSupportsInterleavedThinking(id),
            anthropicXhigh: anthropicSupportsXhigh(id),
            anthropicPreserved: anthropicPreservesThinking(id),
            openaiReasoning: openaiSupportsReasoning(id),
            geminiThinking: geminiSupportsThinking(id)
          }
        }
      ])
    )
    const order = Object.fromEntries(
      KINDS.map((kind) => [kind, sortedModels(kind, CORPUS.map((id) => ({ id }))).map((m) => m.id)])
    )
    await expect(JSON.stringify({ facts, order }, null, 2) + '\n').toMatchFileSnapshot(
      'goldens/model-knowledge.json'
    )
  })
})
