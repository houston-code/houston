import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ComposerPrBar } from './ComposerPrBar'

const props = (over = {}) => ({
  changes: { fileCount: 3, added: 42, removed: 7 },
  onShowChanges: vi.fn(),
  onCreatePr: vi.fn(),
  ...over
})

describe('ComposerPrBar', () => {
  it('shows the file count to the left of the +/− stat', () => {
    render(<ComposerPrBar {...props()} />)
    expect(screen.getByText('3 changed files')).toBeInTheDocument()
    expect(screen.getByText('+42')).toBeInTheDocument()
    expect(screen.getByText('−7')).toBeInTheDocument()
  })

  it('singularizes a single changed file', () => {
    render(<ComposerPrBar {...props({ changes: { fileCount: 1, added: 2, removed: 0 } })} />)
    expect(screen.getByText('1 changed file')).toBeInTheDocument()
  })

  it('opens the Changes panel when the stat chip is clicked', () => {
    const onShowChanges = vi.fn()
    render(<ComposerPrBar {...props({ onShowChanges })} />)
    fireEvent.click(screen.getByRole('button', { name: /changed files/ }))
    expect(onShowChanges).toHaveBeenCalledTimes(1)
  })

  it('hands off to the agent when Create PR is clicked', () => {
    const onCreatePr = vi.fn()
    render(<ComposerPrBar {...props({ onCreatePr })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create PR' }))
    expect(onCreatePr).toHaveBeenCalledTimes(1)
  })

  it('disables Create PR while a run is in progress', () => {
    render(<ComposerPrBar {...props({ creating: true })} />)
    expect(screen.getByRole('button', { name: 'Create PR' })).toBeDisabled()
  })

  it('renders nothing when there are no changes', () => {
    const { container } = render(
      <ComposerPrBar {...props({ changes: { fileCount: 0, added: 0, removed: 0 } })} />
    )
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('button', { name: 'Create PR' })).not.toBeInTheDocument()
  })
})
