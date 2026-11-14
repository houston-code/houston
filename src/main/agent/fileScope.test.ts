import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { rgPath as vscodeRg } from '@vscode/ripgrep'
import { minimatch } from 'minimatch'
import {
  SCOPE_CACHE_MAX_ROOTS,
  SCOPE_CACHE_TTL_MS,
  ScopeCache,
  gitListFiles,
  gitTrackedHidden,
  globTester,
  hasHiddenSegment,
  inGitScope,
  listScope,
  planRuns,
  planScope,
  runPathArgs
} from './fileScope'
import { resolveRipgrep, searchContents } from './search'
import { resolveAstGrep, searchStructural } from './astgrep'
import { clearMentionCache, findFiles } from './mentions'
import { loadProjectRules } from './rules'
import { getTool } from './tools'

/**
 * Which files the discovery tools see. Fixture: a git repo whose .gitignore
 * covers build/, target/, and node_modules/, with one tracked file force-added
 * under build/, plus a plain (non-git) folder with the same layout.
 */

// The search backends under test. Either may be missing on a given machine; the
// tests that need one skip rather than pass vacuously.
const rg = resolveRipgrep() ?? (existsSync(vscodeRg) ? vscodeRg : null)
const ag =
  [resolve(process.cwd(), 'node_modules/@ast-grep/cli/ast-grep'), resolve(process.cwd(), 'node_modules/.bin/ast-grep')].find(
    (p) => existsSync(p)
  ) ?? resolveAstGrep()

// Real git and ripgrep/ast-grep processes per test; give them room under load.
const SLOW = 30_000

let root: string
let repo: string
let plain: string

const write = (base: string, rel: string, content = 'console.log(needle)\n'): void => {
  const full = join(base, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}
const git = (args: string[], cwd: string): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

/** Files every backend must find in the repo fixture, sorted. */
const REPO_EXPECTED = ['build/entitlements.ts', 'src/app.ts', 'vendor/lib.ts']

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'houston-scope-')))
  repo = join(root, 'repo')
  plain = join(root, 'plain')
  mkdirSync(repo)
  mkdirSync(plain)
  git(['init', '-q'], repo)
  write(repo, '.gitignore', 'build/\ntarget/\nnode_modules/\n')
  write(repo, 'src/app.ts') // untracked, not ignored: in scope
  write(repo, 'vendor/lib.ts') // a skip-list name, but git does not ignore it
  write(repo, 'build/entitlements.ts') // tracked despite the ignore rule
  git(['add', '-f', 'build/entitlements.ts'], repo)
  write(repo, 'build/generated.ts') // ignored, untracked
  write(repo, 'target/out.ts') // ignored
  write(repo, 'node_modules/dep/index.ts') // ignored
  write(repo, '.hidden/secret.ts') // hidden: skipped everywhere

  write(plain, 'src/app.ts')
  write(plain, 'build/generated.ts')
  write(plain, 'target/out.ts')
  write(plain, '__pycache__/mod.ts')
  write(plain, 'vendor/lib.ts')
  clearMentionCache()
})

afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

/** search_files in files-with-matches mode, as a sorted, '/'-separated list. */
async function searchedFiles(
  workspace: string,
  rgBin: string | null,
  searchRel = '.',
  glob?: string
): Promise<string[]> {
  const out = await searchContents({
    pattern: 'needle',
    workspace,
    searchRel,
    startAbs: join(workspace, searchRel),
    rgPath: rgBin,
    max: 100,
    glob,
    filesWithMatches: true
  })
  if (out === 'No matches found.') return []
  return out
    .split('\n')
    .map((l) => l.replace(/\\/g, '/'))
    .sort()
}

describe('inGitScope / gitListFiles', () => {
  it('is true inside a work tree, false outside one and inside an ignored directory', async () => {
    expect(await inGitScope(repo)).toBe(true)
    expect(await inGitScope(join(repo, 'src'))).toBe(true)
    expect(await inGitScope(plain)).toBe(false)
    expect(await inGitScope(join(repo, 'target'))).toBe(false)
  })

  it('lists tracked files under an ignored directory and drops ignored untracked ones', async () => {
    const listed = await gitListFiles(repo)
    expect(listed).toContain('build/entitlements.ts')
    expect(listed).toContain('vendor/lib.ts')
    expect(listed).not.toContain('build/generated.ts')
    expect(listed).not.toContain('target/out.ts')
    expect(listed?.some((p) => p.startsWith('node_modules/'))).toBe(false)
    expect(await gitListFiles(plain)).toBeNull()
  })
})

