import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveAstGrep, formatAstGrepMatches, runAstGrep, searchStructural } from './astgrep'

describe('resolveAstGrep', () => {
  it('prefers the HOUSTON_AST_GREP override when it exists', () => {
    const exists = (p: string): boolean => p === '/custom/ast-grep'
    expect(
      resolveAstGrep({ env: { HOUSTON_AST_GREP: '/custom/ast-grep', PATH: '' }, exists, candidates: [] })
    ).toBe('/custom/ast-grep')
  })

  it('finds ast-grep on PATH', () => {
    const exists = (p: string): boolean => p === '/usr/local/bin/ast-grep'
    expect(resolveAstGrep({ env: { PATH: '/nope:/usr/local/bin' }, exists, candidates: [] })).toBe(
      '/usr/local/bin/ast-grep'
    )
  })

  it('falls back to a known candidate dir', () => {
    const exists = (p: string): boolean => p === '/opt/homebrew/bin/ast-grep'
    expect(
      resolveAstGrep({ env: { PATH: '' }, exists, candidates: ['/opt/homebrew/bin/ast-grep'] })
    ).toBe('/opt/homebrew/bin/ast-grep')
  })

  it('returns null when nothing is found', () => {
    expect(resolveAstGrep({ env: { PATH: '/nope' }, exists: () => false, candidates: [] })).toBeNull()
  })
})

describe('formatAstGrepMatches', () => {
  it('formats compact JSON into 1-based path:line:col: text entries', () => {
    const json = JSON.stringify([
      { file: 'src/a.ts', text: 'console.log(x)', range: { start: { line: 4, column: 2 } } },
      { file: 'src/b.ts', text: 'console.log(y)', range: { start: { line: 0, column: 0 } } }
    ])
    expect(formatAstGrepMatches(json, 100)).toEqual([
      'src/a.ts:5:3: console.log(x)',
      'src/b.ts:1:1: console.log(y)'
    ])
  })

  it('uses only the first line of a multi-line match and trims it', () => {
    const json = JSON.stringify([
      { file: 'a.ts', text: '  function f() {\n  return 1\n}', range: { start: { line: 0, column: 0 } } }
    ])
    expect(formatAstGrepMatches(json, 100)).toEqual(['a.ts:1:1: function f() {'])
  })

  it('respects the max limit', () => {
    const json = JSON.stringify(
      Array.from({ length: 5 }, (_, i) => ({ file: `f${i}.ts`, text: 'x', range: { start: { line: 0, column: 0 } } }))
    )
    expect(formatAstGrepMatches(json, 2)).toHaveLength(2)
  })

  it('returns [] for empty or invalid input', () => {
    expect(formatAstGrepMatches('', 100)).toEqual([])
    expect(formatAstGrepMatches('not json', 100)).toEqual([])
    expect(formatAstGrepMatches('{"not":"an array"}', 100)).toEqual([])
    expect(formatAstGrepMatches('[]', 100)).toEqual([])
  })
})

describe('searchStructural (validation)', () => {
  it('requires a pattern', async () => {
    await expect(
      searchStructural({ pattern: '', lang: 'ts', workspace: '/w', searchRel: '.', binPath: '/x', max: 100 })
    ).rejects.toThrow(/pattern is required/)
  })

  it('requires a lang', async () => {
    await expect(
      searchStructural({ pattern: 'foo($A)', lang: '', workspace: '/w', searchRel: '.', binPath: '/x', max: 100 })
    ).rejects.toThrow(/lang is required/)
  })

  it('errors clearly when no ast-grep binary is available', async () => {
    await expect(
      searchStructural({ pattern: 'foo($A)', lang: 'ts', workspace: '/w', searchRel: '.', binPath: null, max: 100 })
    ).rejects.toThrow(/ast-grep is not available/)
  })
})

// Integration tests against the real ast-grep binary (the dev/build dependency).
// Skipped when the binary can't be located (e.g. an unsupported platform).
function findAstGrep(): string | null {
  const candidates = [
    resolve(process.cwd(), 'node_modules/@ast-grep/cli/ast-grep'),
    resolve(process.cwd(), 'node_modules/.bin/ast-grep')
  ]
  return candidates.find((p) => existsSync(p)) ?? resolveAstGrep()
}

describe('runAstGrep / searchStructural (ast-grep binary)', () => {
  const ag = findAstGrep()
  let workspace: string

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'houston-ag-')))
    mkdirSync(join(workspace, 'src'))
    writeFileSync(
      join(workspace, 'src', 'app.ts'),
      'function add(a, b) { return a + b }\nconsole.log(add(1, 2))\nconst x = 3\n'
    )
    // A skip-dir file that should be excluded from results.
    mkdirSync(join(workspace, 'node_modules'))
    writeFileSync(join(workspace, 'node_modules', 'dep.ts'), 'console.log(999)\n')
  })

  afterEach(() => rmSync(workspace, { recursive: true, force: true }))

  it.skipIf(!ag)('finds a structural match and excludes skip dirs', async () => {
    const out = await searchStructural({
      pattern: 'console.log($A)',
      lang: 'ts',
      workspace,
      searchRel: '.',
      binPath: ag,
      max: 100
    })
    expect(out).toContain('src/app.ts:2:')
    expect(out).not.toContain('node_modules')
  })

  it.skipIf(!ag)('returns "No matches found." when nothing matches', async () => {
    const out = await searchStructural({
      pattern: 'while ($C) { $$$ }',
      lang: 'ts',
      workspace,
      searchRel: '.',
      binPath: ag,
      max: 100
    })
    expect(out).toBe('No matches found.')
  })

  it.skipIf(!ag)('surfaces an invalid pattern/language as an error', async () => {
    const res = await runAstGrep({
      binPath: ag as string,
      pattern: 'console.log($A)',
      lang: 'not-a-language',
      cwd: workspace,
      searchRel: '.',
      max: 100
    })
    expect(res.error).toBeTruthy()
  })
})
