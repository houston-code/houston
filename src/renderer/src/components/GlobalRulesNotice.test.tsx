import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LegacyRulesDecideResult } from '@shared/types'
import { GlobalRulesNotice } from './GlobalRulesNotice'

const TITLE = /Your global rules now live in/

function installApi(opts: { show?: boolean; decide?: LegacyRulesDecideResult | Error } = {}) {
  const { show = true, decide = { settings: { theme: 'dark' } } } = opts
  const getLegacyRulesNotice = vi.fn().mockResolvedValue(show)
  const decideLegacyRulesNotice =
    decide instanceof Error ? vi.fn().mockRejectedValue(decide) : vi.fn().mockResolvedValue(decide)
  window.api = { getLegacyRulesNotice, decideLegacyRulesNotice } as unknown as typeof window.api
  return { getLegacyRulesNotice, decideLegacyRulesNotice }
}

describe('GlobalRulesNotice', () => {
  it('shows when main says the notice applies', async () => {
    installApi({ show: true })
    render(<GlobalRulesNotice />)
    expect(await screen.findByText(TITLE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import it' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep separate' })).toBeInTheDocument()
    expect(screen.getByText('@~/.claude/CLAUDE.md')).toBeInTheDocument()
  })

  it('stays hidden when it does not apply', async () => {
    const { getLegacyRulesNotice } = installApi({ show: false })
    render(<GlobalRulesNotice />)
    await waitFor(() => expect(getLegacyRulesNotice).toHaveBeenCalled())
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
  })

  it('stays hidden when the bridge is missing or fails', async () => {
    window.api = {} as unknown as typeof window.api
    render(<GlobalRulesNotice />)
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
  })

  it('imports, hands back fresh settings, and hides', async () => {
    const settings = { theme: 'dark' }
    const { decideLegacyRulesNotice } = installApi({
      decide: { settings, file: '/h/.houston/AGENTS.md' } as LegacyRulesDecideResult
    })
    const onDecided = vi.fn()
    render(<GlobalRulesNotice onDecided={onDecided} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Import it' }))
    await waitFor(() => expect(screen.queryByText(TITLE)).not.toBeInTheDocument())
    expect(decideLegacyRulesNotice).toHaveBeenCalledWith('import')
    expect(onDecided).toHaveBeenCalledWith(settings)
  })

  it('keeps separate and hides', async () => {
    const { decideLegacyRulesNotice } = installApi()
    render(<GlobalRulesNotice />)
    fireEvent.click(await screen.findByRole('button', { name: 'Keep separate' }))
    await waitFor(() => expect(screen.queryByText(TITLE)).not.toBeInTheDocument())
    expect(decideLegacyRulesNotice).toHaveBeenCalledWith('keep')
  })

  it('shows a failed import inline and stays up to retry', async () => {
    const onDecided = vi.fn()
    installApi({ decide: { settings: {}, error: 'EACCES' } as LegacyRulesDecideResult })
    render(<GlobalRulesNotice onDecided={onDecided} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Import it' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('EACCES')
    expect(screen.getByText(TITLE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import it' })).toBeEnabled()
    expect(onDecided).not.toHaveBeenCalled()
  })

  it('reports a rejected call without hiding', async () => {
    installApi({ decide: new Error('ipc gone') })
    render(<GlobalRulesNotice />)
    fireEvent.click(await screen.findByRole('button', { name: 'Keep separate' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save your choice")
    expect(screen.getByText(TITLE)).toBeInTheDocument()
  })
})
