import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { UpdateCheckResult } from '@shared/update'
import { UpdateBanner } from './UpdateBanner'

const available: Extract<UpdateCheckResult, { status: 'available' }> = {
  status: 'available',
  currentVersion: '0.1.0',
  latestVersion: '0.2.0',
  releaseUrl: 'https://github.com/houston-code/houston/releases'
}

const noop = (): void => {}

describe('UpdateBanner', () => {
  it('renders nothing when there is no update state', () => {
    const { container } = render(
      <UpdateBanner
        update={null}
        progress={null}
        downloaded={null}
        onInstall={noop}
        onDismiss={noop}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a manual download link on unsigned builds (no autoInstall)', () => {
    render(
      <UpdateBanner
        update={available}
        progress={null}
        downloaded={null}
        onInstall={noop}
        onDismiss={noop}
      />
    )
    expect(screen.getByText(/0\.2\.0/)).toBeInTheDocument()
    expect(screen.getByText(/0\.1\.0/)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /download/i })
    expect(link).toHaveAttribute('href', available.releaseUrl)
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('shows "Downloading…" instead of a link when the build auto-installs', () => {
    render(
      <UpdateBanner
        update={{ ...available, autoInstall: true }}
        progress={null}
        downloaded={null}
        onInstall={noop}
        onDismiss={noop}
      />
    )
    expect(screen.queryByRole('link', { name: /download/i })).not.toBeInTheDocument()
    expect(screen.getByText(/downloading/i)).toBeInTheDocument()
  })

  it('shows a progress percentage while downloading', () => {
    render(
      <UpdateBanner
        update={available}
        progress={{ percent: 42, bytesPerSecond: 1000, transferred: 4, total: 10 }}
        downloaded={null}
        onInstall={noop}
        onDismiss={noop}
      />
    )
    expect(screen.getByText(/42%/)).toBeInTheDocument()
  })

  it('shows a Restart-to-install button once downloaded and calls onInstall', () => {
    const onInstall = vi.fn()
    render(
      <UpdateBanner
        update={available}
        progress={null}
        downloaded={{ version: '0.2.0' }}
        onInstall={onInstall}
        onDismiss={noop}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /restart to install/i }))
    expect(onInstall).toHaveBeenCalledOnce()
  })

  it('prioritizes the downloaded state over progress and available', () => {
    render(
      <UpdateBanner
        update={available}
        progress={{ percent: 90, bytesPerSecond: 1, transferred: 9, total: 10 }}
        downloaded={{ version: '0.2.0' }}
        onInstall={noop}
        onDismiss={noop}
      />
    )
    expect(screen.getByRole('button', { name: /restart to install/i })).toBeInTheDocument()
    expect(screen.queryByText(/90%/)).not.toBeInTheDocument()
  })

  it('calls onDismiss when the dismiss button is clicked', () => {
    const onDismiss = vi.fn()
    render(
      <UpdateBanner
        update={available}
        progress={null}
        downloaded={null}
        onInstall={noop}
        onDismiss={onDismiss}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
