// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ProviderConfig } from '@shared/types'
import { SmallModelField } from './smallModelField'

const provider = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'anthropic',
  kind: 'anthropic',
  label: 'Anthropic',
  models: [{ id: 'claude-opus-5-5' }, { id: 'claude-haiku-5-5' }],
  requiresKey: true,
  hasKey: true,
  builtIn: true,
  ...over
})

describe('SmallModelField', () => {
  it('shows the automatic pick and stores nothing for it', () => {
    const onChange = vi.fn()
    render(<SmallModelField provider={provider({ smallModel: 'claude-opus-5-5' })} onChange={onChange} />)
    const select = screen.getByLabelText('Model for side tasks (Anthropic)') as HTMLSelectElement
    expect(screen.getByText('Automatic (claude-haiku-5-5)')).toBeTruthy()
    fireEvent.change(select, { target: { value: '__automatic__' } })
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it('stores "" for the chat model, and an id for a listed model', () => {
    const onChange = vi.fn()
    render(<SmallModelField provider={provider()} onChange={onChange} />)
    const select = screen.getByLabelText('Model for side tasks (Anthropic)') as HTMLSelectElement
    expect(select.value).toBe('__automatic__')
    fireEvent.change(select, { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith('')
    fireEvent.change(select, { target: { value: 'claude-opus-5-5' } })
    expect(onChange).toHaveBeenLastCalledWith('claude-opus-5-5')
  })

  it('says the chat model is used when the provider has no curated sibling', () => {
    render(<SmallModelField provider={provider({ kind: 'openai-compatible', label: 'Local', models: [] })} onChange={vi.fn()} />)
    expect(screen.getByText("Automatic (the chat's model)")).toBeTruthy()
  })
})
