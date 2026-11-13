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
  it('shows context as used/maximum and the cost as text, and always opens the breakdown', () => {
    // One model and no cache: the breakdown still opens (the chip is how you get to it).
    const oneModel = { ...base, perModel: [row('claude', { cost: 0.42, outputTokens: 3_000 })] }
    render(<CostBreakdown usage={oneModel} contextWindow={200_000} meterPct={6} meterClass="" />)
    const btn = screen.getByRole('button', { name: /Show breakdown/ })
    expect(btn).toHaveTextContent('12k/200k')
    expect(btn).toHaveTextContent('$0.42')
    expect(btn).toHaveAccessibleName('Usage: context 12k/200k (6%), cost $0.420. Show breakdown')
    fireEvent.click(btn)
    const panel = screen.getByRole('dialog', { name: 'Cost breakdown' })
    expect(within(panel).getByText('Context: 12,000 of 200,000 tokens (6%)')).toBeInTheDocument()
    expect(within(panel).getByText('claude')).toBeInTheDocument()
  })

  it('shows output tokens instead of a cost for a model with no known price', () => {
    render(<CostBreakdown usage={{ ...base, cost: 0 }} contextWindow={null} meterPct={null} meterClass="" />)
    const btn = screen.getByRole('button', { name: /Show breakdown/ })
    expect(btn).toHaveTextContent('12k ctx')
    expect(btn).toHaveTextContent('3k out')
    expect(btn).not.toHaveTextContent('$')
  })

  it('opens a per-model breakdown when more than one model billed', () => {
    const usage: SessionUsage = {
      ...base,
      output: 100,
      cacheRead: 8_000,
      perModel: [row('claude', { cost: 0.4, cacheReadTokens: 8_000 }), row('haiku', { cost: 0.02 })]
    }
    render(<CostBreakdown usage={usage} contextWindow={200_000} meterPct={6} meterClass="" />)
    fireEvent.click(screen.getByRole('button', { name: /Show breakdown/ }))
    const panel = screen.getByRole('dialog', { name: 'Cost breakdown' })
    expect(within(panel).getByText('claude')).toBeInTheDocument()
    expect(within(panel).getByText('haiku')).toBeInTheDocument() // the cheaper subagent model, shown apart
    expect(within(panel).getByText('Total')).toBeInTheDocument()
  })

  it('opens for a single model when it has cache reads (the split is the point)', () => {
    const usage: SessionUsage = {
      ...base,
      output: 50,
      cost: 0.01,
      cacheRead: 9_000,
      perModel: [row('claude', { cacheReadTokens: 9_000 })]
    }
    render(<CostBreakdown usage={usage} contextWindow={200_000} meterPct={6} meterClass="" />)
    expect(screen.getByRole('button', { name: /Show breakdown/ })).toBeInTheDocument()
  })

  it('adds an "Earlier models" row for usage recorded before the per-model breakdown', () => {
    // A conversation that ran before per-model tallies: $30.11 total, one model since at $0.23.
    const usage: SessionUsage = {
      context: 121_596,
      output: 117_527,
      cost: 30.1120243,
      cacheRead: 724_768,
      perModel: [row('claude-haiku-4-5', { outputTokens: 691, cost: 0.2279633, cacheReadTokens: 724_768 })]
    }
    render(<CostBreakdown usage={usage} contextWindow={200_000} meterPct={61} meterClass="" />)
    fireEvent.click(screen.getByRole('button', { name: /Show breakdown/ }))
    const panel = screen.getByRole('dialog', { name: 'Cost breakdown' })
    const earlier = within(panel).getByText('Earlier models').closest('.usage-panel__row') as HTMLElement
    expect(earlier).not.toBeNull()
    expect(within(earlier).getByText('$29.88')).toBeInTheDocument()
    expect(within(earlier).getByText('116.8k')).toBeInTheDocument()
  })

  it('adds no "Earlier models" row when the rows already add up', () => {
    const usage: SessionUsage = { ...base, output: 100, cost: 0.02, perModel: [row('claude'), row('haiku')] }
    render(<CostBreakdown usage={usage} contextWindow={200_000} meterPct={6} meterClass="" />)
    fireEvent.click(screen.getByRole('button', { name: /Show breakdown/ }))
    expect(screen.queryByText('Earlier models')).toBeNull()
  })

  it('toggles closed again, and closes on Escape', () => {
    const usage: SessionUsage = { ...base, perModel: [row('claude'), row('haiku')] }
    render(<CostBreakdown usage={usage} contextWindow={200_000} meterPct={6} meterClass="" />)
    const btn = screen.getByRole('button', { name: /Show breakdown/ })
    fireEvent.click(btn)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens on what fills the context once a breakdown is known, even with one model', () => {
    const usage: SessionUsage = {
      ...base,
      perModel: [row('claude')],
      contextParts: { system: 4000, tools: 5000, instructions: 1000, memory: 0, conversation: 1500, toolResults: 500 }
    }
    render(<CostBreakdown usage={usage} contextWindow={200_000} meterPct={6} meterClass="" />)
    fireEvent.click(screen.getByRole('button', { name: /Show breakdown/ }))
    const ctx = screen.getByRole('region', { name: 'What fills the context' })
    expect(within(ctx).getByText('Context: 12,000 of 200,000 tokens (6%)')).toBeInTheDocument()
    expect(within(ctx).getByText('Tool definitions')).toBeInTheDocument()
    expect(within(ctx).getByText('~5k')).toBeInTheDocument()
    expect(within(ctx).getByText(/approximate/)).toBeInTheDocument()
  })

  it('opens when asked from elsewhere (the /context command)', () => {
    const usage: SessionUsage = {
      ...base,
      contextParts: { system: 1, tools: 1, instructions: 0, memory: 0, conversation: 1, toolResults: 0 }
    }
    const { rerender } = render(<CostBreakdown usage={usage} contextWindow={null} meterPct={null} meterClass="" />)
    expect(screen.queryByRole('dialog')).toBeNull()
    rerender(<CostBreakdown usage={usage} contextWindow={null} meterPct={null} meterClass="" openSignal={1} />)
    expect(screen.getByRole('dialog', { name: 'Cost breakdown' })).toBeInTheDocument()
  })
})

function row(
  model: string,
  over: Partial<NonNullable<SessionUsage['perModel']>[number]> = {}
): NonNullable<SessionUsage['perModel']>[number] {
  return { model, inputTokens: 100, outputTokens: 50, cost: 0.01, cacheReadTokens: 0, cacheWriteTokens: 0, ...over }
}
