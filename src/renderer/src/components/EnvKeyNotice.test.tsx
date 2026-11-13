import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, EnvKeyOffer } from '@shared/types'
import { defaultSettings } from '@shared/defaults'
import { EnvKeyNotice } from './EnvKeyNotice'

const OFFERS: EnvKeyOffer[] = [
  { providerId: 'anthropic', providerLabel: 'Anthropic (Claude)', envVar: 'ANTHROPIC_API_KEY', last4: 'wxyz' },
  { providerId: 'openai', providerLabel: 'OpenAI (GPT)', envVar: 'OPENAI_API_KEY', last4: 'abcd' }
]

function installApi(over: Partial<Record<string, unknown>> = {}) {
  const fresh: AppSettings = defaultSettings()
  const api = {
    getEnvKeyOffers: vi.fn(() => Promise.resolve(OFFERS)),
    importEnvKey: vi.fn(() => Promise.resolve(fresh)),
    dismissEnvKeyOffers: vi.fn(() => Promise.resolve()),
    getSecureStorageStatus: vi.fn(() => Promise.resolve({ available: true, platform: 'darwin' })),
    ...over
  }
  window.api = api as unknown as typeof window.api
  return { api, fresh }
}

describe('EnvKeyNotice', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows nothing when no key is offered', async () => {
    const { api } = installApi({ getEnvKeyOffers: vi.fn(() => Promise.resolve([])) })
    const { container } = render(<EnvKeyNotice onImported={vi.fn()} />)
    await waitFor(() => expect(api.getEnvKeyOffers).toHaveBeenCalledWith('startup'))
    expect(container).toBeEmptyDOMElement()
  })

  it('names the provider, the variable and the last four characters, one offer at a time', async () => {
    installApi()
    render(<EnvKeyNotice onImported={vi.fn()} />)
    expect(await screen.findByText('Use the Anthropic (Claude) key from your environment?')).toBeInTheDocument()
    const region = screen.getByRole('region')
    expect(region).toHaveTextContent('ANTHROPIC_API_KEY holds a key ending in wxyz')
    expect(screen.queryByText(/OpenAI/)).not.toBeInTheDocument()
  })

  it('stores the key on Use it and moves to the next offer', async () => {
    const { api, fresh } = installApi()
    const onImported = vi.fn()
    render(<EnvKeyNotice onImported={onImported} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Use it' }))
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(fresh, 'anthropic'))
    expect(api.importEnvKey).toHaveBeenCalledWith('anthropic')
    expect(await screen.findByText('Use the OpenAI (GPT) key from your environment?')).toBeInTheDocument()
  })

  it('records Not now and stores nothing', async () => {
    const { api } = installApi({ getEnvKeyOffers: vi.fn(() => Promise.resolve(OFFERS.slice(0, 1))) })
    const onImported = vi.fn()
    render(<EnvKeyNotice onImported={onImported} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(screen.queryByRole('region')).not.toBeInTheDocument())
    expect(api.dismissEnvKeyOffers).toHaveBeenCalledWith(['anthropic'])
    expect(api.importEnvKey).not.toHaveBeenCalled()
    expect(onImported).not.toHaveBeenCalled()
  })

  it('keeps the offer and shows why when the key does not work', async () => {
    installApi({
      importEnvKey: vi.fn(() =>
        Promise.reject(new Error("Error invoking remote method 'app:envKeyImport': Error: invalid x-api-key"))
      )
    })
    const onImported = vi.fn()
    render(<EnvKeyNotice onImported={onImported} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Use it' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't use that key: invalid x-api-key")
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument()
    expect(onImported).not.toHaveBeenCalled()
  })
})
