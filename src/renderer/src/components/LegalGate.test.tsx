import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LICENSE_URL, PRIVACY_URL, TERMS_URL } from '@shared/legal'
import { LegalGate } from './LegalGate'

describe('LegalGate', () => {
  it('renders a labelled modal dialog with the key disclaimers', () => {
    render(<LegalGate onAccept={() => {}} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('legal-gate-title')
    expect(screen.getByText(/before you use houston/i)).toBeInTheDocument()
    // The load-bearing disclaimers are stated inline (not only behind links).
    expect(screen.getByText(/as.is, no warranty/i)).toBeInTheDocument()
    expect(screen.getByText(/no liability/i)).toBeInTheDocument()
    expect(screen.getByText(/you are responsible/i)).toBeInTheDocument()
    expect(screen.getByText(/data residency is your call/i)).toBeInTheDocument()
  })

  it('shows first-run copy by default (not the updated-terms wording)', () => {
    render(<LegalGate onAccept={() => {}} />)
    expect(screen.getByText(/before you use houston/i)).toBeInTheDocument()
    expect(screen.queryByText(/have been updated/i)).not.toBeInTheDocument()
  })

  it('shows updated-terms copy when isUpdate is set', () => {
    render(<LegalGate onAccept={() => {}} isUpdate />)
    expect(screen.getByText(/houston’s terms have been updated/i)).toBeInTheDocument()
    expect(screen.getByText(/we’ve updated houston’s terms/i)).toBeInTheDocument()
    expect(screen.queryByText(/before you use houston/i)).not.toBeInTheDocument()
    // Disclaimers, links, and the accept button are unchanged in update mode.
    expect(screen.getByText(/no liability/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /terms of use/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /i agree/i })).toBeInTheDocument()
  })

  it('links to the full Terms, Privacy Policy, and License', () => {
    render(<LegalGate onAccept={() => {}} />)
    expect(screen.getByRole('link', { name: /terms of use/i })).toHaveAttribute('href', TERMS_URL)
    expect(screen.getByRole('link', { name: /privacy policy/i })).toHaveAttribute(
      'href',
      PRIVACY_URL
    )
    expect(screen.getByRole('link', { name: /apache license 2\.0/i })).toHaveAttribute(
      'href',
      LICENSE_URL
    )
  })

  it('asks acceptance for the Terms and Privacy Policy only, not the license', () => {
    // Houston is Apache-2.0: the license grants rights rather than imposing conditions
    // on running the app, so it is linked for reference but never something to accept.
    render(<LegalGate onAccept={() => {}} />)
    const consent = screen.getByText(/by selecting/i)
    expect(consent).toHaveTextContent(/accept the Terms of Use and the Privacy Policy/i)
    expect(consent).not.toHaveTextContent(/accept the Terms of Use, Privacy Policy, and License/i)
  })

  it('accepts only via the "I Agree" button', () => {
    const onAccept = vi.fn()
    render(<LegalGate onAccept={onAccept} />)
    fireEvent.click(screen.getByRole('button', { name: /i agree/i }))
    expect(onAccept).toHaveBeenCalledOnce()
  })

  it('cannot be dismissed with Escape (it is a blocking gate)', () => {
    const onAccept = vi.fn()
    render(<LegalGate onAccept={onAccept} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onAccept).not.toHaveBeenCalled()
  })

  it('quits via the "Quit" button', () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => {})
    render(<LegalGate onAccept={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /quit/i }))
    expect(close).toHaveBeenCalledOnce()
    close.mockRestore()
  })
})
