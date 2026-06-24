import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AppSettings, SelectedModel } from '@shared/types'
import type { SessionUsage } from '@shared/usage'
import { ControlBar } from './ControlBar'

function makeSettings(): AppSettings {
  return {
    schemaVersion: 1,
    providers: [
      {
        id: 'anthropic',
        kind: 'anthropic',
        label: 'Anthropic',
        models: [{ id: 'claude-opus', label: 'Claude Opus' }, { id: 'claude-haiku' }],
        requiresKey: true,
        hasKey: true,
        builtIn: true
      },
      {
        id: 'local',
        kind: 'openai-compatible',
        label: 'Local',
        models: [{ id: 'llama' }],
        requiresKey: true,
        hasKey: false,
        builtIn: false
      }
    ],
    selected: { providerId: 'anthropic', model: 'claude-opus' },
    approvalPolicy: 'ask',
    recentWorkspaces: []
  } as unknown as AppSettings
}

function baseProps() {
  return {
    settings: makeSettings(),
    selected: { providerId: 'anthropic', model: 'claude-opus' } as SelectedModel,
    workspace: '/Users/me/projects/houston',
    usage: null as SessionUsage | null,
    onSelectModel: vi.fn(),
    onChangePolicy: vi.fn(),
    onChangeReasoning: vi.fn(),
    onChangeWorkspace: vi.fn(),
    onOpenSettings: vi.fn()
  }
}

describe('ControlBar', () => {
  it('renders the model options and reflects the current selection', () => {
    render(<ControlBar {...baseProps()} />)

    const modelSelect = screen.getByTitle('Model') as HTMLSelectElement
    expect(modelSelect.value).toBe('anthropic::claude-opus')

    // Labelled and unlabelled (id-only) models both appear...
    expect(screen.getByRole('option', { name: 'Claude Opus' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'claude-haiku' })).toBeInTheDocument()
    // ...grouped by provider, with a "(no key)" hint on the keyless one.
    expect(screen.getByRole('group', { name: 'Anthropic' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Local (no key)' })).toBeInTheDocument()
  })

  it('reports the picked model via onSelectModel', () => {
    const props = baseProps()
    render(<ControlBar {...props} />)

    fireEvent.change(screen.getByTitle('Model'), { target: { value: 'anthropic::claude-haiku' } })

    expect(props.onSelectModel).toHaveBeenCalledWith({ providerId: 'anthropic', model: 'claude-haiku' })
  })

  it('shows the folder basename and changes workspace on click', () => {
    const props = baseProps()
    render(<ControlBar {...props} />)

    const wsButton = screen.getByTitle('Change project folder')
    expect(wsButton).toHaveTextContent('houston')

    fireEvent.click(wsButton)
    expect(props.onChangeWorkspace).toHaveBeenCalledOnce()
  })

  it('prompts to set an API key only when the selected provider lacks one', () => {
    // Default selection (Anthropic, has key) → no warning.
    const withKey = baseProps()
    const { unmount } = render(<ControlBar {...withKey} />)
    expect(screen.queryByRole('button', { name: /Set API key/ })).not.toBeInTheDocument()
    unmount()

    // Selecting the keyless provider surfaces the warning, which opens settings.
    const noKey = baseProps()
    render(<ControlBar {...noKey} selected={{ providerId: 'local', model: 'llama' }} />)
    const warn = screen.getByRole('button', { name: /Set API key/ })
    fireEvent.click(warn)
    expect(noKey.onOpenSettings).toHaveBeenCalledOnce()
  })

  it('surfaces token usage only when there are tokens', () => {
    const { unmount } = render(<ControlBar {...baseProps()} usage={null} />)
    expect(screen.queryByTitle(/Output this conversation/)).not.toBeInTheDocument()
    unmount()

    render(<ControlBar {...baseProps()} usage={{ context: 1000, output: 200, cost: 0.02 }} />)
    expect(screen.getByTitle(/Output this conversation/)).toBeInTheDocument()
  })
})
