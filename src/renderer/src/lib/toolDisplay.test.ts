import { describe, expect, it } from 'vitest'
import type { DisplayItem, ToolItem } from './items'
import { describeTool, groupItems, groupSummary, shortenPath } from './toolDisplay'

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
})

describe('groupSummary', () => {
  it('counts repeated verbs', () => {
    const items = [
      tool('read_file', { path: 'a' }, 't1'),
      tool('read_file', { path: 'b' }, 't2'),
      tool('run_shell', { command: 'ls' }, 't3')
    ]
    expect(groupSummary(items)).toBe('Read ×2 · Run')
  })
})
