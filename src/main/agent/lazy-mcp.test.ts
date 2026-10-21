import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/agent'
import { DEFERRED_TOOL_CATALOG, isDeferredBuiltin } from './deferred-tools'
import { TOOLS, type ToolDef } from './tools'
import {
  FIND_TOOLS_NAME,
  MCP_LAZY_THRESHOLD,
  builtinCatalogEntries,
  catalogLines,
  loadedDeferredTools,
  makeFindToolsDef,
  mcpCatalogEntries,
  searchCatalog
} from './lazy-mcp'

function fakeDef(name: string, description: string): ToolDef {
  return {
    kind: 'mcp',
    summarize: () => name,
    schema: { name, description, parameters: { type: 'object', properties: {} } },
    execute: () => Promise.resolve('')
  }
}

const defs: ToolDef[] = [
  fakeDef('srv:create_issue', 'Create a new issue in the tracker.'),
  fakeDef('srv:list_issues', 'List open issues.'),
  fakeDef('srv:send_email', 'Send an email to a recipient.'),
  fakeDef('srv:weather', 'Look up the current forecast for a city.')
]
const entries = mcpCatalogEntries(defs)
const names = (es: { def: ToolDef }[]): string[] => es.map((e) => e.def.schema.name)

const noctx = undefined as never

describe('searchCatalog', () => {
  it('returns everything for "*", "all", or an empty query', () => {
    expect(searchCatalog(entries, '*')).toHaveLength(defs.length)
    expect(searchCatalog(entries, 'all')).toHaveLength(defs.length)
    expect(searchCatalog(entries, '   ')).toHaveLength(defs.length)
  })

  it('matches case-insensitively on name and description', () => {
    expect(names(searchCatalog(entries, 'ISSUE'))).toEqual(['srv:create_issue', 'srv:list_issues'])
    // "forecast" only appears in the weather tool's description.
    expect(names(searchCatalog(entries, 'forecast'))).toEqual(['srv:weather'])
  })

  it('ranks name matches above description-only matches', () => {
    const withDescHit = mcpCatalogEntries([...defs, fakeDef('srv:notify', 'Email someone when an issue changes.')])
    // "email" is in send_email's name (score 2) and notify's description (score 1).
    const ranked = names(searchCatalog(withDescHit, 'email'))
    expect(ranked[0]).toBe('srv:send_email')
    expect(ranked).toContain('srv:notify')
  })

  it('takes exact names separated by commas', () => {
    expect(names(searchCatalog(entries, 'srv:weather, srv:send_email'))).toEqual(['srv:send_email', 'srv:weather'])
  })

  it('matches a built-in by its catalog summary, not only its description', () => {
    const builtins = builtinCatalogEntries(TOOLS)
    expect(names(searchCatalog(builtins, 'jupyter'))).toEqual(['notebook_edit'])
  })

  it('returns nothing when no tool matches', () => {
    expect(searchCatalog(entries, 'nonexistent')).toEqual([])
  })
})

describe('catalogLines', () => {
  it('lists each tool with a one-line summary', () => {
    const cat = catalogLines(entries)
    expect(cat).toContain('- srv:create_issue: Create a new issue in the tracker.')
    expect(cat.split('\n')).toHaveLength(defs.length)
  })

  it('truncates a very large catalog and notes the remainder', () => {
    const many = Array.from({ length: 250 }, (_, i) => fakeDef(`srv:t${i}`, `Tool ${i}.`))
    expect(catalogLines(mcpCatalogEntries(many))).toContain('…and 50 more')
  })
})

describe('DEFERRED_TOOL_CATALOG', () => {
  it('names only real built-ins, each with a one-line summary', () => {
    const builtins = new Set(TOOLS.map((t) => t.schema.name))
    for (const [name, summary] of Object.entries(DEFERRED_TOOL_CATALOG)) {
      expect(builtins.has(name), name).toBe(true)
      expect(summary, name).not.toMatch(/\n/)
      expect(summary.length, name).toBeLessThanOrEqual(160)
    }
  })

  it('keeps the core coding loop eager', () => {
    for (const core of [
      'read_file',
      'write_file',
      'edit_file',
      'multi_edit',
      'apply_patch',
      'list_dir',
      'glob',
      'search_files',
      'run_shell',
      'read_shell_output',
      'kill_shell',
      'todo_write',
      'ask_user',
      'present_plan',
      'dispatch_agent',
      'skill',
      'web_fetch'
    ]) {
      expect(isDeferredBuiltin(core), core).toBe(false)
    }
  })

  it('defers every GitHub tool', () => {
    for (const t of TOOLS) {
      if (t.schema.name.startsWith('gh_')) expect(isDeferredBuiltin(t.schema.name), t.schema.name).toBe(true)
    }
  })
})

