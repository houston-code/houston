import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Icon } from './Icon'

describe('Icon', () => {
  it('renders an svg tagged with the icon name', () => {
    const { container } = render(<Icon name="archive" />)
    const svg = container.querySelector('svg')
    expect(svg).toBeInTheDocument()
    expect(svg).toHaveAttribute('data-icon', 'archive')
  })

  it('is decorative (aria-hidden) and inherits color via currentColor', () => {
    const { container } = render(<Icon name="filter" />)
    const svg = container.querySelector('svg')!
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveAttribute('stroke', 'currentColor')
    // Keeps the shared base class so global sizing/alignment applies.
    expect(svg).toHaveClass('icon')
  })

  it('honors a custom size and appends an extra className', () => {
    const { container } = render(<Icon name="copy" size={20} className="extra" />)
    const svg = container.querySelector('svg')!
    expect(svg).toHaveAttribute('width', '20')
    expect(svg).toHaveAttribute('height', '20')
    expect(svg).toHaveClass('icon', 'extra')
  })
})