describe('search_files scope', () => {
  it('JS fallback: finds tracked build/ files, skips ignored target/ and hidden files', async () => {
    expect(await searchedFiles(repo, null)).toEqual(REPO_EXPECTED)
  }, SLOW)

  it.skipIf(!rg)('ripgrep returns the same set as the JS fallback', async () => {
    expect(await searchedFiles(repo, rg)).toEqual(await searchedFiles(repo, null))
  }, SLOW)

  it.skipIf(!rg)('ripgrep applies the glob filter to tracked-but-ignored files too', async () => {
    expect(await searchedFiles(repo, rg, '.', '*.ts')).toEqual(REPO_EXPECTED)
    expect(await searchedFiles(repo, rg, '.', 'src/**')).toEqual(['src/app.ts'])
    expect(await searchedFiles(repo, null, '.', 'src/**')).toEqual(['src/app.ts'])
  }, SLOW)

  it.skipIf(!rg)('works with ripgrep found through the HOUSTON_RG override', async () => {
    const viaOverride = resolveRipgrep({ env: { HOUSTON_RG: rg as string, PATH: '' }, candidates: [] })
    expect(viaOverride).toBe(rg)
    expect(await searchedFiles(repo, viaOverride)).toEqual(REPO_EXPECTED)
  }, SLOW)

  it('searches inside an ignored directory named explicitly (both backends)', async () => {
    expect(await searchedFiles(repo, null, 'target')).toEqual(['target/out.ts'])
    if (rg) expect(await searchedFiles(repo, rg, 'target')).toEqual(['target/out.ts'])
  }, SLOW)

  it('scopes to a subdirectory of the repo', async () => {
    expect(await searchedFiles(repo, null, 'build')).toEqual(['build/entitlements.ts'])
    if (rg) expect(await searchedFiles(repo, rg, 'build')).toEqual(['build/entitlements.ts'])
  }, SLOW)

  it('tolerates a tracked file deleted from disk', async () => {
    unlinkSync(join(repo, 'build', 'entitlements.ts'))
    expect(await searchedFiles(repo, null)).toEqual(['src/app.ts', 'vendor/lib.ts'])
    if (rg) expect(await searchedFiles(repo, rg)).toEqual(['src/app.ts', 'vendor/lib.ts'])
  }, SLOW)

  it('non-git folder: falls back to the fixed skip set, including generated dirs', async () => {
    expect(await searchedFiles(plain, null)).toEqual(['src/app.ts'])
    if (rg) expect(await searchedFiles(plain, rg)).toEqual(['src/app.ts'])
  }, SLOW)
})

