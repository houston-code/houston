import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CostBreakdown } from './CostBreakdown'
import type { SessionUsage } from '@shared/usage'

/**
 * The control-bar chip showed one aggregate number: you could see what a session
 * cost but not which model spent it, nor the cache split. The breakdown surfaces
 * both — but only when there's more than one number worth seeing.
 */
const base: SessionUsage = { context: 12_000, output: 3_000, cost: 0.42 }

describe('CostBreakdown', () => {
  it('is a plain chip (no button) when there is nothing extra to show', () => {
    render(<CostBreakdown usage={base} contextWindow={200_000} meterPct={6} meterClass="" />)
    expect(screen.queryByRole('button', { name: 'Cost breakdown' })).toBeNull()
    // One model and no cache is not a breakdown worth a click either.
    const oneModel = { ...base, perModel: [row('claude')] }
    render(<CostBreakdown usage={oneModel} contextWindow={200_000} meterPct={6} meterClass="" />)
    expect(screen.queryByRole('button', { name: 'Cost breakdown' })).toBeNull()
  })

  it('opens a per-model breakdown when more than one model billed', () => {
    const usage: SessionUsage = {
      ...base,
      perModel: [row('claude', { cost: 0.4, cacheReadTokens: 8_000 }), row('haiku', { cost: 0.02 })]
    }
    render(<CostBreakdown usage={usage} contextWindow={200_000} meterPct={6} meterClass="" />)
    fireEvent.click(screen.getByRole('button', { name: 'Cost breakdown' }))
    const panel = screen.getByRole('dialog', { name: 'Cost breakdown' })
    expect(within(panel).getByText('claude')).toBeInTheDocument()
    expect(within(panel).getByText('haiku')).toBeInTheDocument() // the cheaper subagent model, shown apart
    expect(within(panel).getByText('Total')).toBeInTheDocument()
  })

  it('opens for a single model when it has cache reads (the split is the point)', () => {
    const usage: SessionUsage = { ...base, cacheRead: 9_000, perModel: [row('claude', { cacheReadTokens: 9_000 })] }
    render(<CostBreakdown usage={usage} contextWindow={200_000} meterPct={6} meterClass="" />)
    expect(screen.getByRole('button', { name: 'Cost breakdown' })).toBeInTheDocument()
  })

  it('toggles closed again, and closes on Escape', () => {
    const usage: SessionUsage = { ...base, perModel: [row('claude'), row('haiku')] }
    render(<CostBreakdown usage={usage} contextWindow={200_000} meterPct={6} meterClass="" />)
    const btn = screen.getByRole('button', { name: 'Cost breakdown' })
    fireEvent.click(btn)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

function row(
  model: string,
  over: Partial<NonNullable<SessionUsage['perModel']>[number]> = {}
): NonNullable<SessionUsage['perModel']>[number] {
  return { model, inputTokens: 100, outputTokens: 50, cost: 0.01, cacheReadTokens: 0, cacheWriteTokens: 0, ...over }
}
