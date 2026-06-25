import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WhatsNew } from '@shared/update'
import { WhatsNewModal } from './WhatsNewModal'

const info: WhatsNew = { version: '0.2.0', highlights: 'Faster search and a calmer UI.' }

describe('WhatsNewModal', () => {
  it('renders nothing when there is no pending what\'s-new', () => {
    const { container } = render(<WhatsNewModal info={null} onClose={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the version heading and the highlights', () => {
    render(<WhatsNewModal info={info} onClose={() => {}} />)
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByText(/0\.2\.0/)).toBeInTheDocument()
    expect(screen.getByText(info.highlights)).toBeInTheDocument()
  })

  it('closes via the "Got it" button', () => {
    const onClose = vi.fn()
    render(<WhatsNewModal info={info} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /got it/i }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
