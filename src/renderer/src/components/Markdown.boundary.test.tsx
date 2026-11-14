import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// A visual whose renderer throws, the way a bug on some model-written diagram would.
vi.mock('./VisualBlock', () => ({
  VisualBlock: () => {
    throw new Error('visual failed')
  }
}))

import { Markdown } from './Markdown'

afterEach(() => vi.restoreAllMocks())

describe('Markdown visual error boundary', () => {
  it('replaces only the failing visual with a notice and keeps the surrounding text', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<Markdown text={'Before\n\n```svg\n<svg></svg>\n```\n\nAfter'} visuals />)
    expect(screen.getByText("This item couldn't be shown.")).toBeInTheDocument()
    expect(screen.getByText('Before')).toBeInTheDocument()
    expect(screen.getByText('After')).toBeInTheDocument()
  })
})
