import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/types'
import { defaultSettings } from '@shared/defaults'
import { ConnectModel } from './ConnectModel'

function settings(over: Partial<AppSettings> = {}): AppSettings {
  return { ...defaultSettings(), ...over }
}

function installApi(
  opts: { listModels?: () => Promise<unknown>; testKey?: () => Promise<number> } = {}
) {
  const fresh = settings()
  const api = {
    setKey: vi.fn().mockResolvedValue(fresh),
    deleteKey: vi.fn().mockResolvedValue(fresh),
    testKey: vi.fn(opts.testKey ?? (() => Promise.resolve(3))),
    getSecureStorageStatus: vi.fn(() => Promise.resolve({ available: true, platform: 'darwin' })),
    relaunchApp: vi.fn(() => Promise.resolve(true)),
    listModels: vi.fn(opts.listModels ?? (() => Promise.resolve([{ id: 'm1' }]))),
    getSettings: vi.fn().mockResolvedValue(fresh),
    saveSettings: vi.fn((s: AppSettings) => Promise.resolve(s))
  }
  window.api = api as unknown as typeof window.api
  return { api, fresh }
}

function renderPanel(s: AppSettings = settings()) {
  const onConnected = vi.fn()
  const onBack = vi.fn()
  render(<ConnectModel settings={s} onConnected={onConnected} onBack={onBack} />)
  return { onConnected, onBack }
}

const keyInput = (): HTMLElement => screen.getByLabelText('API key')

describe('ConnectModel', () => {
  beforeEach(() => vi.clearAllMocks())

  it('offers the built-in providers, Anthropic first', () => {
    installApi()
    renderPanel()
    const tiles = screen.getAllByRole('radio').map((t) => t.textContent)
    expect(tiles).toEqual(['Anthropic', 'OpenAI', 'Gemini', 'Ollama', 'LM Studio'])
    expect(screen.getByRole('radio', { name: 'Anthropic' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('link', { name: 'Get a key' })).toHaveAttribute(
      'href',
      'https://console.anthropic.com/settings/keys'
    )
  })

  it('asks for a key before trying to connect', async () => {
    const { api } = installApi()
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Paste an API key first.')
    expect(api.setKey).not.toHaveBeenCalled()
  })

  it('checks the key before storing it, then reports the provider', async () => {
    const { api, fresh } = installApi()
    const { onConnected } = renderPanel()
    fireEvent.change(keyInput(), { target: { value: '  sk-test  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(fresh, 'anthropic'))
    expect(api.testKey).toHaveBeenCalledWith('anthropic', 'sk-test')
    expect(api.setKey).toHaveBeenCalledWith('anthropic', 'sk-test')
    expect(api.testKey.mock.invocationCallOrder[0]).toBeLessThan(api.setKey.mock.invocationCallOrder[0])
  })

  it('never stores a key that fails the check, and offers to save it anyway', async () => {
    const { api } = installApi({ testKey: () => Promise.reject(new Error('401 invalid x-api-key')) })
    const { onConnected } = renderPanel()
    fireEvent.change(keyInput(), { target: { value: 'sk-bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("That key didn't work: 401 invalid x-api-key")
    // Nothing was written, so a key that already worked is untouched.
    expect(api.setKey).not.toHaveBeenCalled()
    expect(api.deleteKey).not.toHaveBeenCalled()
    expect(onConnected).not.toHaveBeenCalled()

    // The check can fail for reasons other than a bad key (offline, a proxy).
    fireEvent.click(screen.getByRole('button', { name: 'Save anyway' }))
    await waitFor(() => expect(onConnected).toHaveBeenCalled())
    expect(api.setKey).toHaveBeenCalledWith('anthropic', 'sk-bad')
  })

  it('reports a storage failure as a save failure, without Save anyway', async () => {
    const { api } = installApi()
    api.setKey.mockRejectedValue(new Error('OS encryption (Keychain) is unavailable'))
    const { onConnected } = renderPanel()
    fireEvent.change(keyInput(), { target: { value: 'sk-good' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save the key: OS encryption")
    expect(screen.queryByRole('button', { name: 'Save anyway' })).not.toBeInTheDocument()
    expect(onConnected).not.toHaveBeenCalled()
  })

  it('checks a local host without asking for a key and seeds its models', async () => {
    const { api } = installApi({ listModels: () => Promise.resolve([{ id: 'llama3.1' }]) })
    const { onConnected } = renderPanel()
    fireEvent.click(screen.getByRole('radio', { name: 'Ollama' }))
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }))
    await waitFor(() => expect(onConnected).toHaveBeenCalled())
    const saved = api.saveSettings.mock.calls[0][0] as AppSettings
    expect(saved.providers.find((p) => p.id === 'ollama')!.models).toEqual([{ id: 'llama3.1' }])
    expect(onConnected.mock.calls[0][1]).toBe('ollama')
    expect(api.setKey).not.toHaveBeenCalled()
  })

  it('explains how to start a local host that serves no models', async () => {
    installApi({ listModels: () => Promise.reject(new Error('ECONNREFUSED')) })
    const { onConnected } = renderPanel()
    fireEvent.click(screen.getByRole('radio', { name: 'Ollama' }))
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/No models found\. Start Ollama/)
    expect(onConnected).not.toHaveBeenCalled()
  })

  it('offers a restart when the Keychain refused the save (denied prompt)', async () => {
    const { api } = installApi()
    api.setKey.mockRejectedValue(new Error('secure store unavailable'))
    api.getSecureStorageStatus.mockResolvedValue({ available: false, platform: 'darwin' })
    const { onConnected } = renderPanel()
    fireEvent.change(keyInput(), { target: { value: 'sk-good' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByRole('button', { name: 'Restart Houston' })).toBeInTheDocument()
    expect(screen.getByText(/choose Always Allow/)).toBeInTheDocument()
    expect(screen.queryByText(/Couldn't save the key/)).not.toBeInTheDocument()
    expect(onConnected).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Restart Houston' }))
    await waitFor(() => expect(api.relaunchApp).toHaveBeenCalled())
  })

  it('is one Tab stop, with arrow keys moving the selection like a radio group', () => {
    installApi()
    renderPanel()
    const radios = screen.getAllByRole('radio')
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1, -1, -1])
    radios[0].focus()
    fireEvent.keyDown(radios[0], { key: 'ArrowRight' })
    expect(screen.getByRole('radio', { name: 'OpenAI' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'OpenAI' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    // Wraps from the first tile to the last.
    expect(screen.getByRole('radio', { name: 'LM Studio' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(screen.getByRole('radio', { name: 'Anthropic' })).toHaveFocus()
    expect(screen.getAllByRole('radio').map((r) => r.tabIndex)).toEqual([0, -1, -1, -1, -1])
  })

  it('goes back to the checklist', () => {
    installApi()
    const { onBack } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

describe('ipcErrorMessage', () => {
  it("strips Electron's remote-method wrapper", async () => {
    const { ipcErrorMessage } = await import('./ConnectModel')
    expect(
      ipcErrorMessage(
        new Error("Error invoking remote method 'settings:listModels': Error: 401 invalid x-api-key")
      )
    ).toBe('401 invalid x-api-key')
    expect(ipcErrorMessage(new Error('plain'))).toBe('plain')
  })
})
