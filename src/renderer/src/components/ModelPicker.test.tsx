import { fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, afterEach } from 'vitest'
import type { AppSettings, ProviderConfig, SelectedModel } from '@shared/types'
import { ModelPicker } from './ModelPicker'

function provider(over: Partial<ProviderConfig> & Pick<ProviderConfig, 'id'>): ProviderConfig {
  return {
    kind: 'openai',
    label: 'OpenAI (GPT)',
    models: [],
    requiresKey: true,
    hasKey: true,
    builtIn: true,
    ...over
  }
}

/** OpenAI provider in the post-migration shape: GPT-5 family appended to the bottom. */
function settingsWith(models: ProviderConfig['models']): AppSettings {
  return { providers: [provider({ id: 'openai', models })] } as unknown as AppSettings
}

const OPENAI_STORED = [
  { id: 'gpt-4o', label: 'GPT-4o' },
  { id: 'o3', label: 'o3' },
  { id: 'gpt-5', label: 'GPT-5' },
  { id: 'gpt-5-mini', label: 'GPT-5 mini' }
]

function renderPicker(over?: {
  settings?: AppSettings
  selected?: SelectedModel | null
  onSelect?: (s: SelectedModel) => void
}) {
  const onSelect = over?.onSelect ?? vi.fn()
  // `?? ` would turn an explicit `selected: null` back into the default, so honor the
  // key's presence instead.
  const selected: SelectedModel | null =
    over && 'selected' in over ? over.selected ?? null : { providerId: 'openai', model: 'gpt-5' }
  render(
    <ModelPicker
      settings={over?.settings ?? settingsWith(OPENAI_STORED)}
      selected={selected}
      onSelect={onSelect}
    />
  )
  return { onSelect }
}

describe('ModelPicker', () => {
  it('shows the selected model with its context window on the trigger', () => {
    renderPicker()
    expect(screen.getByTitle('Model')).toHaveTextContent('GPT-5 · 400k')
  })

  it('orders models by the curated default order, not the stored order', () => {
    renderPicker()
    fireEvent.click(screen.getByTitle('Model'))
    const names = screen.getAllByRole('option').map((o) => o.textContent)
    // Stored order was gpt-4o, o3, gpt-5, gpt-5-mini — display restores GPT-5 first.
    expect(names[0]).toContain('GPT-5')
    expect(names[1]).toContain('GPT-5 mini')
    expect(names[2]).toContain('GPT-4o')
    expect(names[3]).toContain('o3')
  })

  it('annotates each model with its context window', () => {
    renderPicker()
    fireEvent.click(screen.getByTitle('Model'))
    // Exact names so the bare "GPT-5" doesn't also match "GPT-5 mini".
    expect(screen.getByRole('option', { name: 'GPT-5 400k' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'GPT-5 mini 400k' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'GPT-4o 128k' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'o3 200k' })).toBeInTheDocument()
  })

  it('marks the current model as the selected option', () => {
    renderPicker()
    fireEvent.click(screen.getByTitle('Model'))
    const selected = screen.getByRole('option', { selected: true })
    expect(selected).toHaveTextContent('GPT-5')
  })

  it('selects a model on click and closes the menu', () => {
    const { onSelect } = renderPicker()
    fireEvent.click(screen.getByTitle('Model'))
    fireEvent.click(screen.getByRole('option', { name: /GPT-4o/ }))
    expect(onSelect).toHaveBeenCalledWith({ providerId: 'openai', model: 'gpt-4o' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('navigates with the arrow keys and selects with Enter', () => {
    const { onSelect } = renderPicker()
    const trigger = screen.getByTitle('Model')
    fireEvent.click(trigger) // opens with gpt-5 active
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }) // -> gpt-5-mini
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith({ providerId: 'openai', model: 'gpt-5-mini' })
  })

  it('closes on Escape without selecting', () => {
    const { onSelect } = renderPicker()
    const trigger = screen.getByTitle('Model')
    fireEvent.click(trigger)
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('shows a placeholder group when a provider has no models', () => {
    renderPicker({ settings: settingsWith([]), selected: null })
    expect(screen.getByTitle('Model')).toHaveTextContent('Select a model…')
    fireEvent.click(screen.getByTitle('Model'))
    const group = screen.getByRole('group', { name: 'OpenAI (GPT)' })
    expect(within(group).getByText(/no models configured/)).toBeInTheDocument()
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
  })

  it('flags a provider that is missing its required key', () => {
    const settings = {
      providers: [provider({ id: 'openai', hasKey: false, models: OPENAI_STORED })]
    } as unknown as AppSettings
    renderPicker({ settings, selected: { providerId: 'openai', model: 'gpt-5' } })
    fireEvent.click(screen.getByTitle('Model'))
    expect(screen.getByRole('group', { name: 'OpenAI (GPT) (no key)' })).toBeInTheDocument()
  })
})

describe('ModelPicker — local model tool-support warning', () => {
  afterEach(() => {
    delete (window as { api?: unknown }).api
  })

  function ollamaSettings(): AppSettings {
    return {
      providers: [
        provider({
          id: 'ollama',
          kind: 'openai-compatible',
          label: 'Local — Ollama',
          requiresKey: false,
          hasKey: false,
          baseUrl: 'http://localhost:11434/v1',
          models: [{ id: 'llama2', label: 'llama2' }]
        })
      ]
    } as unknown as AppSettings
  }

  function installApi(supportsTools: boolean | null): ReturnType<typeof vi.fn> {
    const fn = vi.fn().mockResolvedValue(supportsTools)
    ;(window as { api?: unknown }).api = { ollamaSupportsTools: fn }
    return fn
  }

  function renderOllama(): void {
    render(
      <ModelPicker
        settings={ollamaSettings()}
        selected={{ providerId: 'ollama', model: 'llama2' }}
        onSelect={vi.fn()}
      />
    )
  }

  it('warns when the selected local model does not support tools', async () => {
    const fn = installApi(false)
    renderOllama()
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveClass('control--model-warn')
    })
    expect(fn).toHaveBeenCalledWith('ollama', 'llama2')
    // A hover/focus tooltip carries the explanation, tied to the trigger for a11y.
    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent(/tool calling/)
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-describedby', tip.id)
  })

  it('stays silent when tool support is unknown (null)', async () => {
    installApi(null)
    renderOllama()
    // Give the async check a chance to resolve before asserting absence.
    await Promise.resolve()
    await waitFor(() => {
      expect(screen.getByRole('combobox')).not.toHaveClass('control--model-warn')
    })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('stays silent when the model supports tools', async () => {
    installApi(true)
    renderOllama()
    await waitFor(() => expect(window.api.ollamaSupportsTools).toHaveBeenCalled())
    expect(screen.getByRole('combobox')).not.toHaveClass('control--model-warn')
  })

  it('does not probe non-local providers', () => {
    const fn = installApi(false)
    render(
      <ModelPicker
        settings={settingsWith(OPENAI_STORED)}
        selected={{ providerId: 'openai', model: 'gpt-5' }}
        onSelect={vi.fn()}
      />
    )
    expect(fn).not.toHaveBeenCalled()
    expect(screen.getByRole('combobox')).not.toHaveClass('control--model-warn')
  })
})
