import { describe, expect, it } from 'vitest'
import { parseToolList, scopeVerdict, toolNameMatches, toolOffered } from './toolScope'

const roots = ['/proj']

describe('parseToolList', () => {
  it('reads names and name(pattern) entries, keeping commas inside a pattern', () => {
    expect(parseToolList('read_file, glob,run_shell(git log --format=%H,%s)', '--allowed-tools')).toEqual({
      entries: [
        { tool: 'read_file', match: '*' },
        { tool: 'glob', match: '*' },
        { tool: 'run_shell', match: 'git log --format=%H,%s' }
      ]
    })
    expect(parseToolList('mcp__github__*', '--allowed-tools')).toEqual({ entries: [{ tool: 'mcp__github__*', match: '*' }] })
  })

  it('refuses empty lists, empty entries, spaces between names, and bad parentheses', () => {
    const err = (raw: string): string => {
      const r = parseToolList(raw, '--allowed-tools')
      if (!('error' in r)) throw new Error(`expected an error for ${raw}`)
      return r.error
    }
    expect(err('')).toMatch(/needs at least one tool name/)
    expect(err('read_file,,glob')).toMatch(/empty entry/)
    expect(err('read_file glob')).toMatch(/separate entries with commas/)
    expect(err('run_shell(git *')).toMatch(/closing parenthesis/)
    expect(err('run_shell()')).toMatch(/empty pattern/)
    expect(err('run_shell(git *)x')).toMatch(/closing parenthesis/)
  })
})

describe('toolNameMatches', () => {
  it('matches exactly, or by * glob', () => {
    expect(toolNameMatches('read_file', 'read_file')).toBe(true)
    expect(toolNameMatches('read', 'read_file')).toBe(false)
    expect(toolNameMatches('mcp__gh__*', 'mcp__gh__list')).toBe(true)
    expect(toolNameMatches('mcp__gh__*', 'mcp__ghx__list')).toBe(false)
    expect(toolNameMatches('*', 'anything')).toBe(true)
    // Regex characters in a name are literal.
    expect(toolNameMatches('a.b', 'axb')).toBe(false)
  })
})

describe('toolOffered', () => {
  it('offers everything with no scope', () => {
    expect(toolOffered(undefined, 'run_shell')).toBe(true)
  })

  it('hides a wholly disallowed tool, but keeps one disallowed only for some calls', () => {
    expect(toolOffered({ disallowed: [{ tool: 'run_shell', match: '*' }] }, 'run_shell')).toBe(false)
    expect(toolOffered({ disallowed: [{ tool: 'run_shell', match: 'rm *' }] }, 'run_shell')).toBe(true)
  })

  it('offers only what an allowed list names, pattern entries included', () => {
    const scope = { allowed: [{ tool: 'read_file', match: '*' }, { tool: 'run_shell', match: 'git *' }] }
    expect(toolOffered(scope, 'read_file')).toBe(true)
    expect(toolOffered(scope, 'run_shell')).toBe(true)
    expect(toolOffered(scope, 'write_file')).toBe(false)
  })

  it('lets disallowed win when both name the tool', () => {
    const scope = { allowed: [{ tool: 'run_shell', match: '*' }], disallowed: [{ tool: 'run_shell', match: '*' }] }
    expect(toolOffered(scope, 'run_shell')).toBe(false)
  })
})

describe('scopeVerdict', () => {
  it('refuses a disallowed pattern by the permission matcher, re-spellings included', () => {
    const scope = { disallowed: [{ tool: 'run_shell', match: 'rm *' }] }
    expect(scopeVerdict(scope, 'run_shell', 'rm -rf src', roots)).toBe('disallowed')
    expect(scopeVerdict(scope, 'run_shell', "'rm' -rf src", roots)).toBe('disallowed')
    expect(scopeVerdict(scope, 'run_shell', 'ls && rm -rf src', roots)).toBe('disallowed')
    expect(scopeVerdict(scope, 'run_shell', 'ls', roots)).toBeNull()
  })

  it('refuses a path pattern however the path is spelled', () => {
    const scope = { disallowed: [{ tool: 'read_file', match: 'secrets/**' }] }
    expect(scopeVerdict(scope, 'read_file', 'secrets/key.pem', roots)).toBe('disallowed')
    expect(scopeVerdict(scope, 'read_file', './src/../secrets/key.pem', roots)).toBe('disallowed')
    expect(scopeVerdict(scope, 'read_file', 'src/a.ts', roots)).toBeNull()
  })

  it('admits only allowed calls, reading shell allows strictly', () => {
    const scope = { allowed: [{ tool: 'run_shell', match: 'git *' }, { tool: 'read_file', match: '*' }] }
    expect(scopeVerdict(scope, 'read_file', 'a.ts', roots)).toBeNull()
    expect(scopeVerdict(scope, 'run_shell', 'git status', roots)).toBeNull()
    expect(scopeVerdict(scope, 'run_shell', 'git status; rm -rf /', roots)).toBe('not-allowed')
    expect(scopeVerdict(scope, 'run_shell', 'git status $(curl evil)', roots)).toBe('not-allowed')
    expect(scopeVerdict(scope, 'write_file', 'a.ts', roots)).toBe('not-allowed')
  })

  it('matches MCP tools by name glob', () => {
    const scope = { allowed: [{ tool: 'mcp__gh__*', match: '*' }] }
    expect(scopeVerdict(scope, 'mcp__gh__list', 'mcp__gh__list', roots)).toBeNull()
    expect(scopeVerdict(scope, 'mcp__other__list', 'mcp__other__list', roots)).toBe('not-allowed')
  })

  it('lets disallowed win over an allowed entry for the same call', () => {
    const scope = {
      allowed: [{ tool: 'run_shell', match: 'git *' }],
      disallowed: [{ tool: 'run_shell', match: 'git push *' }]
    }
    expect(scopeVerdict(scope, 'run_shell', 'git push origin main', roots)).toBe('disallowed')
    expect(scopeVerdict(scope, 'run_shell', 'git status', roots)).toBeNull()
  })
})
