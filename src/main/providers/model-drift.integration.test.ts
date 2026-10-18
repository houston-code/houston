import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defaultProviders } from '@shared/defaults'
import type { ModelOption } from '@shared/types'
import { listAnthropicModels } from './anthropic'
import { listOpenAIModels } from './openai'
import { listGeminiModels } from './gemini'
import {
  driftCandidates,
  priceChangeKey,
  renderDriftSection,
  renderPriceRows,
  upcomingPriceChanges,
  type DriftProvider
} from './drift'

/**
 * Live runner for the weekly model-drift workflow (.github/workflows/model-drift.yml).
 * Lists one provider's models with that provider's key, keeps the ones Houston doesn't
 * ship and should consider (see drift.ts), and writes a Markdown section plus the flagged
 * ids to DRIFT_OUT for the workflow's report job.
 *
 * OPT-IN ONLY: runs solely when DRIFT_PROVIDER is set, so a normal `npm test` skips it.
 * Listing models is free; no model is called. Run one locally with e.g.
 *   DRIFT_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... DRIFT_OUT=/tmp/drift.json \
 *     npx vitest run --project node model-drift.integration
 */

const PROVIDER = process.env.DRIFT_PROVIDER as DriftProvider | undefined

const KEY_ENV: Record<DriftProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY'
}

async function listed(provider: DriftProvider, key: string): Promise<ModelOption[]> {
  switch (provider) {
    case 'anthropic':
      return listAnthropicModels(key)
    case 'openai':
      return listOpenAIModels(key)
    case 'gemini':
      return listGeminiModels(key)
  }
}

describe.skipIf(!PROVIDER)('model drift (live listing)', () => {
  it('lists the provider models and writes the drift section', { timeout: 60_000 }, async () => {
    const provider = PROVIDER!
    expect(Object.keys(KEY_ENV), `DRIFT_PROVIDER must be one of ${Object.keys(KEY_ENV).join(', ')}`).toContain(
      provider
    )
    const key = process.env[KEY_ENV[provider]]
    // A missing key must fail, not skip: a skipped run would report "nothing new" forever.
    expect(key, `${KEY_ENV[provider]} is not set`).toBeTruthy()

    const models = await listed(provider, key!)
    // An empty listing means the call or the parsing broke, not that the provider has no models.
    expect(models.length, `${provider} listed no models`).toBeGreaterThan(0)

    const shipped = defaultProviders().find((p) => p.id === provider)?.models.map((m) => m.id) ?? []
    const ignoreFile = fileURLToPath(new URL('./model-drift-ignore.json', import.meta.url))
    const ignored = new Set(
      (JSON.parse(readFileSync(ignoreFile, 'utf8')) as { ignore: Array<{ id: string }> }).ignore.map((e) => e.id)
    )
    const now = new Date()
    const candidates = driftCandidates(provider, models, shipped, ignored, now)
    const prices = upcomingPriceChanges(shipped, now)

    const out = process.env.DRIFT_OUT
    expect(out, 'DRIFT_OUT is not set').toBeTruthy()
    writeFileSync(
      out!,
      JSON.stringify({
        provider,
        ids: candidates.map((c) => c.id),
        section: renderDriftSection(provider, candidates),
        priceIds: prices.map(priceChangeKey),
        priceRows: renderPriceRows(prices)
      })
    )
  })
})
