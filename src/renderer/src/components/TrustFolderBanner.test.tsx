import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { FolderTrustStatus } from '@shared/types'
import { TrustFolderBanner } from './TrustFolderBanner'

const TITLE = /asks for extra permissions/
const CHANGED_TITLE = /trusted configuration changed/

function installApi(status: FolderTrustStatus) {
  const getFolderTrustStatus = vi.fn().mockResolvedValue(status)
  const decideFolderTrust = vi.fn().mockResolvedValue({})
  window.api = { getFolderTrustStatus, decideFolderTrust } as unknown as typeof window.api
  return { getFolderTrustStatus, decideFolderTrust }
}

function props(over: Partial<Parameters<typeof TrustFolderBanner>[0]> = {}) {
  return {
    workspace: '/tmp/app',
    running: false,
    sessionDismissed: false,
    onNotNow: vi.fn(),
    ...over
  }
}

const undecided: FolderTrustStatus = {
  state: 'undecided',
  counts: { allowRules: 2, hooks: 1, mcpServers: 0 }
}

describe('TrustFolderBanner', () => {
  it('shows for an undecided folder with the elevating counts', async () => {
    installApi(undecided)
    render(<TrustFolderBanner {...props()} />)
    expect(await screen.findByText(TITLE)).toBeInTheDocument()
    expect(screen.getByText(/2 allow rules, 1 hook/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Trust this folder' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Never for this folder' })).toBeInTheDocument()
  })

  it("names commands that pre-approve tools, and where they live", async () => {
    installApi({ state: 'undecided', counts: { allowRules: 0, hooks: 0, mcpServers: 0, commands: 2 } })
    const { unmount } = render(<TrustFolderBanner {...props()} />)
    expect(await screen.findByText(/2 commands that pre-approve tools \(in \.houston\/commands\)/)).toBeInTheDocument()
    unmount()
    installApi({ state: 'changed', counts: { allowRules: 1, hooks: 0, mcpServers: 0, commands: 1 } })
    render(<TrustFolderBanner {...props()} />)
    expect(
      await screen.findByText(/\.houston\/settings\.json and \.houston\/commands changed since you trusted it \(now: 1 allow rule, 1 command that pre-approves tools\)/)
    ).toBeInTheDocument()
  })

  it('names every plugin file the trust would cover', async () => {
    installApi({
      state: 'changed',
      counts: { allowRules: 0, hooks: 0, mcpServers: 0, plugins: 2 },
      plugins: ['audit.js', 'notify.js']
    })
    render(<TrustFolderBanner {...props()} />)
    expect(await screen.findByText(CHANGED_TITLE)).toBeInTheDocument()
    expect(screen.getByText(/2 plugins \(audit\.js, notify\.js\)/)).toBeInTheDocument()
    expect(screen.getByText(/projectPlugins setting/)).toBeInTheDocument()
  })

  it('lists commands and plugins together, with every place they live', async () => {
    installApi({
      state: 'undecided',
      counts: { allowRules: 1, hooks: 0, mcpServers: 0, commands: 1, plugins: 1 },
      plugins: ['audit.js']
    })
    render(<TrustFolderBanner {...props()} />)
    expect(
      await screen.findByText(
        /1 allow rule, 1 command that pre-approves tools, 1 plugin \(audit\.js\) \(in \.houston\/settings\.json, \.houston\/commands, and \.houston\/plugins\)/
      )
    ).toBeInTheDocument()
    expect(screen.getByText(/projectPlugins setting/)).toBeInTheDocument()
  })

  it('shows the changed variant when trust drifted', async () => {
    installApi({ state: 'changed', counts: { allowRules: 0, hooks: 2, mcpServers: 1 } })
    render(<TrustFolderBanner {...props()} />)
    expect(await screen.findByText(CHANGED_TITLE)).toBeInTheDocument()
    expect(screen.getByText(/2 hooks, 1 MCP server/)).toBeInTheDocument()
  })

  it('stays hidden when the project elevates nothing, is trusted, or was refused', async () => {
    for (const state of ['none', 'trusted', 'untrusted'] as const) {
      const { getFolderTrustStatus } = installApi(
        state === 'none' ? { state } : { state, counts: { allowRules: 1, hooks: 0, mcpServers: 0 } }
      )
      const { unmount } = render(<TrustFolderBanner {...props()} />)
      await waitFor(() => expect(getFolderTrustStatus).toHaveBeenCalled())
      expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
      unmount()
    }
  })

  it('never asks while session-dismissed (no IPC at all)', async () => {
    const { getFolderTrustStatus } = installApi(undecided)
    render(<TrustFolderBanner {...props({ sessionDismissed: true })} />)
    await waitFor(() => expect(getFolderTrustStatus).not.toHaveBeenCalled())
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
  })

  it('persists a trust decision and refreshes itself away', async () => {
    const { getFolderTrustStatus, decideFolderTrust } = installApi(undecided)
    render(<TrustFolderBanner {...props()} />)
    // After deciding, the re-fetch reports trusted and the banner disappears.
    getFolderTrustStatus.mockResolvedValue({
      state: 'trusted',
      counts: undecided.counts
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Trust this folder' }))
    await waitFor(() => expect(decideFolderTrust).toHaveBeenCalledWith('/tmp/app', 'trusted'))
    await waitFor(() => expect(screen.queryByText(TITLE)).not.toBeInTheDocument())
  })

  it('persists never', async () => {
    const { decideFolderTrust } = installApi(undecided)
    render(<TrustFolderBanner {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Never for this folder' }))
    await waitFor(() => expect(decideFolderTrust).toHaveBeenCalledWith('/tmp/app', 'never'))
  })

  it('"Not now" is session-only: tells the caller, persists nothing', async () => {
    const onNotNow = vi.fn()
    const { decideFolderTrust } = installApi(undecided)
    render(<TrustFolderBanner {...props({ onNotNow })} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    expect(onNotNow).toHaveBeenCalled()
    expect(decideFolderTrust).not.toHaveBeenCalled()
  })
})