describe('makeFindToolsDef', () => {
  const builtins = builtinCatalogEntries(TOOLS)

  it('lists built-ins and MCP tools in separate sections', () => {
    const find = makeFindToolsDef(builtins, entries)
    expect(find.schema.name).toBe(FIND_TOOLS_NAME)
    expect(find.kind).toBe('read')
    expect(find.schema.description).toContain('Houston tools:\n- ')
    expect(find.schema.description).toContain(`- gh_run_view: ${DEFERRED_TOOL_CATALOG.gh_run_view}`)
    expect(find.schema.description).toContain(`MCP tools (${defs.length} from connected servers):`)
    expect(find.schema.description).toContain('srv:weather')
  })

  it('omits the MCP section when no MCP tool is deferred', () => {
    expect(makeFindToolsDef(builtins, []).schema.description).not.toContain('MCP tools')
  })

  it('names the tools it matched, without repeating their schemas', async () => {
    const find = makeFindToolsDef([], entries)
    const out = await find.execute({ query: 'issue' }, noctx)
    expect(out).toBe('Loaded 2 tool(s), callable from your next step: srv:create_issue, srv:list_issues')
  })

  it('explains when no tool matches', async () => {
    const out = await makeFindToolsDef([], entries).execute({ query: 'nope' }, noctx)
    expect(out).toContain('No tools matched "nope"')
  })
})

describe('loadedDeferredTools', () => {
  const builtins = builtinCatalogEntries(TOOLS)
  const catalog = [...builtins, ...entries]
  const find = (id: string, query: string): ChatMessage => ({
    role: 'assistant',
    content: '',
    toolCalls: [{ id, name: FIND_TOOLS_NAME, arguments: { query } }]
  })
  const result = (id: string, content: string): ChatMessage => ({
    role: 'tool',
    content,
    toolCallId: id,
    toolName: FIND_TOOLS_NAME
  })

  it('is empty for a conversation that loaded nothing', () => {
    expect(loadedDeferredTools([{ role: 'user', content: 'hi' }], catalog)).toEqual([])
  })

  it('loads what a successful find_tools call matched, in load order, without duplicates', () => {
    const log: ChatMessage[] = [
      find('c1', 'gh_pr_view'),
      result('c1', 'Loaded 1 tool(s), callable from your next step: gh_pr_view'),
      find('c2', 'srv:weather, gh_pr_view'),
      result('c2', 'Loaded 2 tool(s), callable from your next step: gh_pr_view, srv:weather')
    ]
    expect(names(loadedDeferredTools(log, catalog).map((def) => ({ def })))).toEqual(['gh_pr_view', 'srv:weather'])
  })

  it('ignores a find_tools call that failed, was blocked, or has no result yet', () => {
    const log: ChatMessage[] = [
      find('c1', 'gh_pr_view'),
      result('c1', 'Blocked by a PreToolUse hook.'),
      find('c2', 'schedule_run')
    ]
    expect(loadedDeferredTools(log, catalog)).toEqual([])
  })

  it('loads a deferred tool the model called directly, but not an eager one', () => {
    const log: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'read_file', arguments: { path: 'a' } },
          { id: 'c2', name: 'recall_history', arguments: { query: 'x' } }
        ]
      }
    ]
    expect(loadedDeferredTools(log, catalog).map((d) => d.schema.name)).toEqual(['recall_history'])
  })

  it('drops a loaded tool that is no longer in the catalog (an MCP server went away)', () => {
    const log: ChatMessage[] = [find('c1', 'srv:weather'), result('c1', 'Loaded 1 tool(s)')]
    expect(loadedDeferredTools(log, builtins)).toEqual([])
  })
})

describe('MCP_LAZY_THRESHOLD', () => {
  it('is a sane positive bound', () => {
    expect(MCP_LAZY_THRESHOLD).toBeGreaterThan(0)
  })
})
