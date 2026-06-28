import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, ProviderConfig } from '@shared/types'
import { SettingsModal } from './SettingsModal'

/**
 * Install a fake `window.api` with only the methods SettingsModal touches. Each
 * mutating call (setKey/deleteKey/listModels) is preceded by a saveSettings, so
 * saveSettings resolves to the settings it was handed back (the "fresh" result).
 */
function installApi(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  const saveSettings = vi.fn((s: AppSettings) => Promise.resolve(s))
  const setKey = vi.fn((_id: string, _key: string) => Promise.resolve(makeSettings()))
  const deleteKey = vi.fn((_id: string) => Promise.resolve(makeSettings()))
  // listModels returns ModelOption[] (ids + optional capability metadata).
  const listModels = vi.fn((_id: string) => Promise.resolve([{ id: 'model-a' }, { id: 'model-b' }]))
  const pickDirectory = vi.fn(() => Promise.resolve('/picked/dir'))
  const getVersion = vi.fn(() => Promise.resolve('1.2.3'))
  const checkForUpdates = vi.fn(() => Promise.resolve({ status: 'up-to-date', currentVersion: '1.2.3' }))
  const getIntegrations = vi.fn(() =>
    Promise.resolve({ gh: { installed: false, authenticated: false }, formatters: [] })
  )
  const api = {
    saveSettings,
    setKey,
    deleteKey,
    listModels,
    pickDirectory,
    getVersion,
    checkForUpdates,
    getIntegrations,
    ...overrides
  }
  window.api = api as unknown as typeof window.api
  return api
}

const anthropic: ProviderConfig = {
  id: 'anthropic',
  kind: 'anthropic',
  label: 'Anthropic',
  models: [{ id: 'claude-sonnet' }],
  requiresKey: true,
  hasKey: true,
  builtIn: true
}

const customEndpoint: ProviderConfig = {
  id: 'custom-1234',
  kind: 'openai-compatible',
  label: 'My Local',
  baseUrl: 'http://localhost:8000/v1',
  models: [],
  requiresKey: false,
  hasKey: false,
  builtIn: false
}

function makeSettings(over: Partial<AppSettings> = {}): AppSettings {
  return {
    schemaVersion: 1,
    providers: [anthropic, customEndpoint],
    selected: null,
    approvalPolicy: 'ask',
    recentWorkspaces: [],
    searchProvider: 'tavily',
    searchKeyStatus: {},
    ...over
  } as AppSettings
}

function renderModal(over: Partial<AppSettings> = {}, props: Partial<React.ComponentProps<typeof SettingsModal>> = {}) {
  const onClose = vi.fn()
  const onSaved = vi.fn()
  const utils = render(
    <SettingsModal initial={makeSettings(over)} onClose={onClose} onSaved={onSaved} {...props} />
  )
  return { onClose, onSaved, ...utils }
}

