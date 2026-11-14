import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServerConfig } from '@shared/types'
import { McpAddPanels } from './mcpCatalog'

afterEach(cleanup)

describe('McpAddPanels', () => {
  it('stays closed until asked', () => {
    render(<McpAddPanels servers={[]} workspace="/w" onAdd={vi.fn()} />)
    expect(screen.queryByRole('list', { name: 'MCP server catalog' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add from catalog' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('reviews a catalog entry prefilled for the project and adds it switched off', () => {
    const onAdd = vi.fn()
    render(<McpAddPanels servers={[]} workspace="/w/app" onAdd={onAdd} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add from catalog' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review Git' }))
    const form = screen.getByRole('form', { name: 'Review Git' })
    expect((screen.getByLabelText('Arguments, one per line') as HTMLTextAreaElement).value).toBe(
      'mcp-server-git\n--repository\n/w/app'
    )
    expect(document.activeElement).toBe(screen.getByLabelText('Id'))
    expect(onAdd).not.toHaveBeenCalled()
    fireEvent.submit(form)
    expect(onAdd).toHaveBeenCalledWith([
      { id: 'git', transport: 'stdio', command: 'uvx', args: ['mcp-server-git', '--repository', '/w/app'], enabled: false }
    ])
    expect(screen.getByRole('status').textContent).toMatch(/switched off/)
  })

  it('suggests a free id, switches on only when asked, and blocks an incomplete entry', () => {
    const onAdd = vi.fn()
    const servers: McpServerConfig[] = [{ id: 'filesystem', command: 'x', enabled: true }]
    render(<McpAddPanels servers={servers} workspace={null} onAdd={onAdd} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add from catalog' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review Filesystem' }))
    expect((screen.getByLabelText('Id') as HTMLInputElement).value).toBe('filesystem-2')
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    expect(screen.getByRole('alert').textContent).toBe('Replace {project} with a folder path.')
    expect(onAdd).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Arguments, one per line'), {
      target: { value: '-y\n@modelcontextprotocol/server-filesystem\n/home/me/notes' }
    })
    fireEvent.click(screen.getByRole('checkbox', { name: /Switch it on now/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    expect(onAdd.mock.calls[0][0][0]).toMatchObject({ id: 'filesystem-2', enabled: true, args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/me/notes'] })
  })

  it('lets an id with a dash or a space be typed, tidying it when the field is left', () => {
    const onAdd = vi.fn()
    render(<McpAddPanels servers={[]} workspace="/w/app" onAdd={onAdd} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add from catalog' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review Git' }))
    const id = screen.getByLabelText('Id') as HTMLInputElement
    fireEvent.change(id, { target: { value: 'my-' } })
    expect(id.value).toBe('my-')
    fireEvent.change(id, { target: { value: 'my git' } })
    fireEvent.blur(id)
    expect(id.value).toBe('my-git')
    fireEvent.submit(screen.getByRole('form', { name: 'Review Git' }))
    expect(onAdd.mock.calls[0][0][0]).toMatchObject({ id: 'my-git' })
  })

  it('takes Escape to cancel a review, then to close the panel', () => {
    const onDialogKey = vi.fn()
    render(
      <div onKeyDown={onDialogKey}>
        <McpAddPanels servers={[]} workspace="/w/app" onAdd={vi.fn()} />
      </div>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add from catalog' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review Git' }))
    fireEvent.keyDown(screen.getByLabelText('Id'), { key: 'Escape' })
    expect(screen.queryByRole('form', { name: 'Review Git' })).toBeNull()
    expect(screen.getByRole('list', { name: 'MCP server catalog' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Review Git' }), { key: 'Escape' })
    expect(screen.queryByRole('list', { name: 'MCP server catalog' })).toBeNull()
    expect(onDialogKey).not.toHaveBeenCalled()
    // Nothing left open: Escape goes on to the dialog.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Add from catalog' }), { key: 'Escape' })
    expect(onDialogKey).toHaveBeenCalledTimes(1)
  })

  it('reads pasted JSON, shows it, and adds the new servers switched off', () => {
    const onAdd = vi.fn()
    render(<McpAddPanels servers={[{ id: 'git', command: 'x', enabled: true }]} workspace={null} onAdd={onAdd} />)
    fireEvent.click(screen.getByRole('button', { name: 'Paste JSON' }))
    const box = screen.getByRole('textbox')
    fireEvent.change(box, {
      target: { value: JSON.stringify({ mcpServers: { git: { command: 'uvx' }, time: { command: 'uvx', args: ['mcp-server-time'], env: { TZ: 'UTC' } }, bad: {} } }) }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Read it' }))
    expect(screen.getByText('already configured, will be skipped')).toBeTruthy()
    expect(screen.getByText('Variables: TZ')).toBeTruthy()
    expect(screen.getByText('Not read: bad: needs a "command" or a "url"')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 switched off' }))
    expect(onAdd).toHaveBeenCalledWith([
      { id: 'time', transport: 'stdio', command: 'uvx', args: ['mcp-server-time'], env: { TZ: 'UTC' }, enabled: false }
    ])
    expect(screen.getByRole('status').textContent).toMatch(/Skipped git/)
  })

  it('reports text that is not JSON', () => {
    render(<McpAddPanels servers={[]} workspace={null} onAdd={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Paste JSON' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '{nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Read it' }))
    expect(screen.getByRole('alert').textContent).toMatch(/Not valid JSON/)
  })
})
