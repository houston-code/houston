import { describe, expect, it } from 'vitest'
import type { ToolDef } from './tools'
import {
  FIND_TOOLS_NAME,
  MCP_LAZY_THRESHOLD,
  makeFindToolsDef,
  mcpCatalog,
  searchMcpDefs
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

const noctx = undefined as never

describe('searchMcpDefs', () => {
  it('returns everything for "*", "all", or an empty query', () => {
    expect(searchMcpDefs(defs, '*')).toHaveLength(defs.length)
    expect(searchMcpDefs(defs, 'all')).toHaveLength(defs.length)
    expect(searchMcpDefs(defs, '   ')).toHaveLength(defs.length)
  })

  it('matches case-insensitively on name and description', () => {
    expect(searchMcpDefs(defs, 'ISSUE').map((d) => d.schema.name)).toEqual([
      'srv:create_issue',
      'srv:list_issues'
    ])
    // "forecast" only appears in the weather tool's description.
    expect(searchMcpDefs(defs, 'forecast').map((d) => d.schema.name)).toEqual(['srv:weather'])
  })

  it('ranks name matches above description-only matches', () => {
    const withDescHit = [
      ...defs,
      fakeDef('srv:notify', 'Email someone when an issue changes.')
    ]
    // "email" is in send_email's name (score 2) and notify's description (score 1).
    const ranked = searchMcpDefs(withDescHit, 'email').map((d) => d.schema.name)
    expect(ranked[0]).toBe('srv:send_email')
    expect(ranked).toContain('srv:notify')
  })

  it('returns nothing when no tool matches', () => {
    expect(searchMcpDefs(defs, 'nonexistent')).toEqual([])
  })
})

describe('mcpCatalog', () => {
  it('lists each tool with a one-line summary', () => {
    const cat = mcpCatalog(defs)
    expect(cat).toContain('- srv:create_issue — Create a new issue in the tracker.')
    expect(cat.split('\n')).toHaveLength(defs.length)
  })

  it('truncates a very large catalog and notes the remainder', () => {
    const many = Array.from({ length: 250 }, (_, i) => fakeDef(`srv:t${i}`, `Tool ${i}.`))
    const cat = mcpCatalog(many)
    expect(cat).toContain('…and 50 more')
  })
})

describe('makeFindToolsDef', () => {
  it('advertises the catalog and connected count in its schema', () => {
    const find = makeFindToolsDef(defs, new Set())
    expect(find.schema.name).toBe(FIND_TOOLS_NAME)
    expect(find.kind).toBe('read')
    expect(find.schema.description).toContain(`${defs.length} MCP tools are connected`)
    expect(find.schema.description).toContain('srv:weather')
  })

  it('reveals matching tools and returns their full schemas', async () => {
    const revealed = new Set<string>()
    const find = makeFindToolsDef(defs, revealed)
    const out = await find.execute({ query: 'issue' }, noctx)
    expect(revealed).toEqual(new Set(['srv:create_issue', 'srv:list_issues']))
    expect(out).toContain('Loaded 2 tool(s)')
    expect(out).toContain('srv:create_issue')
    expect(out).toContain('parameters:')
  })

  it('reveals everything for "*"', async () => {
    const revealed = new Set<string>()
    const find = makeFindToolsDef(defs, revealed)
    await find.execute({ query: '*' }, noctx)
    expect(revealed.size).toBe(defs.length)
  })

  it('reveals nothing and explains when no tool matches', async () => {
    const revealed = new Set<string>()
    const find = makeFindToolsDef(defs, revealed)
    const out = await find.execute({ query: 'nope' }, noctx)
    expect(revealed.size).toBe(0)
    expect(out).toContain('No MCP tools matched "nope"')
  })

  it('treats a missing query as "*"', async () => {
    const revealed = new Set<string>()
    const find = makeFindToolsDef(defs, revealed)
    await find.execute({}, noctx)
    expect(revealed.size).toBe(defs.length)
  })
})

describe('MCP_LAZY_THRESHOLD', () => {
  it('is a sane positive bound', () => {
    expect(MCP_LAZY_THRESHOLD).toBeGreaterThan(0)
  })
})
