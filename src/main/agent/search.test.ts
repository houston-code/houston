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
