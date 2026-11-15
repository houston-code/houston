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
    // Out of range is brought back into range when the field is left, not mid-typing.
    fireEvent.change(input, { target: { value: '250' } })
    fireEvent.blur(input)
    expect(latest.compactionThresholdPercent).toBe(100)
  })

  /** Types `text` one character at a time onto what the box shows, as a keyboard does. */
  function typeInto(input: HTMLInputElement, text: string): void {
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '' } })
    for (const ch of text) fireEvent.change(input, { target: { value: input.value + ch } })
    fireEvent.blur(input)
  }

  it('keeps a token count typed digit by digit into a cleared box', () => {
    render(<Harness initial={{ compactionThreshold: 90_000 }} />)
    const input = screen.getByRole('spinbutton', { name: /many tokens/ }) as HTMLInputElement
    typeInto(input, '80000')
    expect(input.value).toBe('80000')
    expect(latest.compactionThreshold).toBe(80_000)
  })

  it('keeps a percentage typed digit by digit into a cleared box', () => {
    render(<Harness initial={{ compactionThresholdPercent: 30 }} />)
    const input = screen.getByRole('spinbutton', { name: /percentage of the context window/ }) as HTMLInputElement
    typeInto(input, '50')
    expect(input.value).toBe('50')
    expect(latest.compactionThresholdPercent).toBe(50)
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
