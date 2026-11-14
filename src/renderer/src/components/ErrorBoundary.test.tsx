import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'

function Boom(): JSX.Element {
  throw new Error('kaboom')
}

describe('ErrorBoundary', () => {
  it('keeps a strip to move the window by on the crash screen', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    )
    expect(screen.getByRole('alert')).toHaveTextContent('kaboom')
    expect(container.querySelector('.window-drag')).toHaveAttribute('aria-hidden', 'true')
    vi.restoreAllMocks()
  })
})
