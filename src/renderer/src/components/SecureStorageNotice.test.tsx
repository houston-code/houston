import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SecureStorageNotice, secureStorageBlocked } from './SecureStorageNotice'

function installApi(opts: { relaunch?: boolean; status?: { available: boolean; platform: string } } = {}) {
  const api = {
    relaunchApp: vi.fn(() => Promise.resolve(opts.relaunch ?? true)),
    getSecureStorageStatus: vi.fn(() =>
      Promise.resolve(opts.status ?? { available: false, platform: 'darwin' })
    )
  }
  window.api = api as unknown as typeof window.api
  return api
}

describe('SecureStorageNotice', () => {
  it('explains the macOS fix and restarts Houston on request', async () => {
    const api = installApi()
    render(<SecureStorageNotice platform="darwin" />)
    expect(screen.getByRole('alert')).toHaveTextContent('choose Always Allow')
    fireEvent.click(screen.getByRole('button', { name: 'Restart Houston' }))
    await waitFor(() => expect(api.relaunchApp).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Restarting…' })).toBeDisabled()
  })

  it('re-enables the button when the user keeps running work instead', async () => {
    installApi({ relaunch: false })
    render(<SecureStorageNotice platform="darwin" />)
    fireEvent.click(screen.getByRole('button', { name: 'Restart Houston' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restart Houston' })).toBeEnabled())
  })
})

describe('secureStorageBlocked', () => {
  it('returns the platform when the secure store is unusable', async () => {
    installApi({ status: { available: false, platform: 'linux' } })
    expect(await secureStorageBlocked()).toBe('linux')
  })

  it('returns null when storage works (the failure was something else)', async () => {
    installApi({ status: { available: true, platform: 'darwin' } })
    expect(await secureStorageBlocked()).toBeNull()
  })
})
