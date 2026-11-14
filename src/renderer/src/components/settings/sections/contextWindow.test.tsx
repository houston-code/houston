// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import type { AppSettings } from '@shared/types'
import { defaultSettings } from '@shared/defaults'
import type { SettingsCtx } from '../context'
import { ContextWindowSection } from './models'

let latest: AppSettings

function Harness({ initial }: { initial: Partial<AppSettings> }): JSX.Element {
  const [settings, setSettings] = useState<AppSettings>({ ...defaultSettings(), ...initial })
  latest = settings
  const ctx = { settings, setSettings } as unknown as SettingsCtx
  return <ContextWindowSection ctx={ctx} />
}

describe('ContextWindowSection compaction limit', () => {
  it('starts automatic and stores nothing for it', () => {
    render(<Harness initial={{}} />)
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('auto')
    expect(screen.queryByRole('spinbutton', { name: /percentage/ })).toBeNull()
  })

  it('stores a share of the window, and only that field', () => {
    render(<Harness initial={{ compactionThreshold: 90_000 }} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'percent' } })
    const input = screen.getByRole('spinbutton', { name: /percentage of the context window/ })
    fireEvent.change(input, { target: { value: '45' } })
    expect(latest.compactionThresholdPercent).toBe(45)
    expect(latest.compactionThreshold).toBeUndefined()
    fireEvent.change(input, { target: { value: '250' } })
    expect(latest.compactionThresholdPercent).toBe(100)
  })

  it('stores a token count, and 0 for off', () => {
    render(<Harness initial={{ compactionThresholdPercent: 30 }} />)
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('percent')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'tokens' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: /many tokens/ }), { target: { value: '120000' } })
    expect(latest.compactionThreshold).toBe(120_000)
    expect(latest.compactionThresholdPercent).toBeUndefined()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'off' } })
    expect(latest.compactionThreshold).toBe(0)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'auto' } })
    expect('compactionThreshold' in latest).toBe(false)
  })
})
