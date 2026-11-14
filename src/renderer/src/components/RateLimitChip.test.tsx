import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RateLimitState } from '@shared/rateLimitState'
import { RateLimitChip } from './RateLimitChip'
import { useRateLimits } from '../hooks/useRateLimits'

const state = (over: Partial<RateLimitState> = {}): RateLimitState => ({
  providerId: 'anthropic',
  observedAt: Date.now(),
  remainingRequests: 0,
  remainingTokens: 1200,
  source: 'retry',
  ...over
})

function Bar({ provider }: { provider: string }): JSX.Element {
  const states = useRateLimits()
  return (
    <footer data-testid="bar">
      <RateLimitChip state={states.find((s) => s.providerId === provider)} />
    </footer>
  )
}

describe('RateLimitChip', () => {
  const original = window.api
  afterEach(() => {
    window.api = original
  })

  it('shows nothing without data', () => {
    const { container } = render(<RateLimitChip state={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says what is left and when it resets, with the full line on hover', () => {
    const resetAt = Date.now() + 60_000
    render(<RateLimitChip state={state({ resetAt })} />)
    const time = new Date(resetAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    const chip = screen.getByText(`0 requests and 1,200 tokens left, resets ${time}`)
    expect(chip.getAttribute('title')).toMatch(/^Provider rate limit: 0 requests and 1,200 tokens left/)
  })

  it('follows main: hidden until the selected provider reports, then updated live', async () => {
    let push: ((s: RateLimitState[]) => void) | undefined
    window.api = {
      getRateLimits: vi.fn().mockResolvedValue([state({ providerId: 'openai', remainingRequests: 5 })]),
      onRateLimitsChanged: vi.fn((cb: (s: RateLimitState[]) => void) => {
        push = cb
        return () => {}
      })
    } as unknown as typeof window.api
    render(<Bar provider="anthropic" />)
    await act(async () => {})
    // Another provider's state is not this chat's.
    expect(screen.getByTestId('bar')).toBeEmptyDOMElement()
    act(() => push?.([state({ remainingRequests: 3, remainingTokens: undefined })]))
    expect(screen.getByText('3 requests left')).toBeInTheDocument()
  })
})
