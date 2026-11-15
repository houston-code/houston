// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import type { AppSettings, ProviderConfig } from '@shared/types'
import { defaultSettings } from '@shared/defaults'
import type { SettingsCtx } from '../context'
import { FallbackModelsSection } from './models'

let latest: AppSettings

const providers = [
  { id: 'anthropic', label: 'Anthropic', kind: 'anthropic', requiresKey: true, hasKey: true, models: [{ id: 'claude-haiku-5-5' }] },
  { id: 'openai', label: 'OpenAI', kind: 'openai', requiresKey: true, hasKey: true, models: [{ id: 'gpt-5' }] },
  { id: 'nokey', label: 'NoKey', kind: 'openai', requiresKey: true, hasKey: false, models: [{ id: 'x' }] }
] as unknown as ProviderConfig[]

function Harness({ initial }: { initial: Partial<AppSettings> }): JSX.Element {
  const [settings, setSettings] = useState<AppSettings>({ ...defaultSettings(), providers, ...initial })
  latest = settings
  const ctx = { settings, setSettings } as unknown as SettingsCtx
  return <FallbackModelsSection ctx={ctx} />
}

describe('FallbackModelsSection', () => {
  it('adds a ready model, offering only models not already listed', () => {
    render(<Harness initial={{}} />)
    expect(screen.queryByRole('combobox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '+ Add fallback model' }))
    const select = screen.getByRole('combobox', { name: 'Fallback model to add' }) as HTMLSelectElement
    // Ready providers only: the one without a key is not offered.
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Choose a model…',
      'Anthropic: claude-haiku-5-5',
      'OpenAI: gpt-5'
    ])
    fireEvent.change(select, { target: { value: select.options[2].value } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(latest.fallbackModels).toEqual([{ providerId: 'openai', model: 'gpt-5' }])
    fireEvent.click(screen.getByRole('button', { name: '+ Add fallback model' }))
    const again = screen.getByRole('combobox', { name: 'Fallback model to add' }) as HTMLSelectElement
    expect([...again.options].map((o) => o.textContent)).not.toContain('OpenAI: gpt-5')
  })

  it('reorders and removes, clearing the setting when the list empties', () => {
    render(
      <Harness
        initial={{
          fallbackModels: [
            { providerId: 'openai', model: 'gpt-5' },
            { providerId: 'anthropic', model: 'claude-haiku-5-5' }
          ]
        }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Move Anthropic.* up/ }))
    expect(latest.fallbackModels?.[0].providerId).toBe('anthropic')
    fireEvent.click(screen.getByRole('button', { name: /Remove Anthropic/ }))
    fireEvent.click(screen.getByRole('button', { name: /Remove OpenAI/ }))
    expect(latest.fallbackModels).toBeUndefined()
  })

  it('marks an entry a run would skip', () => {
    render(<Harness initial={{ fallbackModels: [{ providerId: 'gone', model: 'm' }] }} />)
    expect(screen.getByText(/skipped: provider removed/)).toBeTruthy()
  })
})
