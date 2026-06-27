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
