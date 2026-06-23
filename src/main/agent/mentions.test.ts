import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findFiles } from './mentions'

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
