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
    expect(screen.getByRole('combobox')).toHaveTextContent('GPT-5 · 400k')
  })

  it('orders models by the curated default order, not the stored order', () => {
    renderPicker()
    fireEvent.click(screen.getByRole('combobox'))
    const names = screen.getAllByRole('option').map((o) => o.textContent)
    // Stored order was gpt-4o, o3, gpt-5, gpt-5-mini — display restores GPT-5 first.
    expect(names[0]).toContain('GPT-5')
    expect(names[1]).toContain('GPT-5 mini')
    expect(names[2]).toContain('GPT-4o')
    expect(names[3]).toContain('o3')
  })

  it('annotates each model with its context window', () => {
    renderPicker()
    fireEvent.click(screen.getByRole('combobox'))
    // Anchored so the bare "GPT-5" doesn't also match "GPT-5 mini".
    expect(screen.getByRole('option', { name: /^GPT-5, 400k context/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /^GPT-5 mini, 400k context/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /^GPT-4o, 128k context/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /^o3, 200k context/ })).toBeInTheDocument()
  })

  it('reads every badge aloud in the option name, not just the glyphs', () => {
    renderPicker()
    fireEvent.click(screen.getByRole('combobox'))
    expect(
      screen.getByRole('option', {
        name: 'GPT-5, 400k context, tools, vision, reasoning, $1.25 input, $10 output per million tokens'
      })
    ).toBeInTheDocument()
  })

  it('shows the price per million tokens next to each priced model', () => {
    renderPicker()
    fireEvent.click(screen.getByRole('combobox'))
    const opt = screen.getByRole('option', { name: /^GPT-4o,/ })
    expect(within(opt).getByText('$2.50/$10')).toBeInTheDocument()
  })

  it('marks the current model as the selected option', () => {
    renderPicker()
    fireEvent.click(screen.getByRole('combobox'))
    const selected = screen.getByRole('option', { selected: true })
    expect(selected).toHaveTextContent('GPT-5')
  })

  it('selects a model on click and closes the menu', () => {
    const { onSelect } = renderPicker()
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('option', { name: /GPT-4o/ }))
    expect(onSelect).toHaveBeenCalledWith({ providerId: 'openai', model: 'gpt-4o' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('focuses the search field, navigates with the arrow keys and selects with Enter', async () => {
    const { onSelect } = renderPicker()
    fireEvent.click(screen.getByRole('combobox')) // opens with gpt-5 active
    const search = screen.getByRole('searchbox', { name: 'Search models' })
    await waitFor(() => expect(search).toHaveFocus())
    fireEvent.keyDown(search, { key: 'ArrowDown' }) // -> gpt-5-mini
    expect(search.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: /^GPT-5 mini,/ }).id
    )
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith({ providerId: 'openai', model: 'gpt-5-mini' })
  })

  it('filters across providers by any part of the name, id, or provider', () => {
    const settings = {
      providers: [
        provider({ id: 'openai', models: OPENAI_STORED }),
        provider({ id: 'anthropic', kind: 'anthropic', label: 'Anthropic (Claude)', models: [{ id: 'claude-opus-5-5' }] })
      ]
    } as unknown as AppSettings
    const { onSelect } = renderPicker({ settings })
    fireEvent.click(screen.getByRole('combobox'))
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'opus 5' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.queryByRole('group', { name: 'OpenAI (GPT)' })).not.toBeInTheDocument()
    // The first match becomes active, so Enter picks it straight away.
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith({ providerId: 'anthropic', model: 'claude-opus-5-5' })
  })

  it('says so when nothing matches, and Enter does nothing', () => {
    const { onSelect } = renderPicker()
    fireEvent.click(screen.getByRole('combobox'))
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(screen.getByText(/No models match/)).toBeInTheDocument()
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('opens already filtered when a character is typed on the closed trigger', () => {
    renderPicker()
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'o' })
    expect(screen.getByRole('searchbox')).toHaveValue('o')
  })

  it('closes on Escape without selecting', () => {
    const { onSelect } = renderPicker()
    const trigger = screen.getByRole('combobox')
    fireEvent.click(trigger)
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('collapses providers with no models into one line instead of an empty group each', () => {
    const settings = {
      providers: [
        provider({ id: 'openai', models: OPENAI_STORED }),
        provider({ id: 'ollama', kind: 'openai-compatible', label: 'Ollama (local)', requiresKey: false, models: [] }),
        provider({ id: 'lmstudio', kind: 'openai-compatible', label: 'LM Studio (local)', requiresKey: false, models: [] })
      ]
    } as unknown as AppSettings
    renderPicker({ settings })
    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.queryByRole('group', { name: 'Ollama (local)' })).not.toBeInTheDocument()
    expect(screen.getByText('No models yet: Ollama (local), LM Studio (local)')).toBeInTheDocument()
  })

  it('shows only that line when no provider has models', () => {
    renderPicker({ settings: settingsWith([]), selected: null })
    expect(screen.getByRole('combobox')).toHaveTextContent('Select a model…')
    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.getByText('No models yet: OpenAI (GPT)')).toBeInTheDocument()
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
  })

  it('lists providers that can be used now ahead of ones missing a key', () => {
    const settings = {
      providers: [
        provider({ id: 'openai', hasKey: false, models: OPENAI_STORED }),
        provider({ id: 'anthropic', kind: 'anthropic', label: 'Anthropic (Claude)', models: [{ id: 'claude-opus-5-5' }] })
      ]
    } as unknown as AppSettings
    renderPicker({ settings })
    fireEvent.click(screen.getByRole('combobox'))
    const labels = screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))
    expect(labels).toEqual(['Anthropic (Claude)', 'OpenAI (GPT) (no key)'])
  })

  it('marks a model added by a recent update, or recently released per its host, as New', () => {
    const now = new Date('2026-10-18T12:00:00Z')
    const settings = settingsWith([
      { id: 'gpt-6.1-sol', addedAt: '2026-10-10' }, // arrived 8 days ago
      { id: 'gpt-6-luna', caps: { releasedAt: '2026-09-20' } }, // released 28 days ago
      { id: 'gpt-5.5', addedAt: '2026-07-01' }, // long since
      { id: 'gpt-5.4', caps: { releasedAt: '2026-03-01' } }
    ])
    render(<ModelPicker settings={settings} selected={null} onSelect={vi.fn()} now={now} />)
    fireEvent.click(screen.getByRole('combobox'))
    const fresh = screen.getAllByRole('option').filter((o) => /, new$/.test(o.getAttribute('aria-label') ?? ''))
    expect(fresh.map((o) => o.getAttribute('aria-label')?.split(',')[0])).toEqual(['gpt-6.1-sol', 'gpt-6-luna'])
    expect(screen.getAllByText('New')).toHaveLength(2)
  })

  it('shows the tools badge on Claude, whose listing carries no capability metadata', () => {
    const settings = {
      providers: [provider({ id: 'anthropic', kind: 'anthropic', label: 'Anthropic (Claude)', models: [{ id: 'claude-opus-5-5' }] })]
    } as unknown as AppSettings
    renderPicker({ settings, selected: null })
    fireEvent.click(screen.getByRole('combobox'))
    const opt = screen.getByRole('option', { name: /^claude-opus-5\.5,/ })
    expect(within(opt).getByTitle('Supports tool calling')).toBeInTheDocument()
  })

  it('shows the placeholder when the selection points at a model no longer in the list', () => {
    // The store reconciles these away, but the picker must never render a removed id as
    // if it were the live selection. gpt-5 was deleted from the provider's models.
    renderPicker({
      settings: settingsWith(OPENAI_STORED.filter((m) => m.id !== 'gpt-5')),
      selected: { providerId: 'openai', model: 'gpt-5' }
    })
    const trigger = screen.getByRole('combobox')
    expect(trigger).toHaveTextContent('Select a model…')
    expect(trigger).not.toHaveTextContent('gpt-5')
  })

  it('flags a provider that is missing its required key', () => {
    const settings = {
      providers: [provider({ id: 'openai', hasKey: false, models: OPENAI_STORED })]
    } as unknown as AppSettings
    renderPicker({ settings, selected: { providerId: 'openai', model: 'gpt-5' } })
    fireEvent.click(screen.getByRole('combobox'))
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
          label: 'Ollama (local)',
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

describe('ModelPicker — host-listed capabilities', () => {
  afterEach(() => {
    delete (window as { api?: unknown }).api
  })

  function hostSettings(caps: Record<string, unknown>): AppSettings {
    return {
      providers: [
        provider({
          id: 'openrouter',
          kind: 'openai-compatible',
          label: 'OpenRouter',
          requiresKey: true,
          hasKey: true,
          baseUrl: 'https://openrouter.ai/api/v1',
          models: [{ id: 'deepseek/deepseek-r1', caps }]
        })
      ]
    } as unknown as AppSettings
  }

  it('warns from a listed tools:false without probing the server', async () => {
    const fn = vi.fn().mockResolvedValue(true)
    ;(window as { api?: unknown }).api = { ollamaSupportsTools: fn }
    render(
      <ModelPicker
        settings={hostSettings({ tools: false })}
        selected={{ providerId: 'openrouter', model: 'deepseek/deepseek-r1' }}
        onSelect={vi.fn()}
      />
    )
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveClass('control--model-warn'))
    // The listed value is authoritative — no live preflight needed.
    expect(fn).not.toHaveBeenCalled()
  })

  it('suppresses the local preflight when tools are listed as supported', async () => {
    const fn = vi.fn().mockResolvedValue(false)
    ;(window as { api?: unknown }).api = { ollamaSupportsTools: fn }
    render(
      <ModelPicker
        settings={hostSettings({ tools: true })}
        selected={{ providerId: 'openrouter', model: 'deepseek/deepseek-r1' }}
        onSelect={vi.fn()}
      />
    )
    await Promise.resolve()
    expect(fn).not.toHaveBeenCalled()
    expect(screen.getByRole('combobox')).not.toHaveClass('control--model-warn')
  })

  it('renders capability chips for tools / vision / reasoning', () => {
    render(
      <ModelPicker
        settings={hostSettings({ tools: true, vision: true, reasoning: true })}
        selected={{ providerId: 'openrouter', model: 'deepseek/deepseek-r1' }}
        onSelect={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('combobox'))
    const opt = screen.getByRole('option', { name: /deepseek/ })
    expect(within(opt).getByTitle('Supports tool calling')).toBeInTheDocument()
    expect(within(opt).getByTitle('Accepts images (vision)')).toBeInTheDocument()
    expect(within(opt).getByTitle('Has a reasoning mode')).toBeInTheDocument()
  })

  it('shows the listed context window on a model the heuristics do not know', () => {
    render(
      <ModelPicker
        settings={hostSettings({ contextWindow: 128_000 })}
        selected={{ providerId: 'openrouter', model: 'deepseek/deepseek-r1' }}
        onSelect={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.getByRole('option', { name: /^deepseek\/deepseek-r1, 128k context/ })).toBeInTheDocument()
  })
})
