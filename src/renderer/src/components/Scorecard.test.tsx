import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { emptyFailureSignalCounts } from '@shared/failureSignals'
import { emptyRunEndCounts, type Scorecard as ScorecardData } from '@shared/scorecard'
import { Scorecard } from './Scorecard'

/** Install a fake `window.api` whose getScorecard resolves to `data`. */
function installApi(data: ScorecardData) {
  const getScorecard = vi.fn().mockResolvedValue(data)
  window.api = { getScorecard } as unknown as typeof window.api
  return { getScorecard }
}

const emptyData: ScorecardData = { groupBy: 'model', models: [], totalRuns: 0, totalCost: 0 }

const sampleData: ScorecardData = {
  groupBy: 'model',
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
      runEnds: { ...emptyRunEndCounts(), error: 1, limits: { ...emptyRunEndCounts().limits, stalled: 2 } },
      tools: [
        { name: 'read_file', count: 5 },
        { name: 'run_shell', count: 3 }
      ],
      signals: { ...emptyFailureSignalCounts(), stalled: 2, toolArgError: 3, unanswered: 1 }
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
      runEnds: emptyRunEndCounts(),
      tools: [],
      signals: emptyFailureSignalCounts()
    }
  ]
}

describe('Scorecard', () => {
  it('takes focus on open and closes on Esc', async () => {
    installApi(emptyData)
    const onClose = vi.fn()
    render(<Scorecard onClose={onClose} />)
    expect(document.activeElement).toBe(screen.getByLabelText('Close'))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

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

  it('lists how runs stopped short and the failure signals, each kind once', async () => {
    installApi(sampleData)
    render(<Scorecard onClose={vi.fn()} />)
    const opusCard = await screen.findByLabelText('Stats for claude-opus-4-6')
    const stops = within(opusCard).getByLabelText('Runs that stopped short')
    expect([...stops.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['failed 1', 'stalled 2'])
    const signals = within(opusCard).getByLabelText('Failure signals')
    // The stall is shown with the stops, not a second time as a signal.
    expect([...signals.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'no reply 1',
      'malformed tool calls 3'
    ])
    expect(within(signals).getByText(/malformed tool calls/).getAttribute('title')).toMatch(/invalid arguments/)

    // A model with nothing to report says so instead of listing empty chips.
    const gptCard = screen.getByLabelText('Stats for gpt-5')
    expect(within(gptCard).queryByLabelText('Runs that stopped short')).toBeNull()
    expect(within(gptCard).getByText('None found')).toBeInTheDocument()
  })

  it('says plainly that it reads the saved chats, text included, on this computer only', async () => {
    installApi(sampleData)
    render(<Scorecard onClose={vi.fn()} />)
    await screen.findByText('claude-opus-4-6')
    const copy = screen.getByText(/worked out on this computer/).textContent ?? ''
    expect(copy).toMatch(/never\s+sent anywhere/)
    expect(copy).toMatch(/including their\s+text/)
    expect(copy).toMatch(/only the counts are shown/)
    expect(copy).not.toContain('—')
  })

  it('asks for per-model rows first, and splits by prompt version when ticked', async () => {
    const split: ScorecardData = {
      groupBy: 'model-prompt',
      totalRuns: 1,
      totalCost: 0,
      models: [
        { ...sampleData.models[1], promptId: '0123456789ab' },
        { ...sampleData.models[1], totalSteps: 1 }
      ]
    }
    const getScorecard = vi.fn().mockImplementation((groupBy?: string) =>
      Promise.resolve(groupBy === 'model-prompt' ? split : sampleData)
    )
    window.api = { getScorecard } as unknown as typeof window.api
    render(<Scorecard onClose={vi.fn()} />)
    await screen.findByText('claude-opus-4-6')
    expect(getScorecard).toHaveBeenLastCalledWith('model')

    fireEvent.click(screen.getByLabelText('Split each model by prompt version'))
    await waitFor(() => expect(getScorecard).toHaveBeenLastCalledWith('model-prompt'))
    expect(await screen.findByLabelText('Stats for gpt-5 (prompt 0123456789ab)')).toBeInTheDocument()
    expect(screen.getByLabelText('Stats for gpt-5 (before prompt ids)')).toBeInTheDocument()
    expect(screen.queryByText('claude-opus-4-6')).toBeNull()
  })
})
