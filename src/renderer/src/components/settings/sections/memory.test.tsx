import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MemoryOverview, MemoryRecord, MemoryRequest, MemoryResponse } from '@shared/memoryTypes'
import type { AppSettings } from '@shared/types'
import type { SettingsCtx } from '../context'
import { MemoriesSection, MemorySettingsSection } from './memory'

afterEach(cleanup)

const memory = (over: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: 'm_20261024_aaaaaa',
  scope: 'repo',
  type: 'project',
  name: 'tests-need-rg',
  description: 'Set HOUSTON_RG',
  body: 'The search tests need it.',
  created: '2026-10-24T00:00:00.000Z',
  updated: '2026-10-24T00:00:00.000Z',
  origin: 'agent',
  pinned: false,
  ...over
})

const overview = (over: Partial<MemoryOverview> = {}): MemoryOverview => ({
  repo: { key: 'k1', label: 'app' },
  repoMemories: [memory()],
  globalMemories: [],
  otherRepos: [],
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
    persistNow: vi.fn(),
    workspace: '/w/app',
    policy: null,
    ...over
  }
}

function installApi(respond: (req: MemoryRequest) => MemoryResponse) {
  const memoryRequest = vi.fn((req: MemoryRequest) => Promise.resolve(respond(req)))
  const revealMemoryFolder = vi.fn(() => Promise.resolve())
  window.api = { memoryRequest, revealMemoryFolder } as unknown as typeof window.api
  return { memoryRequest, revealMemoryFolder }
}

describe('MemoriesSection', () => {
  it('lists this repository and all-projects memories, with the body behind the description', async () => {
    const api = installApi(() => ({ ok: true, overview: overview({ globalMemories: [memory({ id: 'm_20261024_bbbbbb', scope: 'global', type: 'user', name: 'short-prs' })] }) }))
    render(<MemoriesSection ctx={ctx()} />)
    expect(await screen.findByText('This repository (app)')).toBeInTheDocument()
    expect(api.memoryRequest).toHaveBeenCalledWith({ op: 'list', workspace: '/w/app' })
    expect(screen.getByText('tests-need-rg')).toBeInTheDocument()
    expect(screen.getByText('short-prs')).toBeInTheDocument()
    expect(screen.getByText('About you')).toBeInTheDocument()
    expect(screen.getAllByText('Set HOUSTON_RG')[0].tagName).toBe('SUMMARY')
  })

  it('says so when nothing is saved, and asks for a project when none is open', async () => {
    installApi(() => ({ ok: true, overview: overview({ repo: null, repoMemories: [] }) }))
    render(<MemoriesSection ctx={ctx({ workspace: null })} />)
    expect(await screen.findByText('Open a project to see its memories.')).toBeInTheDocument()
    expect(screen.getByText('Nothing saved for every project yet.')).toBeInTheDocument()
  })

  it('deletes with an undo that restores it', async () => {
    let current = overview()
    const api = installApi((req) => {
      if (req.op === 'remove') current = overview({ repoMemories: [] })
      if (req.op === 'restore') current = overview()
      return { ok: true, overview: current }
    })
    render(<MemoriesSection ctx={ctx()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete memory tests-need-rg' }))
    expect(await screen.findByText('Nothing saved for this repository yet.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(screen.getByText('tests-need-rg')).toBeInTheDocument())
    expect(api.memoryRequest).toHaveBeenCalledWith({ op: 'restore', workspace: '/w/app', scope: 'repo', id: 'm_20261024_aaaaaa' })
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('edits a memory, sending the version it was read at', async () => {
    const api = installApi(() => ({ ok: true, overview: overview() }))
    render(<MemoriesSection ctx={ctx()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit memory tests-need-rg' }))
    fireEvent.change(screen.getByLabelText('Memory'), { target: { value: 'Updated body' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.memoryRequest).toHaveBeenCalledWith({
        op: 'update',
        workspace: '/w/app',
        scope: 'repo',
        id: 'm_20261024_aaaaaa',
        type: 'project',
        name: 'tests-need-rg',
        description: 'Set HOUSTON_RG',
        body: 'Updated body',
        expectedUpdated: '2026-10-24T00:00:00.000Z'
      })
    )
    await waitFor(() => expect(screen.queryByLabelText('Memory')).toBeNull())
  })

  it('keeps the editor open and shows why when an edit is refused', async () => {
    installApi((req) =>
      req.op === 'update' ? { ok: false, error: 'Memory changed since it was read; reload it and retry.', overview: overview() } : { ok: true, overview: overview() }
    )
    render(<MemoriesSection ctx={ctx()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit memory tests-need-rg' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/changed since it was read/)).toBeInTheDocument()
    expect(screen.getByLabelText('Memory')).toBeInTheDocument()
  })

  it('pins and unpins', async () => {
    const api = installApi((req) => ({ ok: true, overview: overview({ repoMemories: [memory({ pinned: req.op === 'pin' && req.pinned })] }) }))
    render(<MemoriesSection ctx={ctx()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Pin memory tests-need-rg' }))
    expect(await screen.findByText('Pinned')).toBeInTheDocument()
    expect(api.memoryRequest).toHaveBeenCalledWith({ op: 'pin', workspace: '/w/app', scope: 'repo', id: 'm_20261024_aaaaaa', pinned: true })
  })

  it('moves or, after a confirmation, deletes another repository’s memories', async () => {
    const other = { key: 'k2', label: 'old-clone', root: '/old/old-clone', count: 3 }
    const api = installApi(() => ({ ok: true, overview: overview({ otherRepos: [other] }) }))
    render(<MemoriesSection ctx={ctx()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Move here' }))
    expect(api.memoryRequest).toHaveBeenCalledWith({ op: 'adoptRepo', workspace: '/w/app', key: 'k2' })
    // Buttons are disabled while a request is in flight.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move here' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Delete the memories of old-clone' }))
    expect(api.memoryRequest).not.toHaveBeenCalledWith(expect.objectContaining({ op: 'removeRepo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete 3' }))
    await waitFor(() =>
      expect(api.memoryRequest).toHaveBeenCalledWith({ op: 'removeRepo', workspace: '/w/app', key: 'k2' })
    )
  })
})

describe('MemorySettingsSection', () => {
  it('turns memory off and opens the folder', async () => {
    const api = installApi(() => ({ ok: true, overview: overview() }))
    const c = ctx()
    render(<MemorySettingsSection ctx={c} />)
    const box = screen.getByRole('checkbox')
    expect(box).toBeChecked()
    fireEvent.click(box)
    expect(c.setSettings).toHaveBeenCalled()
    const update = (c.setSettings as ReturnType<typeof vi.fn>).mock.calls[0][0] as (s: AppSettings) => AppSettings
    expect(update({} as AppSettings).memoryEnabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Open memory folder' }))
    await waitFor(() => expect(api.revealMemoryFolder).toHaveBeenCalled())
  })
})
