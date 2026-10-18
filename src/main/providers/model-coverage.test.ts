import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defaultProviders } from '@shared/defaults'
import { BEDROCK_MODELS, FOUNDRY_MODELS, VERTEX_MODELS } from '@shared/provider-catalog'
import { knownModelFamily } from '@shared/models'
import { contextWindowFor, modelCapabilities, modelPricing, resolveToolSupport } from '@shared/usage'
import type { ProviderKind } from '@shared/types'

/**
 * Every model Houston ships by name must be fully understood, not just listed. A model
 * that only half-matches the id rules in shared/model-facts.ts still appears in the
 * picker and still runs, but quietly wrong: no reasoning sent (Opus 5.5 once), no price
 * so cost reads $0 (GPT-6 once), or sorted below the o-series as an unknown family.
 *
 * "Shipped by name" means the built-in default model lists and the curated Bedrock,
 * Vertex and Foundry lists. Each must resolve to a price, a context window, a named
 * display family, tool calling, and a reasoning mode, and must be pinned in the
 * model-knowledge golden, so adding a model always arrives with a reviewed diff of
 * every fact Houston derives for it.
 */

interface Shipped {
  kind: ProviderKind
  id: string
  /** Where the id comes from, for the failure message. */
  source: string
}

const shipped: Shipped[] = [
  ...defaultProviders().flatMap((p) =>
    p.models.map((m) => ({ kind: p.kind, id: m.id, source: `${p.id} defaults` }))
  ),
  ...BEDROCK_MODELS.map((id) => ({ kind: 'bedrock' as const, id, source: 'Bedrock catalog' })),
  ...VERTEX_MODELS.map((id) => ({ kind: 'vertex' as const, id, source: 'Vertex catalog' })),
  ...FOUNDRY_MODELS.map((id) => ({ kind: 'foundry' as const, id, source: 'Foundry catalog' }))
]

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL('./goldens/model-knowledge.json', import.meta.url)), 'utf8')
) as { facts: Record<string, unknown> }

const label = ({ id, source }: Shipped): string => `${id} (${source})`

describe('model coverage', () => {
  it('has shipped models to check', () => {
    // Guards the checks below against passing vacuously if a list is renamed or emptied.
    expect(shipped.length).toBeGreaterThan(10)
  })

  it.each(shipped.map((m) => [label(m), m] as const))('%s is fully described', (_name, m) => {
    const where = label(m)
    expect(modelPricing(m.id), `${where} has no price: add it to model-facts.ts`).not.toBeNull()
    expect(contextWindowFor(m.id), `${where} has no context window: add it to model-facts.ts`).not.toBeNull()
    expect(
      knownModelFamily(m.kind, m.id),
      `${where} matches no display family and would sort below every known one: add a family rule`
    ).not.toBeNull()
    expect(
      resolveToolSupport(undefined, m.id),
      `${where} is not known to call tools, which this agent requires`
    ).toBe(true)
    expect(
      modelCapabilities(m.id).reasoning,
      `${where} has no reasoning mode, so the reasoning control is disabled for it: extend its gate`
    ).toBe(true)
  })

  it.each(shipped.map((m) => [label(m), m] as const))('%s is pinned in the model-knowledge golden', (_name, m) => {
    expect(
      Object.keys(golden.facts),
      `${label(m)} is not in the model-knowledge corpus: add it to model-knowledge.test.ts and regenerate the golden with -u`
    ).toContain(m.id)
  })
})
