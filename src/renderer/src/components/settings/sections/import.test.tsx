import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImportCandidate, ImportOutcome } from '@shared/importConfig'
import type { AppSettings } from '@shared/types'
import type { SettingsCtx } from '../context'
import { ImportSection, importSummary } from './import'

afterEach(cleanup)

const cand = (over: Partial<ImportCandidate>): ImportCandidate => ({
  id: 'mcp:user:~/.cursor/mcp.json:git',
  kind: 'mcp',
  scope: 'user',
  name: 'git',
  source: '~/.cursor/mcp.json',
  target: 'Settings > MCP Servers (added switched off)',
  detail: 'uvx mcp-server-git',
  status: 'new',
  ...over
})

function ctx(over: Partial<SettingsCtx> = {}): SettingsCtx {
  return {
    settings: {} as AppSettings,
    setSettings: vi.fn(),
    busy: null,
    setBusy: vi.fn(),
    keyInputs: {},
    setKeyInputs: vi.fn(),
    setFormError: vi.fn(),
    saveKey: vi.fn(),
    removeKey: vi.fn(),
    persistNow: vi.fn(() => Promise.resolve()),
    workspace: '/w/app',
    policy: null,
    ...over
  }
}

function installApi(candidates: ImportCandidate[], outcome: ImportOutcome) {
  const scanImports = vi.fn(() => Promise.resolve({ candidates }))
  const applyImports = vi.fn(() => Promise.resolve(outcome))
  window.api = { scanImports, applyImports } as unknown as typeof window.api
  return { scanImports, applyImports }
}

describe('ImportSection', () => {
  it('lists finds by kind with nothing selected, and disables what Houston already has', async () => {
    installApi(
      [
        cand({}),
        cand({ id: 'command:user:x', kind: 'command', name: '/review', status: 'present', note: 'Houston already has /review' })
      ],
      { imported: [], failed: [] }
    )
    render(<ImportSection ctx={ctx()} />)
    expect(await screen.findByText('MCP servers')).toBeTruthy()
    expect(screen.getByText('Custom commands')).toBeTruthy()
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([
      [false, false],
      [false, true]
    ])
    expect(screen.getByText('Houston already has /review')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Import selected' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('saves pending edits, imports only the picked ids, and merges the new servers into the working copy', async () => {
    const api = installApi([cand({}), cand({ id: 'rules:user:a', kind: 'rules', name: 'AGENTS.md' })], {
      imported: ['mcp:user:~/.cursor/mcp.json:git'],
      failed: [],
      settings: { mcpServers: [{ id: 'git', command: 'uvx', enabled: false }] } as AppSettings
    })
    const c = ctx()
    render(<ImportSection ctx={c} />)
    fireEvent.click(await screen.findByRole('checkbox', { name: /git/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Import selected (1)' }))
    await waitFor(() => expect(api.applyImports).toHaveBeenCalledWith('/w/app', ['mcp:user:~/.cursor/mcp.json:git']))
    expect(c.persistNow).toHaveBeenCalled()
    const update = (c.setSettings as ReturnType<typeof vi.fn>).mock.calls[0][0] as (s: AppSettings) => AppSettings
    expect(update({ theme: 'dark', mcpServers: [] } as unknown as AppSettings)).toEqual({
      theme: 'dark',
      mcpServers: [{ id: 'git', command: 'uvx', enabled: false }]
    })
    expect(await screen.findByText(/New MCP servers are switched off/)).toBeTruthy()
    expect(api.scanImports).toHaveBeenCalledTimes(2)
  })

  it('selects every new find at once', async () => {
    installApi([cand({}), cand({ id: 'b', name: 'b' }), cand({ id: 'c', name: 'c', status: 'present' })], {
      imported: [],
      failed: []
    })
    render(<ImportSection ctx={ctx()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Select all new' }))
    expect(screen.getByRole('button', { name: 'Import selected (2)' })).toBeTruthy()
  })

  it('says when nothing was found', async () => {
    installApi([], { imported: [], failed: [] })
    render(<ImportSection ctx={ctx({ workspace: null })} />)
    expect(await screen.findByText('Nothing to import was found in your home folder.')).toBeTruthy()
  })
})

describe('importSummary', () => {
  it('names the follow-up each kind needs', () => {
    expect(importSummary([cand({ scope: 'project' })], 1)).toBe(
      "Imported 1. This project's servers take effect once you trust the folder. 1 could not be imported."
    )
    expect(importSummary([], 0)).toBe('')
  })
})
