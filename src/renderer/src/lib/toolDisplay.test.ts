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
  it('labels the multi-file and git tools instead of showing their raw names', () => {
    expect(describeTool(tool('multi_edit', { path: 'src/x.ts' }))).toEqual({ verb: 'Edit', target: 'src/x.ts', mono: true })
    const one = ['*** Begin Patch', '*** Update File: src/app.ts', '@@', '-a', '+b', '*** End Patch'].join('\n')
    expect(describeTool(tool('apply_patch', { patch: one }))).toEqual({ verb: 'Patch', target: 'src/app.ts', mono: true })
    const two = ['*** Begin Patch', '*** Add File: a.txt', '+a', '*** Delete File: b.txt', '*** End Patch'].join('\n')
    expect(describeTool(tool('apply_patch', { patch: two }))).toEqual({ verb: 'Patch', target: '2 files', mono: false })
    const unified = ['--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1 +1 @@', '-a', '+b'].join('\n')
    expect(describeTool(tool('apply_patch', { patch: unified })).target).toBe('src/app.ts')
    expect(describeTool(tool('git_status', {})).verb).toBe('Git status')
    expect(describeTool(tool('git_diff', { path: 'src' }))).toEqual({ verb: 'Git diff', target: 'src', mono: true })
  })

  it('labels the GitHub issue, review, merge and CI tools', () => {
    expect(describeTool(tool('gh_pr_merge', { number: 42 })).verb).toBe('Merge PR')
    expect(describeTool(tool('gh_pr_merge', { number: 42 })).target).toBe('#42')
    expect(describeTool(tool('gh_pr_review', {})).target).toBe('(current)')
    expect(describeTool(tool('gh_issue_view', { number: '7' })).target).toBe('#7')
    expect(describeTool(tool('gh_issue_create', { title: 'Crash on start' })).target).toBe('Crash on start')
    expect(describeTool(tool('gh_run_view', { run_id: 123 })).target).toBe('123')
  })

  it('labels each GitHub state change by what it does', () => {
    expect(describeTool(tool('gh_pr_set_state', { number: 5, action: 'close' }))).toEqual({
      verb: 'Close PR',
      target: '#5',
      mono: false
    })
    expect(describeTool(tool('gh_pr_set_state', { number: 5, action: 'reopen' })).verb).toBe('Reopen PR')
    expect(describeTool(tool('gh_pr_set_state', { action: 'ready' }))).toEqual({
      verb: 'Mark PR ready',
      target: '(current)',
      mono: false
    })
    expect(describeTool(tool('gh_pr_set_state', { action: 'draft' })).verb).toBe('Draft PR')
    // An unknown action (or a key on Object.prototype) falls back rather than rendering junk.
    expect(describeTool(tool('gh_pr_set_state', { action: 'constructor' })).verb).toBe('Update PR')
    expect(describeTool(tool('gh_issue_set_state', { number: 7, action: 'close' }))).toEqual({
      verb: 'Close issue',
      target: '#7',
      mono: false
    })
    expect(describeTool(tool('gh_issue_set_state', { number: 7, action: 'reopen' })).verb).toBe('Reopen issue')
    expect(describeTool(tool('gh_issue_set_state', { number: 7 })).verb).toBe('Update issue')
  })

  it('shows an MCP tool by its own name and server, not the namespaced identifier', () => {
    expect(describeTool(tool('mcp__linear__create_issue', {}))).toEqual({
      verb: 'create_issue',
      target: 'via linear',
      mono: false
    })
  })

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

  it('labels a dispatched subagent by its task description', () => {
    expect(describeTool(tool('dispatch_agent', { description: 'find auth flow' }))).toEqual({
      verb: 'Subagent',
      target: 'find auth flow',
      mono: false
    })
    expect(describeTool(tool('dispatch_agent', {})).target).toBe('research task')
  })

  it('labels a review, noting the base when given', () => {
    expect(describeTool(tool('review_changes', {}))).toEqual({
      verb: 'Review',
      target: 'uncommitted changes',
      mono: false
    })
    expect(describeTool(tool('review_changes', { base: 'main' })).target).toBe('changes vs main')
  })

  it('describes a localhost view by its URL', () => {
    expect(describeTool(tool('view_localhost', { url: 'http://localhost:3000' }))).toEqual({
      verb: 'View',
      target: 'http://localhost:3000',
      mono: true
    })
  })

  it('describes a PR sweep by its mode', () => {
    expect(describeTool(tool('pr_sweep', { mode: 'author' }))).toEqual({
      verb: 'PR sweep',
      target: 'author',
      mono: false
    })
  })

  it('describes gh PR tools, coercing a numeric PR ref to #N', () => {
    expect(describeTool(tool('gh_pr_create', { title: 'Fix it' }))).toEqual({
      verb: 'Open PR',
      target: 'Fix it',
      mono: false
    })
    expect(describeTool(tool('gh_pr_view', { number: 7 })).target).toBe('#7')
    expect(describeTool(tool('gh_pr_view', {})).target).toBe('(current)')
    expect(describeTool(tool('gh_pr_checkout', { number: 9 })).target).toBe('#9')
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

  it('keeps a list_dir that is awaiting approval so its prompt is visible', () => {
    // A permission rule can force a prompt on any tool; hiding it then would wedge
    // the run on a prompt that renders nothing.
    const awaiting: ToolItem = { ...tool('list_dir', { path: '.' }, 'l1'), status: 'awaiting-approval' }
    const nodes = groupItems([awaiting])
    expect(nodes).toHaveLength(1)
    expect(nodes[0].kind).toBe('toolgroup')
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

describe('groupItems: proposal cards', () => {
  const proposal = (over: Partial<ToolItem> = {}): ToolItem => ({
    kind: 'tool',
    id: 'p1',
    name: 'propose_session',
    args: { title: 'Docs', prompt: 'p' },
    status: 'done',
    output: 'Proposed "Docs" to the user as a card.',
    ...over
  })

  it('lifts an accepted proposal out of the tool group into its own card', () => {
    const nodes = groupItems([tool('read_file', { path: 'a' }, 't1'), proposal(), tool('read_file', { path: 'b' }, 't2')])
    expect(nodes.map((n) => n.kind)).toEqual(['toolgroup', 'proposal', 'toolgroup'])
  })

  it('keeps a running or refused proposal as an ordinary tool row', () => {
    expect(groupItems([proposal({ status: 'running', output: undefined })]).map((n) => n.kind)).toEqual(['toolgroup'])
    expect(
      groupItems([proposal({ status: 'error', output: 'Error: already proposed' })]).map((n) => n.kind)
    ).toEqual(['toolgroup'])
  })
})
