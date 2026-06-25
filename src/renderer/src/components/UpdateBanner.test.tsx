import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { UpdateCheckResult } from '@shared/update'
import { UpdateBanner } from './UpdateBanner'

const available: Extract<UpdateCheckResult, { status: 'available' }> = {
  status: 'available',
  currentVersion: '0.1.0',
  latestVersion: '0.2.0',
  releaseUrl: 'https://github.com/piyushvijay/houston/releases'
}

describe('UpdateBanner', () => {
  it('renders nothing when there is no update', () => {
    const { container } = render(<UpdateBanner update={null} onDismiss={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows both versions and a download link to the releases page', () => {
    render(<UpdateBanner update={available} onDismiss={() => {}} />)
    expect(screen.getByText(/0\.2\.0/)).toBeInTheDocument()
    expect(screen.getByText(/0\.1\.0/)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /download/i })
    expect(link).toHaveAttribute('href', available.releaseUrl)
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('calls onDismiss when the dismiss button is clicked', () => {
    const onDismiss = vi.fn()
    render(<UpdateBanner update={available} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
