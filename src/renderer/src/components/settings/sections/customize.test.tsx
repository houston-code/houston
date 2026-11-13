import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CustomItem, CustomizeOverview } from '@shared/customize'
import type { AppSettings } from '@shared/types'
import type { SettingsCtx } from '../context'
import { CustomizeSection, InstructionFilesSection } from './customize'

afterEach(cleanup)

const item = (over: Partial<CustomItem> = {}): CustomItem => ({
  id: 'command:project:review',
  kind: 'command',
  scope: 'project',
  name: 'review',
  description: 'Review the diff',
  file: '.houston/commands/review.md',
  enabled: true,
  ...over
})

function ctx(workspace: string | null = '/w/app'): SettingsCtx {
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
    workspace,
    policy: null
  }
}

function installApi(overview: CustomizeOverview) {
  const ok = (): Promise<{ ok: boolean }> => Promise.resolve({ ok: true })
  const api = {
    customizeList: vi.fn(() => Promise.resolve(overview)),
    customizeCreate: vi.fn(ok),
    customizeSetEnabled: vi.fn(ok),
    customizeOpen: vi.fn(ok),
    customizeDelete: vi.fn(ok),
    customizeOpenInstruction: vi.fn(ok)
  }
  window.api = api as unknown as typeof window.api
  return api
}

describe('CustomizeSection', () => {
  it('lists items by kind with their place, and notes a user item the project hides', async () => {
    installApi({
      items: [item(), item({ id: 'command:user:review', scope: 'user', file: '~/.houston/commands/review.md', shadowed: true })],
      instructions: []
    })
    render(<CustomizeSection ctx={ctx()} />)
    expect(await screen.findAllByText('/review')).toHaveLength(2)
    expect(screen.getByText('This project', { selector: '.pill' })).toBeTruthy()
    expect(screen.getByText('All projects', { selector: '.pill' })).toBeTruthy()
    expect(screen.getByText(/which is used instead/)).toBeTruthy()
    expect(screen.getAllByText('None yet.')).toHaveLength(2) // skills and agents
  })

  it('switches an item off, opens it, and asks before moving it to the trash', async () => {
    const api = installApi({ items: [item()], instructions: [] })
    render(<CustomizeSection ctx={ctx()} />)
    fireEvent.click(await screen.findByRole('checkbox', { name: '/review (This project) on' }))
    await waitFor(() => expect(api.customizeSetEnabled).toHaveBeenCalledWith('/w/app', 'command:project:review', false))
    fireEvent.click(screen.getByRole('button', { name: 'Open /review (This project)' }))
    await waitFor(() => expect(api.customizeOpen).toHaveBeenCalledWith('/w/app', 'command:project:review'))
    const del = screen.getByRole('button', { name: 'Delete /review (This project)' }) as HTMLButtonElement
    await waitFor(() => expect(del.disabled).toBe(false)) // the open has finished
    fireEvent.click(del)
    expect(api.customizeDelete).not.toHaveBeenCalled()
    const confirm = screen.getByRole('button', { name: 'Move to trash' })
    await waitFor(() => expect(document.activeElement).toBe(confirm))
    fireEvent.click(confirm)
    await waitFor(() => expect(api.customizeDelete).toHaveBeenCalledWith('/w/app', 'command:project:review'))
  })

  it('cancels a delete without calling main', async () => {
    const api = installApi({ items: [item()], instructions: [] })
    render(<CustomizeSection ctx={ctx()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete /review (This project)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: 'Move to trash' })).toBeNull()
    expect(api.customizeDelete).not.toHaveBeenCalled()
  })

  it('creates from a template in the chosen place, and only with a valid name', async () => {
    const api = installApi({ items: [], instructions: [] })
    render(<CustomizeSection ctx={ctx()} />)
    const input = await screen.findByRole('textbox', { name: 'New agent name' })
    fireEvent.change(input, { target: { value: 'bad name' } })
    expect((screen.getByRole('button', { name: 'Create agent' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'helper' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Where the new agent goes' }), { target: { value: 'user' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }))
    await waitFor(() => expect(api.customizeCreate).toHaveBeenCalledWith('/w/app', 'agent', 'user', 'helper'))
  })

  it('offers only All projects with no project open', async () => {
    installApi({ items: [], instructions: [] })
    render(<CustomizeSection ctx={ctx(null)} />)
    const select = (await screen.findByRole('combobox', { name: 'Where the new skill goes' })) as HTMLSelectElement
    expect(select.value).toBe('user')
    expect((screen.getAllByRole('option', { name: 'This project' })[0] as HTMLOptionElement).disabled).toBe(true)
  })

  it('shows an error main reports', async () => {
    const api = installApi({ items: [item()], instructions: [] })
    api.customizeOpen.mockResolvedValueOnce({ ok: false, error: 'No app to open it' } as never)
    render(<CustomizeSection ctx={ctx()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open /review (This project)' }))
    expect((await screen.findByRole('alert')).textContent).toBe('No app to open it')
  })
})

describe('InstructionFilesSection', () => {
  it('lists the loaded files in order and opens one by its label', async () => {
    const api = installApi({
      items: [],
      instructions: [
        { label: '~/.houston/AGENTS.md (global)', scope: 'global' },
        { label: 'AGENTS.md', scope: 'project' },
        { label: 'pkg/AGENTS.md', scope: 'nested', truncated: true }
      ]
    })
    render(<InstructionFilesSection ctx={ctx()} />)
    expect(await screen.findByText('Every project')).toBeTruthy()
    expect(screen.getByText('Shortened to fit')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open pkg/AGENTS.md' }))
    await waitFor(() => expect(api.customizeOpenInstruction).toHaveBeenCalledWith('/w/app', 'pkg/AGENTS.md'))
  })

  it('says when none are loaded', async () => {
    installApi({ items: [], instructions: [] })
    render(<InstructionFilesSection ctx={ctx(null)} />)
    expect(await screen.findByText(/None are loaded/)).toBeTruthy()
  })
})
