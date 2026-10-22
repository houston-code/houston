import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, ProviderConfig } from '@shared/types'
import { SettingsModal } from './SettingsModal'

/** The settings main would return: set by renderModal, updated by saveSettings. */
let stored: AppSettings

/**
 * Install a fake `window.api` with only the methods SettingsModal touches. Each
 * mutating call (setKey/deleteKey/listModels) is preceded by a saveSettings, so
 * saveSettings resolves to the settings it was handed back (the "fresh" result).
 */
function installApi(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  const saveSettings = vi.fn((s: AppSettings) => {
    stored = s
    return Promise.resolve(s)
  })
  // What main holds: what the modal opened on, then whatever it last saved.
  const getSettings = vi.fn(() => Promise.resolve(stored))
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
  const getPermissionPolicy = vi.fn(() => Promise.resolve({ managed: [], project: null }))
  const getRuleUsage = vi.fn(() => Promise.resolve({}))
  const exportSettingsFile = vi.fn(() => Promise.resolve(null))
  const importSettingsFile = vi.fn(() => Promise.resolve(null))
  const testPermission = vi.fn(() => Promise.resolve({ decision: null, tier: null, userMatches: [] }))
  const api = {
    saveSettings,
    getSettings,
    setKey,
    deleteKey,
    listModels,
    pickDirectory,
    getVersion,
    checkForUpdates,
    getIntegrations,
    cleanupPermissionRules,
    getMcpStatuses,
    getPermissionPolicy,
    getRuleUsage,
    testPermission,
    exportSettingsFile,
    importSettingsFile,
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
  stored = makeSettings(over)
  const utils = render(<SettingsModal initial={stored} onClose={onClose} onSaved={onSaved} {...props} />)
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
  })

  it('marks the open section in a labelled nav', () => {
    installApi()
    renderModal()
    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    const current = (): string[] =>
      within(nav)
        .getAllByRole('button')
        .filter((b) => b.getAttribute('aria-current') === 'page')
        .map((b) => b.textContent?.trim() ?? '')
    expect(current()).toEqual(['Providers & Models'])
    fireEvent.click(within(nav).getByRole('button', { name: 'Keyboard' }))
    expect(current()).toEqual(['Keyboard'])
  })

  it('groups the nav under headings, with Permissions right after Keyboard and About last', () => {
    installApi()
    renderModal()
    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    const labels = within(nav)
      .getAllByRole('button')
      .map((b) => b.textContent?.trim())
    expect(labels).toEqual([
      'Providers & Models',
      'Agent Behavior',
      'Tools',
      'MCP Servers',
      'Hooks',
      'Workspace',
      'General',
      'Appearance',
      'Keyboard',
      'Permissions',
      'About'
    ])
    // Group headings, except where a one-page group is named like its page.
    expect([...nav.querySelectorAll('.set-nav__heading')].map((h) => h.textContent)).toEqual([
      'AI',
      'App',
      'Security'
    ])
  })

  it('shows the legal links on About', () => {
    installApi()
    renderModal()
    expect(screen.queryByRole('link', { name: 'Privacy' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'About' }))
    expect(screen.getByRole('link', { name: 'Privacy' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'License (Apache-2.0)' })).toBeInTheDocument()
  })

  it('opens diagnostics from About when a handler is given', () => {
    installApi()
    const onShowDoctor = vi.fn()
    renderModal({}, { onShowDoctor })
    fireEvent.click(screen.getByRole('button', { name: 'About' }))
    fireEvent.click(screen.getByRole('button', { name: 'Run diagnostics' }))
    expect(onShowDoctor).toHaveBeenCalledTimes(1)
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

  it('puts permissions on their own page, apart from tools and MCP', () => {
    installApi()
    renderModal()

    // Nothing from Permissions is present until the page is selected.
    expect(screen.queryByRole('heading', { name: 'Permissions' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    for (const h of ['Approval mode', 'Web reads in full auto', 'Permissions', 'Trusted folders', 'Sandbox egress']) {
      expect(screen.getByRole('heading', { name: h })).toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: '+ Add rule' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'MCP servers' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Tools' }))
    expect(screen.getByRole('heading', { name: 'Web search' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Permissions' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'MCP Servers' }))
    expect(screen.getByRole('heading', { name: 'MCP servers' })).toBeInTheDocument()
  })

  it('sets the approval mode new chats start in', async () => {
    const api = installApi()
    renderModal({ approvalPolicy: 'ask' })
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    const group = screen.getByRole('radiogroup', { name: 'Default approval mode' })
    expect(within(group).getByRole('radio', { name: /Ask every time/ })).toBeChecked()
    fireEvent.click(within(group).getByRole('radio', { name: /Auto-approve edits/ }))
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
    expect((api.saveSettings.mock.calls.at(-1)![0] as AppSettings).approvalPolicy).toBe('auto-edit')
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
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }))

    expect(screen.getByRole('heading', { name: 'Optional integrations' })).toBeInTheDocument()
    // gh is absent → warn status + an enable hint linking to the install page.
    await waitFor(() => expect(screen.getByText('Not found')).toBeInTheDocument())
    expect(screen.getByText('cli.github.com')).toBeInTheDocument()
    // Formatter rollup reflects the injected statuses (1 of 2 found).
    expect(screen.getByText('1 of 2 found')).toBeInTheDocument()
  })

  it('says formatters need Git for Windows when the shell is the cmd.exe fallback', async () => {
    installApi({
      getIntegrations: vi.fn(() =>
        Promise.resolve({
          gh: { installed: true, authenticated: true },
          formatters: [{ bin: 'prettier', installed: false, languages: ['ts'] }],
          formattersNeedGitBash: true
        })
      )
    })
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }))

    await waitFor(() => expect(screen.getByText('Needs Git for Windows')).toBeInTheDocument())
    expect(screen.getByRole('link', { name: 'gitforwindows.org' })).toHaveAttribute(
      'href',
      'https://gitforwindows.org'
    )
    // The per-formatter list (all ✗ here) would mislead, so it's replaced.
    expect(screen.queryByText(/of 1 found/)).not.toBeInTheDocument()
  })

  it('reports gh as signed in when installed and authenticated', async () => {
    installApi({
      getIntegrations: vi.fn(() =>
        Promise.resolve({ gh: { installed: true, authenticated: true }, formatters: [] })
      )
    })
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }))

    await waitFor(() => expect(screen.getByText('Installed & signed in')).toBeInTheDocument())
    // No enable hint when it's already usable.
    expect(screen.queryByText('cli.github.com')).not.toBeInTheDocument()
  })

  it('sets whether web reads ask in full auto, asking once per site by default', async () => {
    const api = installApi()
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    const select = screen.getByLabelText('Web reads') as HTMLSelectElement
    expect(select.value).toBe('ask')
    fireEvent.change(select, { target: { value: 'allow' } })
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
    expect((api.saveSettings.mock.calls.at(-1)![0] as AppSettings).webReads).toBe('allow')
  })

  it('adds a permission rule when "+ Add rule" is clicked', () => {
    installApi()
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))

    // The rule-row count proves the click mutated state: 0 rows before, exactly 1 after.
    expect(document.querySelectorAll('.rule')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '+ Add rule' }))
    expect(document.querySelectorAll('.rule')).toHaveLength(1)

    // The new rule is a run_shell rule, last in the list, and defaults to the safe
    // 'ask' action.
    expect(screen.getByRole('combobox', { name: 'Rule 1 tool' })).toHaveValue('run_shell')
    expect(screen.getByDisplayValue('Ask')).toBeInTheDocument()

    // By tool, it lands in a run_shell group whose header names the tool.
    fireEvent.click(screen.getByRole('button', { name: 'By tool' }))
    expect(document.querySelector('.rule-group__tool')?.textContent).toBe('run_shell')
    expect(screen.queryByRole('combobox', { name: 'Rule 1 tool' })).toBeNull()
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
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    fireEvent.click(screen.getByRole('button', { name: 'By tool' }))

    // Two tool groups (run_shell with 2, web_fetch with 1); three rows total.
    const groups = [...document.querySelectorAll('.rule-group__tool')].map((n) => n.textContent)
    expect(groups).toEqual(['run_shell', 'web_fetch'])
    expect(document.querySelectorAll('.rule')).toHaveLength(3)

    // Filtering by "git" narrows to the single matching rule.
    fireEvent.change(screen.getByPlaceholderText('Filter rules…'), { target: { value: 'git' } })
    expect(document.querySelectorAll('.rule')).toHaveLength(1)
    expect(screen.getByDisplayValue('git status')).toBeInTheDocument()
  })

  describe('settings search', () => {
    const search = (): HTMLInputElement => screen.getByRole('searchbox', { name: 'Search settings' }) as HTMLInputElement
    const type = (q: string): void => {
      fireEvent.change(search(), { target: { value: q } })
    }
    const visibleHeadings = (): string[] =>
      [...document.querySelectorAll<HTMLElement>('.set-section h3')]
        .filter((h) => !h.closest('[hidden]'))
        .map((h) => h.textContent ?? '')
    const resultPages = (): string[] =>
      [...document.querySelectorAll<HTMLElement>('.set-results__page')]
        .filter((p) => !p.hidden)
        .map((p) => p.getAttribute('aria-label') ?? '')

    it('focuses the search box when Settings opens', async () => {
      installApi()
      renderModal()
      await waitFor(() => expect(document.activeElement).toBe(search()))
    })

    it('finds a section by a synonym and lists it under its page, across pages', () => {
      installApi()
      renderModal()
      type('proxy')
      expect(visibleHeadings()).toEqual(['Sandbox egress'])
      expect(resultPages()).toEqual(['Permissions'])
      // The current page is replaced by the results: its sections are hidden.
      expect(screen.getByText('My Local').closest('[hidden]')).not.toBeNull()
      expect(screen.getByText('1 result')).toBeInTheDocument()
    })

    it('finds sections by their own text, needing every word', () => {
      installApi()
      renderModal()
      type('format save')
      expect(visibleHeadings()).toContain('Format on save')
      expect(visibleHeadings()).not.toContain('Appearance')
    })

    it("finds the user's own values: a rule pattern, a model id, an MCP server", () => {
      installApi()
      renderModal({
        permissionRules: [{ action: 'deny', tool: 'run_shell', match: 'deploy-prod *' }],
        mcpServers: [{ id: 'linearbot', command: 'npx', args: [], enabled: true }]
      })
      type('deploy-prod')
      expect(visibleHeadings()).toEqual(['Permissions'])
      type('claude-sonnet')
      expect(visibleHeadings()).toEqual(['Providers & models'])
      type('linearbot')
      expect(visibleHeadings()).toEqual(['MCP servers'])
    })

    it('counts matches per page in the nav and dims pages with none', () => {
      installApi()
      renderModal()
      type('api key')
      const nav = screen.getByRole('navigation', { name: 'Settings sections' })
      const models = within(nav).getByRole('button', { name: /Providers & Models/ })
      expect(within(models).getByLabelText(/match/)).toBeInTheDocument()
      expect(within(nav).getByRole('button', { name: /^Keyboard/ })).toHaveClass('is-dim')
      expect(within(nav).queryAllByRole('button').some((b) => b.getAttribute('aria-current') === 'page')).toBe(false)
    })

    it('says so when nothing matches', () => {
      installApi()
      renderModal()
      type('zzqx')
      expect(screen.getByText('No settings match “zzqx”.')).toBeInTheDocument()
      expect(screen.getByText('0 results')).toBeInTheDocument()
    })

    it('keeps the results live: a setting edited in the results is saved', async () => {
      const api = installApi()
      renderModal({ formatOnSave: false })
      type('format on save')
      fireEvent.click(screen.getByRole('checkbox', { name: /run the matching formatter/i }))
      await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
      expect((api.saveSettings.mock.calls.at(-1)![0] as AppSettings).formatOnSave).toBe(true)
    })

    it("jumps to a result's page from its heading, clearing the search", () => {
      installApi()
      renderModal()
      type('proxy')
      const heading = document.querySelector('.set-results__page:not([hidden]) .set-results__title') as HTMLElement
      fireEvent.click(within(heading).getByRole('button', { name: 'Permissions' }))
      expect(search().value).toBe('')
      expect(screen.getByRole('heading', { name: 'Approval mode' })).toBeInTheDocument()
    })

    it('clears a non-empty search on Escape instead of closing', () => {
      installApi()
      const { onClose } = renderModal()
      type('theme')
      fireEvent.keyDown(search(), { key: 'Escape' })
      expect(search().value).toBe('')
      expect(onClose).not.toHaveBeenCalled()
      // A second Escape, with the box empty, closes as usual.
      fireEvent.keyDown(search(), { key: 'Escape' })
      expect(onClose).toHaveBeenCalled()
    })

    it('focuses the search box on Mod+F from anywhere in Settings', () => {
      installApi()
      renderModal()
      const other = screen.getByRole('button', { name: 'Keyboard' })
      other.focus()
      fireEvent.keyDown(other, { key: 'f', metaKey: true, ctrlKey: true })
      expect(document.activeElement).toBe(search())
    })

    it('opens with a query already typed', () => {
      installApi()
      renderModal({}, { initialQuery: 'notifications' })
      expect(search().value).toBe('notifications')
      expect(visibleHeadings()).toEqual(['Notifications'])
    })
  })

  describe('admin and project rules', () => {
    const policy = {
      managed: [{ action: 'deny' as const, tool: '*', match: 'curl *' }],
      project: {
        rules: [{ action: 'ask' as const, tool: 'run_shell', match: 'git push*' }],
        allowRules: [{ action: 'allow' as const, tool: 'run_shell', match: 'npm test' }],
        hooks: [{ event: 'PostToolUse' as const, matcher: 'edit_file', command: 'npm run fmt' }],
        mcpServers: [{ id: 'db', transport: 'stdio' as const, target: 'npx db-mcp' }],
        trust: 'undecided' as const
      }
    }

    it('asks main for the open project and lists every tier in the order checked', async () => {
      const getPermissionPolicy = vi.fn(() => Promise.resolve(policy))
      installApi({ getPermissionPolicy })
      renderModal({ permissionRules: [{ action: 'allow', tool: 'run_shell', match: 'git status' }] }, { workspace: '/repo' })
      expect(getPermissionPolicy).toHaveBeenCalledWith('/repo')
      fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
      fireEvent.click(await screen.findByRole('button', { name: 'All sources' }))
      const tiers = [...document.querySelectorAll('.rule-tier__title')].map((t) => t.textContent)
      expect(tiers).toEqual([
        'Administrator policy',
        "This project's guardrails",
        'Your rules',
        "This project's allow rules",
        "Then the chat's approval mode"
      ])
      expect(screen.getByText('curl *')).toBeInTheDocument()
      expect(screen.getByText('git push*')).toBeInTheDocument()
      expect(screen.getByText('Ignored until you trust this folder')).toBeInTheDocument()
      // Your own rules are summarized here, edited in the ordered view.
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
      expect(screen.getByDisplayValue('git status')).toBeInTheDocument()
    })

    it("shows the project's hooks and MCP servers read-only on their pages", async () => {
      installApi({ getPermissionPolicy: vi.fn(() => Promise.resolve({ ...policy, project: { ...policy.project, trust: 'trusted' as const } })) })
      renderModal({}, { workspace: '/repo' })
      fireEvent.click(screen.getByRole('button', { name: 'Hooks' }))
      expect(await screen.findByRole('heading', { name: "This project's hooks" })).toBeInTheDocument()
      expect(screen.getByText('npm run fmt')).toBeInTheDocument()
      expect(screen.getByText('In effect: you trust this folder')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'MCP Servers' }))
      expect(screen.getByRole('heading', { name: "This project's MCP servers" })).toBeInTheDocument()
      expect(screen.getByText('npx db-mcp')).toBeInTheDocument()
    })

    it('offers no All sources view or project sections when nothing else applies', async () => {
      const getPermissionPolicy = vi.fn(() => Promise.resolve({ managed: [], project: null }))
      installApi({ getPermissionPolicy })
      renderModal()
      await waitFor(() => expect(getPermissionPolicy).toHaveBeenCalledWith(null))
      fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
      expect(screen.queryByRole('button', { name: 'All sources' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Hooks' }))
      expect(screen.queryByRole('heading', { name: "This project's hooks" })).toBeNull()
    })
  })

  describe('rule history and tester', () => {
    it('shows when a rule was added and last used', async () => {
      const day = 24 * 60 * 60 * 1000
      const rule = { action: 'allow' as const, tool: 'run_shell', match: 'git *', addedAt: Date.now() - 3 * day, source: 'prompt' as const }
      installApi({
        getRuleUsage: vi.fn(() => Promise.resolve({ ['allow\u0000run_shell\u0000git *\u0000']: Date.now() - 1.5 * day }))
      })
      renderModal({ permissionRules: [rule] })
      fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
      expect(await screen.findByText('Added 3 days ago from an approval prompt · last used yesterday')).toBeInTheDocument()
    })

    it('stamps a rule added in Settings', async () => {
      const api = installApi()
      renderModal()
      fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
      fireEvent.click(screen.getByRole('button', { name: '+ Add rule' }))
      expect(screen.getByText('Added today in Settings · not used yet')).toBeInTheDocument()
      await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
      const saved = (api.saveSettings.mock.calls.at(-1)![0] as AppSettings).permissionRules
      expect(saved?.[0]).toMatchObject({ source: 'settings', addedAt: expect.any(Number) })
    })

    it('tests a call against the unsaved rules and highlights the rows that match', async () => {
      const testPermission = vi.fn(() => Promise.resolve({ decision: 'deny', tier: 'user', userMatches: [1] }))
      installApi({ testPermission })
      renderModal(
        {
          permissionRules: [
            { action: 'allow', tool: 'run_shell', match: 'git *' },
            { action: 'deny', tool: 'run_shell', match: 'rm *' }
          ]
        },
        { workspace: '/repo' }
      )
      fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
      // An unsaved edit is part of what gets tested.
      fireEvent.change(screen.getByDisplayValue('rm *'), { target: { value: 'rm -rf *' } })
      fireEvent.change(screen.getByRole('textbox', { name: 'Call to test' }), { target: { value: 'rm -rf build' } })
      await waitFor(() =>
        expect(testPermission).toHaveBeenCalledWith({
          workspace: '/repo',
          tool: 'run_shell',
          subject: 'rm -rf build',
          userRules: [
            { action: 'allow', tool: 'run_shell', match: 'git *' },
            { action: 'deny', tool: 'run_shell', match: 'rm -rf *' }
          ]
        })
      )
      expect(await screen.findByText('Deny, decided by your rule 2.')).toBeInTheDocument()
      const rows = document.querySelectorAll('.rule-row')
      expect(rows[1]).toHaveClass('rule-row--hit')
      expect(rows[0]).not.toHaveClass('rule-row--hit')
    })
  })

  describe('rules as text', () => {
    const rules = [
      { action: 'allow' as const, tool: 'run_shell', match: 'git *', addedAt: 7, source: 'prompt' as const },
      { action: 'deny' as const, tool: 'run_shell', match: 'rm *' }
    ]
    const editor = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Rules as JSON' }) as HTMLTextAreaElement
    const open = (): void => {
      fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
      fireEvent.click(screen.getByRole('button', { name: 'Edit as text' }))
    }

    it('shows the rules as JSON, one per line, without bookkeeping fields', () => {
      installApi()
      renderModal({ permissionRules: rules })
      open()
      expect(editor().value).toBe(
        '[\n  {"action":"allow","tool":"run_shell","match":"git *"},\n  {"action":"deny","tool":"run_shell","match":"rm *"}\n]\n'
      )
      expect(screen.getByText('No changes yet.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    })

    it('blocks Apply on invalid text and says where', () => {
      installApi()
      renderModal({ permissionRules: rules })
      open()
      fireEvent.change(editor(), { target: { value: '[\n  {"acton":"deny","tool":"*","match":"*"}\n]' } })
      expect(screen.getByRole('alert')).toHaveTextContent('Line 2: Rule 1 has an unknown field "acton".')
      expect(editor()).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    })

    it('summarizes and lints the edit, then applies it keeping each rule\'s history', async () => {
      const api = installApi()
      renderModal({ permissionRules: rules })
      open()
      fireEvent.change(editor(), {
        target: {
          value:
            '[{"action":"allow","tool":"run_shell","match":"*"},{"action":"deny","tool":"run_shell","match":"rm *"},{"action":"allow","tool":"run_shell","match":"git *"}]'
        }
      })
      expect(screen.getByText('Applying adds 1 rule and changes the order.')).toBeInTheDocument()
      expect(screen.getByText(/Rule 2: Never applies: rule 1/)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
      // Back to the list, in the new order.
      expect([...document.querySelectorAll<HTMLInputElement>('.rule__match')].map((i) => i.value)).toEqual(['*', 'rm *', 'git *'])
      await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
      const saved = (api.saveSettings.mock.calls.at(-1)![0] as AppSettings).permissionRules
      expect(saved?.[0]).toMatchObject({ match: '*', source: 'settings', addedAt: expect.any(Number) })
      expect(saved?.[1]).toEqual({ action: 'deny', tool: 'run_shell', match: 'rm *' })
      expect(saved?.[2]).toEqual({ action: 'allow', tool: 'run_shell', match: 'git *', addedAt: 7, source: 'prompt' })
    })

    it('leaves the rules alone on Cancel', () => {
      installApi()
      renderModal({ permissionRules: rules })
      open()
      fireEvent.change(editor(), { target: { value: '[]' } })
      fireEvent.click(within(document.querySelector('.rules-text') as HTMLElement).getByRole('button', { name: 'Cancel' }))
      expect(document.querySelectorAll('.rule-row')).toHaveLength(2)
    })
  })

  describe('rule order', () => {
    const ordered = [
      { action: 'allow' as const, tool: 'run_shell', match: '*' },
      { action: 'deny' as const, tool: 'run_shell', match: 'rm *' },
      { action: 'ask' as const, tool: 'web_fetch', match: 'https://a.example/*' }
    ]
    const patterns = (): string[] =>
      [...document.querySelectorAll<HTMLInputElement>('.rule__match')].map((i) => i.value)

    it('lists rules numbered in the order they are checked', () => {
      installApi()
      renderModal({ permissionRules: ordered })
      fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
      expect([...document.querySelectorAll('.rule__num')].map((n) => n.textContent)).toEqual(['1', '2', '3'])
      expect(patterns()).toEqual(['*', 'rm *', 'https://a.example/*'])
    })

    it('warns when an earlier rule means a later one never applies', () => {
      installApi()
      renderModal({ permissionRules: ordered })
      fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
      expect(screen.getByText('Never applies: rule 1 (allow run_shell *) matches first.')).toBeInTheDocument()
      expect(screen.getByText('Approves every run_shell call without asking.')).toBeInTheDocument()
      expect(screen.getByText('2 rules need attention.')).toBeInTheDocument()
    })

    it('moves a rule up and down, and the warning follows the new order', async () => {
      const api = installApi()
      renderModal({ permissionRules: ordered })
      fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
      expect(screen.getByRole('button', { name: 'Move rule 1 up' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Move rule 3 down' })).toBeDisabled()

      fireEvent.click(screen.getByRole('button', { name: 'Move rule 2 up' }))
      expect(patterns()).toEqual(['rm *', '*', 'https://a.example/*'])
      expect(screen.queryByText(/Never applies/)).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: 'Move rule 1 down' }))
      expect(patterns()).toEqual(['*', 'rm *', 'https://a.example/*'])
      fireEvent.click(screen.getByRole('button', { name: 'Move rule 2 up' }))

      await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
      const saved = api.saveSettings.mock.calls.at(-1)?.[0] as AppSettings
      expect(saved.permissionRules?.map((r) => r.match)).toEqual(['rm *', '*', 'https://a.example/*'])
    })

    it('reorders by dragging a rule onto another', () => {
      installApi()
      renderModal({ permissionRules: ordered })
      fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
      const handles = document.querySelectorAll('.rule__handle')
      const rows = document.querySelectorAll('.rule-row')
      fireEvent.dragStart(handles[2], { dataTransfer: { setData: vi.fn(), setDragImage: vi.fn() } })
      fireEvent.dragOver(rows[0])
      fireEvent.drop(rows[0])
      expect(patterns()).toEqual(['https://a.example/*', '*', 'rm *'])
    })

    it('turns reordering off while a filter hides rules, keeping the real numbers', () => {
      installApi()
      renderModal({ permissionRules: ordered })
      fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
      fireEvent.change(screen.getByPlaceholderText('Filter rules…'), { target: { value: 'rm' } })
      expect([...document.querySelectorAll('.rule__num')].map((n) => n.textContent)).toEqual(['2'])
      expect(screen.getByRole('button', { name: 'Move rule 2 up' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Move rule 2 down' })).toBeDisabled()
    })

    it('edits a rule\'s tool in the ordered view', () => {
      installApi()
      renderModal({ permissionRules: ordered })
      fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
      fireEvent.change(screen.getByRole('combobox', { name: 'Rule 2 tool' }), { target: { value: 'write_file' } })
      // No longer the same tool as rule 1, so nothing shadows it.
      expect(screen.queryByText(/Never applies/)).toBeNull()
    })
  })

  it('shows a rule\'s Exact flag and saves it when toggled, keeping it through edits', async () => {
    const api = installApi()
    renderModal({
      permissionRules: [
        { action: 'allow', tool: 'write_file', match: 'src', exact: true },
        { action: 'allow', tool: 'write_file', match: 'docs' }
      ]
    })
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    const boxes = screen.getAllByRole('checkbox', { name: 'Exact' }) as HTMLInputElement[]
    expect(boxes.map((b) => b.checked)).toEqual([true, false])

    // Editing the pattern keeps the flag; toggling flips it on the other rule.
    fireEvent.change(screen.getByDisplayValue('src'), { target: { value: 'src/a.ts' } })
    fireEvent.click(boxes[1])
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
    const saved = api.saveSettings.mock.calls.at(-1)?.[0] as AppSettings
    expect(saved.permissionRules).toEqual([
      { action: 'allow', tool: 'write_file', match: 'src/a.ts', exact: true },
      { action: 'allow', tool: 'write_file', match: 'docs', exact: true }
    ])
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
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    expect(document.querySelectorAll('.rule')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Clean up rules' }))
    await waitFor(() => expect(cleanupPermissionRules).toHaveBeenCalledOnce())
    // The two exact commands collapse to the single generalized rule the helper returns.
    await waitFor(() => expect(document.querySelectorAll('.rule')).toHaveLength(1))
    expect(screen.getByDisplayValue('npm install')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Removed 1 redundant rule.')
  })

  it('says so when "Clean up rules" finds nothing to change', async () => {
    const rules = [{ action: 'allow' as const, tool: 'run_shell', match: 'npm install' }]
    installApi({ cleanupPermissionRules: vi.fn(() => Promise.resolve(rules)) })
    renderModal({ permissionRules: rules })
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clean up rules' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Rules are already tidy.'))
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

  it('offers a restart when the key cannot be saved because the Keychain is unusable', async () => {
    installApi({
      setKey: vi.fn(() => Promise.reject(new Error('secure store unavailable'))),
      getSecureStorageStatus: vi.fn(() => Promise.resolve({ available: false, platform: 'darwin' })),
      relaunchApp: vi.fn(() => Promise.resolve(true))
    })
    renderModal()
    fireEvent.change(screen.getByPlaceholderText('•••••••• (stored)'), { target: { value: 'sk-secret' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0])
    expect(await screen.findByRole('button', { name: 'Restart Houston' })).toBeInTheDocument()
    expect(screen.getByText(/choose Always Allow/)).toBeInTheDocument()
    expect(screen.queryByText(/Could not save API key/)).not.toBeInTheDocument()
  })

  it('shows the plain error when the save failed for another reason', async () => {
    installApi({
      setKey: vi.fn(() => Promise.reject(new Error('disk full'))),
      getSecureStorageStatus: vi.fn(() => Promise.resolve({ available: true, platform: 'darwin' }))
    })
    renderModal()
    fireEvent.change(screen.getByPlaceholderText('•••••••• (stored)'), { target: { value: 'sk-secret' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0])
    expect(await screen.findByText('Could not save API key: disk full')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restart Houston' })).not.toBeInTheDocument()
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

  it('summarizes what a fetch changed, and flags models this version does not recognize', async () => {
    const api = installApi()
    api.listModels.mockResolvedValueOnce([{ id: 'claude-opus-5-5' }, { id: 'claude-zeta-9' }])
    renderModal()
    fireEvent.click(screen.getAllByText('fetch from provider')[0]) // anthropic, which had claude-sonnet
    const note = await screen.findByRole('status')
    expect(note).toHaveTextContent('Fetched 2 models: 2 new, 1 no longer listed.')
    expect(note).toHaveTextContent('New: claude-opus-5-5, claude-zeta-9.')
    expect(note).toHaveTextContent('Removed (no longer listed): claude-sonnet.')
    expect(note).toHaveTextContent("doesn't fully recognize claude-zeta-9")
    expect(note.textContent).not.toContain('\u2014')
  })

  it('says so when a fetch changed nothing, and keeps the note until the list is edited', async () => {
    const api = installApi()
    api.listModels.mockResolvedValueOnce([{ id: 'claude-sonnet' }])
    renderModal()
    fireEvent.click(screen.getAllByText('fetch from provider')[0])
    expect(await screen.findByRole('status')).toHaveTextContent('Fetched 1 model. No changes.')
    const area = screen.getAllByPlaceholderText('one model id per line')[0]
    // Tabbing through the field changes nothing, so the note stays.
    fireEvent.focus(area)
    fireEvent.blur(area)
    expect(screen.getByRole('status')).toBeInTheDocument()
    // A real edit makes it stale.
    fireEvent.focus(area)
    fireEvent.change(area, { target: { value: 'claude-sonnet\nclaude-opus' } })
    fireEvent.blur(area)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
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
    renderModal()

    const modelsArea = screen.getAllByPlaceholderText('one model id per line')[0] // anthropic
    fireEvent.focus(modelsArea)
    // A second id typed with surrounding whitespace and a trailing blank line.
    fireEvent.change(modelsArea, { target: { value: 'claude-sonnet\n  claude-opus  \n' } })
    fireEvent.blur(modelsArea)

    // Blur trims each line and drops the empty one — without fighting the typing.
    expect(modelsArea).toHaveValue('claude-sonnet\nclaude-opus')

    // Saving persists both ids for the anthropic provider.
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
    const saved = api.saveSettings.mock.calls.at(-1)?.[0] as AppSettings
    const provider = saved.providers.find((p) => p.id === 'anthropic')!
    expect(provider.models.map((m) => m.id)).toEqual(['claude-sonnet', 'claude-opus'])
  })

  it('keeps capability metadata and the added date for ids that survive an edit', async () => {
    const api = installApi()
    const withMeta: ProviderConfig = {
      ...anthropic,
      models: [{ id: 'claude-sonnet', caps: { tools: true, contextWindow: 1_000_000 }, addedAt: '2026-10-10' }]
    }
    renderModal({ providers: [withMeta, customEndpoint] })
    const modelsArea = screen.getAllByPlaceholderText('one model id per line')[0]
    fireEvent.focus(modelsArea)
    fireEvent.change(modelsArea, { target: { value: 'claude-sonnet\nclaude-opus' } })
    fireEvent.blur(modelsArea)
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
    const saved = (api.saveSettings.mock.calls.at(-1)?.[0] as AppSettings).providers.find((p) => p.id === 'anthropic')!
    expect(saved.models).toEqual([
      { id: 'claude-sonnet', caps: { tools: true, contextWindow: 1_000_000 }, addedAt: '2026-10-10' },
      { id: 'claude-opus' }
    ])
  })

  it('keeps an incomplete header line while typing and parses it on blur', async () => {
    const api = installApi()
    renderModal()

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
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
    const saved = api.saveSettings.mock.calls.at(-1)?.[0] as AppSettings
    const provider = saved.providers.find((p) => p.id === 'custom-1234')!
    expect(provider.headers).toEqual({ Authorization: 'Bearer TOKEN' })
  })

  describe('defaults, export, and import', () => {
    it('marks a section whose preferences differ from the defaults, and resets it', async () => {
      const api = installApi()
      renderModal({ reasoningSummary: 'detailed', verbosity: 'medium' }, { initialTab: 'agent' })
      const reset = screen.getByRole('button', { name: 'Reset Reasoning to defaults' })
      expect(screen.getAllByText('Modified')).toHaveLength(1)
      fireEvent.click(reset)
      expect(screen.queryByText('Modified')).toBeNull()
      await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
      const saved = api.saveSettings.mock.calls.at(-1)![0] as AppSettings
      expect(saved).not.toHaveProperty('reasoningSummary')
      expect(saved).not.toHaveProperty('verbosity')
    })

    it('never marks the approval mode Modified, since its default depends on the machine', () => {
      installApi()
      renderModal({ approvalPolicy: 'full-auto' })
      fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
      expect(screen.queryByRole('button', { name: 'Reset Approval mode to defaults' })).toBeNull()
    })

    it('exports only preferences to the file the user picks', async () => {
      const exportSettingsFile = vi.fn(() => Promise.resolve('/tmp/houston-settings.json'))
      installApi({ exportSettingsFile })
      renderModal({ theme: 'dark', additionalRoots: ['/private/place'] })
      fireEvent.click(screen.getByRole('button', { name: 'General' }))
      fireEvent.click(screen.getByRole('button', { name: 'Export…' }))
      expect(await screen.findByText('Exported to /tmp/houston-settings.json.')).toBeInTheDocument()
      const text = (exportSettingsFile.mock.calls[0] as unknown as [string])[0]
      expect(JSON.parse(text).settings.theme).toBe('dark')
      expect(text).not.toMatch(/private|providers/)
    })

    it('imports after a summary that calls out allow rules and hooks, and can be undone', async () => {
      const file = JSON.stringify({
        format: 'houston-settings',
        version: 1,
        settings: {
          theme: 'light',
          permissionRules: [{ action: 'allow', tool: 'run_shell', match: 'make *' }],
          hooks: [{ event: 'Stop', matcher: '*', command: 'make lint' }],
          providers: []
        }
      })
      const api = installApi({ importSettingsFile: vi.fn(() => Promise.resolve(file)) })
      renderModal({ theme: 'dark' })
      fireEvent.click(screen.getByRole('button', { name: 'General' }))
      fireEvent.click(screen.getByRole('button', { name: 'Import…' }))
      const panel = await screen.findByRole('group', { name: 'Confirm import' })
      expect(panel).toHaveTextContent('Import replaces your theme, permission rules, hooks.')
      expect(panel).toHaveTextContent('1 rule that allow calls without asking and 1 hook that runs shell commands')
      expect(panel).toHaveTextContent('Not imported (not preferences): providers.')
      expect(api.saveSettings).not.toHaveBeenCalled()
      fireEvent.click(within(panel).getByRole('button', { name: 'Import' }))
      await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
      const saved = api.saveSettings.mock.calls.at(-1)![0] as AppSettings
      expect(saved.theme).toBe('light')
      expect(saved.hooks).toEqual([{ event: 'Stop', matcher: '*', command: 'make lint' }])
      expect(await screen.findByRole('button', { name: 'Undo' })).toBeInTheDocument()
    })

    it('refuses a file that is not a valid export, changing nothing', async () => {
      const api = installApi({ importSettingsFile: vi.fn(() => Promise.resolve('{"theme":"dark"}')) })
      renderModal()
      fireEvent.click(screen.getByRole('button', { name: 'General' }))
      fireEvent.click(screen.getByRole('button', { name: 'Import…' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('This is not a Houston settings export.')
      expect(api.saveSettings).not.toHaveBeenCalled()
    })

    it('resets every preference after confirming, keeping rules and hooks', async () => {
      const api = installApi()
      const rules = [{ action: 'deny' as const, tool: '*', match: 'x' }]
      renderModal({ theme: 'dark', formatOnSave: true, permissionRules: rules })
      fireEvent.click(screen.getByRole('button', { name: 'General' }))
      fireEvent.click(screen.getByRole('button', { name: 'Reset preferences…' }))
      const panel = screen.getByRole('group', { name: 'Confirm reset' })
      fireEvent.click(within(panel).getByRole('button', { name: 'Reset' }))
      await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
      const saved = api.saveSettings.mock.calls.at(-1)![0] as AppSettings
      expect(saved).not.toHaveProperty('theme')
      expect(saved).not.toHaveProperty('formatOnSave')
      expect(saved.permissionRules).toEqual(rules)
    })
  })

  describe('saving as you go', () => {
    it('saves a toggle right away, as a patch over the stored settings, and reports it', async () => {
      const api = installApi()
      const { onSaved, onClose } = renderModal({ formatOnSave: false })
      // Something else changed the stored settings meanwhile (an "Always allow" rule).
      const rule = { action: 'allow' as const, tool: 'run_shell', match: 'npm test' }
      api.getSettings.mockResolvedValue(makeSettings({ formatOnSave: false, permissionRules: [rule] }))
      fireEvent.click(screen.getByRole('button', { name: 'Tools' }))
      fireEvent.click(screen.getByRole('checkbox', { name: /run the matching formatter/i }))
      await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1))
      const saved = api.saveSettings.mock.calls[0][0] as AppSettings
      expect(saved.formatOnSave).toBe(true)
      // The rule saved elsewhere survives: only what this panel changed is written.
      expect(saved.permissionRules).toEqual([rule])
      expect(onSaved).toHaveBeenCalledWith(saved)
      expect(await screen.findByText('Saved')).toBeInTheDocument()
      expect(onClose).not.toHaveBeenCalled()
    })

    it('waits for a text field to lose focus before saving it', async () => {
      const api = installApi()
      renderModal({}, { initialTab: 'agent' })
      const box = screen.getByPlaceholderText(/Extra instructions appended/)
      box.focus()
      fireEvent.change(box, { target: { value: 'be concise' } })
      expect(await screen.findByText('Not saved yet')).toBeInTheDocument()
      await new Promise((r) => setTimeout(r, 400))
      expect(api.saveSettings).not.toHaveBeenCalled()
      fireEvent.blur(box)
      box.blur()
      await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
      expect((api.saveSettings.mock.calls.at(-1)![0] as AppSettings).systemPromptExtra).toBe('be concise')
    })

    it('saves a removed setting as removed', async () => {
      const api = installApi()
      renderModal({ compactionThreshold: 50000 }, { initialTab: 'agent' })
      fireEvent.change(screen.getByDisplayValue('50000'), { target: { value: '' } })
      await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
      expect(api.saveSettings.mock.calls.at(-1)![0]).not.toHaveProperty('compactionThreshold')
    })

    it('undoes the last save once', async () => {
      const api = installApi()
      renderModal({ formatOnSave: false })
      fireEvent.click(screen.getByRole('button', { name: 'Tools' }))
      const box = screen.getByRole('checkbox', { name: /run the matching formatter/i })
      fireEvent.click(box)
      await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1))
      fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
      expect(box).not.toBeChecked()
      await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(2))
      expect((api.saveSettings.mock.calls[1][0] as AppSettings).formatOnSave).toBe(false)
      // Undoing an undo is not offered.
      await screen.findByText('Saved')
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    })

    it('saves what is pending when Settings closes, and closes without asking', async () => {
      const api = installApi()
      const { onClose, unmount } = renderModal({}, { initialTab: 'agent' })
      const box = screen.getByPlaceholderText(/Extra instructions appended/)
      box.focus()
      fireEvent.change(box, { target: { value: 'pending edit' } })
      fireEvent.click(screen.getByRole('button', { name: 'Close settings' }))
      expect(onClose).toHaveBeenCalledTimes(1)
      unmount()
      await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
      expect((api.saveSettings.mock.calls.at(-1)![0] as AppSettings).systemPromptExtra).toBe('pending edit')
    })

    it('shows a failed save in the footer', async () => {
      installApi({ saveSettings: vi.fn(() => Promise.reject(new Error('disk full'))) })
      renderModal({ formatOnSave: false })
      fireEvent.click(screen.getByRole('button', { name: 'Tools' }))
      fireEvent.click(screen.getByRole('checkbox', { name: /run the matching formatter/i }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not save settings: disk full')
      expect(screen.getByText('Not saved')).toBeInTheDocument()
    })
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

  it('caps the subagent history kept per chat, clamped to 0 to 1024 MB', async () => {
    const api = installApi()
    renderModal({}, { initialTab: 'agent' })
    const box = screen.getByLabelText(/Subagent history kept per chat/) as HTMLInputElement
    fireEvent.change(box, { target: { value: '5000' } })
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
    expect((api.saveSettings.mock.calls.at(-1)![0] as AppSettings).subagentHistoryMb).toBe(1024)
  })

  it('shows keep-going off for a previously chosen step cap, and on by default', () => {
    installApi()
    renderModal({ maxIterations: 25 }, { initialTab: 'agent' })
    expect(screen.getByRole('checkbox', { name: /keep going while the turn is making progress/i })).not.toBeChecked()
    cleanup()
    renderModal({}, { initialTab: 'agent' })
    expect(screen.getByRole('checkbox', { name: /keep going while the turn is making progress/i })).toBeChecked()
  })

  it('editing the step cap never silently turns keep-going off', () => {
    installApi()
    renderModal({}, { initialTab: 'agent' })
    const box = screen.getByRole('checkbox', { name: /keep going while the turn is making progress/i })
    expect(box).toBeChecked()
    fireEvent.change(screen.getByDisplayValue('40'), { target: { value: '60' } })
    expect(box).toBeChecked()
  })

  it('toggles a checkbox option (format on save) under the Tools tab', () => {
    installApi()
    const { onSaved } = renderModal({ formatOnSave: false })
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }))

    const checkbox = screen.getByRole('checkbox', { name: /run the matching formatter/i })
    expect(checkbox).not.toBeChecked()
    fireEvent.click(checkbox)
    expect(checkbox).toBeChecked()
    // The toggle is local state until the footer Save; onSaved hasn't fired yet.
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('picks the diagnostics-on-save mode under the Tools tab, unset reading as the language-server default', async () => {
    const api = installApi()
    renderModal({ diagnosticsOnSave: false })
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }))

    const select = screen.getByRole('combobox', { name: /after the agent writes a file/i })
    expect(select).toHaveValue('off')
    fireEvent.change(select, { target: { value: 'auto' } })
    expect(select).toHaveValue('auto')
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
    const saved = api.saveSettings.mock.calls.at(-1)![0] as AppSettings
    // The default is stored as unset, so a later default change still reaches this user.
    expect(saved.diagnosticsOnSave).toBeUndefined()
  })

  it('edits extra language servers as JSON and refuses an invalid list', async () => {
    const api = installApi()
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }))
    const box = screen.getByRole('textbox', { name: /extra language servers/i })
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: '[{"id": "lua"}]' } })
    fireEvent.blur(box)
    expect(screen.getByRole('alert')).toHaveTextContent(/"id", "command", and "extensions"/)
    fireEvent.focus(box)
    fireEvent.change(box, {
      target: { value: '[{"id": "lua", "command": "lua-language-server", "extensions": ["lua"]}]' }
    })
    fireEvent.blur(box)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: /run language servers/i }), { target: { value: 'off' } })
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
    const saved = api.saveSettings.mock.calls.at(-1)![0] as AppSettings
    expect(saved.lspServers).toEqual([{ id: 'lua', command: 'lua-language-server', extensions: ['lua'] }])
    expect(saved.lspEnabled).toBe(false)
  })

  it('shows which language servers are installed', async () => {
    installApi({
      getIntegrations: vi.fn(() =>
        Promise.resolve({
          gh: { installed: true, authenticated: true },
          formatters: [],
          languageServers: [
            { id: 'typescript', name: 'TypeScript', languages: ['ts'], path: '/usr/bin/tls', installHint: '', user: false },
            { id: 'go', name: 'Go', languages: ['go'], path: null, installHint: '', user: false }
          ]
        })
      )
    })
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }))
    expect(await screen.findByText('Language servers (code intelligence)')).toBeInTheDocument()
    expect(screen.getByText('1 of 2 found')).toBeInTheDocument()
  })

  it('removes a permission rule when its ✕ control is clicked', () => {
    installApi()
    renderModal({
      permissionRules: [{ action: 'deny', tool: 'run_shell', match: 'rm *' }]
    })
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))

    // Exactly one rule row to start.
    expect(document.querySelectorAll('.rule')).toHaveLength(1)
    const ruleRow = document.querySelector('.rule') as HTMLElement
    // The ✕ inside the rule row removes it.
    fireEvent.click(within(ruleRow).getByRole('button', { name: 'Remove rule 1' }))

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
    fireEvent.click(screen.getByRole('button', { name: 'MCP Servers' }))

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
    fireEvent.click(screen.getByRole('button', { name: 'MCP Servers' }))

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
    fireEvent.click(screen.getByRole('button', { name: 'MCP Servers' }))

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
    fireEvent.click(screen.getByRole('button', { name: 'MCP Servers' }))
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
      fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))

      expect(screen.getByRole('heading', { name: 'Sandbox egress' })).toBeInTheDocument()
      const mode = screen.getByLabelText(/^Mode/) as HTMLSelectElement
      expect(mode.value).toBe('allowlist')
      expect(screen.getByLabelText(/Additional allowed domains/)).toBeInTheDocument()
      expect(screen.getByLabelText(/Denied domains/)).toBeInTheDocument()
    })

    it('edits the allow list (one domain per line, normalized on blur) and saves it', async () => {
      const api = installApi()
      renderModal({ sandboxEgress: { allow: ['corp.example'] } })
      fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))

      const allow = screen.getByLabelText(/Additional allowed domains/) as HTMLTextAreaElement
      expect(allow.value).toBe('corp.example')
      fireEvent.focus(allow)
      fireEvent.change(allow, { target: { value: 'corp.example\n  other.example  \n\n' } })
      fireEvent.blur(allow)
      expect(allow.value).toBe('corp.example\nother.example')

      await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
      const saved = api.saveSettings.mock.calls.at(-1)![0] as AppSettings
      expect(saved.sandboxEgress?.allow).toEqual(['corp.example', 'other.example'])
    })

    it("switching to 'All domains' hides the lists and persists the explicit escape hatch", async () => {
      const api = installApi()
      renderModal()
      fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))

      fireEvent.change(screen.getByLabelText(/^Mode/), { target: { value: 'all' } })
      expect(screen.queryByLabelText(/Additional allowed domains/)).not.toBeInTheDocument()

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

      // Picking a new option applies immediately.
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'light' } })
      expect(document.documentElement.dataset.theme).toBe('light')
    })

    it('saves the chosen theme at once, and keeps it after closing', async () => {
      const api = installApi()
      const { onSaved, unmount } = renderModal({ theme: 'dark' })
      fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'light' } })

      // The choice is saved and propagated upward without a Save step.
      await waitFor(() => expect(onSaved).toHaveBeenCalled())
      expect((api.saveSettings.mock.calls.at(-1)?.[0] as AppSettings).theme).toBe('light')

      // The saved theme survives the close.
      unmount()
      expect(document.documentElement.dataset.theme).toBe('light')
    })
  })

  describe('updates tab', () => {
    it('has its own tab with the manual check, which reports the result', async () => {
      const api = installApi()
      renderModal()
      fireEvent.click(screen.getByRole('button', { name: 'About' }))
      // The page fetches and shows the installed version.
      expect(await screen.findByText('Houston 1.2.3')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
      await waitFor(() => expect(api.checkForUpdates).toHaveBeenCalled())
      expect(await screen.findByText('You’re on the latest version.')).toBeInTheDocument()
    })

    it('is no longer buried under Appearance', () => {
      installApi()
      renderModal()
      fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
      expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull()
    })
  })
})
