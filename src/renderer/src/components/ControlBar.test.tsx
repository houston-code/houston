import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AppSettings, SelectedModel } from '@shared/types'
import type { RepoInfo } from '@shared/agent'
import type { SessionUsage } from '@shared/usage'
import { ControlBar } from './ControlBar'

const repo: RepoInfo = {
  isRepo: true,
  root: '/Users/me/projects/houston',
  currentBranch: 'main',
  branches: ['main', 'develop']
}

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
    newChat: false,
    repoInfo: null as RepoInfo | null,
    worktreeMode: true,
    branchName: 'houston/swift-otter',
    baseBranch: 'main',
    currentWorktree: null,
    onToggleWorktree: vi.fn(),
    onChangeBranchName: vi.fn(),
    onChangeBaseBranch: vi.fn(),
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

  it('hides the worktree editor unless it is a new chat in a git repo', () => {
    // Existing chat → no editor.
    const { unmount } = render(<ControlBar {...baseProps()} newChat={false} repoInfo={repo} />)
    expect(screen.queryByLabelText('New branch name')).not.toBeInTheDocument()
    unmount()

    // New chat but not a repo → no editor.
    render(<ControlBar {...baseProps()} newChat={true} repoInfo={{ ...repo, isRepo: false }} />)
    expect(screen.queryByLabelText('New branch name')).not.toBeInTheDocument()
  })

  it('shows the branch name + base controls for a new chat in a repo, defaulting worktree on', () => {
    render(<ControlBar {...baseProps()} newChat={true} repoInfo={repo} worktreeMode={true} />)
    expect((screen.getByLabelText('New branch name') as HTMLInputElement).value).toBe(
      'houston/swift-otter'
    )
    expect((screen.getByLabelText('Base branch') as HTMLSelectElement).value).toBe('main')
  })

  it('hides the branch fields when the worktree toggle is off', () => {
    render(<ControlBar {...baseProps()} newChat={true} repoInfo={repo} worktreeMode={false} />)
    expect(screen.queryByLabelText('New branch name')).not.toBeInTheDocument()
    // The toggle itself is still present so the user can turn it back on.
    expect(screen.getByText('⑂ New worktree')).toBeInTheDocument()
  })

  it('reports branch edits and base selection', () => {
    const props = baseProps()
    render(<ControlBar {...props} newChat={true} repoInfo={repo} />)
    fireEvent.change(screen.getByLabelText('New branch name'), { target: { value: 'feature/x' } })
    expect(props.onChangeBranchName).toHaveBeenCalledWith('feature/x')
    fireEvent.change(screen.getByLabelText('Base branch'), { target: { value: 'develop' } })
    expect(props.onChangeBaseBranch).toHaveBeenCalledWith('develop')
  })

  it('flags an invalid branch name on the input', () => {
    render(<ControlBar {...baseProps()} newChat={true} repoInfo={repo} branchName="--bad" />)
    expect(screen.getByLabelText('New branch name')).toHaveAttribute('aria-invalid', 'true')
  })

  it('shows a read-only branch badge for an existing worktree chat', () => {
    render(
      <ControlBar
        {...baseProps()}
        newChat={false}
        currentWorktree={{ path: '/wt', branch: 'houston/feat', repoRoot: '/repo' }}
      />
    )
    expect(screen.getByText('⑂ houston/feat')).toBeInTheDocument()
  })

  it('surfaces token usage only when there are tokens', () => {
    const { unmount } = render(<ControlBar {...baseProps()} usage={null} />)
    expect(screen.queryByTitle(/Output this conversation/)).not.toBeInTheDocument()
    unmount()

    render(<ControlBar {...baseProps()} usage={{ context: 1000, output: 200, cost: 0.02 }} />)
    expect(screen.getByTitle(/Output this conversation/)).toBeInTheDocument()
  })
})
