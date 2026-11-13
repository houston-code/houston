import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, IntegrationsInfo } from '@shared/types'
import type { SettingsCtx } from '../context'
import { IntegrationsSection } from './tools'
import { VerifySuggestion } from './verifySuggestion'

afterEach(cleanup)

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

const info: IntegrationsInfo = {
  gh: { installed: false, authenticated: false },
  formatters: [
    { bin: 'prettier', installed: false, languages: ['ts'] },
    { bin: 'gofmt', installed: false, languages: ['go'] }
  ],
  ripgrep: { installed: false },
  languageServers: [{ id: 'typescript', name: 'TypeScript', languages: ['ts'], path: null, installHint: '', user: false }],
  install: {
    gh: 'brew install gh',
    rg: 'brew install ripgrep',
    'fmt:prettier': 'npm install -g prettier',
    'lsp:typescript': 'npm install -g typescript-language-server typescript'
  }
}

describe('IntegrationsSection install buttons', () => {
  it('offers Install only for missing items with a command, and types it into the terminal', async () => {
    window.api = { getIntegrations: vi.fn(() => Promise.resolve(info)) } as unknown as typeof window.api
    const onTypeInTerminal = vi.fn()
    render(<IntegrationsSection ctx={ctx({ onTypeInTerminal })} />)
    const rg = await screen.findByRole('button', { name: 'Install ripgrep (types brew install ripgrep into the terminal)' })
    expect(screen.getByRole('button', { name: /Install gh/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Install prettier/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Install TypeScript/ })).toBeTruthy()
    // gofmt has no command on this machine, so no button.
    expect(screen.queryByRole('button', { name: /Install gofmt/ })).toBeNull()
    expect(screen.getByText(/press Enter to run it/)).toBeTruthy()
    fireEvent.click(rg)
    expect(onTypeInTerminal).toHaveBeenCalledWith('brew install ripgrep')
  })

  it('shows no buttons where there is no terminal to type into', async () => {
    window.api = { getIntegrations: vi.fn(() => Promise.resolve(info)) } as unknown as typeof window.api
    render(<IntegrationsSection ctx={ctx()} />)
    expect(await screen.findByText('ripgrep', { exact: false })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Install/ })).toBeNull()
  })
})

describe('VerifySuggestion', () => {
  it("offers the project's command and fills the field without anything else", async () => {
    window.api = {
      inferVerifyCommand: vi.fn(() => Promise.resolve({ command: 'npm test', source: 'package.json script test' }))
    } as unknown as typeof window.api
    const onUse = vi.fn()
    render(<VerifySuggestion workspace="/w/app" current="" onUse={onUse} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Use this command' }))
    expect(onUse).toHaveBeenCalledWith('npm test')
    expect(screen.getByText('package.json script test', { exact: false })).toBeTruthy()
  })

  it('says In use when the field already has it, and shows nothing without a project or a match', async () => {
    const infer = vi.fn(() => Promise.resolve({ command: 'npm test', source: 'package.json script test' }))
    window.api = { inferVerifyCommand: infer } as unknown as typeof window.api
    render(<VerifySuggestion workspace="/w/app" current="npm test" onUse={vi.fn()} />)
    expect(await screen.findByText('In use.')).toBeTruthy()
    cleanup()
    const { container } = render(<VerifySuggestion workspace={null} current="" onUse={vi.fn()} />)
    expect(container.textContent).toBe('')
    infer.mockResolvedValueOnce(null as never)
    cleanup()
    const r = render(<VerifySuggestion workspace="/w/other" current="" onUse={vi.fn()} />)
    await waitFor(() => expect(infer).toHaveBeenCalledWith('/w/other'))
    expect(r.container.textContent).toBe('')
  })
})
