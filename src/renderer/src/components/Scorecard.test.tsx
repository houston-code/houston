import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Scorecard as ScorecardData } from '@shared/scorecard'
import { Scorecard } from './Scorecard'

/** Install a fake `window.api` whose getScorecard resolves to `data`. */
function installApi(data: ScorecardData) {
  const getScorecard = vi.fn().mockResolvedValue(data)
  window.api = { getScorecard } as unknown as typeof window.api
  return { getScorecard }
}

const emptyData: ScorecardData = { models: [], totalRuns: 0, totalCost: 0 }

const sampleData: ScorecardData = {
  totalRuns: 3,
  totalCost: 1.23,
  models: [
    {
      model: 'claude-opus-4-6',
      runs: 2,
      totalSteps: 6,
      avgSteps: 3,
      totalToolCalls: 8,
      avgToolCalls: 4,
      totalOutputTokens: 12_345,
      totalCost: 1.2,
      avgCost: 0.6,
      completedRuns: 1,
      limitedRuns: 1,
      completionRate: 0.5,
      tools: [
        { name: 'read_file', count: 5 },
        { name: 'run_shell', count: 3 }
      ]
    },
    {
      model: 'gpt-5',
      runs: 1,
      totalSteps: 2,
      avgSteps: 2,
      totalToolCalls: 0,
      avgToolCalls: 0,
      totalOutputTokens: 200,
      totalCost: 0.03,
      avgCost: 0.03,
      completedRuns: 1,
      limitedRuns: 0,
      completionRate: 1,
      tools: []
    }
  ]
}

describe('Scorecard', () => {
  it('renders a per-model card with derived stats and a tool histogram', async () => {
    installApi(sampleData)
    render(<Scorecard onClose={vi.fn()} />)

    expect(await screen.findByText('claude-opus-4-6')).toBeInTheDocument()
    expect(screen.getByText('gpt-5')).toBeInTheDocument()
    // Avg steps value for the opus card.
    const opusCard = screen.getByLabelText('Stats for claude-opus-4-6')
    const avgSteps = opusCard.querySelector('.scorecard-stat__value')
    expect(avgSteps?.textContent).toBe('3')
    // Completion rate rendered as a percentage.
    expect(screen.getByText('50%')).toBeInTheDocument()
    // Tool histogram entries.
    expect(screen.getByText('read_file')).toBeInTheDocument()
    expect(screen.getByText('run_shell')).toBeInTheDocument()
    // Header totals.
    expect(screen.getByText('3 runs')).toBeInTheDocument()
  })

  it('shows an empty state when there are no runs yet', async () => {
    installApi(emptyData)
    render(<Scorecard onClose={vi.fn()} />)
    expect(await screen.findByText(/No runs yet/i)).toBeInTheDocument()
  })

  it('surfaces an error when the aggregation fails', async () => {
    const getScorecard = vi.fn().mockRejectedValue(new Error('disk gone'))
    window.api = { getScorecard } as unknown as typeof window.api
    render(<Scorecard onClose={vi.fn()} />)
    expect(await screen.findByText(/disk gone/)).toBeInTheDocument()
  })

  it('closes when the overlay is clicked and via the close button', async () => {
    installApi(sampleData)
    const onClose = vi.fn()
    const { container } = render(<Scorecard onClose={onClose} />)
    await screen.findByText('claude-opus-4-6')

    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledTimes(1)

    const overlay = container.querySelector('.drawer-overlay') as HTMLElement
    fireEvent.click(overlay)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('refetches when the refresh button is pressed', async () => {
    const api = installApi(sampleData)
    render(<Scorecard onClose={vi.fn()} />)
    await screen.findByText('claude-opus-4-6')
    expect(api.getScorecard).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTitle('Refresh'))
    await waitFor(() => expect(api.getScorecard).toHaveBeenCalledTimes(2))
  })
})
