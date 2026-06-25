import { describe, expect, it } from 'vitest'
import type { DisplayItem, ToolItem } from './items'
import { describeTool, foldReadRuns, groupItems, shortenPath } from './toolDisplay'

function tool(name: string, args: Record<string, unknown>, id = name): ToolItem {
  return { kind: 'tool', id, name, args, status: 'done' }
}

describe('shortenPath', () => {
  it('keeps short paths intact', () => {
    expect(shortenPath('src/app.ts')).toBe('src/app.ts')
    expect(shortenPath('app.ts')).toBe('app.ts')
  })

  it('trims long paths to the last two segments', () => {
    expect(shortenPath('/Users/me/proj/src/main/agent/tools.ts')).toBe('…/agent/tools.ts')
  })
})

describe('describeTool', () => {
  it('describes file tools by path', () => {
    expect(describeTool(tool('read_file', { path: 'src/x.ts' }))).toEqual({
      verb: 'Read',
      target: 'src/x.ts',
      mono: true
    })
    expect(describeTool(tool('edit_file', { path: 'a/b/c/d.ts' })).verb).toBe('Edit')
  })

  it('describes a shell command on one line', () => {
    expect(describeTool(tool('run_shell', { command: 'npm run\n  test' }))).toEqual({
      verb: 'Run',
      target: 'npm run ⏎ test',
      mono: true
    })
  })

  it('describes a search with its location', () => {
    expect(describeTool(tool('search_files', { pattern: 'foo', path: 'src/lib' })).target).toBe(
      'foo in src/lib'
    )
  })

  it('describes a web search in prose (non-mono)', () => {
    expect(describeTool(tool('web_search', { query: 'rust async' }))).toEqual({
      verb: 'Search web',
      target: 'rust async',
      mono: false
    })
  })

  it('describes a localhost view by its URL', () => {
    expect(describeTool(tool('view_localhost', { url: 'http://localhost:3000' }))).toEqual({
      verb: 'View',
      target: 'http://localhost:3000',
      mono: true
    })
  })

  it('falls back to the tool name for unknown tools', () => {
    expect(describeTool(tool('mystery_tool', {})).verb).toBe('mystery_tool')
  })
})

describe('groupItems', () => {
  const user: DisplayItem = { kind: 'user', id: 'u1', text: 'hi' }
  const asst: DisplayItem = { kind: 'assistant', id: 'a1', text: 'ok', streaming: false }

  it('collapses consecutive tool items into one group', () => {
    const items: DisplayItem[] = [
      user,
      tool('read_file', { path: 'a' }, 't1'),
      tool('read_file', { path: 'b' }, 't2'),
      tool('run_shell', { command: 'ls' }, 't3'),
      asst
    ]
    const nodes = groupItems(items)
    expect(nodes.map((n) => n.kind)).toEqual(['user', 'toolgroup', 'assistant'])
    const group = nodes[1]
    expect(group.kind === 'toolgroup' && group.items).toHaveLength(3)
  })

  it('starts a new group when text interrupts tool calls', () => {
    const items: DisplayItem[] = [
      tool('read_file', { path: 'a' }, 't1'),
      asst,
      tool('read_file', { path: 'b' }, 't2')
    ]
    const nodes = groupItems(items)
    expect(nodes.map((n) => n.kind)).toEqual(['toolgroup', 'assistant', 'toolgroup'])
  })

  it('returns an empty list for no items', () => {
    expect(groupItems([])).toEqual([])
  })

  it('drops list_dir items but keeps the reads around them grouped', () => {
    const items: DisplayItem[] = [
      tool('list_dir', { path: '.' }, 'l1'),
      tool('read_file', { path: 'a' }, 't1'),
      tool('list_dir', { path: 'src' }, 'l2'),
      tool('read_file', { path: 'b' }, 't2')
    ]
    const nodes = groupItems(items)
    expect(nodes).toHaveLength(1)
    const group = nodes[0]
    expect(group.kind === 'toolgroup' && group.items.map((i) => i.name)).toEqual([
      'read_file',
      'read_file'
    ])
  })

  it('omits a group made entirely of list_dir calls', () => {
    const items: DisplayItem[] = [tool('list_dir', { path: '.' }, 'l1'), asst]
    expect(groupItems(items).map((n) => n.kind)).toEqual(['assistant'])
  })
})

describe('foldReadRuns', () => {
  it('folds a run of consecutive reads into one aggregate', () => {
    const runs = foldReadRuns([
      tool('read_file', { path: 'a' }, 't1'),
      tool('read_file', { path: 'b' }, 't2'),
      tool('run_shell', { command: 'ls' }, 't3')
    ])
    expect(runs.map((r) => r.kind)).toEqual(['reads', 'single'])
    expect(runs[0].kind === 'reads' && runs[0].items).toHaveLength(2)
  })

  it('keeps a lone read as a single row and never folds non-reads', () => {
    const runs = foldReadRuns([
      tool('read_file', { path: 'a' }, 't1'),
      tool('edit_file', { path: 'b' }, 't2'),
      tool('read_file', { path: 'c' }, 't3')
    ])
    expect(runs.map((r) => r.kind)).toEqual(['single', 'single', 'single'])
  })
})
