import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { UpdateCheckResult } from '@shared/update'
import { UpdateBanner } from './UpdateBanner'

const available: Extract<UpdateCheckResult, { status: 'available' }> = {
  status: 'available',
  currentVersion: '0.1.0',
  latestVersion: '0.2.0',
  releaseUrl: 'https://houstoncode.ai/#download'
}

const noop = (): void => {}

describe('UpdateBanner', () => {
  it('renders nothing when there is no update state', () => {
    const { container } = render(
      <UpdateBanner
        update={null}
        progress={null}
        downloaded={null}
        failed={null}
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
        failed={null}
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
        failed={null}
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
        failed={null}
        onInstall={noop}
        onDismiss={noop}
      />
    )
    expect(screen.getByText(/42%/)).toBeInTheDocument()
  })

  it('keeps the announced text still and puts the percent on a progress bar', () => {
    const banner = (percent: number): JSX.Element => (
      <UpdateBanner
        update={available}
        progress={{ percent, bytesPerSecond: 1000, transferred: 4, total: 10 }}
        downloaded={null}
        failed={null}
        onInstall={noop}
        onDismiss={noop}
      />
    )
    const { rerender } = render(banner(42))
    const bar = screen.getByRole('progressbar', { name: 'Update download' })
    expect(bar).toHaveAttribute('aria-valuenow', '42')
    // What a screen reader hears from the live region doesn't change per progress event.
    const spoken = (): string =>
      [...screen.getByRole('status').querySelectorAll('.update-banner__label')]
        .map((el) => {
          const copy = el.cloneNode(true) as HTMLElement
          copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove())
          return copy.textContent?.trim()
        })
        .join('')
    const before = spoken()
    rerender(banner(43))
    expect(spoken()).toBe(before)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '43')
  })

  it('labels the close button "Cancel download" while the download runs', () => {
    const onDismiss = vi.fn()
    const { rerender } = render(
      <UpdateBanner
        update={{ ...available, autoInstall: true }}
        progress={{ percent: 42, bytesPerSecond: 1000, transferred: 4, total: 10 }}
        downloaded={null}
        failed={null}
        onInstall={noop}
        onDismiss={onDismiss}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel update download' }))
    expect(onDismiss).toHaveBeenCalledOnce()

    // Before the first progress event the download has already started too.
    rerender(
      <UpdateBanner
        update={{ ...available, autoInstall: true }}
        progress={null}
        downloaded={null}
        failed={null}
        onInstall={noop}
        onDismiss={onDismiss}
      />
    )
    expect(screen.getByRole('button', { name: 'Cancel update download' })).toBeInTheDocument()
  })

  it('keeps a plain dismiss once there is no download left to cancel', () => {
    const { rerender } = render(
      <UpdateBanner
        update={available}
        progress={null}
        downloaded={null}
        failed={null}
        onInstall={noop}
        onDismiss={noop}
      />
    )
    expect(screen.getByRole('button', { name: 'Dismiss update notice' })).toBeInTheDocument()
    rerender(
      <UpdateBanner
        update={{ ...available, autoInstall: true }}
        progress={null}
        downloaded={{ version: '0.2.0' }}
        failed={null}
        onInstall={noop}
        onDismiss={noop}
      />
    )
    expect(screen.getByRole('button', { name: 'Dismiss update notice' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument()
  })

  it('shows a Restart-to-install button once downloaded and calls onInstall', () => {
    const onInstall = vi.fn()
    render(
      <UpdateBanner
        update={available}
        progress={null}
        downloaded={{ version: '0.2.0' }}
        failed={null}
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
        failed={null}
        onInstall={noop}
        onDismiss={noop}
      />
    )
    expect(screen.getByRole('button', { name: /restart to install/i })).toBeInTheDocument()
    expect(screen.queryByText(/90%/)).not.toBeInTheDocument()
  })

  it('swaps Restart to install for a Download link when macOS refused the update', () => {
    const onInstall = vi.fn()
    render(
      <UpdateBanner
        update={{ ...available, autoInstall: true }}
        progress={{ percent: 100, bytesPerSecond: 1, transferred: 10, total: 10 }}
        downloaded={{ version: '0.2.0' }}
        failed={{ version: '0.2.0', releaseUrl: 'https://houstoncode.ai/#download' }}
        onInstall={onInstall}
        onDismiss={noop}
      />
    )
    expect(screen.getByText(/couldn’t be installed automatically/i)).toBeInTheDocument()
    expect(screen.getByText('0.2.0')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /download/i })
    expect(link).toHaveAttribute('href', 'https://houstoncode.ai/#download')
    expect(link).toHaveAttribute('target', '_blank')
    // Nothing left that claims the update can still install in place.
    expect(screen.queryByRole('button', { name: /restart to install/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/100%/)).not.toBeInTheDocument()
    expect(screen.queryByText(/downloading/i)).not.toBeInTheDocument()
  })

  it('lets the refused-update notice be dismissed', () => {
    const onDismiss = vi.fn()
    render(
      <UpdateBanner
        update={null}
        progress={null}
        downloaded={null}
        failed={{ version: '0.2.0', releaseUrl: 'https://houstoncode.ai/#download' }}
        onInstall={noop}
        onDismiss={onDismiss}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('calls onDismiss when the dismiss button is clicked', () => {
    const onDismiss = vi.fn()
    render(
      <UpdateBanner
        update={available}
        progress={null}
        downloaded={null}
        failed={null}
        onInstall={noop}
        onDismiss={onDismiss}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
