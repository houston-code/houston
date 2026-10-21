import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { rgPath as vscodeRg } from '@vscode/ripgrep'
import { gitListFiles, hasHiddenSegment, inGitScope, planRuns, runPathArgs } from './fileScope'
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
})