describe('SettingsModal', () => {
  it('renders as a labelled modal dialog showing the Models tab and current providers', async () => {
    installApi()
    renderModal()

    const dialog = screen.getByRole('dialog')
    // The dialog is titled by the visible heading for screen readers: its
    // aria-labelledby must point at the element that actually carries that id.
    const labelledBy = dialog.getAttribute('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    const titleEl = document.getElementById(labelledBy!)
    expect(titleEl).not.toBeNull()
    expect(dialog.contains(titleEl)).toBe(true)

    // Models is the default tab; both providers are listed with their state.
    expect(screen.getByText('Anthropic')).toBeInTheDocument()
    expect(screen.getByText('My Local')).toBeInTheDocument()
    expect(screen.getByText('key set ✓')).toBeInTheDocument() // anthropic.hasKey

    // The mounted modal fetches and shows its version (Appearance tab uses it later).
    await waitFor(() => expect(window.api.getVersion).toHaveBeenCalled())
  })

  it('maps over the passed providers array, rendering exactly one row per provider', () => {
    installApi()
    // A single provider in → exactly one provider row out. This fails if the
    // component renders a hardcoded list instead of iterating `initial.providers`.
    renderModal({ providers: [anthropic] })

    const providers = document.querySelectorAll('.provider')
    expect(providers).toHaveLength(1)
    expect(within(providers[0] as HTMLElement).getByText('Anthropic')).toBeInTheDocument()
    expect(screen.queryByText('My Local')).not.toBeInTheDocument()
  })

  it('switches to the Tools & Permissions tab and reveals its controls', () => {
    installApi()
    renderModal()

    // Tools content isn't present until the tab is selected.
    expect(screen.queryByText('Permissions')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Tools & Permissions' }))

    expect(screen.getByRole('heading', { name: 'Permissions' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'MCP servers' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+ Add rule' })).toBeInTheDocument()
  })

  it('shows the optional-integrations status and how to enable gh when missing', async () => {
    installApi({
      getIntegrations: vi.fn(() =>
        Promise.resolve({
          gh: { installed: false, authenticated: false },
          formatters: [
            { bin: 'prettier', installed: true, languages: ['ts'] },
            { bin: 'gofmt', installed: false, languages: ['go'] }
          ]
        })
      )
    })
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Tools & Permissions' }))

    expect(screen.getByRole('heading', { name: 'Optional integrations' })).toBeInTheDocument()
    // gh is absent → warn status + an enable hint linking to the install page.
    await waitFor(() => expect(screen.getByText('Not found')).toBeInTheDocument())
    expect(screen.getByText('cli.github.com')).toBeInTheDocument()
    // Formatter rollup reflects the injected statuses (1 of 2 found).
    expect(screen.getByText('1 of 2 found')).toBeInTheDocument()
  })

  it('reports gh as signed in when installed and authenticated', async () => {
    installApi({
      getIntegrations: vi.fn(() =>
        Promise.resolve({ gh: { installed: true, authenticated: true }, formatters: [] })
      )
    })
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Tools & Permissions' }))

    await waitFor(() => expect(screen.getByText('Installed & signed in')).toBeInTheDocument())
    // No enable hint when it's already usable.
    expect(screen.queryByText('cli.github.com')).not.toBeInTheDocument()
  })

  it('adds a permission rule when "+ Add rule" is clicked', () => {
    installApi()
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Tools & Permissions' }))

    // The rule-row count proves the click mutated state: 0 rows before, exactly 1
    // after. (Hooks share the same placeholder, but there are no hooks here.)
    expect(screen.queryAllByPlaceholderText('tool (or *)')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '+ Add rule' }))
    expect(screen.queryAllByPlaceholderText('tool (or *)')).toHaveLength(1)

    // The single new editable rule row carries the default action/tool.
    expect(screen.getByPlaceholderText('tool (or *)')).toHaveValue('run_shell')
    expect(screen.getByDisplayValue('Allow')).toBeInTheDocument()
  })

  it('saves an API key: persists settings first, then calls setKey with the typed value', async () => {
    const api = installApi()
    renderModal()

    const keyInput = screen.getByPlaceholderText('•••••••• (stored)') // anthropic.hasKey password field
    fireEvent.change(keyInput, { target: { value: 'sk-secret' } })
    // The Save next to the anthropic provider's key row.
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0])

    await waitFor(() => expect(api.setKey).toHaveBeenCalledWith('anthropic', 'sk-secret'))
    // persistThen saves the (unsecreted) settings before storing the secret.
    expect(api.saveSettings).toHaveBeenCalled()
    expect(api.saveSettings.mock.invocationCallOrder[0]).toBeLessThan(
      api.setKey.mock.invocationCallOrder[0]
    )
    // The input is cleared after a successful save.
    await waitFor(() => expect(keyInput).toHaveValue(''))
  })

  it('fetches models from the provider and writes them into the textarea', async () => {
    const api = installApi()
    renderModal()

    // The custom endpoint starts with no models.
    const modelsAreas = screen.getAllByPlaceholderText('one model id per line')
    const customArea = modelsAreas[1]
    expect(customArea).toHaveValue('')

    // "fetch from provider" lives in the custom provider's Models field.
    const fetchButtons = screen.getAllByText('fetch from provider')
    fireEvent.click(fetchButtons[1])

    await waitFor(() => expect(api.listModels).toHaveBeenCalledWith('custom-1234'))
    await waitFor(() => expect(customArea).toHaveValue('model-a\nmodel-b'))
  })

  it('saves all settings and closes when the footer Save is clicked', async () => {
    const api = installApi()
    const { onClose, onSaved, container } = renderModal()

    // Edit a free-text field so we can assert it's carried into the save payload.
    fireEvent.change(screen.getByPlaceholderText(/Extra instructions appended/), {
      target: { value: 'be concise' }
    })
    // Several "Save" buttons exist (one per API key row); target the footer's
    // accent Save specifically.
    fireEvent.click(within(container.querySelector('.modal__foot')!).getByText('Save'))

    // The accent footer Save persists and propagates the fresh settings, then closes.
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const saved = api.saveSettings.mock.calls.at(-1)?.[0] as AppSettings
    expect(saved.systemPromptExtra).toBe('be concise')
    expect(onClose).toHaveBeenCalled()
  })

  it('closes via the header close button and via the Cancel button', () => {
    installApi()
    const { onClose } = renderModal()

    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('closes on Escape (focus trap) and not on inner clicks', () => {
    installApi()
    const { onClose } = renderModal()
    const dialog = screen.getByRole('dialog')

    // Clicking inside the dialog must not bubble to the backdrop's onClose.
    fireEvent.click(dialog)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('moves focus into the dialog on open (focus trap)', async () => {
    installApi()
    renderModal()
    // useFocusTrap focuses the first focusable control inside the dialog.
    const dialog = screen.getByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
  })

  it('toggles a checkbox option (format on save) under the Tools tab', () => {
    installApi()
    const { onSaved } = renderModal({ formatOnSave: false })
    fireEvent.click(screen.getByRole('button', { name: 'Tools & Permissions' }))

    const checkbox = screen.getByRole('checkbox', { name: /run the matching formatter/i })
    expect(checkbox).not.toBeChecked()
    fireEvent.click(checkbox)
    expect(checkbox).toBeChecked()
    // The toggle is local state until the footer Save; onSaved hasn't fired yet.
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('toggles the diagnostics-on-save option under the Tools tab', () => {
    installApi()
    const { onSaved } = renderModal({ diagnosticsOnSave: false })
    fireEvent.click(screen.getByRole('button', { name: 'Tools & Permissions' }))

    const checkbox = screen.getByRole('checkbox', { name: /run a fast checker/i })
    expect(checkbox).not.toBeChecked()
    fireEvent.click(checkbox)
    expect(checkbox).toBeChecked()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('removes a permission rule when its ✕ control is clicked', () => {
    installApi()
    renderModal({
      permissionRules: [{ action: 'deny', tool: 'run_shell', match: 'rm *' }]
    })
    fireEvent.click(screen.getByRole('button', { name: 'Tools & Permissions' }))

    // Exactly one rule row to start.
    expect(screen.queryAllByPlaceholderText('tool (or *)')).toHaveLength(1)
    const ruleRow = document.querySelector('.rule') as HTMLElement
    // The ✕ inside the rule row removes it.
    fireEvent.click(within(ruleRow).getByRole('button', { name: '✕' }))

    expect(screen.queryAllByPlaceholderText('tool (or *)')).toHaveLength(0)
  })

  it('removes a stored API key: calls deleteKey with the provider id and hides Remove', async () => {
    // After deletion the persisted/fresh provider no longer has a key, so the
    // Remove affordance must disappear.
    const keyless: ProviderConfig = { ...anthropic, hasKey: false }
    const deleteKey = vi.fn((_id: string) =>
      Promise.resolve(makeSettings({ providers: [keyless] }))
    )
    const api = installApi({ deleteKey })
    // Only the built-in anthropic provider, so the sole Remove button is its key
    // row's (no non-builtin provider contributes a provider-level Remove).
    renderModal({ providers: [anthropic] })

    // anthropic.hasKey → a Remove button exists in its key row.
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(api.deleteKey).toHaveBeenCalledWith('anthropic'))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
    )
  })

  it('removes a custom (non-builtin) provider when its Remove is clicked', () => {
    installApi()
    renderModal()

    // Built-in anthropic has no Remove; the custom endpoint does.
    expect(screen.getByText('My Local')).toBeInTheDocument()
    const customRow = within(screen.getByText('My Local').closest('.provider') as HTMLElement)
    fireEvent.click(customRow.getByRole('button', { name: 'Remove' }))

    expect(screen.queryByText('My Local')).not.toBeInTheDocument()
    // The built-in provider is untouched.
    expect(screen.getByText('Anthropic')).toBeInTheDocument()
  })

  it('adds an MCP server row when "+ Add MCP server" is clicked', () => {
    installApi()
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Tools & Permissions' }))

    // No servers configured to start.
    expect(document.querySelectorAll('.mcp-server')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '+ Add MCP server' }))

    const servers = document.querySelectorAll('.mcp-server')
    expect(servers).toHaveLength(1)
    // The new server row defaults to a stdio command field.
    expect(within(servers[0] as HTMLElement).getByPlaceholderText('command (e.g. npx)')).toBeInTheDocument()
  })

  it('adds an additional folder from the directory picker', async () => {
    const pickDirectory = vi.fn(() => Promise.resolve('/picked/dir'))
    const api = installApi({ pickDirectory })
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))

    // No roots listed before picking.
    expect(screen.queryByText('/picked/dir')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '+ Add folder' }))

    await waitFor(() => expect(api.pickDirectory).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('/picked/dir')).toBeInTheDocument())
  })

  describe('appearance theme preview', () => {
    // The preview writes data-theme onto the shared document root; reset between
    // cases so one test's selection can't leak into the next.
    afterEach(() => {
      delete document.documentElement.dataset.theme
    })

    it('previews the selected theme on the document root before saving', () => {
      installApi()
      renderModal({ theme: 'dark' })
      fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
      // Opening with the saved theme applies it (no change yet).
      expect(document.documentElement.dataset.theme).toBe('dark')

      // Picking a new option previews immediately, without touching Save.
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'light' } })
      expect(document.documentElement.dataset.theme).toBe('light')
    })

    it('reverts the preview to the open-time theme when closed without saving', () => {
      installApi()
      const { onSaved, unmount } = renderModal({ theme: 'dark' })
      fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'light' } })
      expect(document.documentElement.dataset.theme).toBe('light')

      // Closing without Save (modal unmounts) discards the preview.
      unmount()
      expect(document.documentElement.dataset.theme).toBe('dark')
      expect(onSaved).not.toHaveBeenCalled()
    })

    it('keeps the previewed theme after Save and does not revert on close', async () => {
      const api = installApi()
      const { onSaved, unmount } = renderModal({ theme: 'dark' })
      fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'light' } })

      // Footer Save persists the selection and propagates it upward.
      const foot = document.querySelector('.modal__foot') as HTMLElement
      fireEvent.click(within(foot).getByText('Save'))
      await waitFor(() => expect(onSaved).toHaveBeenCalled())
      expect((api.saveSettings.mock.calls.at(-1)?.[0] as AppSettings).theme).toBe('light')

      // The committed theme survives the close instead of snapping back.
      unmount()
      expect(document.documentElement.dataset.theme).toBe('light')
    })
  })
})
