import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findFiles, fuzzyScore, clearMentionCache, CACHE_TTL_MS } from './mentions'

let workspace: string
const write = (rel: string): void => {
  const full = join(workspace, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, 'x')
}

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'houston-mentions-')))
  write('src/app.ts')
  write('src/components/Button.tsx')
  write('src/util/app-helpers.ts')
  write('README.md')
  write('node_modules/dep/index.ts')
  write('.git/config')
})

afterEach(() => rmSync(workspace, { recursive: true, force: true }))

describe('findFiles', () => {
  it('substring-matches the query against the relative path', async () => {
    const out = await findFiles(workspace, 'app')
    expect(out).toContain('src/app.ts')
    expect(out).toContain('src/util/app-helpers.ts')
    expect(out).not.toContain('README.md')
  })

  it('skips node_modules and dotfiles', async () => {
    const out = await findFiles(workspace, '')
    expect(out.some((p) => p.includes('node_modules'))).toBe(false)
    expect(out.some((p) => p.startsWith('.git'))).toBe(false)
    expect(out).toContain('README.md')
  })

  it('ranks basename matches and shorter paths first', async () => {
    const out = await findFiles(workspace, 'app')
    // app.ts (basename match, short) should rank before app-helpers (also basename) by length,
    // and both before any mid-path-only match.
    expect(out[0]).toBe('src/app.ts')
  })

  it('respects the max', async () => {
    const out = await findFiles(workspace, '', 2)
    expect(out).toHaveLength(2)
  })

  it('is case-insensitive', async () => {
    expect(await findFiles(workspace, 'button')).toContain('src/components/Button.tsx')
  })
})

describe('fuzzyScore', () => {
  it('matches characters in order, not just substrings', () => {
    // The case the old substring matcher simply could not find.
    expect(fuzzyScore('src/main/tui-editor.ts', 'tuieditor')).not.toBeNull()
    expect(fuzzyScore('src/main/tui-editor.ts', 'editor')).not.toBeNull()
  })

  it('rejects a query whose characters are out of order', () => {
    expect(fuzzyScore('src/main/tui.ts', 'zzz')).toBeNull()
    expect(fuzzyScore('abc.ts', 'cba')).toBeNull()
  })

  // `@editor` means tui-editor.ts, not a deep path that happens to contain the
  // letters somewhere.
  it('prefers a match in the filename over one scattered up the path', () => {
    const inName = fuzzyScore('src/tui-editor.ts', 'editor') as number
    const inPath = fuzzyScore('src/editor-legacy/very/deep/thing.ts', 'editor') as number
    expect(inName).toBeLessThan(inPath)
  })

  it('prefers a filename that starts with the query', () => {
    const starts = fuzzyScore('src/editor.ts', 'edit') as number
    const contains = fuzzyScore('src/my-editor.ts', 'edit') as number
    expect(starts).toBeLessThan(contains)
  })

  it('prefers adjacent characters over scattered ones', () => {
    const tight = fuzzyScore('src/abc.ts', 'abc') as number
    const loose = fuzzyScore('src/a-b-c.ts', 'abc') as number
    expect(tight).toBeLessThan(loose)
  })

  it('matches everything for an empty query', () => {
    expect(fuzzyScore('anything.ts', '')).toBe(0)
  })
})

describe('findFiles — what it can now see', () => {
  const NOW = 1_000_000

  function repo(): string {
    const ws = mkdtempSync(join(tmpdir(), 'houston-mentions-'))
    mkdirSync(join(ws, '.github/workflows'), { recursive: true })
    mkdirSync(join(ws, 'src/components'), { recursive: true })
    writeFileSync(join(ws, '.github/workflows/ci.yml'), 'on: push')
    writeFileSync(join(ws, 'src/components/Button.tsx'), 'x')
    writeFileSync(join(ws, 'src/tui-editor.ts'), 'x')
    writeFileSync(join(ws, 'README.md'), 'x')
    return ws
  }

  beforeEach(() => clearMentionCache())

  // The blanket dotfile skip made this file unreachable no matter what you typed.
  it('finds a dotfile path like .github/workflows/ci.yml', async () => {
    const ws = repo()
    expect(await findFiles(ws, 'ci.yml', 20, NOW)).toContain('.github/workflows/ci.yml')
  })

  it('offers directories, not only files', async () => {
    const ws = repo()
    expect(await findFiles(ws, 'components', 20, NOW)).toContain('src/components/')
  })

  it('finds a file by a fuzzy query', async () => {
    const ws = repo()
    expect(await findFiles(ws, 'tuied', 20, NOW)).toContain('src/tui-editor.ts')
  })

  it('lists something useful for a bare @', async () => {
    const ws = repo()
    const out = await findFiles(ws, '', 20, NOW)
    expect(out.length).toBeGreaterThan(0)
    expect(out).toContain('README.md') // shallowest first
  })

  it('never offers .git itself', async () => {
    const ws = repo()
    mkdirSync(join(ws, '.git'), { recursive: true })
    writeFileSync(join(ws, '.git/config'), 'x')
    const out = await findFiles(ws, 'config', 20, NOW)
    expect(out.some((p) => p.startsWith('.git/'))).toBe(false)
  })

  it('reuses the listing while you type, then refreshes', async () => {
    const ws = repo()
    await findFiles(ws, 'a', 20, NOW)
    writeFileSync(join(ws, 'brand-new.ts'), 'x')
    // Within the window: the new file is not seen (that is the point — no re-walk).
    expect(await findFiles(ws, 'brand', 20, NOW + 100)).not.toContain('brand-new.ts')
    // Past it: seen.
    expect(await findFiles(ws, 'brand', 20, NOW + CACHE_TTL_MS + 1)).toContain('brand-new.ts')
  })
})
