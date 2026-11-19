import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/types'
import type { SettingsCtx } from '../context'
import { NotificationsSection } from './app'

afterEach(cleanup)

function ctx(settings: Partial<AppSettings> = {}): SettingsCtx {
  return {
    settings: settings as AppSettings,
    setSettings: vi.fn(),
    busy: null,
    setBusy: vi.fn(),
    keyInputs: {},
    setKeyInputs: vi.fn(),
    setFormError: vi.fn(),
    saveKey: vi.fn(),
    removeKey: vi.fn(),
    persistNow: vi.fn(() => Promise.resolve()),
    workspace: '/w/app',
    policy: null
  }
}

function installApi(opts: { hasOsPage: boolean; supported?: boolean; fail?: boolean }) {
  const sendTestNotification = vi.fn(() =>
    opts.fail ? Promise.reject(new Error('ipc down')) : Promise.resolve(opts.supported ?? true)
  )
  const openNotificationSettings = vi.fn(() => Promise.resolve(true))
  const notificationSettingsAvailable = vi.fn(() => Promise.resolve(opts.hasOsPage))
  window.api = {
    sendTestNotification,
    openNotificationSettings,
    notificationSettingsAvailable
  } as unknown as typeof window.api
  return { sendTestNotification, openNotificationSettings }
}

describe('NotificationsSection test notification', () => {
  it('sends a test and says where to look when nothing appears', async () => {
    const api = installApi({ hasOsPage: true })
    render(<NotificationsSection ctx={ctx()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send test notification' }))
    expect(await screen.findByText(/allow Houston in system notification settings/)).toBeTruthy()
    expect(api.sendTestNotification).toHaveBeenCalledOnce()
  })

  it('on macOS, says how to keep notifications on screen', async () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    installApi({ hasOsPage: true })
    render(<NotificationsSection ctx={ctx()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send test notification' }))
    expect(await screen.findByText(/set Houston’s notifications to Persistent/)).toBeTruthy()
    platform.mockRestore()
  })

  it('opens the system notification settings', async () => {
    const api = installApi({ hasOsPage: true })
    render(<NotificationsSection ctx={ctx()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open system notification settings' }))
    expect(api.openNotificationSettings).toHaveBeenCalledOnce()
  })

  it('offers no settings shortcut where the OS has no such page', async () => {
    installApi({ hasOsPage: false })
    render(<NotificationsSection ctx={ctx()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send test notification' }))
    expect(await screen.findByText(/check your desktop’s notification settings/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open system notification settings' })).toBeNull()
  })

  it('says so when the system cannot show notifications', async () => {
    installApi({ hasOsPage: false, supported: false })
    render(<NotificationsSection ctx={ctx()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send test notification' }))
    expect(await screen.findByText('This system can’t show desktop notifications.')).toBeTruthy()
  })

  it('says agent notifications are off when they are, though the test is sent', async () => {
    const api = installApi({ hasOsPage: true })
    render(<NotificationsSection ctx={ctx({ desktopNotifications: false })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send test notification' }))
    expect(await screen.findByText(/Agent notifications are off/)).toBeTruthy()
    expect(api.sendTestNotification).toHaveBeenCalledWith(false)
  })

  it('reports a failed send instead of staying silent', async () => {
    installApi({ hasOsPage: true, fail: true })
    render(<NotificationsSection ctx={ctx()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send test notification' }))
    expect(await screen.findByText('Couldn’t send a test notification.')).toBeTruthy()
  })
})
