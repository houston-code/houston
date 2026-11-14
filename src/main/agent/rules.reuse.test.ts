import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Counts how often the nested-rules discovery lists the repository, so a test can
// tell a reused listing from a fresh one. Everything else is the real module.
const h = vi.hoisted(() => ({ listings: 0 }))
vi.mock('./fileScope', async (importActual) => {
  const actual = await importActual<typeof import('./fileScope')>()
  return {
    ...actual,
    gitListFiles: (...args: Parameters<typeof actual.gitListFiles>) => {
      h.listings++
      return actual.gitListFiles(...args)
    }
  }
})

const { loadProjectRules, resetReusedRulesDiscovery, settleReusedRulesDiscovery } = await import('./rules')

let root: string
let workspace: string
let globalDir: string
let home: string

const git = (args: string[]): void => {
  execFileSync('git', args, { cwd: workspace, stdio: 'ignore' })
}
const write = (rel: string, text: string): void => {
  const parts = rel.split('/')
  if (parts.length > 1) mkdirSync(join(workspace, ...parts.slice(0, -1)), { recursive: true })
  writeFileSync(join(workspace, ...parts), text)
}

/** A run start's load: the nested-rules listing reused across loads. */
const load = (): ReturnType<typeof loadProjectRules> =>
  loadProjectRules(workspace, { globalDir, home, reuseDiscovery: true })
/** A load that discovers from scratch, as every load did before reuse. */
const fresh = (): ReturnType<typeof loadProjectRules> => loadProjectRules(workspace, { globalDir, home })

beforeEach(() => {
  resetReusedRulesDiscovery()
  h.listings = 0
  root = realpathSync(mkdtempSync(join(tmpdir(), 'houston-rules-reuse-')))
  workspace = join(root, 'repo')
  home = join(root, 'home')
  globalDir = join(home, '.houston')
  mkdirSync(workspace)
  mkdirSync(globalDir, { recursive: true })
  git(['init', '-q'])
})

afterEach(async () => {
  vi.useRealTimers()
  await settleReusedRulesDiscovery()
  resetReusedRulesDiscovery()
  rmSync(root, { recursive: true, force: true })
})

describe('loadProjectRules with reuseDiscovery', () => {
  it('assembles exactly what a fresh load does', async () => {
    write('AGENTS.md', 'Root rules.')
    write('packages/api/AGENTS.md', 'API rules.')
    write('packages/api/deep/CLAUDE.md', 'Deep rules.')
    git(['add', 'packages/api/AGENTS.md'])
    const expected = await fresh()
    expect(expected.files).toHaveLength(3)
    expect(await load()).toEqual(expected)
    expect(await load()).toEqual(expected)
  })

  it('reuses the listing: a later load runs no git listing before it returns', async () => {
    // The refresh timer never fires on its own here, so the count can only move
    // when the test runs the refresh.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    write('AGENTS.md', 'Root rules.')
    await load()
    expect(h.listings).toBe(1)
    await load()
    expect(h.listings).toBe(1)
    // The listing is refreshed in the background for the next load instead.
    await settleReusedRulesDiscovery()
    expect(h.listings).toBe(2)
  })

  it('shows an edited rules file on the next load', async () => {
    write('AGENTS.md', 'Root v1.')
    write('pkg/AGENTS.md', 'Nested v1.')
    const first = await load()
    expect(first.text).toContain('Root v1.')
    expect(first.text).toContain('Nested v1.')
    write('AGENTS.md', 'Root v2.')
    write('pkg/AGENTS.md', 'Nested v2.')
    const next = await load()
    expect(next.text).toContain('Root v2.')
    expect(next.text).toContain('Nested v2.')
    expect(next.text).not.toContain('v1.')
  })

  it('drops a deleted rules file on the next load', async () => {
    write('pkg/AGENTS.md', 'Nested rules.')
    write('lib/CLAUDE.md', 'Lib rules.')
    expect((await load()).files).toEqual([join('lib', 'CLAUDE.md'), join('pkg', 'AGENTS.md')])
    unlinkSync(join(workspace, 'pkg', 'AGENTS.md'))
    const next = await load()
    expect(next.files).toEqual([join('lib', 'CLAUDE.md')])
    expect(next.text).not.toContain('Nested rules.')
  })

  it.skipIf(process.platform === 'win32')(
    'drops a rules file replaced by a symlink on the next load, as a fresh load does',
    async () => {
      write('docs/rules.md', 'Linked rules.')
      write('pkg/AGENTS.md', 'Nested rules.')
      expect((await load()).files).toEqual([join('pkg', 'AGENTS.md')])
      unlinkSync(join(workspace, 'pkg', 'AGENTS.md'))
      symlinkSync(join(workspace, 'docs', 'rules.md'), join(workspace, 'pkg', 'AGENTS.md'))
      const next = await load()
      expect(next.files).toEqual([])
      expect(next).toEqual(await fresh())
    }
  )

  it('lists a new untracked rules file no later than the second load after it appears', async () => {
    write('AGENTS.md', 'Root rules.')
    await load()
    write('pkg/AGENTS.md', 'New nested rules.')
    // The next load still answers from the previous listing...
    expect((await load()).text).not.toContain('New nested rules.')
    // ...and the one after has it, whether or not the background refresh ran yet.
    const later = await load()
    expect(later.text).toContain('New nested rules.')
    expect(later).toEqual(await fresh())
  })

  it('lists a new rules file on the very next load once the background refresh has run', async () => {
    await load()
    await load()
    write('pkg/AGENTS.md', 'New nested rules.')
    await settleReusedRulesDiscovery()
    // The refresh scheduled by the second load ran after the file appeared.
    expect((await load()).text).toContain('New nested rules.')
  })

  it('lists a newly tracked rules file the same way', async () => {
    await load()
    write('pkg/CLAUDE.md', 'Tracked nested rules.')
    git(['add', 'pkg/CLAUDE.md'])
    await load()
    expect((await load()).text).toContain('Tracked nested rules.')
  })

  it('reuses the walk for a folder git does not cover too', async () => {
    rmSync(join(workspace, '.git'), { recursive: true, force: true })
    write('pkg/AGENTS.md', 'Walked rules.')
    expect((await load()).text).toContain('Walked rules.')
    write('lib/AGENTS.md', 'Walked later.')
    await load()
    const later = await load()
    expect(later.text).toContain('Walked later.')
    expect(later).toEqual(await fresh())
  })

  it('leaves a load without reuseDiscovery discovering from scratch every time', async () => {
    await fresh()
    write('pkg/AGENTS.md', 'Nested rules.')
    expect((await fresh()).text).toContain('Nested rules.')
    expect(h.listings).toBe(2)
  })

  it('keeps workspaces apart', async () => {
    write('pkg/AGENTS.md', 'First workspace.')
    const other = join(root, 'other')
    mkdirSync(join(other, 'pkg'), { recursive: true })
    writeFileSync(join(other, 'pkg', 'AGENTS.md'), 'Second workspace.')
    expect((await load()).text).toContain('First workspace.')
    const second = await loadProjectRules(other, { globalDir, home, reuseDiscovery: true })
    expect(second.text).toContain('Second workspace.')
    expect(second.text).not.toContain('First workspace.')
  })
})
