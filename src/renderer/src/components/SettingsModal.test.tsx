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
  // Default cleanup echoes its input; individual tests override to assert the tidy-up.
  const cleanupPermissionRules = vi.fn((rules: unknown) => Promise.resolve(rules))
  const getMcpStatuses = vi.fn(() => Promise.resolve([]))
  const api = {
    saveSettings,
    setKey,
    deleteKey,
    listModels,
    pickDirectory,
    getVersion,
    checkForUpdates,
    getIntegrations,
    cleanupPermissionRules,
    getMcpStatuses,
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

/**
 * The cloud-hosted Claude kinds are configured by region (and project), not by a
 * base URL or a key. Before they existed, the provider block gated every optional
 * field on `openai-compatible`, so a Bedrock/Vertex provider rendered with nothing
 * to configure at all.
 */
describe('SettingsModal cloud-hosted Claude providers', () => {
  const bedrockAws: ProviderConfig = {
    id: 'bedrock-aws',
    kind: 'bedrock',
    label: 'Amazon Bedrock (AWS credentials)',
    region: 'us-east-1',
    models: [{ id: 'anthropic.claude-opus-4-8' }],
    requiresKey: false,
    hasKey: false,
    builtIn: false
  }
  const vertex: ProviderConfig = {
    id: 'vertex',
    kind: 'vertex',
    label: 'Google Vertex AI',
    region: 'us-east5',
    models: [{ id: 'claude-opus-4-8' }],
    requiresKey: false,
    hasKey: false,
    builtIn: false
  }

  it('shows a region field for Bedrock, and no project field', () => {
    installApi()
    renderModal({ providers: [bedrockAws] })
    expect(screen.getByLabelText('Region')).toHaveValue('us-east-1')
    expect(screen.queryByLabelText('Project ID')).not.toBeInTheDocument()
  })

  it('shows region and project fields for Vertex', () => {
    installApi()
    renderModal({ providers: [vertex] })
    expect(screen.getByLabelText('Region')).toHaveValue('us-east5')
    expect(screen.getByLabelText('Project ID')).toBeInTheDocument()
  })

  it('offers an optional API key for Bedrock but none for Vertex', () => {
    installApi()
    const { unmount } = renderModal({ providers: [bedrockAws] })
    // Bedrock accepts a bearer token that overrides the AWS credential chain.
    expect(screen.getByLabelText('API key')).toBeInTheDocument()
    unmount()

    // Vertex has no API key concept at all, so offering the field would invite a
    // key that is silently ignored.
    installApi()
    renderModal({ providers: [vertex] })
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument()
  })

  it('saves an edited region', async () => {
    const api = installApi()
    renderModal({ providers: [bedrockAws] })
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'eu-west-1' } })
    // Scoped to the footer: the API key row has a "Save" button of its own.
    const foot = document.querySelector('.modal__foot') as HTMLElement
    fireEvent.click(within(foot).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
    const saved = api.saveSettings.mock.calls.at(-1)![0] as AppSettings
    expect(saved.providers[0].region).toBe('eu-west-1')
  })

  it('leaves the base URL field hidden until one is set as an override', () => {
    installApi()
    const { unmount } = renderModal({ providers: [bedrockAws] })
    // The endpoint is derived from the region, so there is nothing to fill in.
    expect(screen.queryByLabelText('Base URL')).not.toBeInTheDocument()
    unmount()

    installApi()
    renderModal({ providers: [{ ...bedrockAws, baseUrl: 'https://gw.internal/anthropic' }] })
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://gw.internal/anthropic')
  })
})

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

  it('renders Legal as the last tab in the nav, revealing its links when selected', () => {
    installApi()
    renderModal()

    // Legal is a standalone tab, ordered last after Appearance.
    const labels = screen
      .getAllByRole('button')
      .map((b) => b.textContent?.trim())
      .filter((t) => t && ['Legal', 'Models & Inference', 'Tools & Permissions', 'Workspace', 'Keyboard', 'Appearance'].includes(t))
    expect(labels.at(-1)).toBe('Legal')

    // Its content isn't rendered until selected; then the legal links appear.
    expect(screen.queryByRole('link', { name: 'Privacy' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Legal' }))
    expect(screen.getByRole('link', { name: 'Privacy' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'License (Apache-2.0)' })).toBeInTheDocument()
  })

  it('offers a Loop scorecard button on the Models tab that calls onShowScorecard', () => {
    installApi()
    const onShowScorecard = vi.fn()
    renderModal({}, { onShowScorecard })
    // The section lives in the default Models tab; heading + button render there.
    expect(screen.getByRole('heading', { name: 'Loop scorecard' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /open loop scorecard/i }))
    expect(onShowScorecard).toHaveBeenCalledTimes(1)
  })

  it('omits the Loop scorecard section when no handler is given', () => {
    installApi()
    renderModal()
    expect(screen.queryByRole('heading', { name: 'Loop scorecard' })).not.toBeInTheDocument()
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

    // The rule-row count proves the click mutated state: 0 rows before, exactly 1 after.
    expect(document.querySelectorAll('.rule')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '+ Add rule' }))
    expect(document.querySelectorAll('.rule')).toHaveLength(1)

    // The new rule lands in a run_shell group (per-tool grouping) and defaults to the
    // safe 'ask' action; the tool is shown by the group header, not a per-row field.
    expect(document.querySelector('.rule-group__tool')?.textContent).toBe('run_shell')
    expect(screen.getByDisplayValue('Ask')).toBeInTheDocument()
  })

  it('groups rules by tool and filters them', () => {
    installApi()
    renderModal({
      permissionRules: [
        { action: 'allow', tool: 'run_shell', match: 'npm install' },
        { action: 'allow', tool: 'run_shell', match: 'git status' },
        { action: 'deny', tool: 'web_fetch', match: 'https://evil.example.com' }
      ]
    })
    fireEvent.click(screen.getByRole('button', { name: 'Tools & Permissions' }))

    // Two tool groups (run_shell with 2, web_fetch with 1); three rows total.
    const groups = [...document.querySelectorAll('.rule-group__tool')].map((n) => n.textContent)
    expect(groups).toEqual(['run_shell', 'web_fetch'])
    expect(document.querySelectorAll('.rule')).toHaveLength(3)

    // Filtering by "git" narrows to the single matching rule.
    fireEvent.change(screen.getByPlaceholderText('Filter rules…'), { target: { value: 'git' } })
    expect(document.querySelectorAll('.rule')).toHaveLength(1)
    expect(screen.getByDisplayValue('git status')).toBeInTheDocument()
  })

  it('tidies rules via the "Clean up rules" button (main-process helper)', async () => {
    const cleaned = [{ action: 'allow', tool: 'run_shell', match: 'npm install' }]
    const cleanupPermissionRules = vi.fn(() => Promise.resolve(cleaned))
    installApi({ cleanupPermissionRules })
    renderModal({
      permissionRules: [
        { action: 'allow', tool: 'run_shell', match: 'cd /repo && npm install foo' },
        { action: 'allow', tool: 'run_shell', match: 'cd /repo && npm install bar' }
      ]
    })
    fireEvent.click(screen.getByRole('button', { name: 'Tools & Permissions' }))
    expect(document.querySelectorAll('.rule')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Clean up rules' }))
    await waitFor(() => expect(cleanupPermissionRules).toHaveBeenCalledOnce())
    // The two exact commands collapse to the single generalized rule the helper returns.
    await waitFor(() => expect(document.querySelectorAll('.rule')).toHaveLength(1))
    expect(screen.getByDisplayValue('npm install')).toBeInTheDocument()
  })

  it('saves an API key via setKey without persisting the modal’s other edits', async () => {
    const api = installApi()
    renderModal()

    const keyInput = screen.getByPlaceholderText('•••••••• (stored)') // anthropic.hasKey password field
    fireEvent.change(keyInput, { target: { value: 'sk-secret' } })
    // The Save next to the anthropic provider's key row.
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0])

    await waitFor(() => expect(api.setKey).toHaveBeenCalledWith('anthropic', 'sk-secret'))
    // A key is a secret, not a settings edit — storing it must not persist the
    // working copy (so Cancel still discards unrelated edits).
    expect(api.saveSettings).not.toHaveBeenCalled()
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

  it('keeps a trailing newline while typing so a new model line can be started', () => {
    installApi()
    renderModal()

    const modelsArea = screen.getAllByPlaceholderText('one model id per line')[0] // anthropic
    expect(modelsArea).toHaveValue('claude-sonnet')

    // Pressing Enter at the end of the list must open a blank line for the next
    // id. A textarea that re-normalized on every keystroke would strip the
    // trailing newline immediately, so the caret could never leave the last id.
    fireEvent.focus(modelsArea)
    fireEvent.change(modelsArea, { target: { value: 'claude-sonnet\n' } })
    expect(modelsArea).toHaveValue('claude-sonnet\n')

    // The fresh line accepts a manually typed id.
    fireEvent.change(modelsArea, { target: { value: 'claude-sonnet\nclaude-opus' } })
    expect(modelsArea).toHaveValue('claude-sonnet\nclaude-opus')
  })

  it('normalizes the models list on blur and persists manually added ids', async () => {
    const api = installApi()
    const { container } = renderModal()

    const modelsArea = screen.getAllByPlaceholderText('one model id per line')[0] // anthropic
    fireEvent.focus(modelsArea)
    // A second id typed with surrounding whitespace and a trailing blank line.
    fireEvent.change(modelsArea, { target: { value: 'claude-sonnet\n  claude-opus  \n' } })
    fireEvent.blur(modelsArea)

    // Blur trims each line and drops the empty one — without fighting the typing.
    expect(modelsArea).toHaveValue('claude-sonnet\nclaude-opus')

    // Saving persists both ids for the anthropic provider.
    fireEvent.click(within(container.querySelector('.modal__foot')!).getByText('Save'))
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
    const saved = api.saveSettings.mock.calls.at(-1)?.[0] as AppSettings
    const provider = saved.providers.find((p) => p.id === 'anthropic')!
    expect(provider.models.map((m) => m.id)).toEqual(['claude-sonnet', 'claude-opus'])
  })

  it('keeps an incomplete header line while typing and parses it on blur', async () => {
    const api = installApi()
    const { container } = renderModal()

    // Custom headers is shown for the openai-compatible custom endpoint.
    const headersArea = screen.getByPlaceholderText('one per line (e.g. HTTP-Referer: https://myapp)')
    expect(headersArea).toHaveValue('')

    fireEvent.focus(headersArea)
    // Typing the key before the colon must not make the line vanish — parsing on
    // every keystroke would drop it (no colon yet) and reset the field.
    fireEvent.change(headersArea, { target: { value: 'Authorization' } })
    expect(headersArea).toHaveValue('Authorization')
    // Finish the header and open a blank line for the next one.
    fireEvent.change(headersArea, { target: { value: 'Authorization: Bearer TOKEN\n' } })
    expect(headersArea).toHaveValue('Authorization: Bearer TOKEN\n')

    // Blur parses into a headers record and drops the incomplete/blank line.
    fireEvent.blur(headersArea)
    expect(headersArea).toHaveValue('Authorization: Bearer TOKEN')

    // Saving persists the parsed header for the custom endpoint.
    fireEvent.click(within(container.querySelector('.modal__foot')!).getByText('Save'))
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
    const saved = api.saveSettings.mock.calls.at(-1)?.[0] as AppSettings
    const provider = saved.providers.find((p) => p.id === 'custom-1234')!
    expect(provider.headers).toEqual({ Authorization: 'Bearer TOKEN' })
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

  it('warns before discarding unsaved edits, and discards only on confirm', () => {
    installApi()
    const { onClose } = renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Tools & Permissions' }))
    fireEvent.click(screen.getByRole('button', { name: '+ Add rule' })) // now dirty

    // Cancel while dirty asks to confirm instead of closing.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('Discard unsaved changes?')).toBeInTheDocument()

    // Keep editing dismisses the prompt without closing.
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()

    // Discard actually closes.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows a key-save failure inline instead of a blocking alert', async () => {
    const api = installApi({ setKey: vi.fn(() => Promise.reject(new Error('Keychain unavailable'))) })
    renderModal()

    fireEvent.change(screen.getByPlaceholderText('•••••••• (stored)'), {
      target: { value: 'sk-secret' }
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0])

    expect(await screen.findByRole('alert')).toHaveTextContent(/Keychain unavailable/)
    expect(api.saveSettings).not.toHaveBeenCalled()
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
    expect(document.querySelectorAll('.rule')).toHaveLength(1)
    const ruleRow = document.querySelector('.rule') as HTMLElement
    // The ✕ inside the rule row removes it.
    fireEvent.click(within(ruleRow).getByRole('button', { name: '✕' }))

    expect(document.querySelectorAll('.rule')).toHaveLength(0)
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

  it('signs a remote MCP server in via OAuth (saves first, then flips to Sign out)', async () => {
    const remote = {
      id: 'linear',
      name: 'linear',
      transport: 'http' as const,
      command: '',
      url: 'https://mcp.example.com/mcp',
      enabled: true
    }
    const signedIn = makeSettings({ mcpServers: [{ ...remote, hasOAuth: true }] })
    const mcpOAuthLogin = vi.fn(() => Promise.resolve({ ok: true, settings: signedIn }))
    const api = installApi({ mcpOAuthLogin })
    renderModal({ mcpServers: [remote] })
    fireEvent.click(screen.getByRole('button', { name: 'Tools & Permissions' }))

    fireEvent.click(screen.getByRole('button', { name: 'Sign in (OAuth)' }))

    // The flow reads the persisted URL, so the working copy is saved first.
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
    await waitFor(() => expect(mcpOAuthLogin).toHaveBeenCalledWith('linear'))
    // The fresh hasOAuth flag flips the affordance to signed-in + Sign out.
    await waitFor(() => expect(screen.getByText('Signed in with OAuth')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('signs a remote MCP server out (mcpOAuthLogout, flag cleared)', async () => {
    const remote = {
      id: 'linear',
      name: 'linear',
      transport: 'http' as const,
      command: '',
      url: 'https://mcp.example.com/mcp',
      hasOAuth: true,
      enabled: true
    }
    const signedOut = makeSettings({ mcpServers: [{ ...remote, hasOAuth: false }] })
    const mcpOAuthLogout = vi.fn(() => Promise.resolve(signedOut))
    installApi({ mcpOAuthLogout })
    renderModal({ mcpServers: [remote] })
    fireEvent.click(screen.getByRole('button', { name: 'Tools & Permissions' }))

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(mcpOAuthLogout).toHaveBeenCalledWith('linear'))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign in (OAuth)' })).toBeInTheDocument()
    )
  })

  it('shows live MCP connection status from getMcpStatuses', async () => {
    const remote = {
      id: 'linear',
      name: 'linear',
      transport: 'http' as const,
      command: '',
      url: 'https://mcp.example.com/mcp',
      enabled: true
    }
    installApi({
      getMcpStatuses: vi.fn(() =>
        Promise.resolve([{ id: 'linear', state: 'needs-auth', error: 'HTTP 401' }])
      )
    })
    renderModal({ mcpServers: [remote] })
    fireEvent.click(screen.getByRole('button', { name: 'Tools & Permissions' }))
    await waitFor(() => expect(screen.getByText('Needs sign-in')).toBeInTheDocument())
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

  describe('sandbox egress', () => {
    it('defaults to allowlist mode with editable allow/deny domain lists', () => {
      installApi()
      renderModal()
      fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))

      expect(screen.getByRole('heading', { name: 'Sandbox egress' })).toBeInTheDocument()
      const mode = screen.getByLabelText(/^Mode/) as HTMLSelectElement
      expect(mode.value).toBe('allowlist')
      expect(screen.getByLabelText(/Additional allowed domains/)).toBeInTheDocument()
      expect(screen.getByLabelText(/Denied domains/)).toBeInTheDocument()
    })

    it('edits the allow list (one domain per line, normalized on blur) and saves it', async () => {
      const api = installApi()
      renderModal({ sandboxEgress: { allow: ['corp.example'] } })
      fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))

      const allow = screen.getByLabelText(/Additional allowed domains/) as HTMLTextAreaElement
      expect(allow.value).toBe('corp.example')
      fireEvent.focus(allow)
      fireEvent.change(allow, { target: { value: 'corp.example\n  other.example  \n\n' } })
      fireEvent.blur(allow)
      expect(allow.value).toBe('corp.example\nother.example')

      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
      const saved = api.saveSettings.mock.calls.at(-1)![0] as AppSettings
      expect(saved.sandboxEgress?.allow).toEqual(['corp.example', 'other.example'])
    })

    it("switching to 'All domains' hides the lists and persists the explicit escape hatch", async () => {
      const api = installApi()
      renderModal()
      fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))

      fireEvent.change(screen.getByLabelText(/^Mode/), { target: { value: 'all' } })
      expect(screen.queryByLabelText(/Additional allowed domains/)).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
      const saved = api.saveSettings.mock.calls.at(-1)![0] as AppSettings
      expect(saved.sandboxEgress?.mode).toBe('all')
    })
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
