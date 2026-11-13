import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { RunMeterText } from './RunMeterText'

describe('RunMeterText', () => {
  it('renders nothing while no turn runs', () => {
    const { container } = render(<RunMeterText meter={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('ticks the elapsed time once a second and shows output tokens', () => {
    vi.useFakeTimers({ now: 10_000 })
    try {
      const { container } = render(<RunMeterText meter={{ startedAt: 10_000, reported: 1200, streamedChars: 400 }} />)
      expect(container.textContent).toBe('0s · 1.3k tokens')
      act(() => {
        vi.advanceTimersByTime(3_000)
      })
      expect(container.textContent).toBe('3s · 1.3k tokens')
    } finally {
      vi.useRealTimers()
    }
  })
})
