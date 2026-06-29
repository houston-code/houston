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
  branches: ['main', 'develop'],
  exists: true
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
  it('reflects the current selection and lists models grouped by provider when opened', () => {
    render(<ControlBar {...baseProps()} />)

    // The trigger shows the selected model and its context window.
    const trigger = screen.getByTitle('Model')
    expect(trigger).toHaveTextContent('Claude Opus')
    expect(trigger).toHaveTextContent('200k')

    // Options only exist once the menu is opened.
    expect(screen.queryByRole('option', { name: /claude-haiku/ })).not.toBeInTheDocument()
    fireEvent.click(trigger)

    // Labelled and unlabelled (id-only) models both appear, each annotated with its
    // context window (these synthetic ids resolve to the 200K default).
    expect(screen.getByRole('option', { name: /Claude Opus/ })).toHaveTextContent('200k')
    expect(screen.getByRole('option', { name: /claude-haiku/ })).toBeInTheDocument()
    // ...grouped by provider, with a "(no key)" hint on the keyless one.
    expect(screen.getByRole('group', { name: 'Anthropic' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Local (no key)' })).toBeInTheDocument()
  })

  it('reports the picked model via onSelectModel', () => {
    const props = baseProps()
    render(<ControlBar {...props} />)

    fireEvent.click(screen.getByTitle('Model'))
    fireEvent.click(screen.getByRole('option', { name: /claude-haiku/ }))

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

  it('lists base branches without a "from" prefix', () => {
    render(<ControlBar {...baseProps()} newChat={true} repoInfo={repo} worktreeMode={true} />)
    expect(screen.getByRole('option', { name: 'main (current)' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'develop' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /^from / })).not.toBeInTheDocument()
  })

  it('shows the base picker before the New worktree toggle', () => {
    render(<ControlBar {...baseProps()} newChat={true} repoInfo={repo} worktreeMode={true} />)
    const base = screen.getByLabelText('Base branch')
    const toggle = screen.getByText('⑂ New worktree')
    // DOCUMENT_POSITION_FOLLOWING (4) means `toggle` comes after `base`.
    expect(base.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('labels the folder control with the repo name, not the worktree directory', () => {
    // New chat started from inside a worktree: workspace is the worktree path, but
    // repoInfo.root points at the main repo — the control should show the repo.
    render(
      <ControlBar
        {...baseProps()}
        workspace="/Users/me/projects/houston/.houston/worktrees/feat-x"
        newChat={true}
        repoInfo={{ ...repo, root: '/Users/me/projects/myrepo' }}
      />
    )
    expect(screen.getByTitle('Change project folder')).toHaveTextContent('myrepo')
  })

  it('labels the folder control from the worktree repoRoot for an existing worktree chat', () => {
    render(
      <ControlBar
        {...baseProps()}
        workspace="/Users/me/projects/houston/.houston/worktrees/feat-x"
        newChat={false}
        currentWorktree={{
          path: '/Users/me/projects/houston/.houston/worktrees/feat-x',
          branch: 'houston/feat',
          repoRoot: '/Users/me/projects/houston'
        }}
      />
    )
    expect(screen.getByTitle('Change project folder')).toHaveTextContent('houston')
  })

  it('hides the branch fields when the worktree toggle is off', () => {
    render(<ControlBar {...baseProps()} newChat={true} repoInfo={repo} worktreeMode={false} />)
    expect(screen.queryByLabelText('New branch name')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Base branch')).not.toBeInTheDocument()
    // The toggle itself is still present so the user can turn it back on.
    expect(screen.getByText('⑂ New worktree')).toBeInTheDocument()
  })

  it('shows the current branch (read-only) when the worktree toggle is off', () => {
    // Without a worktree the chat works on the repo's current branch — make that
    // obvious so the user knows which branch will be touched.
    render(<ControlBar {...baseProps()} newChat={true} repoInfo={repo} worktreeMode={false} />)
    expect(screen.getByText('⑂ main')).toBeInTheDocument()
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
