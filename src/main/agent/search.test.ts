import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRipgrep, runRipgrep, searchContents } from './search'

describe('resolveRipgrep', () => {
  it('prefers the HOUSTON_RG override when it exists', () => {
    const exists = (p: string): boolean => p === '/custom/rg'
    expect(resolveRipgrep({ env: { HOUSTON_RG: '/custom/rg', PATH: '' }, exists, candidates: [] })).toBe(
      '/custom/rg'
    )
  })

  it('finds rg on PATH', () => {
    const exists = (p: string): boolean => p === '/usr/local/bin/rg'
    expect(resolveRipgrep({ env: { PATH: '/nope:/usr/local/bin' }, exists, candidates: [] })).toBe(
      '/usr/local/bin/rg'
    )
  })

  it('looks for rg.exe on PATH on Windows', () => {
    const dir = 'C:\\tools'
    const exists = (p: string): boolean => p === join(dir, 'rg.exe')
    expect(
      resolveRipgrep({ platform: 'win32', env: { PATH: dir }, exists, candidates: [] })
    ).toBe(join(dir, 'rg.exe'))
  })

  it('falls back to a known candidate dir', () => {
    const exists = (p: string): boolean => p === '/opt/homebrew/bin/rg'
    expect(
      resolveRipgrep({ env: { PATH: '' }, exists, candidates: ['/opt/homebrew/bin/rg'] })
    ).toBe('/opt/homebrew/bin/rg')
  })

  it('returns null when nothing is found', () => {
    expect(resolveRipgrep({ env: { PATH: '/nope' }, exists: () => false, candidates: [] })).toBeNull()
  })
})

describe('searchContents (JS fallback)', () => {
  let workspace: string

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'houston-search-')))
    mkdirSync(join(workspace, 'src'))
    writeFileSync(join(workspace, 'src', 'app.ts'), 'const answer = 42\n')
    mkdirSync(join(workspace, 'node_modules'))
    writeFileSync(join(workspace, 'node_modules', 'dep.ts'), 'const answer = 99\n')
  })

  afterEach(() => rmSync(workspace, { recursive: true, force: true }))

  const fallback = (pattern: string): Promise<string> =>
    searchContents({ pattern, workspace, searchRel: '.', startAbs: workspace, rgPath: null, max: 100 })

  it('matches by regex and skips build/dep dirs', async () => {
    const out = await fallback('answer = \\d+')
    expect(out).toContain('src/app.ts:1:')
    expect(out).not.toContain('node_modules')
  })

  it('reports no matches', async () => {
    expect(await fallback('zzz-not-here')).toBe('No matches found.')
  })

  it('throws on an invalid regex', async () => {
    await expect(fallback('(')).rejects.toThrow(/Invalid regular expression/)
  })

  it('reports a missing search path plainly instead of "no matches"', async () => {
    await expect(
      searchContents({
        pattern: 'answer',
        workspace,
        searchRel: 'nope/here',
        startAbs: join(workspace, 'nope', 'here'),
        rgPath: null,
        max: 100
      })
    ).rejects.toThrow(/Search path not found/i)
  })

  it('searches a single-file path, not only a directory', async () => {
    // jsWalk would readdir() a file path and hit ENOTDIR (silently "no matches"); the
    // ripgrep backend searches a file argument, so the JS fallback must match it.
    const out = await searchContents({
      pattern: 'answer',
      workspace,
      searchRel: 'src/app.ts',
      startAbs: join(workspace, 'src', 'app.ts'),
      rgPath: null,
      max: 100
    })
    expect(out).toContain('src/app.ts:1:')
  })
})

describe('searchContents options (JS fallback)', () => {
  let workspace: string

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'houston-search-opt-')))
    mkdirSync(join(workspace, 'src'))
    writeFileSync(join(workspace, 'src', 'app.ts'), 'line1\nNEEDLE here\nline3\nneedle lower\n')
    writeFileSync(join(workspace, 'src', 'notes.md'), 'needle in markdown\n')
  })

  afterEach(() => rmSync(workspace, { recursive: true, force: true }))

  const search = (
    pattern: string,
    opts: Partial<Parameters<typeof searchContents>[0]> = {}
  ): Promise<string> =>
    searchContents({
      pattern,
      workspace,
      searchRel: '.',
      startAbs: workspace,
      rgPath: null,
      max: 100,
      ...opts
    })

  it('respects ignoreCase', async () => {
    expect(await search('needle')).not.toContain('app.ts:2') // case-sensitive misses NEEDLE
    const ci = await search('needle', { ignoreCase: true })
    expect(ci).toContain('src/app.ts:2:')
    expect(ci).toContain('src/app.ts:4:')
  })

  it('filters by glob', async () => {
    const out = await search('needle', { ignoreCase: true, glob: '*.md' })
    expect(out).toContain('src/notes.md')
    expect(out).not.toContain('app.ts')
  })

  it('returns files-with-matches mode', async () => {
    const out = await search('needle', { ignoreCase: true, filesWithMatches: true })
    expect(out.split('\n').sort()).toEqual(['src/app.ts', 'src/notes.md'])
  })

  it('includes context lines around a match', async () => {
    const out = await search('NEEDLE', { context: 1 })
    expect(out).toContain('src/app.ts:1- line1') // context before (dash separator)
    expect(out).toContain('src/app.ts:2: NEEDLE here') // match (colon separator)
    expect(out).toContain('src/app.ts:3- line3') // context after
  })

  it('labels a match as a match even when it falls inside another match context window', async () => {
    // Matches on lines 1 and 3; with context 2, line 3 also appears in line 1's window.
    // It must still read as a match (':'), not context ('-'), as ripgrep does.
    writeFileSync(join(workspace, 'src', 'close.ts'), 'MATCH one\nfiller\nMATCH two\nfiller2\n')
    const out = await search('MATCH', { context: 2 })
    expect(out).toContain('src/close.ts:1: MATCH one')
    expect(out).toContain('src/close.ts:3: MATCH two')
  })
})

