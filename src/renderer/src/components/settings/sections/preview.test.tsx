import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/types'
import type { SettingsCtx } from '../context'
import { PreviewSection } from './tools'

afterEach(cleanup)

function ctx(settings: Partial<AppSettings>): SettingsCtx {
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
    persistNow: vi.fn(),
    workspace: null,
    policy: null
  }
}

describe('PreviewSection', () => {
  it('is on by default and saves an explicit off', () => {
    const c = ctx({})
    render(<PreviewSection ctx={c} />)
    const box = screen.getByRole('checkbox') as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    const update = (c.setSettings as ReturnType<typeof vi.fn>).mock.calls[0][0] as (s: AppSettings) => AppSettings
    expect(update({} as AppSettings).previewAutoOpen).toBe(false)
  })

  it('shows off when turned off', () => {
    render(<PreviewSection ctx={ctx({ previewAutoOpen: false })} />)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })
})
