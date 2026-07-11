import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RepoInfo } from '@shared/agent'
import { GitInitBanner } from './GitInitBanner'

const TITLE = /isn.t a git repository/

/** A RepoInfo with the two fields the banner reads (exists / isRepo) set. */
function repoInfo(exists: boolean, isRepo: boolean): RepoInfo {
  return { isRepo, root: '', currentBranch: null, branches: [], isLinkedWorktreeRoot: false, exists }
}

/**
 * Install a fake `window.api` for the banner. `exists`/`isRepo` seed getRepoInfo,
 * `dismissed` seeds isGitInitDismissed, and initGitRepo defaults to success.
 */
function installApi(opts: { exists?: boolean; isRepo?: boolean; dismissed?: boolean } = {}) {
  const { exists = true, isRepo = false, dismissed = false } = opts
  const getRepoInfo = vi.fn().mockResolvedValue(repoInfo(exists, isRepo))
  const isGitInitDismissed = vi.fn().mockResolvedValue(dismissed)
  const initGitRepo = vi.fn().mockResolvedValue({ ok: true })
  const dismissGitInit = vi.fn().mockResolvedValue({})
  window.api = {
    getRepoInfo,
    isGitInitDismissed,
    initGitRepo,
    dismissGitInit
  } as unknown as typeof window.api
  return { getRepoInfo, isGitInitDismissed, initGitRepo, dismissGitInit }
}

/** Standard props: a write has happened, nothing dismissed, no run in progress. */
function props(over: Partial<Parameters<typeof GitInitBanner>[0]> = {}) {
  return {
    workspace: '/tmp/app',
    writeHappened: true,
    running: false,
    sessionDismissed: false,
    onNotNow: vi.fn(),
    ...over
  }
}

describe('GitInitBanner', () => {
  it('shows for an existing non-repo once a write has happened', async () => {
    installApi({ exists: true, isRepo: false })
    render(<GitInitBanner {...props()} />)
    expect(await screen.findByText(TITLE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Initialize repository/ })).toBeInTheDocument()
  })

  it('stays hidden until a write has happened', async () => {
    const { getRepoInfo } = installApi({ exists: true, isRepo: false })
    render(<GitInitBanner {...props({ writeHappened: false })} />)
    // With no write, the banner never even asks for repo state.
    await waitFor(() => expect(getRepoInfo).not.toHaveBeenCalled())
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
  })

  it('stays hidden when the workspace is already a repo', async () => {
    const { getRepoInfo } = installApi({ exists: true, isRepo: true })
    render(<GitInitBanner {...props()} />)
    await waitFor(() => expect(getRepoInfo).toHaveBeenCalled())
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
  })

  it('stays hidden when the workspace path no longer exists', async () => {
    const { getRepoInfo } = installApi({ exists: false, isRepo: false })
    render(<GitInitBanner {...props()} />)
    await waitFor(() => expect(getRepoInfo).toHaveBeenCalled())
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
  })

  it('stays hidden when the folder was already opted out of', async () => {
    const { isGitInitDismissed } = installApi({ dismissed: true })
    render(<GitInitBanner {...props()} />)
    await waitFor(() => expect(isGitInitDismissed).toHaveBeenCalled())
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
  })

  it('stays hidden when dismissed for the session', async () => {
    const { getRepoInfo } = installApi()
    render(<GitInitBanner {...props({ sessionDismissed: true })} />)
    // Session-dismissed short-circuits before any IPC.
    await waitFor(() => expect(getRepoInfo).not.toHaveBeenCalled())
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
  })

  it('initializes the repo, then hides once it re-checks as a repo', async () => {
    // getRepoInfo reflects a mutable flag flipped by initGitRepo, so it hides on the
    // post-init re-check regardless of how many times the effects re-read it.
    let inited = false
    const getRepoInfo = vi.fn(async () => repoInfo(true, inited))
    const isGitInitDismissed = vi.fn().mockResolvedValue(false)
    const initGitRepo = vi.fn(async () => {
      inited = true
      return { ok: true }
    })
    window.api = {
      getRepoInfo,
      isGitInitDismissed,
      initGitRepo,
      dismissGitInit: vi.fn()
    } as unknown as typeof window.api

    render(<GitInitBanner {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Initialize repository/ }))
    await waitFor(() => expect(initGitRepo).toHaveBeenCalledWith('/tmp/app'))
    await waitFor(() => expect(screen.queryByText(TITLE)).not.toBeInTheDocument())
  })

  it('re-checks and hides on the recheck signal (e.g. init from the Changes panel)', async () => {
    let isRepo = false
    const getRepoInfo = vi.fn(async () => repoInfo(true, isRepo))
    window.api = {
      getRepoInfo,
      isGitInitDismissed: vi.fn().mockResolvedValue(false),
      initGitRepo: vi.fn(),
      dismissGitInit: vi.fn()
    } as unknown as typeof window.api

    const { rerender } = render(<GitInitBanner {...props({ recheckSignal: 0 })} />)
    expect(await screen.findByText(TITLE)).toBeInTheDocument()

    // The repo was initialized elsewhere; bumping the signal makes the banner re-read.
    isRepo = true
    rerender(<GitInitBanner {...props({ recheckSignal: 1 })} />)
    await waitFor(() => expect(screen.queryByText(TITLE)).not.toBeInTheDocument())
  })

  it('surfaces an error when initializing fails', async () => {
    const { initGitRepo } = installApi()
    initGitRepo.mockResolvedValue({ ok: false, error: 'git init failed.' })
    render(<GitInitBanner {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Initialize repository/ }))
    expect(await screen.findByText('git init failed.')).toBeInTheDocument()
    // The banner stays put so the user can retry.
    expect(screen.getByText(TITLE)).toBeInTheDocument()
  })

  it('reports "Not now" to the caller without touching persistence', async () => {
    const onNotNow = vi.fn()
    const { dismissGitInit } = installApi()
    render(<GitInitBanner {...props({ onNotNow })} />)
    fireEvent.click(await screen.findByRole('button', { name: /Not now/ }))
    expect(onNotNow).toHaveBeenCalledTimes(1)
    expect(dismissGitInit).not.toHaveBeenCalled()
  })

  it('persists "Don\'t ask again", reports fresh settings up, and hides; a remount stays suppressed', async () => {
    const { dismissGitInit } = installApi({ dismissed: false })
    const freshSettings = { gitInitDismissed: ['/tmp/app'] }
    dismissGitInit.mockResolvedValue(freshSettings)
    const onDismissed = vi.fn()
    const { unmount } = render(<GitInitBanner {...props({ onDismissed })} />)
    fireEvent.click(await screen.findByLabelText(/Don.t ask again for this folder/))
    await waitFor(() => expect(dismissGitInit).toHaveBeenCalledWith('/tmp/app'))
    // Reports the persisted settings up so the caller's copy stays in sync.
    await waitFor(() => expect(onDismissed).toHaveBeenCalledWith(freshSettings))
    // Hides immediately after opting out.
    await waitFor(() => expect(screen.queryByText(TITLE)).not.toBeInTheDocument())

    // A fresh mount reads the now-persisted opt-out and never shows the banner.
    unmount()
    const { isGitInitDismissed } = installApi({ dismissed: true })
    render(<GitInitBanner {...props()} />)
    await waitFor(() => expect(isGitInitDismissed).toHaveBeenCalled())
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
  })
})
