import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegistrySearchResult, RegistryServer } from '@shared/mcpRegistry'
import { McpAddPanels } from './mcpCatalog'

afterEach(cleanup)

// The registry is always a mocked search function here: no request leaves the test.

const weather: RegistryServer = {
  name: 'io.github.acme/weather',
  title: 'Weather',
  description: 'Forecasts <img src=x onerror=alert(1)>',
  version: '1.2.3',
  repositoryUrl: 'https://github.com/acme/weather',
  packages: [
    {
      registryType: 'npm',
      identifier: '@acme/weather-mcp',
      version: '1.2.3',
      transport: 'stdio',
      env: [{ kind: 'env', name: 'WEATHER_KEY', description: 'API key', required: true, secret: true }],
      packageArguments: [],
      runtimeArguments: []
    },
    {
      registryType: 'npm',
      identifier: '@acme/weather-next',
      version: 'latest',
      transport: 'stdio',
      env: [],
      packageArguments: [],
      runtimeArguments: []
    }
  ],
  remotes: [
    {
      type: 'streamable-http',
      url: 'https://mcp.acme.example/mcp',
      headers: [
        { kind: 'header', name: 'Authorization', description: 'Bearer token', required: true, secret: true, format: 'Bearer {key}' }
      ]
    }
  ]
}

const ok = (servers: RegistryServer[], nextCursor?: string): RegistrySearchResult => ({
  ok: true,
  page: { servers, ...(nextCursor ? { nextCursor } : {}) }
})

describe('McpAddPanels: Browse registry', () => {
  it('keeps the curated list as Recommended beside the registry', () => {
    render(<McpAddPanels servers={[]} workspace={null} onAdd={vi.fn()} searchRegistry={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Recommended' }))
    expect(screen.getByRole('list', { name: 'MCP server catalog' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Browse registry' }))
    expect(screen.queryByRole('list', { name: 'MCP server catalog' })).toBeNull()
    expect(screen.getByRole('searchbox', { name: 'Search the MCP Registry' })).toBeTruthy()
  })

  it('searches only when asked and shows each entry as text with its delivery and repository', async () => {
    const search = vi.fn(async () => ok([weather]))
    render(<McpAddPanels servers={[]} workspace={null} onAdd={vi.fn()} searchRegistry={search} />)
    fireEvent.click(screen.getByRole('button', { name: 'Browse registry' }))
    expect(search).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the MCP Registry' }), { target: { value: 'weather' } })
    fireEvent.submit(screen.getByRole('search'))
    await screen.findByRole('list', { name: 'MCP Registry results' })
    expect(search).toHaveBeenCalledWith('weather', undefined)
    expect(screen.getByText('Forecasts <img src=x onerror=alert(1)>')).toBeTruthy()
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText(/npm @acme\/weather-mcp 1\.2\.3 \(stdio\)/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'https://github.com/acme/weather' }).getAttribute('href')).toBe(
      'https://github.com/acme/weather'
    )
    expect(screen.getByText(/No exact version to pin/)).toBeTruthy()
  })

  it('reviews a package pinned and switched off, asking for its variable', async () => {
    const onAdd = vi.fn()
    render(
      <McpAddPanels
        servers={[{ id: 'weather', command: 'x', enabled: true }]}
        workspace={null}
        onAdd={onAdd}
        searchRegistry={async () => ok([weather])}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Browse registry' }))
    fireEvent.submit(screen.getByRole('search'))
    fireEvent.click(await screen.findByRole('button', { name: 'Review npm @acme/weather-mcp 1.2.3' }))
    expect((screen.getByLabelText('Id') as HTMLInputElement).value).toBe('weather-2')
    expect((screen.getByLabelText('Arguments, one per line') as HTMLTextAreaElement).value).toBe('-y\n@acme/weather-mcp@1.2.3')
    const key = screen.getByLabelText(/WEATHER_KEY/) as HTMLInputElement
    expect(key.type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    expect(screen.getByRole('alert').textContent).toBe('Fill in the WEATHER_KEY variable.')
    expect(onAdd).not.toHaveBeenCalled()
    fireEvent.change(key, { target: { value: 'k-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    expect(onAdd).toHaveBeenCalledWith([
      {
        id: 'weather-2',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@acme/weather-mcp@1.2.3'],
        env: { WEATHER_KEY: 'k-123' },
        enabled: false
      }
    ])
    expect(screen.getByRole('status').textContent).toMatch(/switched off/)
  })

  it('reviews a remote as an http server with its header to fill in', async () => {
    const onAdd = vi.fn()
    render(<McpAddPanels servers={[]} workspace={null} onAdd={onAdd} searchRegistry={async () => ok([weather])} />)
    fireEvent.click(screen.getByRole('button', { name: 'Browse registry' }))
    fireEvent.submit(screen.getByRole('search'))
    fireEvent.click(await screen.findByRole('button', { name: 'Review Remote HTTP https://mcp.acme.example/mcp' }))
    expect(screen.getByText(/Format: Bearer \{key\}/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/Authorization/), { target: { value: 'Bearer t' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    expect(onAdd).toHaveBeenCalledWith([
      {
        id: 'weather',
        transport: 'http',
        command: '',
        args: [],
        url: 'https://mcp.acme.example/mcp',
        headers: { Authorization: 'Bearer t' },
        enabled: false
      }
    ])
  })

  it('shows a search error, and pages with the cursor', async () => {
    const search = vi
      .fn<(q: string, c?: string) => Promise<RegistrySearchResult>>()
      .mockResolvedValueOnce({ ok: false, error: 'The registry did not answer in time. Try again.' })
      .mockResolvedValueOnce(ok([weather], 'c1'))
      .mockResolvedValueOnce(ok([{ ...weather, name: 'io.github.acme/other', title: 'Other' }]))
    render(<McpAddPanels servers={[]} workspace={null} onAdd={vi.fn()} searchRegistry={search} />)
    fireEvent.click(screen.getByRole('button', { name: 'Browse registry' }))
    fireEvent.submit(screen.getByRole('search'))
    expect((await screen.findByRole('alert')).textContent).toMatch(/did not answer in time/)
    fireEvent.submit(screen.getByRole('search'))
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }))
    await waitFor(() => expect(screen.getByText('Other')).toBeTruthy())
    expect(search).toHaveBeenLastCalledWith('', 'c1')
    expect(screen.getByText('Weather')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
  })
})