describe('searchContents (ripgrep)', () => {
  const rg = resolveRipgrep()
  let workspace: string

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'houston-rg-')))
    mkdirSync(join(workspace, 'src'))
    writeFileSync(join(workspace, 'src', 'app.ts'), 'const answer = 42\n')
    mkdirSync(join(workspace, 'node_modules'))
    writeFileSync(join(workspace, 'node_modules', 'dep.ts'), 'const answer = 99\n')
  })

  afterEach(() => rmSync(workspace, { recursive: true, force: true }))

  it.skipIf(!rg)('finds matches and excludes skip dirs', async () => {
    const out = await searchContents({
      pattern: 'answer = \\d+',
      workspace,
      searchRel: '.',
      startAbs: workspace,
      rgPath: rg,
      max: 100
    })
    expect(out).toContain('src/app.ts:1:')
    expect(out).not.toContain('node_modules')
  })

  it.skipIf(!rg)('surfaces an invalid pattern as an error', async () => {
    const res = await runRipgrep(rg as string, '(', workspace, '.', 100)
    expect(res.error).toBeTruthy()
  })

  it.skipIf(!rg)('runRipgrep surfaces the real IO error for a missing path (no --no-messages)', async () => {
    // Regression: --no-messages used to swallow this, leaving a generic "ripgrep
    // error" that the caller then mislabeled as an invalid regex.
    const res = await runRipgrep(rg as string, 'answer', workspace, 'nope/here', 100)
    expect(res.matches).toEqual([])
    expect(res.error).toMatch(/no such file|not found|io error/i)
  })

  it.skipIf(!rg)('reports a missing search path plainly, not as an invalid regex', async () => {
    await expect(
      searchContents({
        pattern: 'answer',
        workspace,
        searchRel: 'nope/here',
        startAbs: join(workspace, 'nope', 'here'),
        rgPath: rg,
        max: 100
      })
    ).rejects.toThrow(/Search path not found/i)
  })

  it.skipIf(!rg)('reports a bad pattern with ripgrep own message, not a mislabeled path error', async () => {
    // A valid path plus a genuinely bad regex: the error must clearly be about the
    // regex (ripgrep says "regex parse error"), never a generic path failure.
    await expect(
      searchContents({
        pattern: '(',
        workspace,
        searchRel: '.',
        startAbs: workspace,
        rgPath: rg,
        max: 100
      })
    ).rejects.toThrow(/regex/i)
  })
})

describe('searchContents options (ripgrep)', () => {
  const rg = resolveRipgrep()
  let workspace: string

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'houston-rg-opt-')))
    mkdirSync(join(workspace, 'src'))
    writeFileSync(join(workspace, 'src', 'app.ts'), 'line1\nNEEDLE here\nline3\nneedle lower\n')
    writeFileSync(join(workspace, 'src', 'notes.md'), 'needle in markdown\n')
  })

  afterEach(() => rmSync(workspace, { recursive: true, force: true }))

  const search = (
    pattern: string,
    opts: Partial<Parameters<typeof searchContents>[0]> = {}
  ): Promise<string> =>
    searchContents({
      pattern,
      workspace,
      searchRel: '.',
      startAbs: workspace,
      rgPath: rg,
      max: 100,
      ...opts
    })

  // The rg and JS paths aren't byte-identical (rg emits full lines, the JS walk
  // trims), so these assert behavioral parity: the options take effect.
  it.skipIf(!rg)('respects ignoreCase', async () => {
    expect(await search('needle')).not.toContain('app.ts:2')
    const ci = await search('needle', { ignoreCase: true })
    expect(ci).toContain('src/app.ts:2:')
    expect(ci).toContain('src/app.ts:4:')
  })

  it.skipIf(!rg)('filters by glob', async () => {
    const out = await search('needle', { ignoreCase: true, glob: '*.md' })
    expect(out).toContain('src/notes.md')
    expect(out).not.toContain('app.ts')
  })

  it.skipIf(!rg)('returns files-with-matches mode (paths only, no line numbers)', async () => {
    const out = await search('needle', { ignoreCase: true, filesWithMatches: true })
    const lines = out.split('\n').sort()
    expect(lines).toEqual(['src/app.ts', 'src/notes.md'])
    expect(out).not.toMatch(/:\d+:/)
  })

  it.skipIf(!rg)('includes context lines around a match', async () => {
    const out = await search('NEEDLE', { context: 1 })
    expect(out).toContain('line1') // context before
    expect(out).toContain('NEEDLE here') // match
    expect(out).toContain('line3') // context after
  })
})