describe('tracked hidden paths', () => {
  // Tracked: a workflow, a hook, and two credential files that must stay out.
  // Untracked: a hidden file the ignore rules allow, which stays skipped.
  beforeEach(() => {
    write(repo, '.github/workflows/ci.yml', 'run: needle\n')
    write(repo, '.husky/pre-commit', 'needle\n')
    write(repo, '.env', 'TOKEN=needle\n')
    write(repo, 'config/.npmrc', '//registry/:_authToken=needle\n')
    git(['add', '-f', '.github/workflows/ci.yml', '.husky/pre-commit', '.env', 'config/.npmrc'], repo)
    write(repo, '.scratch/notes.ts') // untracked, not ignored, hidden
  })

  const HIDDEN_EXPECTED = ['.github/workflows/ci.yml', '.husky/pre-commit', ...REPO_EXPECTED].sort()

  it('gitTrackedHidden lists tracked hidden files, minus credential files', async () => {
    expect((await gitTrackedHidden(repo)).sort()).toEqual(['.github/workflows/ci.yml', '.husky/pre-commit'])
    expect(await gitTrackedHidden(join(repo, '.github'))).toEqual([])
    expect(await gitTrackedHidden(plain)).toEqual([])
  })

  it('search_files finds them with the JS fallback, and skips .env, .npmrc and untracked dotfiles', async () => {
    expect(await searchedFiles(repo, null)).toEqual(HIDDEN_EXPECTED)
    expect(await searchedFiles(repo, null, '.', '*.yml')).toEqual(['.github/workflows/ci.yml'])
  }, SLOW)

  it.skipIf(!rg)('search_files finds the same set with ripgrep', async () => {
    expect(await searchedFiles(repo, rg)).toEqual(HIDDEN_EXPECTED)
    expect(await searchedFiles(repo, rg, '.', '*.yml')).toEqual(['.github/workflows/ci.yml'])
    expect(await searchedFiles(repo, rg, '.', '.github/**')).toEqual(['.github/workflows/ci.yml'])
  }, SLOW)

  it('search_files searches a hidden directory named explicitly', async () => {
    expect(await searchedFiles(repo, null, '.github')).toEqual(['.github/workflows/ci.yml'])
    if (rg) expect(await searchedFiles(repo, rg, '.github')).toEqual(['.github/workflows/ci.yml'])
  }, SLOW)

  it('glob matches tracked workflows with ** and leaves credential and untracked dotfiles out', async () => {
    const out = await getTool('glob')!.execute({ pattern: '**/*' }, { workspace: repo, allowNetwork: false })
    const files = out.split('\n').map((l) => l.replace(/\\/g, '/'))
    expect(files).toContain('.github/workflows/ci.yml')
    expect(files).toContain('.husky/pre-commit')
    expect(files.some((f) => f.endsWith('.env') || f.endsWith('.npmrc') || f.startsWith('.scratch/'))).toBe(false)
    const yml = await getTool('glob')!.execute({ pattern: '.github/workflows/*.yml' }, { workspace: repo, allowNetwork: false })
    expect(yml.replace(/\\/g, '/')).toBe('.github/workflows/ci.yml')
  }, SLOW)
})

