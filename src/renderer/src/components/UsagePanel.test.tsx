import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildUsageReport } from '@shared/usageReport'
import { UsagePanel } from './UsagePanel'

const NOW = new Date(2026, 10, 13, 15)

function installApi() {
  const report = buildUsageReport(
    [
      {
        project: '/code/shop',
        messages: [
          { role: 'assistant', at: new Date(2026, 10, 13, 9).toISOString(), usage: { inputTokens: 12_000, outputTokens: 800, cost: 0.42 } }
        ],
        usage: { inputTokens: 12_000, outputTokens: 1200, cost: 0.6 }
      }
    ],
    NOW
  )
  window.api = { getUsageReport: vi.fn(() => Promise.resolve(report)) } as unknown as typeof window.api
}

describe('UsagePanel', () => {
  it('shows spend per day and per project from the local report', async () => {
    installApi()
    render(<UsagePanel costCeilingUsd={0} onChangeCostCeiling={vi.fn()} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('shop')).toBeInTheDocument())
    const row = screen.getByText('shop').closest('tr') as HTMLElement
    expect(within(row).getByText('$0.600')).toBeInTheDocument()
    // The name truncates inside its own block (a table cell ignores max-width), with
    // the full path on the row header.
    expect(screen.getByText('shop')).toHaveClass('usage-view__project-name')
    expect(screen.getByRole('rowheader', { name: 'shop' })).toHaveAttribute('title', '/code/shop')
    // Today's row (and the 30-day total) carry the dated reply's cost.
    expect(screen.getAllByText('$0.420')).toHaveLength(2)
    // The subagent share of the chat's spend is explained, not silently dropped.
    expect(screen.getByText(/came from subagents/)).toHaveTextContent(/^\$0\.180 and 400 output tokens came from subagents/)
  })

  it('edits the cost reminder, saving on Enter', async () => {
    installApi()
    const onChange = vi.fn()
    const { rerender } = render(<UsagePanel costCeilingUsd={0} onChangeCostCeiling={onChange} onClose={vi.fn()} />)
    const input = screen.getByRole('spinbutton', { name: 'Cost reminder, US dollars per turn' })
    fireEvent.change(input, { target: { value: '2.5' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(2.5)
    rerender(<UsagePanel costCeilingUsd={2.5} onChangeCostCeiling={onChange} onClose={vi.fn()} />)
    // A negative or junk value is read as off.
    fireEvent.change(input, { target: { value: '-3' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenLastCalledWith(0)
  })

  it('lists the last rate-limit state of each provider, and leaves the section out without one', async () => {
    installApi()
    const { unmount } = render(<UsagePanel costCeilingUsd={0} onChangeCostCeiling={vi.fn()} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('shop')).toBeInTheDocument())
    expect(screen.queryByRole('heading', { name: 'Provider rate limits' })).toBeNull()
    unmount()

    installApi()
    window.api.getRateLimits = vi.fn().mockResolvedValue([
      { providerId: 'anthropic', observedAt: Date.now(), remainingRequests: 0, remainingTokens: 900, source: 'retry' }
    ])
    window.api.onRateLimitsChanged = vi.fn(() => () => {})
    render(<UsagePanel costCeilingUsd={0} onChangeCostCeiling={vi.fn()} onClose={vi.fn()} />)
    expect(await screen.findByRole('heading', { name: 'Provider rate limits' })).toBeInTheDocument()
    expect(screen.getByText(/0 requests and 900 tokens left/)).toBeInTheDocument()
    expect(screen.getByText('anthropic')).toBeInTheDocument()
  })
})