describe('glob scope', () => {
  const glob = async (workspace: string, pattern: string, path?: string): Promise<string[]> => {
    const out = await getTool('glob')!.execute({ pattern, path }, { workspace, allowNetwork: false })
    return out === 'No files found.' ? [] : out.split('\n').map((l) => l.replace(/\\/g, '/')).sort()
  }

  it('in a repo: tracked build/ files found, ignored and hidden files skipped', async () => {
    expect(await glob(repo, '**/*.ts')).toEqual(REPO_EXPECTED)
    expect(await glob(repo, '*.ts', 'build')).toEqual(['build/entitlements.ts'])
  }, SLOW)

  it('in a plain folder: the fixed skip set applies', async () => {
    expect(await glob(plain, '**/*.ts')).toEqual(['src/app.ts'])
  }, SLOW)

  it('stats matches in batches without changing the result or its order', async () => {
    // More matches than one lstat batch, under three mtimes so most of them tie (a tie
    // keeps git's listing order), plus a tracked file deleted from disk and, where the
    // platform has them, a tracked symlink: both must drop out as before.
    const rels = Array.from({ length: 700 }, (_, i) => `many/f${String(i).padStart(3, '0')}.ts`)
    rels.forEach((rel, i) => {
      write(repo, rel)
      const t = 1_700_000_000 + (i % 3) * 1000
      utimesSync(join(repo, rel), t, t)
    })
    git(['add', 'many'], repo)
    unlinkSync(join(repo, rels[300]))
    if (process.platform !== 'win32') {
      symlinkSync(join(repo, rels[0]), join(repo, 'many', 'link.ts'))
      git(['add', 'many/link.ts'], repo)
    }
    // The reference: git's listing, one lstat at a time, as glob used to stat it.
    const found = (await gitListFiles(repo))!
      .filter((rel) => minimatch(rel, 'many/*.ts'))
      .flatMap((rel) => {
        try {
          const st = lstatSync(join(repo, rel))
          return st.isFile() ? [{ rel, mtimeMs: st.mtimeMs }] : []
        } catch {
          return []
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    expect(found).toHaveLength(699)
    const expected = `${found.slice(0, 200).map((f) => f.rel).join('\n')}\n[truncated to 200 of 699 matches]`
    const out = await getTool('glob')!.execute({ pattern: 'many/*.ts' }, { workspace: repo, allowNetwork: false })
    expect(out.replace(/\\/g, '/')).toBe(expected)
    const cached = { workspace: repo, allowNetwork: false, scopeCache: new ScopeCache() }
    expect(await getTool('glob')!.execute({ pattern: 'many/*.ts' }, cached)).toBe(out)
  }, SLOW)
})

describe('ast_grep scope', () => {
  const structural = async (workspace: string, searchRel = '.'): Promise<string[]> => {
    const out = await searchStructural({
      pattern: 'console.log($A)',
      lang: 'ts',
      workspace,
      searchRel,
      binPath: ag,
      max: 100
    })
    if (out === 'No matches found.') return []
    return [...new Set(out.split('\n').map((l) => l.split(':')[0].replace(/\\/g, '/')))].sort()
  }

  it.skipIf(!ag)('matches the search_files set in a repo and in a plain folder', async () => {
    expect(await structural(repo)).toEqual(REPO_EXPECTED)
    expect(await structural(plain)).toEqual(['src/app.ts'])
    expect(await structural(repo, 'target')).toEqual(['target/out.ts'])
    expect(await structural(repo, 'build')).toEqual(['build/entitlements.ts'])
  }, SLOW)
})

describe('@-mention scope', () => {
  it('offers tracked files under build/ and never ignored ones', async () => {
    expect(await findFiles(repo, 'entitlements')).toContain('build/entitlements.ts')
    expect(await findFiles(repo, 'generated')).toEqual([])
    expect((await findFiles(repo, 'out.ts')).some((p) => p.startsWith('target/'))).toBe(false)
  }, SLOW)

  it('falls back to the fixed skip set outside git', async () => {
    expect(await findFiles(plain, 'mod.ts')).toEqual([])
    expect(await findFiles(plain, 'app')).toContain('src/app.ts')
  }, SLOW)
})

describe('nested rules scope', () => {
  const opts = { home: tmpdir() }

  it('finds a tracked AGENTS.md under build/, never one in an ignored dir', async () => {
    write(repo, 'build/AGENTS.md', 'TRACKED-BUILD-RULES')
    git(['add', '-f', 'build/AGENTS.md'], repo)
    write(repo, 'target/AGENTS.md', 'IGNORED-TARGET-RULES')
    write(repo, 'node_modules/dep/CLAUDE.md', 'VENDOR-RULES')
    write(repo, 'packages/api/AGENTS.md', 'UNTRACKED-PACKAGE-RULES')
    const rules = await loadProjectRules(repo, { ...opts, globalDir: join(root, 'no-global') })
    expect(rules.text).toContain('TRACKED-BUILD-RULES')
    expect(rules.text).toContain('UNTRACKED-PACKAGE-RULES')
    expect(rules.text).not.toContain('IGNORED-TARGET-RULES')
    expect(rules.text).not.toContain('VENDOR-RULES')
    // Shallowest first.
    expect(rules.text.indexOf('TRACKED-BUILD-RULES')).toBeLessThan(rules.text.indexOf('UNTRACKED-PACKAGE-RULES'))
  }, SLOW)

  it('respects the depth and count limits from the git listing', async () => {
    write(repo, 'a/AGENTS.md', 'DEPTH-ONE')
    write(repo, 'a/b/AGENTS.md', 'DEPTH-TWO')
    write(repo, 'z/AGENTS.md', 'DEPTH-ONE-Z')
    const shallow = await loadProjectRules(repo, { ...opts, globalDir: join(root, 'no-global'), maxNestedDepth: 1 })
    expect(shallow.text).toContain('DEPTH-ONE')
    expect(shallow.text).not.toContain('DEPTH-TWO')
    const capped = await loadProjectRules(repo, { ...opts, globalDir: join(root, 'no-global'), maxNestedFiles: 2 })
    // The cap keeps the shallowest files, not whichever the traversal hit first.
    expect(capped.text).toContain('DEPTH-ONE-Z')
    expect(capped.text).not.toContain('DEPTH-TWO')
  }, SLOW)

  it('skips generated dirs in a plain folder', async () => {
    write(plain, 'target/AGENTS.md', 'PLAIN-TARGET-RULES')
    write(plain, 'src/AGENTS.md', 'PLAIN-SRC-RULES')
    const rules = await loadProjectRules(plain, { ...opts, globalDir: join(root, 'no-global') })
    expect(rules.text).toContain('PLAIN-SRC-RULES')
    expect(rules.text).not.toContain('PLAIN-TARGET-RULES')
  }, SLOW)
})

// Containment: git tracks symlinks, and an untrusted repo can commit one pointing
// at a host file. No backend may follow it, whether it sits where the walk goes
// or is handed over as an explicit tracked-but-ignored path.
describe.skipIf(process.platform === 'win32')('tracked symlinks out of the workspace', () => {
  beforeEach(() => {
    write(root, 'outside/secret.ts', 'console.log(needle) // HOST-SECRET\n')
    symlinkSync(join(root, 'outside', 'secret.ts'), join(repo, 'src', 'link.ts'))
    symlinkSync(join(root, 'outside', 'secret.ts'), join(repo, 'build', 'link.ts'))
    git(['add', '-f', 'src/link.ts', 'build/link.ts'], repo)
  })

  it('search_files follows neither (both backends)', async () => {
    expect(await searchedFiles(repo, null)).toEqual(REPO_EXPECTED)
    expect(await searchedFiles(repo, null, 'build')).toEqual(['build/entitlements.ts'])
    if (rg) {
      expect(await searchedFiles(repo, rg)).toEqual(REPO_EXPECTED)
      expect(await searchedFiles(repo, rg, 'build')).toEqual(['build/entitlements.ts'])
    }
  }, SLOW)

  it('glob does not list them', async () => {
    const out = await getTool('glob')!.execute({ pattern: '**/link.ts' }, { workspace: repo, allowNetwork: false })
    expect(out).toBe('No files found.')
  }, SLOW)

  it.skipIf(!ag)('ast_grep follows neither', async () => {
    const out = await searchStructural({
      pattern: 'console.log($A)',
      lang: 'ts',
      workspace: repo,
      searchRel: '.',
      binPath: ag,
      max: 100
    })
    expect(out).not.toContain('link.ts')
  }, SLOW)
})

describe('ScopeCache (a run\'s memo of the scope plan)', () => {
  // The three things a stale plan gets wrong: a tracked hidden file, a tracked file
  // under a directory about to be ignored, and an untracked file beside it.
  beforeEach(() => {
    write(repo, '.github/workflows/ci.yml', 'run: needle\n')
    write(repo, 'lib/kept.ts')
    git(['add', '-f', '.github/workflows/ci.yml', 'lib/kept.ts'], repo)
    write(repo, 'lib/loose.ts')
  })

  const backends = rg ? [null, rg] : [null]

  /** search_files in files-with-matches mode, sorted, through `cache` when given. */
  const found = async (rgBin: string | null, searchRel = '.', cache?: ScopeCache): Promise<string[]> => {
    const out = await searchContents({
      pattern: 'needle',
      workspace: repo,
      searchRel,
      startAbs: join(repo, searchRel),
      rgPath: rgBin,
      max: 100,
      filesWithMatches: true,
      scopeCache: cache
    })
    return out === 'No matches found.' ? [] : out.split('\n').map((l) => l.replace(/\\/g, '/')).sort()
  }
  /** glob's raw output (so its order counts too), through `cache` when given. */
  const globbed = async (pattern: string, path?: string, cache?: ScopeCache): Promise<string> =>
    (await getTool('glob')!.execute({ pattern, path }, { workspace: repo, allowNetwork: false, scopeCache: cache })).replace(
      /\\/g,
      '/'
    )

  it('answers exactly as planning afresh does, for every kind of root', async () => {
    const cache = new ScopeCache()
    for (const dir of [repo, join(repo, 'src'), join(repo, 'build'), join(repo, 'target'), join(repo, '.github'), plain]) {
      const plan = await planScope(dir)
      expect(await cache.plan(dir)).toEqual(plan) // planned
      expect(await cache.plan(dir)).toEqual(plan) // from memory
      // The one-round listing matches the two serial helpers glob used before.
      const listed = await gitListFiles(dir)
      const listing = { listed, trackedHidden: listed ? await gitTrackedHidden(dir) : [] }
      expect(await listScope(dir)).toEqual(listing)
      expect(await cache.listing(dir)).toEqual(listing)
      expect(await cache.listing(dir)).toEqual(listing)
    }
  }, SLOW)

  it('leaves what search_files, glob, and ast_grep find unchanged', async () => {
    const cache = new ScopeCache()
    for (const searchRel of ['.', 'build', 'target', '.github', 'lib']) {
      for (const bin of backends) {
        const fresh = await found(bin, searchRel)
        expect(await found(bin, searchRel, cache)).toEqual(fresh)
        expect(await found(bin, searchRel, cache)).toEqual(fresh)
      }
    }
    for (const [pattern, path] of [['**/*'], ['*.ts', 'build'], ['**/*.yml'], ['*.ts', 'target']]) {
      const fresh = await globbed(pattern, path)
      expect(await globbed(pattern, path, cache)).toBe(fresh)
      expect(await globbed(pattern, path, cache)).toBe(fresh)
    }
    if (ag) {
      // ast-grep walks in parallel, so its line order varies from run to run.
      const structural = async (scopeCache?: ScopeCache): Promise<string[]> =>
        (
          await searchStructural({
            pattern: 'console.log($A)',
            lang: 'ts',
            workspace: repo,
            searchRel: '.',
            binPath: ag,
            max: 100,
            scopeCache
          })
        )
          .split('\n')
          .map((l) => l.replace(/\\/g, '/'))
          .sort()
      const fresh = await structural()
      expect(fresh).toContain('lib/kept.ts:1:1: console.log(needle)')
      expect(await structural(cache)).toEqual(fresh)
      expect(await structural(cache)).toEqual(fresh)
    }
  }, SLOW)

  it('holds its answer until invalidated, then sees a newly tracked file and a new ignore rule', async () => {
    const cache = new ScopeCache()
    for (const bin of backends) await found(bin, '.', cache)
    const globBefore = await globbed('**/*', undefined, cache)
    // What a shell command or a write might do mid-run: track a new hidden file and
    // ignore lib/, whose kept.ts is tracked (so still searched) and loose.ts isn't.
    write(repo, '.husky/pre-commit', 'needle\n')
    git(['add', '-f', '.husky/pre-commit'], repo)
    appendFileSync(join(repo, '.gitignore'), 'lib/\n')
    const fresh = await found(null, '.')
    expect(fresh).toContain('.husky/pre-commit')
    expect(fresh).toContain('lib/kept.ts')
    expect(fresh).not.toContain('lib/loose.ts')
    // A held plan is not checked against the tree again (that is why the loop
    // invalidates the memo after every call that may change it), so every backend
    // still answers for the old tree...
    for (const bin of backends) expect(await found(bin, '.', cache)).not.toEqual(fresh)
    expect(await globbed('**/*', undefined, cache)).toBe(globBefore)
    // ...until it is invalidated.
    cache.invalidate()
    for (const bin of backends) expect(await found(bin, '.', cache)).toEqual(fresh)
    const globFresh = await globbed('**/*')
    expect(globFresh).toContain('.husky/pre-commit')
    expect(globFresh).not.toContain('lib/loose.ts')
    expect(await globbed('**/*', undefined, cache)).toBe(globFresh)
  }, SLOW)

  it('plans afresh once its window has passed', async () => {
    let now = 1_000
    const cache = new ScopeCache({ now: () => now })
    const plan = await cache.plan(repo)
    const listing = await cache.listing(repo)
    now += SCOPE_CACHE_TTL_MS - 1
    expect(await cache.plan(repo)).toBe(plan)
    expect(await cache.listing(repo)).toBe(listing)
    now += 1
    const replanned = await cache.plan(repo)
    expect(replanned).not.toBe(plan)
    expect(replanned).toEqual(plan)
    expect(await cache.listing(repo)).not.toBe(listing)
  }, SLOW)

  it('shares one planning between concurrent callers, one entry per root', async () => {
    const cache = new ScopeCache()
    const [a, b] = await Promise.all([cache.plan(repo), cache.plan(repo)])
    expect(b).toBe(a)
    expect(await cache.plan(join(repo, 'build'))).toEqual({ kind: 'git', walk: false, explicit: ['entitlements.ts'] })
    const listing = await cache.listing(repo)
    expect(await cache.listing(repo)).toBe(listing)
    expect(cache.size).toBe(3)
    cache.invalidate()
    expect(cache.size).toBe(0)
    expect(await cache.plan(repo)).not.toBe(a)
  }, SLOW)

  it('does not keep a planning that an invalidation overtook', async () => {
    const cache = new ScopeCache()
    const pending = cache.plan(repo)
    cache.invalidate()
    await pending
    expect(cache.size).toBe(0)
  }, SLOW)

  it('keeps no answer a git call failed to give', async () => {
    // A filter driver named so no override can switch it off: Houston runs no git
    // there, so the plan is the no-git fallback, and it is worked out again next time.
    appendFileSync(join(repo, '.git', 'config'), '[filter "a=b"]\n\tclean = cat\n')
    const cache = new ScopeCache()
    expect(await cache.plan(repo)).toEqual({ kind: 'plain' })
    expect(await cache.listing(repo)).toEqual({ listed: null, trackedHidden: [] })
    expect(cache.size).toBe(0)
  }, SLOW)

  it('holds a bounded number of roots', async () => {
    const cache = new ScopeCache()
    for (let i = 0; i <= SCOPE_CACHE_MAX_ROOTS; i++) {
      mkdirSync(join(plain, `d${i}`))
      await cache.plan(join(plain, `d${i}`))
    }
    expect(cache.size).toBe(SCOPE_CACHE_MAX_ROOTS)
  }, SLOW)
})

describe('helpers', () => {
  it('hasHiddenSegment checks every segment, with basename exemptions', () => {
    expect(hasHiddenSegment('src/app.ts')).toBe(false)
    expect(hasHiddenSegment('.github/ci.yml')).toBe(true)
    expect(hasHiddenSegment('a/.cache/b')).toBe(true)
    expect(hasHiddenSegment('a/.env.example', new Set(['.env.example']))).toBe(false)
    expect(hasHiddenSegment('.env.example/x', new Set(['.env.example']))).toBe(true)
  })

  it('planRuns walks the root once, then batches the explicit paths', () => {
    const extras = Array.from({ length: 1201 }, (_, i) => `f${i}`)
    const runs = planRuns('src', extras, 500)
    expect(runs.map((r) => [r.searchRel, r.extraPaths.length])).toEqual([
      ['src', 0],
      ['', 500],
      ['', 500],
      ['', 201]
    ])
    expect(runs.flatMap((r) => r.extraPaths)).toEqual(extras)
  })

  it('runPathArgs never drops the search root and never adds one to a batch', () => {
    expect(runPathArgs('.')).toEqual(['.'])
    expect(runPathArgs('')).toEqual(['.'])
    expect(runPathArgs('src', ['b/x'])).toEqual(['src', 'b/x'])
    expect(runPathArgs('', ['b/x'])).toEqual(['b/x'])
  })

  it('globTester answers exactly as minimatch() does, with and without options', () => {
    const paths = [
      'a.ts', 'src/a.ts', 'src/deep/b.tsx', '.hidden/c.ts', 'src/.d.ts', 'README.md',
      'src/x.test.ts', 'a b/c.ts', 'src\\win.ts', ''
    ]
    const patterns = [
      '*.ts', '**/*.ts', 'src/**', 'src/*.{ts,tsx}', '!*.md', '#comment', '**/.*', '[ab]*', '?.ts', '**'
    ]
    for (const pattern of patterns) {
      for (const options of [undefined, { matchBase: true }]) {
        const test = globTester(pattern, options)
        for (const p of paths) expect([pattern, options, p, test(p)]).toEqual([pattern, options, p, minimatch(p, pattern, options)])
      }
    }
  })

  it('globTester compiles lazily, so a pattern minimatch rejects throws on the first test', () => {
    const tooLong = 'a'.repeat(70_000)
    const test = globTester(tooLong) // no throw yet: nothing has been tested
    let thrown: unknown
    try {
      minimatch('a', tooLong)
    } catch (e) {
      thrown = e
    }
    expect(() => test('a')).toThrow((thrown as Error).message)
  })
})
